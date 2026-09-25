import AVFoundation
import MediaPlayer

// MARK: - Playback State

enum PlaybackState: Equatable, Sendable {
    case idle
    case loading
    case playing
    case paused
    case buffering
    case failed(String)
}

// MARK: - Audio Player

@MainActor
@Observable
final class AudioPlayer {
    static let shared = AudioPlayer()

    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var currentTrackID: String?
    @ObservationIgnored private var currentURLString: String?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private weak var timeObserverOwner: AVPlayer?
    @ObservationIgnored private var statusObserver: NSKeyValueObservation?
    @ObservationIgnored private var bufferEmptyObserver: NSKeyValueObservation?
    @ObservationIgnored private var keepUpObserver: NSKeyValueObservation?
    @ObservationIgnored private var timeControlObserver: NSKeyValueObservation?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var stalledObserver: NSObjectProtocol?
    @ObservationIgnored private var failedObserver: NSObjectProtocol?
    @ObservationIgnored private var sessionObservers: [NSObjectProtocol] = []
    @ObservationIgnored private var trackEndAction: (() -> Void)?
    @ObservationIgnored private var lastNowPlayingElapsedSecond = -1
    @ObservationIgnored private var lastNowPlayingDuration: TimeInterval = 0
    @ObservationIgnored private var seekGeneration = 0
    @ObservationIgnored private var wasPlayingBeforeInterruption = false
    /// Start offset for a freshly loaded item (restored queue); applied once
    /// the item is ready so playback doesn't blip from 0.
    @ObservationIgnored private var pendingStartTime: TimeInterval?
    @ObservationIgnored private var audioSessionConfigured = false

    /// True while the user wants audio (playing, loading or buffering).
    private var wantsPlayback = false

    // Stalls are retried only for the current item. A new track, restart, or
    // explicit resume starts a fresh retry budget.
    private let maxStallRetries = 2
    @ObservationIgnored private var stallRetryCount = 0
    @ObservationIgnored private var stallRetryTask: Task<Void, Never>?

    // Next-track preload + crossfade. The next item is loaded well before the
    // end (paused, silent) so the transition starts instantly; the fade itself
    // begins `crossfadeSec` before the end, triggered by a boundary observer.
    @ObservationIgnored private var nextURLString: String?
    @ObservationIgnored private var nextPlayer: AVPlayer?
    @ObservationIgnored private var nextPlayerStatusObserver: NSKeyValueObservation?
    @ObservationIgnored private var crossfadeStarted = false
    @ObservationIgnored private var crossfadeProgress: Double = 0
    @ObservationIgnored private var crossfadeTask: Task<Void, Never>?
    @ObservationIgnored private var boundaryObserver: Any?
    @ObservationIgnored private weak var boundaryObserverOwner: AVPlayer?
    /// Seconds before the crossfade point at which the next item is preloaded.
    static let preloadLeadTime: TimeInterval = 12
    /// Overlap used for "gapless" when crossfade is off.
    static let gaplessBridgeDuration: TimeInterval = 0.25
    // Driven by SettingsStore via applyPlaybackSettings(); 0s ("Off") disables it.
    var crossfadeSec: TimeInterval = 5.0
    var crossfadeEnabled = true

    // Loudness normalization (ReplayGain-style). Base volume per track; fades,
    // the user volume and sleep-timer ramps multiply on top of it. AVPlayer
    // volume is capped at 1.0, so louder-than-target tracks are attenuated
    // while quieter ones play untouched (no boosting into clipping).
    static let loudnessTargetLufs: Double = -16
    @ObservationIgnored private var currentTrackBaseVolume: Float = 1
    @ObservationIgnored private var nextTrackBaseVolume: Float = 1
    @ObservationIgnored private var sleepFadeFactor: Float = 1

    static func normalizationVolume(forLoudness lufs: Double?) -> Float {
        guard SettingsStore.shared.normalization, let lufs, lufs.isFinite else { return 1 }
        let gainDb = loudnessTargetLufs - lufs
        let linear = pow(10.0, gainDb / 20.0)
        return Float(min(max(linear, 0.1), 1.0))
    }

    /// In-app volume (0...1) on top of the system volume; driven by the iPod
    /// wheel and the watch crown. Persisted across launches.
    private(set) var userVolume: Float = 1
    private static let userVolumeKey = "player_user_volume"

    // State
    private(set) var playbackState: PlaybackState = .idle
    var isPlaying: Bool { playbackState == .playing }
    /// True when playback is playing or about to (loading / buffering after a
    /// play request). Use for play/pause affordances.
    var isPlaybackIntended: Bool { wantsPlayback }
    var progress: Double = 0  // 0...1
    var currentTime: TimeInterval = 0
    var duration: TimeInterval = 0
    var isBuffering: Bool {
        switch playbackState {
        case .loading, .buffering:
            return true
        case .idle, .playing, .paused, .failed:
            return false
        }
    }
    var lastErrorMessage: String?
    /// Whether an item is loaded into the engine (false after launch until the
    /// restored track is first played).
    var hasLoadedItem: Bool { player?.currentItem != nil }

