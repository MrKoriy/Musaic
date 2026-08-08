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

    private var player: AVPlayer?
    private var currentTrackID: String?
    private var currentURLString: String?
    private var timeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var bufferEmptyObserver: NSKeyValueObservation?
    private var keepUpObserver: NSKeyValueObservation?
    private var timeControlObserver: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var stalledObserver: NSObjectProtocol?
    private var failedObserver: NSObjectProtocol?
    private var trackEndAction: (() -> Void)?
    private var lastNowPlayingElapsedSecond = -1
    private var lastNowPlayingDuration: TimeInterval = 0
    private var wantsPlayback = false

    // Stalls are retried only for the current item. A new track, restart, or
    // explicit resume starts a fresh retry budget.
    private let maxStallRetries = 2
    private var stallRetryCount = 0
    private var stallRetryTask: Task<Void, Never>?

    // Crossfade
    private var crossfadePlayer: AVPlayer?
    private var crossfadePlayerStatusObserver: NSKeyValueObservation?
    private var crossfadeStarted = false
    private var crossfadeNextURLString: String?
    private var crossfadeTimer: Timer?
    // Driven by SettingsStore via applyPlaybackSettings(); 0s ("Off") disables it.
    var crossfadeSec: TimeInterval = 5.0
    var crossfadeEnabled = true

    // State
    private(set) var playbackState: PlaybackState = .idle
    var isPlaying: Bool { playbackState == .playing }
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

    // Sleep timer - checked on each periodic time tick (fires during background audio).
    var sleepDeadline: Date?
    let sleepFadeDuration: TimeInterval = 8.0

    private init() {
        setupAudioSession()
        setupRemoteCommands()
        applyPlaybackSettings()
    }

    /// Re-read Crossfade / Gapless from SettingsStore and apply to the engine.
    /// - Crossfade > 0  -> real crossfade of that length.
    /// - Crossfade Off + Gapless on -> a short 0.4s bridge approximates gapless
    ///   using the existing next-track pre-load (no AVAudioEngine rewrite).
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
            crossfadeSec = 0.4
        } else {
            crossfadeEnabled = false
            crossfadeSec = 0
        }
    }

    private func setupAudioSession() {
        #if os(iOS)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("[AudioPlayer] Audio session error: \(error)")
        }
        #endif
    }

    // MARK: - Playback

    func play(track: Track, restartIfSame: Bool = false) {
        // Prefer local file if downloaded for offline playback.
        if let localURL = DownloadManager.shared.localFileURL(for: track.id) {
            play(trackID: track.id, url: localURL.absoluteString, restartIfSame: restartIfSame)
        } else {
            play(trackID: track.id, url: track.url, restartIfSame: restartIfSame)
        }
    }

    func play(url: String) {
        play(trackID: nil, url: url, restartIfSame: true)
    }

    private func play(trackID: String?, url: String, restartIfSame: Bool) {
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
            if playbackState != .playing {
                resume()
            } else {
                transition(to: .playing, clearError: true)
            }
            return
        }

        // If crossfade already loaded this URL, promote the fade player instead of a cold start.
        if let fadePlayer = crossfadePlayer,
           crossfadeNextURLString == normalizedURL {
            promoteCrossfadePlayer(fadePlayer, trackID: trackID, urlString: normalizedURL)
            return
        }

        setupAudioSession()
        cleanup()
        currentTrackID = trackID
        currentURLString = normalizedURL
        progress = 0
        currentTime = 0
        duration = 0
        lastNowPlayingElapsedSecond = -1
        lastNowPlayingDuration = 0
        wantsPlayback = true
        stallRetryCount = 0
        lastErrorMessage = nil
        transition(to: .loading, clearError: true)

        let item = makePlayerItem(for: audioURL)
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        self.player = player
        attachObservers(player: player, item: item)

        player.play()
    }

    func togglePlayPause() {
        guard let player else { return }
        if player.currentItem?.status == .failed, let currentURLString {
            play(trackID: currentTrackID, url: currentURLString, restartIfSame: true)
            return
        }
        if isPlaying {
            pause()
        } else {
            resume()
        }
    }

    func pause() {
        let wasPlaying = isPlaying || wantsPlayback
        wantsPlayback = false
        stallRetryTask?.cancel()
        stallRetryTask = nil
        player?.pause()
        if player?.currentItem == nil {
            transition(to: .idle)
        } else {
            transition(to: .paused)
        }
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
        setupAudioSession()
        lastErrorMessage = nil
        stallRetryTask?.cancel()
        stallRetryTask = nil
        stallRetryCount = 0
        cancelVolumeFade()
        player.volume = 1.0
        wantsPlayback = true
        transition(to: .loading, clearError: true)
        player.play()
        syncNowPlayingProgressIfNeeded(force: true)
        if !wasPlaying { onPlaybackResumed?() }
    }

    // MARK: - Sleep timer (ticked from the periodic time observer)

    /// Pause both the main and crossfade players immediately (used by sleep timer
    /// to guarantee audio actually stops, even if a crossfade is in progress).
    func pauseAll() {
        let wasPlaying = isPlaying || wantsPlayback
        wantsPlayback = false
        stallRetryTask?.cancel()
        stallRetryTask = nil
        player?.pause()
        crossfadePlayer?.pause()
        crossfadeTimer?.invalidate()
        crossfadeTimer = nil
        crossfadeStarted = false
        if player?.currentItem == nil {
            transition(to: .idle)
        } else {
            transition(to: .paused)
        }
        syncNowPlayingProgressIfNeeded(force: true)
        if wasPlaying { onPlaybackPaused?() }
    }

    /// Reset any sleep-timer-induced volume fade.
    func cancelVolumeFade() {
        player?.volume = 1.0
        crossfadePlayer?.volume = 1.0
    }

    private func tickSleepTimer() {
        guard let deadline = sleepDeadline else { return }
        let remaining = deadline.timeIntervalSinceNow

        if remaining <= 0 {
            pauseAll()
            player?.volume = 1.0
            crossfadePlayer?.volume = 1.0
            sleepDeadline = nil
            // Mirror the cleared state on the PlayerStore so the UI refreshes.
            Task { @MainActor in
                PlayerStore.shared.clearSleepTimer(silent: true)
            }
            return
        }

        if remaining <= sleepFadeDuration {
            let factor = max(0, min(1, remaining / sleepFadeDuration))
            player?.volume = Float(factor)
            crossfadePlayer?.volume = Float(factor)
        } else {
            // Keep volume at unity outside the fade window in case user re-armed.
            if let p = player, p.volume < 0.999 { p.volume = 1.0 }
            if let cp = crossfadePlayer, cp.volume < 0.999 { cp.volume = 1.0 }
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
        progress = 0
        currentTime = 0
        transition(to: shouldPlay ? .buffering : .paused)

        let target = CMTime(seconds: 0, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak player] _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player, self.player === player else { return }
                if self.wantsPlayback {
                    player.play()
                    self.transition(to: .loading)
                } else {
                    self.transition(to: .paused)
                }
                self.lastNowPlayingElapsedSecond = -1
                self.syncNowPlayingProgressIfNeeded(force: true)
            }
        }
    }

    func seek(to fraction: Double) {
        guard let player else { return }
        guard fraction.isFinite, !fraction.isNaN else { return }
        let safeFraction = max(0, min(1, fraction))

        // Resolve duration: AVPlayer -> item -> track metadata.
        var dur = duration
        if dur <= 0 { dur = resolvedDuration(for: player.currentItem) }
        if dur <= 0 { dur = PlayerStore.shared.currentTrack?.duration ?? 0 }
        guard dur > 0 else { return }

        let targetSeconds = safeFraction * dur

        // Update UI immediately.
        progress = safeFraction
        currentTime = targetSeconds
        if dur > duration { duration = dur }

        let target = CMTime(seconds: targetSeconds, preferredTimescale: 600)
        player.seek(to: target)
        lastNowPlayingElapsedSecond = -1
        syncNowPlayingProgressIfNeeded(force: true)
    }

    func stop() {
        cleanup()
        currentTrackID = nil
        currentURLString = nil
        wantsPlayback = false
        progress = 0
        currentTime = 0
        duration = 0
        lastNowPlayingElapsedSecond = -1
        lastNowPlayingDuration = 0
        lastErrorMessage = nil
        transition(to: .idle, clearError: true)
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
        // including preloaded crossfade items.
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
                    self.duration = self.resolvedDuration(for: item)
                    self.updatePlaybackState(for: player, item: item)
                    if item.status == .readyToPlay { self.lastErrorMessage = nil }
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
                let seconds = time.seconds
                guard seconds.isFinite else { return }

                self.currentTime = max(0, seconds)
                self.onPlaybackProgress?(self.currentTime)
                var dur = self.resolvedDuration(for: player.currentItem)
                if dur <= 0 { dur = PlayerStore.shared.currentTrack?.duration ?? 0 }
                if dur > 0 {
                    self.duration = dur
                    self.progress = min(max(self.currentTime / dur, 0), 1)
                    self.syncNowPlayingProgressIfNeeded()
                }

                // Crossfade: pre-load next track when approaching end.
                if self.crossfadeEnabled,
                   !self.crossfadeStarted,
                   let nextURLStr = self.crossfadeNextURLString,
                   dur > self.crossfadeSec * 1.5,
                   seconds > 0 {
                    let remaining = dur - seconds
                    if remaining > 0, remaining <= self.crossfadeSec {
                        self.crossfadeStarted = true
                        self.beginCrossfade(to: nextURLStr, over: remaining)
                    }
                }

                // Sleep timer: check every tick; handles fade-out + pause reliably
                // even when app is backgrounded while audio plays.
                self.tickSleepTimer()
            }
        }

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
        if let timeObserver, let player {
            player.removeTimeObserver(timeObserver)
        }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let stalledObserver { NotificationCenter.default.removeObserver(stalledObserver) }
        if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }
        timeObserver = nil
        statusObserver = nil
        bufferEmptyObserver = nil
        keepUpObserver = nil
        timeControlObserver = nil
        endObserver = nil
        stalledObserver = nil
        failedObserver = nil
    }

    private func cleanup() {
        stallRetryTask?.cancel()
        stallRetryTask = nil
        removePlayerObservers()
        player?.pause()
        player = nil
        trackEndAction = nil
        cleanupCrossfade()
    }

    private func cleanupCrossfade() {
        crossfadeTimer?.invalidate()
        crossfadeTimer = nil
        crossfadePlayerStatusObserver = nil
        crossfadePlayer?.pause()
        crossfadePlayer = nil
        crossfadeStarted = false
        crossfadeNextURLString = nil
    }

    // MARK: - Crossfade

    /// Tell the player what track comes next so it can crossfade into it.
    func setCrossfadeNextURL(_ urlString: String?) {
        guard crossfadeNextURLString != urlString else { return }
        cleanupCrossfade()
        crossfadeNextURLString = urlString
    }

    private func beginCrossfade(to urlString: String, over remaining: TimeInterval) {
        let normalized = Self.normalizedPlaybackURLString(urlString) ?? urlString
        guard let url = URL(string: normalized) else { return }

        let item = makePlayerItem(for: url)
        let fadePlayer = AVPlayer(playerItem: item)
        fadePlayer.volume = 0
        crossfadePlayer = fadePlayer

        // Wait until the fade player is ready before starting the volume ramp.
        // Re-derive the remaining time at ready-to-play so buffering does not
        // make the ramp use a stale duration.
        crossfadePlayerStatusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self, weak fadePlayer] item, _ in
            Task { @MainActor [weak self, weak fadePlayer] in
                guard let self, let fadePlayer, self.crossfadePlayer === fadePlayer else { return }
                guard item.status == .readyToPlay else { return }
                self.crossfadePlayerStatusObserver = nil
                fadePlayer.play()

                let liveRemaining: TimeInterval
                if let outgoing = self.player, let outgoingItem = outgoing.currentItem {
                    let dur = self.resolvedDuration(for: outgoingItem)
                    let pos = outgoing.currentTime().seconds
                    if dur > 0, pos.isFinite, pos >= 0 {
                        liveRemaining = max(0.5, dur - pos)
                    } else {
                        liveRemaining = remaining
                    }
                } else {
                    liveRemaining = remaining
                }
                self.rampCrossfadeVolumes(fadePlayer: fadePlayer, over: min(liveRemaining, self.crossfadeSec))
            }
        }

        fadePlayer.play() // Start buffering immediately, even before readyToPlay.
    }

    private func rampCrossfadeVolumes(fadePlayer: AVPlayer, over duration: TimeInterval) {
        guard duration > 0 else {
            player?.volume = 0
            fadePlayer.volume = 1
            return
        }

        let fps: TimeInterval = 30
        let totalSteps = max(1, Int(duration * fps))
        let stepInterval = duration / Double(totalSteps)
        let startTime = Date()

        crossfadeTimer?.invalidate()
        let timer = Timer(timeInterval: stepInterval, repeats: true) { [weak self, weak fadePlayer] timer in
            guard self != nil, fadePlayer != nil else {
                timer.invalidate()
                return
            }
            let elapsed = Date().timeIntervalSince(startTime)
            let fadeProgress = min(Float(elapsed / duration), 1.0)
            Task { @MainActor [weak self, weak fadePlayer] in
                guard let self, let fadePlayer else { return }
                self.player?.volume = 1.0 - fadeProgress
                fadePlayer.volume = fadeProgress

                if fadeProgress >= 1.0 {
                    self.crossfadeTimer?.invalidate()
                    self.crossfadeTimer = nil
                    self.player?.volume = 0
                }
            }
        }
        crossfadeTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func promoteCrossfadePlayer(_ fadePlayer: AVPlayer, trackID: String?, urlString: String) {
        removePlayerObservers()
        player?.pause()

        crossfadeTimer?.invalidate()
        crossfadeTimer = nil
        crossfadePlayerStatusObserver = nil

        fadePlayer.volume = 1.0
        player = fadePlayer
        crossfadePlayer = nil
        crossfadeStarted = false
        crossfadeNextURLString = nil
        currentTrackID = trackID
        currentURLString = urlString
        lastErrorMessage = nil
        wantsPlayback = true
        stallRetryCount = 0

        if let item = fadePlayer.currentItem {
            let d = resolvedDuration(for: item)
            if d > 0 { duration = d }
            let t = fadePlayer.currentTime().seconds
            if t.isFinite, t >= 0 {
                currentTime = t
                if duration > 0 { progress = min(max(t / duration, 0), 1) }
            }
            attachObservers(player: fadePlayer, item: item)
            updatePlaybackState(for: fadePlayer, item: item)
        } else {
            registerPlaybackFailure(nil, fallback: "Could not promote crossfade player.")
        }
    }

    private func resolvedDuration(for item: AVPlayerItem?) -> TimeInterval {
        guard let item else { return 0 }
        let seconds = item.duration.seconds
        return (seconds.isFinite && seconds > 0) ? seconds : 0
    }

    private static func normalizedPlaybackURLString(_ raw: String) -> String? {
        URLComponents(string: raw)?.string
    }

    private func transition(to state: PlaybackState, clearError: Bool = false) {
        playbackState = state
        if clearError { lastErrorMessage = nil }
        syncNowPlayingProgressIfNeeded(force: true)
    }

    private func registerPlaybackFailure(_ error: Error?, fallback: String) {
        if case .failed = playbackState { return }
        wantsPlayback = false
        stallRetryTask?.cancel()
        stallRetryTask = nil

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

    private var cachedArtwork: MPMediaItemArtwork?
    private var cachedArtworkURL: String?

    func updateNowPlayingInfo(track: Track) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPMediaItemPropertyPlaybackDuration: duration > 0 ? duration : (track.duration ?? 0),
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        if let album = track.album {
            info[MPMediaItemPropertyAlbumTitle] = album
        }

        if let cached = cachedArtwork, cachedArtworkURL == track.artwork {
            info[MPMediaItemPropertyArtwork] = cached
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        lastNowPlayingElapsedSecond = Int(currentTime.rounded(.down))
        lastNowPlayingDuration = duration > 0 ? duration : (track.duration ?? 0)

        // Load artwork asynchronously if needed.
        let artURLString = track.artwork ?? ""
        let trackTitle = track.title
        let trackArtist = track.artist
        let trackAlbum = track.album
        let trackDuration = track.duration
        if cachedArtworkURL != artURLString,
           let artURL = Self.normalizedPlaybackURLString(artURLString),
           let url = URL(string: artURL) {
            Task { @MainActor [weak self] in
                if let result = try? await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: 1024) {
                    guard let self else { return }
                    let image = result.image
                    let artwork = Self.makeNowPlayingArtwork(image)
                    self.cachedArtwork = artwork
                    self.cachedArtworkURL = artURLString
                    var updatedInfo: [String: Any] = [
                        MPMediaItemPropertyTitle: trackTitle,
                        MPMediaItemPropertyArtist: trackArtist,
                        MPNowPlayingInfoPropertyElapsedPlaybackTime: self.currentTime,
                        MPMediaItemPropertyPlaybackDuration: self.duration > 0 ? self.duration : (trackDuration ?? 0),
                        MPNowPlayingInfoPropertyPlaybackRate: self.isPlaying ? 1.0 : 0.0,
                        MPMediaItemPropertyArtwork: artwork,
                    ]
                    if let album = trackAlbum { updatedInfo[MPMediaItemPropertyAlbumTitle] = album }
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = updatedInfo
                }
            }
        }
    }

    private nonisolated static func makeNowPlayingArtwork(_ image: PlatformImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.platformSize) { _ in image }
    }

    private func syncNowPlayingProgressIfNeeded(force: Bool = false) {
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
    }

    // Callbacks for skip next/previous and playback events - set by PlayerStore.
    var onRemoteNext: (@MainActor () -> Void)?
    var onRemotePrevious: (@MainActor () -> Void)?
    var onPlaybackProgress: (@MainActor (TimeInterval) -> Void)?
    var onPlaybackPaused: (@MainActor () -> Void)?
    var onPlaybackResumed: (@MainActor () -> Void)?
    var onPlaybackFailed: (@MainActor () -> Void)?

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in self?.togglePlayPause() }
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
                self.seek(to: position / dur)
            }
            return .success
        }
    }
}