    // Sleep timer - checked on each periodic time tick (fires during background audio).
    var sleepDeadline: Date?
    let sleepFadeDuration: TimeInterval = 8.0

    // Callbacks - set by PlayerStore.
    @ObservationIgnored var onRemoteNext: (@MainActor () -> Void)?
    @ObservationIgnored var onRemotePrevious: (@MainActor () -> Void)?
    /// Lock screen / AirPods / CarPlay play, pause, toggle and scrub. Routed
    /// through PlayerStore so every surface republishes the same way.
    @ObservationIgnored var onRemotePlay: (@MainActor () -> Void)?
    @ObservationIgnored var onRemotePause: (@MainActor () -> Void)?
    @ObservationIgnored var onRemoteTogglePlayPause: (@MainActor () -> Void)?
    @ObservationIgnored var onRemoteSeek: (@MainActor (Double) -> Void)?
    @ObservationIgnored var onPlaybackProgress: (@MainActor (TimeInterval) -> Void)?
    @ObservationIgnored var onPlaybackPaused: (@MainActor () -> Void)?
    @ObservationIgnored var onPlaybackResumed: (@MainActor () -> Void)?
    @ObservationIgnored var onPlaybackFailed: (@MainActor () -> Void)?
    /// Fired only when `playbackState` actually changes.
    @ObservationIgnored var onPlaybackStateChange: (@MainActor (PlaybackState) -> Void)?
    /// Fired after a seek lands, with the new position in seconds.
    @ObservationIgnored var onPlaybackSeeked: (@MainActor (TimeInterval) -> Void)?

    private init() {
        if let stored = UserDefaults.standard.object(forKey: Self.userVolumeKey) as? NSNumber {
            userVolume = min(max(stored.floatValue, 0), 1)
        }
        // The session is configured and activated lazily on the first play so
        // launching Musaic never interrupts other apps' audio.
        setupAudioSessionObservers()
        setupRemoteCommands()
        applyPlaybackSettings()
    }

    /// Re-read Crossfade / Gapless from SettingsStore and apply to the engine.
    /// - Crossfade > 0  -> real crossfade of that length.
    /// - Crossfade Off + Gapless on -> the preloaded next item starts a quarter
    ///   second before the end (boundary-timed), bridging the gap.
    /// - Crossfade Off + Gapless off -> hard cut between tracks.
    /// Call this whenever the user changes those settings.
    func applyPlaybackSettings() {
        let settings = SettingsStore.shared
        let configured = TimeInterval(settings.crossfadeSec)
        if configured > 0 {
            crossfadeEnabled = true
            crossfadeSec = configured
        } else if settings.gapless {
            crossfadeEnabled = true
            crossfadeSec = Self.gaplessBridgeDuration
        } else {
            crossfadeEnabled = false
            crossfadeSec = 0
        }
        if !crossfadeEnabled {
            teardownNextPlayer()
        }
        installCrossfadeBoundary()
    }

    // MARK: - Audio session

    @discardableResult
    private func activateAudioSession() -> Bool {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do {
            if !audioSessionConfigured {
                try session.setCategory(.playback, mode: .default)
                audioSessionConfigured = true
            }
            try session.setActive(true)
            return true
        } catch {
            print("[AudioPlayer] Audio session activation failed: \(error)")
            return false
        }
        #else
        return true
        #endif
    }

    private func deactivateAudioSession() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func setupAudioSessionObservers() {
        #if os(iOS)
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        sessionObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            guard let info = notification.userInfo,
                  let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
            let rawOptions = (info[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
            Task { @MainActor [weak self] in
                self?.handleInterruption(type, options: AVAudioSession.InterruptionOptions(rawValue: rawOptions))
            }
        })
        sessionObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            guard let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }
            Task { @MainActor [weak self] in
                // Headphones unplugged / AirPods removed: pause like the system player.
                guard let self, reason == .oldDeviceUnavailable, self.wantsPlayback else { return }
                self.pause()
            }
        })
        sessionObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.audioSessionConfigured = false
                if self.wantsPlayback { self.activateAudioSession() }
            }
        })
        #endif
    }

    #if os(iOS)
    private func handleInterruption(_ type: AVAudioSession.InterruptionType, options: AVAudioSession.InterruptionOptions) {
        switch type {
        case .began:
            let wasActive = wantsPlayback || isPlaying
            wasPlayingBeforeInterruption = wasActive
            guard wasActive else { return }
            // Clearing wantsPlayback keeps the KVO observers from reporting
            // "buffering" while the call holds the audio hardware.
            wantsPlayback = false
            stallRetryTask?.cancel()
            stallRetryTask = nil
            cancelCrossfade(keepPreload: true)
            player?.pause()
            transition(to: player?.currentItem == nil ? .idle : .paused)
            syncNowPlayingProgressIfNeeded(force: true)
            onPlaybackPaused?()
        case .ended:
            guard wasPlayingBeforeInterruption else { return }
            wasPlayingBeforeInterruption = false
            if options.contains(.shouldResume) {
                resume()
            }
        @unknown default:
            break
        }
    }
    #endif

    // MARK: - Playback

    /// Plays `track`. `startAt` (seconds) resumes a restored position.
    func play(track: Track, restartIfSame: Bool = false, startAt: TimeInterval = 0) {
        // Prefer local file if downloaded for offline playback.
        let url = DownloadManager.shared.localFileURL(for: track.id)?.absoluteString ?? track.url
        play(trackID: track.id, url: url, restartIfSame: restartIfSame, loudnessLufs: track.loudnessLufs, startAt: startAt)
    }

    func play(url: String) {
        play(trackID: nil, url: url, restartIfSame: true)
    }

    private func play(
        trackID: String?,
        url: String,
        restartIfSame: Bool,
        loudnessLufs: Double? = nil,
        startAt: TimeInterval = 0
    ) {
        let normalizedURL = Self.normalizedPlaybackURLString(url) ?? url

        guard let audioURL = URL(string: normalizedURL) else {
            registerPlaybackFailure(nil, fallback: "Invalid audio URL.")
            return
        }

        if !restartIfSame,
           let player,
           player.currentItem?.status != .failed,
           currentURLString == normalizedURL,
           trackID == nil || currentTrackID == trackID {
            if !wantsPlayback {
                resume()
            } else {
                transition(to: player.timeControlStatus == .playing ? .playing : playbackState, clearError: true)
            }
            return
        }

        // A preloaded (or already fading-in) next item: promote it instead of
        // a cold start.
        if nextPlayer != nil, nextURLString == normalizedURL {
            promoteNextPlayer(trackID: trackID, urlString: normalizedURL)
            return
        }

        activateAudioSession()
        cleanup()
        currentTrackID = trackID
        currentURLString = normalizedURL
        // No loudness data means unity gain, never the previous track's gain.
        currentTrackBaseVolume = Self.normalizationVolume(forLoudness: loudnessLufs)
        let start = startAt.isFinite ? max(0, startAt) : 0
        currentTime = start
        progress = 0
        setDuration(0)
        lastNowPlayingElapsedSecond = -1
        lastNowPlayingDuration = 0
        wantsPlayback = true
        wasPlayingBeforeInterruption = false
        stallRetryCount = 0
        pendingStartTime = start > 0.5 ? start : nil
        transition(to: .loading, clearError: true)

        let item = makePlayerItem(for: audioURL)
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        self.player = player
        applyVolumes()
        attachObservers(player: player, item: item)

        if pendingStartTime == nil {
            player.play()
        }
    }

    func togglePlayPause() {
        guard let player else { return }
        if player.currentItem?.status == .failed, let currentURLString {
            play(trackID: currentTrackID, url: currentURLString, restartIfSame: true)
            return
        }
        if wantsPlayback {
            pause()
        } else {
            resume()
        }
    }

    func pause() {
        let wasPlaying = isPlaying || wantsPlayback
        wantsPlayback = false
        wasPlayingBeforeInterruption = false
        stallRetryTask?.cancel()
        stallRetryTask = nil
        cancelCrossfade(keepPreload: true)
        player?.pause()
        transition(to: player?.currentItem == nil ? .idle : .paused)
        syncNowPlayingProgressIfNeeded(force: true)
        if wasPlaying { onPlaybackPaused?() }
    }

    func resume() {
        guard let player else { return }
        if player.currentItem?.status == .failed, let currentURLString {
            play(trackID: currentTrackID, url: currentURLString, restartIfSame: true)
            return
        }

        let wasPlaying = isPlaying || wantsPlayback
        activateAudioSession()
        lastErrorMessage = nil
        stallRetryTask?.cancel()
        stallRetryTask = nil
        stallRetryCount = 0
        sleepFadeFactor = 1
        wantsPlayback = true
        applyVolumes()
        if player.timeControlStatus != .playing {
            transition(to: .loading, clearError: true)
        }
        if let start = pendingStartTime {
            // Not started yet: the ready handler seeks + plays, or do it now.
            if player.currentItem?.status == .readyToPlay {
                startFromPendingPosition(player: player, start: start)
            }
        } else {
            player.play()
        }
        syncNowPlayingProgressIfNeeded(force: true)
        if !wasPlaying { onPlaybackResumed?() }
    }

    /// Pause both the main and next players immediately (sleep timer).
    func pauseAll() {
        pause()
        nextPlayer?.pause()
    }

    /// Reset any sleep-timer-induced volume fade.
    func cancelVolumeFade() {
        sleepFadeFactor = 1
        applyVolumes()
    }

    /// Sets the in-app volume (0...1).
    func setUserVolume(_ value: Float) {
        let clamped = min(max(value, 0), 1)
        guard abs(clamped - userVolume) > 0.0005 else { return }
        userVolume = clamped
        UserDefaults.standard.set(clamped, forKey: Self.userVolumeKey)
        applyVolumes()
    }

    /// Accurate position read straight from AVPlayer (the observable
    /// `currentTime` only advances every 0.25 s). Use for karaoke timing.
    func livePlaybackTime() -> TimeInterval {
        if let pendingStartTime { return pendingStartTime }
        guard let player else { return currentTime }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? max(0, seconds) : currentTime
    }

    /// Shows a restored position before any item is loaded (launch restore).
    func presentRestoredPosition(_ position: TimeInterval, duration restoredDuration: TimeInterval) {
        guard player == nil else { return }
        let safeDuration = restoredDuration.isFinite ? max(0, restoredDuration) : 0
        let safePosition = position.isFinite ? max(0, position) : 0
        currentTime = safePosition
        setDuration(safeDuration)
        progress = safeDuration > 0 ? min(max(safePosition / safeDuration, 0), 1) : 0
    }

    private func tickSleepTimer() {
        guard let deadline = sleepDeadline else { return }
        let remaining = deadline.timeIntervalSinceNow

        if remaining <= 0 {
            pauseAll()
            sleepFadeFactor = 1
            applyVolumes()
            sleepDeadline = nil
            // Mirror the cleared state on the PlayerStore so the UI refreshes.
            PlayerStore.shared.clearSleepTimer(silent: true)
            return
        }

        let factor: Float = remaining <= sleepFadeDuration
            ? Float(max(0, min(1, remaining / sleepFadeDuration)))
            : 1
        if abs(factor - sleepFadeFactor) > 0.001 {
            sleepFadeFactor = factor
            applyVolumes()
        }
    }

    func restartCurrentTrack() {
        guard let player else { return }

        if player.currentItem?.status == .failed, let currentURLString {
            play(trackID: currentTrackID, url: currentURLString, restartIfSame: true)
            return
        }

        let shouldPlay = wantsPlayback || isPlaying
        stallRetryTask?.cancel()
        stallRetryTask = nil
        stallRetryCount = 0
        pendingStartTime = nil
        cancelCrossfade(keepPreload: true)
        progress = 0
        currentTime = 0
        transition(to: shouldPlay ? .buffering : .paused)

        seekGeneration += 1
        let generation = seekGeneration
        player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak player] _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, self.seekGeneration == generation else { return }
                if self.wantsPlayback {
                    player.play()
                    if player.timeControlStatus != .playing { self.transition(to: .loading) }
                } else {
                    self.transition(to: .paused)
                }
                self.lastNowPlayingElapsedSecond = -1
                self.syncNowPlayingProgressIfNeeded(force: true)
                self.onPlaybackSeeked?(0)
            }
        }
    }

    func seek(to fraction: Double) {
        guard let player else { return }
        guard fraction.isFinite else { return }
        let safeFraction = max(0, min(1, fraction))

        // Resolve duration: AVPlayer -> item -> track metadata.
        var dur = duration
        if dur <= 0 { dur = resolvedDuration(for: player.currentItem) }
        if dur <= 0 { dur = PlayerStore.shared.currentTrack?.duration ?? 0 }
        guard dur > 0 else { return }

        let targetSeconds = safeFraction * dur
        cancelCrossfade(keepPreload: true)

        // Update UI immediately.
        progress = safeFraction
        currentTime = targetSeconds
        if dur > duration { setDuration(dur) }

        if pendingStartTime != nil {
            // Item not started yet: move the pending start instead.
            pendingStartTime = targetSeconds
            onPlaybackSeeked?(targetSeconds)
            return
        }

        let target = CMTime(seconds: targetSeconds, preferredTimescale: 600)
        seekGeneration += 1
        let generation = seekGeneration
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak player] finished in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, finished,
                      self.seekGeneration == generation else { return }
                self.currentTime = targetSeconds
                self.progress = safeFraction
                if self.wantsPlayback && player.timeControlStatus != .playing { player.play() }
                self.syncNowPlayingProgressIfNeeded(force: true)
                self.onPlaybackSeeked?(targetSeconds)
            }
        }
        lastNowPlayingElapsedSecond = -1
        syncNowPlayingProgressIfNeeded(force: true)
    }

    func stop() {
        cleanup()
        teardownNextPlayer()
        nextURLString = nil
        currentTrackID = nil
        currentURLString = nil
        wantsPlayback = false
        wasPlayingBeforeInterruption = false
        progress = 0
        currentTime = 0
        setDuration(0)
        lastNowPlayingElapsedSecond = -1
        lastNowPlayingDuration = 0
        lastErrorMessage = nil
        transition(to: .idle, clearError: true)
        deactivateAudioSession()
    }

    // MARK: - Volume

    /// Single place that derives both players' volumes from base loudness,
    /// user volume, sleep fade and crossfade progress (equal-power curve).
    private func applyVolumes() {
        let common = userVolume * sleepFadeFactor
        if crossfadeStarted {
            let angle = crossfadeProgress * .pi / 2
            player?.volume = Float(cos(angle)) * currentTrackBaseVolume * common
            nextPlayer?.volume = Float(sin(angle)) * nextTrackBaseVolume * common
        } else {
            player?.volume = currentTrackBaseVolume * common
            nextPlayer?.volume = 0
        }
    }

    // MARK: - Observer and retry management

    private func makePlayerItem(for url: URL) -> AVPlayerItem {
        let request = APIService.shared.authenticatedRequest(for: url)
        var options: [String: Any] = [:]
        if let headers = request.allHTTPHeaderFields, !headers.isEmpty {
            options["AVURLAssetHTTPHeaderFieldsKey"] = headers
        }

        // A URL-only player item cannot carry the bearer token. Supplying the
        // request headers through AVURLAsset keeps proxy streams authenticated,
        // including preloaded next items.
        let asset = AVURLAsset(url: url, options: options)
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 8
        return item
    }

    private func attachObservers(player: AVPlayer, item: AVPlayerItem) {
        statusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self, weak player] item, _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, self.isCurrentItem(item) else { return }
                switch item.status {
                case .readyToPlay:
                    self.setDuration(self.resolvedDuration(for: item))
                    if self.lastErrorMessage != nil { self.lastErrorMessage = nil }
                    self.installCrossfadeBoundary()
                    if let start = self.pendingStartTime, self.wantsPlayback {
                        self.startFromPendingPosition(player: player, start: start)
                    } else {
                        self.updatePlaybackState(for: player, item: item)
                    }
                case .failed:
                    self.registerPlaybackFailure(item.error ?? player.currentItem?.error, fallback: "Couldn't load the stream.")
                case .unknown:
                    if self.wantsPlayback { self.transition(to: .loading) }
                @unknown default:
                    break
                }
            }
        }

        bufferEmptyObserver = item.observe(\.isPlaybackBufferEmpty, options: [.initial, .new]) { [weak self] item, _ in
            Task { @MainActor [weak self] in
                guard let self, self.isCurrentItem(item), self.wantsPlayback else { return }
                if item.isPlaybackBufferEmpty { self.transition(to: .buffering) }
            }
        }

        keepUpObserver = item.observe(\.isPlaybackLikelyToKeepUp, options: [.initial, .new]) { [weak self, weak player] item, _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, self.isCurrentItem(item), self.wantsPlayback else { return }
                if item.isPlaybackLikelyToKeepUp {
                    self.updatePlaybackState(for: player, item: item)
                }
            }
        }

        timeControlObserver = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self, weak player] _, _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, let item = player.currentItem else { return }
                self.updatePlaybackState(for: player, item: item)
            }
        }

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self, weak player] time in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player else { return }
                self.handlePeriodicTick(player: player, seconds: time.seconds)
            }
        }
        timeObserverOwner = player

        stalledObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let currentItem = self.player?.currentItem, currentItem === item else { return }
                self.retryAfterStall(for: currentItem)
            }
        }

        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] notification in
            let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            Task { @MainActor [weak self] in
                guard let self, self.isCurrentItem(item) else { return }
                self.registerPlaybackFailure(error, fallback: "Playback stopped unexpectedly.")
            }
        }

        installEndObserver(for: item)
    }

    private func handlePeriodicTick(player: AVPlayer, seconds: Double) {
        guard seconds.isFinite, pendingStartTime == nil else { return }

        currentTime = max(0, seconds)
        onPlaybackProgress?(currentTime)
        var dur = resolvedDuration(for: player.currentItem)
        if dur <= 0 { dur = PlayerStore.shared.currentTrack?.duration ?? 0 }
        if dur > 0 {
            setDuration(dur)
            progress = min(max(currentTime / dur, 0), 1)
            syncNowPlayingProgressIfNeeded()
            advanceTransitionIfNeeded(position: seconds, duration: dur)
        }

        // Sleep timer: check every tick; handles fade-out + pause reliably
        // even when app is backgrounded while audio plays.
        tickSleepTimer()
    }

    private func startFromPendingPosition(player: AVPlayer, start: TimeInterval) {
        pendingStartTime = nil
        let target = CMTime(seconds: start, preferredTimescale: 600)
        seekGeneration += 1
        let generation = seekGeneration
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak player] _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, self.seekGeneration == generation else { return }
                self.currentTime = start
                if self.wantsPlayback {
                    player.play()
                }
                if let item = player.currentItem {
                    self.updatePlaybackState(for: player, item: item)
                }
                self.syncNowPlayingProgressIfNeeded(force: true)
            }
        }
    }

    private func updatePlaybackState(for player: AVPlayer, item: AVPlayerItem) {
        guard wantsPlayback else {
            if case .failed = playbackState { return }
            transition(to: .paused)
            return
        }

        switch player.timeControlStatus {
        case .playing:
            transition(to: .playing, clearError: true)
        case .waitingToPlayAtSpecifiedRate:
            transition(to: .buffering)
        case .paused:
            transition(to: item.status == .readyToPlay ? .buffering : .loading)
        @unknown default:
            transition(to: .buffering)
        }
    }

    private func isCurrentItem(_ item: AVPlayerItem) -> Bool {
        player?.currentItem === item
    }

    private func retryAfterStall(for item: AVPlayerItem) {
        guard isCurrentItem(item), wantsPlayback else { return }
        transition(to: .buffering)
        guard stallRetryTask == nil else { return }

        guard stallRetryCount < maxStallRetries else {
            registerPlaybackFailure(item.error, fallback: "Playback stalled after two retries.")
            return
        }

        let retryNumber = stallRetryCount
        stallRetryCount += 1
        let delayNanoseconds = UInt64(500_000_000 * (retryNumber + 1))
        stallRetryTask = Task { @MainActor [weak self, weak item] in
            do {
                try await Task.sleep(nanoseconds: delayNanoseconds)
            } catch {
                return
            }

            guard let self, let item, self.isCurrentItem(item), self.wantsPlayback else { return }
            self.stallRetryTask = nil
            self.player?.play()
            self.transition(to: .buffering)
        }
    }

    private func removePlayerObservers() {
        if let timeObserver, let owner = timeObserverOwner {
            owner.removeTimeObserver(timeObserver)
        }
        removeCrossfadeBoundary()
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let stalledObserver { NotificationCenter.default.removeObserver(stalledObserver) }
        if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }
        timeObserver = nil
        timeObserverOwner = nil
        statusObserver = nil
        bufferEmptyObserver = nil
        keepUpObserver = nil
        timeControlObserver = nil
        endObserver = nil
        stalledObserver = nil
        failedObserver = nil
    }

    /// Tears down the main player. The preloaded next item survives unless
    /// it's the one being replaced.
    private func cleanup() {
        stallRetryTask?.cancel()
        stallRetryTask = nil
        pendingStartTime = nil
        cancelCrossfade(keepPreload: false)
        removePlayerObservers()
        player?.pause()
        player = nil
    }

    // MARK: - Next-track preload & crossfade

    /// Tell the player what track comes next so it can preload and crossfade
    /// into it. Pass nil to disable the transition (repeat-one, queue end).
    func setCrossfadeNextURL(_ urlString: String?, loudnessLufs: Double? = nil) {
        let normalized = urlString.map { Self.normalizedPlaybackURLString($0) ?? $0 }
        guard nextURLString != normalized else { return }
        teardownNextPlayer()
        nextURLString = normalized
        nextTrackBaseVolume = normalized == nil ? 1 : Self.normalizationVolume(forLoudness: loudnessLufs)
        installCrossfadeBoundary()
        if let player, let item = player.currentItem {
            // Queue edits near the end must still preload / fade in time.
            let position = player.currentTime().seconds
            let dur = resolvedDuration(for: item)
            if position.isFinite, dur > 0 {
                advanceTransitionIfNeeded(position: position, duration: dur)
            }
        }
    }

    /// Preloads the next item inside the lead window and starts the fade in
    /// the last `crossfadeSec` seconds. Called from the periodic tick and the
    /// boundary observer (which gives the precise start for short bridges).
    private func advanceTransitionIfNeeded(position: TimeInterval, duration dur: TimeInterval) {
        guard crossfadeEnabled, crossfadeSec > 0, nextURLString != nil,
              wantsPlayback, let player, player.rate > 0,
              dur > crossfadeSec * 1.5, position > 0 else { return }
        let remaining = dur - position
        guard remaining > 0 else { return }
        if nextPlayer == nil, remaining <= crossfadeSec + Self.preloadLeadTime {
            preloadNextItem()
        }
        if !crossfadeStarted, remaining <= crossfadeSec + 0.02 {
            startCrossfade(remaining: remaining)
        }
    }

    private func preloadNextItem() {
        guard nextPlayer == nil, let urlString = nextURLString, let url = URL(string: urlString) else { return }
        let item = makePlayerItem(for: url)
        let fadePlayer = AVPlayer(playerItem: item)
        fadePlayer.automaticallyWaitsToMinimizeStalling = true
        fadePlayer.volume = 0
        nextPlayer = fadePlayer
        nextPlayerStatusObserver = item.observe(\.status, options: [.new]) { [weak self, weak fadePlayer] item, _ in
            Task { @MainActor [weak self, weak fadePlayer] in
                guard let self, let fadePlayer, self.nextPlayer === fadePlayer, item.status == .failed else { return }
                // A broken next stream must not eat the tail of this track;
                // the regular track-end path will surface the error.
                self.teardownNextPlayer()
            }
        }
    }

    private func startCrossfade(remaining: TimeInterval) {
        if nextPlayer == nil { preloadNextItem() }
        guard let fadePlayer = nextPlayer else { return }
        crossfadeStarted = true
        crossfadeProgress = 0
        applyVolumes()
        fadePlayer.play()

        let fadeLength = max(0.05, min(remaining, crossfadeSec))
        crossfadeTask?.cancel()
        crossfadeTask = Task { @MainActor [weak self, weak fadePlayer] in
            // Don't fade the outgoing track into silence while the incoming
            // one is still spinning up.
            let waitStarted = Date()
            while let fadePlayer, fadePlayer.timeControlStatus != .playing,
                  Date().timeIntervalSince(waitStarted) < fadeLength {
                try? await Task.sleep(for: .milliseconds(20))
                if Task.isCancelled { return }
            }
            let rampStarted = Date()
            while !Task.isCancelled {
                guard let self, self.crossfadeStarted else { return }
                let elapsed = Date().timeIntervalSince(rampStarted)
                self.crossfadeProgress = min(1, elapsed / fadeLength)
                self.applyVolumes()
                if self.crossfadeProgress >= 1 { return }
                try? await Task.sleep(for: .milliseconds(30))
            }
        }
    }

    /// Stops an in-flight fade and restores the main player's volume. With
    /// `keepPreload` the incoming item is rewound and kept ready.
    private func cancelCrossfade(keepPreload: Bool) {
        crossfadeTask?.cancel()
        crossfadeTask = nil
        if crossfadeStarted {
            crossfadeStarted = false
            crossfadeProgress = 0
            if keepPreload, let fadePlayer = nextPlayer {
                fadePlayer.pause()
                fadePlayer.seek(to: .zero)
            }
        }
        if !keepPreload {
            teardownNextPlayer()
        }
        applyVolumes()
    }

    private func teardownNextPlayer() {
        crossfadeTask?.cancel()
        crossfadeTask = nil
        nextPlayerStatusObserver = nil
        nextPlayer?.pause()
        nextPlayer = nil
        crossfadeStarted = false
        crossfadeProgress = 0
        applyVolumes()
    }

    private func installCrossfadeBoundary() {
        removeCrossfadeBoundary()
        guard crossfadeEnabled, crossfadeSec > 0, nextURLString != nil,
              let player, let item = player.currentItem else { return }
        let dur = resolvedDuration(for: item)
        guard dur > crossfadeSec * 1.5 else { return }
        let fadeAt = max(0, dur - crossfadeSec)
        let preloadAt = max(0, fadeAt - Self.preloadLeadTime)
        let times = [preloadAt, fadeAt].map { NSValue(time: CMTime(seconds: $0, preferredTimescale: 600)) }
        boundaryObserver = player.addBoundaryTimeObserver(forTimes: times, queue: .main) { [weak self, weak player] in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player, let item = player.currentItem else { return }
                let position = player.currentTime().seconds
                let dur = self.resolvedDuration(for: item)
                guard position.isFinite, dur > 0 else { return }
                self.advanceTransitionIfNeeded(position: position, duration: dur)
            }
        }
        boundaryObserverOwner = player
    }

    private func removeCrossfadeBoundary() {
        if let boundaryObserver, let owner = boundaryObserverOwner {
            owner.removeTimeObserver(boundaryObserver)
        }
        boundaryObserver = nil
        boundaryObserverOwner = nil
    }

    private func promoteNextPlayer(trackID: String?, urlString: String) {
        guard let fadePlayer = nextPlayer else { return }
        removePlayerObservers()
        player?.pause()

        crossfadeTask?.cancel()
        crossfadeTask = nil
        nextPlayerStatusObserver = nil

        currentTrackBaseVolume = nextTrackBaseVolume
        nextTrackBaseVolume = 1
        player = fadePlayer
        nextPlayer = nil
        crossfadeStarted = false
        crossfadeProgress = 0
        nextURLString = nil
        currentTrackID = trackID
        currentURLString = urlString
        lastErrorMessage = nil
        pendingStartTime = nil
        wantsPlayback = true
        stallRetryCount = 0
        stallRetryTask?.cancel()
        stallRetryTask = nil
        lastNowPlayingElapsedSecond = -1
        activateAudioSession()
        applyVolumes()

        if let item = fadePlayer.currentItem {
            setDuration(resolvedDuration(for: item))
            let t = fadePlayer.currentTime().seconds
            if t.isFinite, t >= 0 {
                currentTime = t
                progress = duration > 0 ? min(max(t / duration, 0), 1) : 0
            } else {
                currentTime = 0
                progress = 0
            }
            attachObservers(player: fadePlayer, item: item)
            // A preloaded-but-silent item (manual skip) still has to start.
            if fadePlayer.timeControlStatus != .playing { fadePlayer.play() }
            updatePlaybackState(for: fadePlayer, item: item)
            syncNowPlayingProgressIfNeeded(force: true)
        } else {
            registerPlaybackFailure(nil, fallback: "Could not promote the next track.")
        }
    }

    // MARK: - Helpers

    private func resolvedDuration(for item: AVPlayerItem?) -> TimeInterval {
        guard let item else { return 0 }
        let seconds = item.duration.seconds
        return (seconds.isFinite && seconds > 0) ? seconds : 0
    }

    /// Observable setters fire on every assignment; only write real changes
    /// so views reading `duration` don't redraw on every tick.
    private func setDuration(_ value: TimeInterval) {
        if abs(duration - value) > 0.01 { duration = value }
    }

    private static func normalizedPlaybackURLString(_ raw: String) -> String? {
        URLComponents(string: raw)?.string
    }

    private func transition(to state: PlaybackState, clearError: Bool = false) {
        if clearError, lastErrorMessage != nil { lastErrorMessage = nil }
        guard playbackState != state else { return }
        playbackState = state
        syncNowPlayingProgressIfNeeded(force: true)
        onPlaybackStateChange?(state)
    }

    private func registerPlaybackFailure(_ error: Error?, fallback: String) {
        if case .failed = playbackState { return }
        wantsPlayback = false
        stallRetryTask?.cancel()
        stallRetryTask = nil
        pendingStartTime = nil
        cancelCrossfade(keepPreload: true)

        var message = fallback
        if let nsError = error as NSError? {
            if nsError.domain == NSURLErrorDomain {
                switch nsError.code {
                case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost:
                    message = "Server unreachable."
                case NSURLErrorTimedOut:
                    message = "Stream timed out."
                default:
                    break
                }
            }

            let description = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if !description.isEmpty, description != "The operation could not be completed" {
                message = description
            }
        }

        lastErrorMessage = message
        transition(to: .failed(message))
        onPlaybackFailed?()
    }

    // Detect track end.
    func onTrackEnd(_ action: @escaping () -> Void) {
        trackEndAction = action
        if let item = player?.currentItem {
            installEndObserver(for: item)
        }
    }

    private func installEndObserver(for item: AVPlayerItem) {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        guard trackEndAction != nil else { return }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isCurrentItem(item) else { return }
                self.trackEndAction?()
            }
        }
    }

    // MARK: - Now Playing Info Center

    @ObservationIgnored private var nowPlayingTrackID: String?
    @ObservationIgnored private var cachedArtwork: MPMediaItemArtwork?
    @ObservationIgnored private var cachedArtworkURL: String?
    @ObservationIgnored private var artworkLoadTask: Task<Void, Never>?

    func updateNowPlayingInfo(track: Track) {
        nowPlayingTrackID = track.id
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPMediaItemPropertyPlaybackDuration: duration > 0 ? duration : (track.duration ?? 0),
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let album = track.album {
            info[MPMediaItemPropertyAlbumTitle] = album
        }
        if let cached = cachedArtwork, cachedArtworkURL == track.artwork {
            info[MPMediaItemPropertyArtwork] = cached
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        applyNowPlayingPlaybackState()
        lastNowPlayingElapsedSecond = Int(currentTime.rounded(.down))
        lastNowPlayingDuration = duration > 0 ? duration : (track.duration ?? 0)

        guard cachedArtworkURL != track.artwork else { return }
        artworkLoadTask?.cancel()
        guard let artURLString = track.artwork,
              let normalized = Self.normalizedPlaybackURLString(artURLString),
              let url = URL(string: normalized) else { return }
        let trackID = track.id
        artworkLoadTask = Task { @MainActor [weak self] in
            guard let result = try? await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: 1024) else { return }
            // The track may have changed while the image was loading.
            guard let self, !Task.isCancelled, self.nowPlayingTrackID == trackID else { return }
            let artwork = Self.makeNowPlayingArtwork(result.image)
            self.cachedArtwork = artwork
            self.cachedArtworkURL = artURLString
            var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            updated[MPMediaItemPropertyArtwork] = artwork
            MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
        }
    }

    /// Removes lock-screen / Control Center metadata (logout).
    func clearNowPlayingInfo() {
        artworkLoadTask?.cancel()
        artworkLoadTask = nil
        nowPlayingTrackID = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        applyNowPlayingPlaybackState()
    }

    private nonisolated static func makeNowPlayingArtwork(_ image: PlatformImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.platformSize) { _ in image }
    }

    private func applyNowPlayingPlaybackState() {
        #if os(macOS)
        let center = MPNowPlayingInfoCenter.default()
        if center.nowPlayingInfo == nil {
            center.playbackState = .stopped
        } else {
            center.playbackState = isPlaying ? .playing : (playbackState == .idle ? .stopped : .paused)
        }
        #endif
    }

    private func syncNowPlayingProgressIfNeeded(force: Bool = false) {
        guard nowPlayingTrackID != nil else { return }
        let resolvedDuration = duration > 0 ? duration : (PlayerStore.shared.currentTrack?.duration ?? 0)
        let elapsedSecond = Int(currentTime.rounded(.down))
        guard force || elapsedSecond != lastNowPlayingElapsedSecond || abs(resolvedDuration - lastNowPlayingDuration) > 0.5 else {
            return
        }

        lastNowPlayingElapsedSecond = elapsedSecond
        lastNowPlayingDuration = resolvedDuration

        var nowPlaying = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        nowPlaying[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        nowPlaying[MPMediaItemPropertyPlaybackDuration] = resolvedDuration
        nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
        applyNowPlayingPlaybackState()
    }

    // MARK: - Remote commands

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let hook = self.onRemotePlay { hook() } else { self.resume() }
            }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let hook = self.onRemotePause { hook() } else { self.pause() }
            }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let hook = self.onRemoteTogglePlayPause { hook() } else { self.togglePlayPause() }
            }
            return .success
        }

        center.nextTrackCommand.addTarget { [weak self] _ in
            guard self != nil else { return .commandFailed }
            Task { @MainActor [weak self] in self?.onRemoteNext?() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard self != nil else { return .commandFailed }
            Task { @MainActor [weak self] in self?.onRemotePrevious?() }
            return .success
        }

        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard self != nil, let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            let position = event.positionTime
            Task { @MainActor [weak self] in
                guard let self else { return }
                let dur = self.duration > 0 ? self.duration : (PlayerStore.shared.currentTrack?.duration ?? 0)
                guard dur > 0 else { return }
                let fraction = position / dur
                if let hook = self.onRemoteSeek { hook(fraction) } else { self.seek(to: fraction) }
            }
            return .success
        }
    }
}
