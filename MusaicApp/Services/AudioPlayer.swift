import AVFoundation
import MediaPlayer

// MARK: - Audio Player

@Observable
final class AudioPlayer: @unchecked Sendable {
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
    private var lastNowPlayingElapsedSecond = -1
    private var lastNowPlayingDuration: TimeInterval = 0
    private var wantsPlayback = false

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
    var isPlaying = false
    var progress: Double = 0  // 0...1
    var currentTime: TimeInterval = 0
    var duration: TimeInterval = 0
    var isBuffering = false
    var lastErrorMessage: String?

    // Sleep timer — checked on each periodic time tick (fires during background audio).
    var sleepDeadline: Date?
    let sleepFadeDuration: TimeInterval = 8.0
    // no isSeeking flag — SeekBar handles its own drag state

    private init() {
        setupAudioSession()
        setupRemoteCommands()
        applyPlaybackSettings()
    }

    /// Re-read Crossfade / Gapless from SettingsStore and apply to the engine.
    /// - Crossfade > 0  → real crossfade of that length.
    /// - Crossfade Off + Gapless on → a short 0.4s bridge approximates gapless
    ///   using the existing next-track pre-load (no AVAudioEngine rewrite).
    /// - Crossfade Off + Gapless off → hard cut between tracks.
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
        // Prefer local file if downloaded for offline playback
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
            if !isPlaying {
                resume()
            } else {
                isBuffering = false
                lastErrorMessage = nil
            }
            return
        }

        // If crossfade already loaded this URL, promote the fade player instead of a cold start
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
        isPlaying = true
        isBuffering = true

        lastErrorMessage = nil

        let item = AVPlayerItem(url: audioURL)
        item.preferredForwardBufferDuration = 8

        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        self.player = player

        statusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                switch item.status {
                case .readyToPlay:
                    self.duration = self.resolvedDuration(for: item)
                    self.isBuffering = false
                    self.lastErrorMessage = nil
                case .failed:
                    self.registerPlaybackFailure(item.error ?? player.currentItem?.error, fallback: "Couldn't load the stream.")
                case .unknown:
                    self.isBuffering = true
                @unknown default:
                    break
                }
            }
        }

        bufferEmptyObserver = item.observe(\.isPlaybackBufferEmpty, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if item.isPlaybackBufferEmpty {
                    self.isBuffering = true
                }
            }
        }

        keepUpObserver = item.observe(\.isPlaybackLikelyToKeepUp, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if item.isPlaybackLikelyToKeepUp {
                    self.isBuffering = false
                }
            }
        }

        timeControlObserver = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                switch player.timeControlStatus {
                case .paused:
                    self.isPlaying = self.wantsPlayback
                case .waitingToPlayAtSpecifiedRate:
                    self.isPlaying = self.wantsPlayback
                    self.isBuffering = true
                case .playing:
                    self.wantsPlayback = true
                    self.isPlaying = true
                    self.isBuffering = false
                    self.lastErrorMessage = nil
                @unknown default:
                    break
                }
            }
        }

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }

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

            // Crossfade: pre-load next track when approaching end
            if self.crossfadeEnabled,
               !self.crossfadeStarted,
               let nextURLStr = self.crossfadeNextURLString,
               dur > self.crossfadeSec * 1.5,
               seconds.isFinite, seconds > 0 {
                let remaining = dur - seconds
                if remaining > 0, remaining <= self.crossfadeSec {
                    self.crossfadeStarted = true
                    self.beginCrossfade(to: nextURLStr, over: remaining)
                }
            }

            // Sleep timer: check every tick (0.25s); handles fade-out + pause reliably
            // even when app is backgrounded while audio plays.
            self.tickSleepTimer()
        }

        stalledObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled,
            object: item,
            queue: .main
        ) { [weak self] _ in
            self?.isBuffering = true
        }

        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] notification in
            let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self?.registerPlaybackFailure(error, fallback: "Playback stopped unexpectedly.")
        }

        player.play()
        isPlaying = true
    }

    func togglePlayPause() {
        guard let player else { return }
        if player.currentItem?.status == .failed, let currentURLString {
            play(url: currentURLString)
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
        player?.pause()
        isPlaying = false
        isBuffering = false
        syncNowPlayingProgressIfNeeded(force: true)
        if wasPlaying { onPlaybackPaused?() }
    }

    func resume() {
        guard let player else { return }
        if player.currentItem?.status == .failed, let currentURLString {
            play(url: currentURLString)
            return
        }
        let wasPlaying = isPlaying || wantsPlayback
        setupAudioSession()
        lastErrorMessage = nil
        cancelVolumeFade()
        player.volume = 1.0
        wantsPlayback = true
        player.play()
        isPlaying = true
        if currentTime == 0 {
            isBuffering = true
        }
        syncNowPlayingProgressIfNeeded(force: true)
        if !wasPlaying { onPlaybackResumed?() }
    }

    // MARK: - Sleep timer (ticked from the periodic time observer)

    /// Pause both the main and crossfade players immediately (used by sleep timer
    /// to guarantee audio actually stops, even if a crossfade is in progress).
    func pauseAll() {
        let wasPlaying = isPlaying || wantsPlayback
        wantsPlayback = false
        player?.pause()
        crossfadePlayer?.pause()
        crossfadeTimer?.invalidate()
        crossfadeTimer = nil
        crossfadeStarted = false
        isPlaying = false
        isBuffering = false
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
            play(url: currentURLString)
            return
        }

        progress = 0
        currentTime = 0
        isBuffering = false
        let target = CMTime(seconds: 0, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            guard let self else { return }
            if self.isPlaying {
                player.play()
            }
            self.lastNowPlayingElapsedSecond = -1
            self.syncNowPlayingProgressIfNeeded(force: true)
        }
    }

    func seek(to fraction: Double) {
        guard let player else { return }
        guard fraction.isFinite, !fraction.isNaN else { return }
        let safeFraction = max(0, min(1, fraction))

        // Resolve duration: AVPlayer → item → track metadata
        var dur = duration
        if dur <= 0 { dur = self.resolvedDuration(for: player.currentItem) }
        if dur <= 0 { dur = PlayerStore.shared.currentTrack?.duration ?? 0 }
        let resolvedDuration = dur
        guard resolvedDuration > 0 else { return }

        let targetSeconds = safeFraction * resolvedDuration

        // Update UI immediately
        progress = safeFraction
        currentTime = targetSeconds
        if resolvedDuration > self.duration { self.duration = resolvedDuration }

        let target = CMTime(seconds: targetSeconds, preferredTimescale: 600)
        player.seek(to: target)
        lastNowPlayingElapsedSecond = -1
        syncNowPlayingProgressIfNeeded(force: true)
    }

    /// Fallback: recreate AVPlayerItem and seek after load
    private func seekByReload(url: String, to targetSeconds: Double, duration: Double) {
        guard let audioURL = URL(string: url) else { return }

        // Pause and remove observers
        player?.pause()
        if let t = timeObserver, let p = player { p.removeTimeObserver(t) }
        timeObserver = nil
        statusObserver = nil
        timeControlObserver = nil
        bufferEmptyObserver = nil
        keepUpObserver = nil

        // Create fresh item
        let item = AVPlayerItem(url: audioURL)
        item.preferredForwardBufferDuration = 8
        let newPlayer = AVPlayer(playerItem: item)
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        self.player = newPlayer

        let target = CMTime(seconds: targetSeconds, preferredTimescale: 600)

        statusObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .readyToPlay else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.statusObserver = nil
                newPlayer.seek(to: target) { _ in
                    newPlayer.play()
                }
                self.duration = duration
                self.isBuffering = false
                self.reattachObservers(player: newPlayer, item: item)
            }
        }
    }

    /// Re-attach time/status/buffer/end observers after player recreation
    /// (e.g. after a crossfade promote). Mirrors the full set wired up in `play()`,
    /// so buffering, stall, and failure UI continue to work for the new track.
    private func reattachObservers(player: AVPlayer, item: AVPlayerItem) {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
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

            // Crossfade pre-load applies to the promoted track too — keep the
            // chain going so we crossfade into whatever comes after this one.
            if self.crossfadeEnabled,
               !self.crossfadeStarted,
               let nextURLStr = self.crossfadeNextURLString,
               dur > self.crossfadeSec * 1.5,
               seconds.isFinite, seconds > 0 {
                let remaining = dur - seconds
                if remaining > 0, remaining <= self.crossfadeSec {
                    self.crossfadeStarted = true
                    self.beginCrossfade(to: nextURLStr, over: remaining)
                }
            }

            self.tickSleepTimer()
        }

        statusObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if item.status == .failed {
                    self.registerPlaybackFailure(item.error ?? player.currentItem?.error, fallback: "Playback failed")
                }
            }
        }

        bufferEmptyObserver = item.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if item.isPlaybackBufferEmpty { self.isBuffering = true }
            }
        }

        keepUpObserver = item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if item.isPlaybackLikelyToKeepUp { self.isBuffering = false }
            }
        }

        timeControlObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                switch p.timeControlStatus {
                case .paused:
                    self.isPlaying = self.wantsPlayback
                case .waitingToPlayAtSpecifiedRate:
                    self.isPlaying = self.wantsPlayback
                    self.isBuffering = true
                case .playing:
                    self.wantsPlayback = true
                    self.isPlaying = true
                    self.isBuffering = false
                    self.lastErrorMessage = nil
                @unknown default:
                    break
                }
            }
        }

        if let stalledObserver { NotificationCenter.default.removeObserver(stalledObserver) }
        stalledObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled,
            object: item,
            queue: .main
        ) { [weak self] _ in self?.isBuffering = true }

        if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }
        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] notification in
            let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self?.registerPlaybackFailure(error, fallback: "Playback stopped unexpectedly.")
        }

        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { _ in PlayerStore.shared.skipNext() }

        if let track = PlayerStore.shared.currentTrack { updateNowPlayingInfo(track: track) }
    }

    func stop() {
        cleanup()
        currentTrackID = nil
        currentURLString = nil
        wantsPlayback = false
        isPlaying = false
        progress = 0
        currentTime = 0
        duration = 0
        isBuffering = false
        lastNowPlayingElapsedSecond = -1
        lastNowPlayingDuration = 0

        lastErrorMessage = nil
    }

    private func cleanup() {
        if let timeObserver, let player {
            player.removeTimeObserver(timeObserver)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        if let stalledObserver {
            NotificationCenter.default.removeObserver(stalledObserver)
        }
        if let failedObserver {
            NotificationCenter.default.removeObserver(failedObserver)
        }
        timeObserver = nil
        statusObserver = nil
        bufferEmptyObserver = nil
        keepUpObserver = nil
        timeControlObserver = nil
        endObserver = nil
        stalledObserver = nil
        failedObserver = nil
        player?.pause()
        player = nil
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

        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 8
        let fadePlayer = AVPlayer(playerItem: item)
        fadePlayer.volume = 0
        crossfadePlayer = fadePlayer

        // Wait until the fade player is ready before starting volume ramp.
        // Re-derive the actual remaining time at ready-to-play — buffering can take
        // 1-3s, and we don't want to ramp over a stale (longer) interval.
        crossfadePlayerStatusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self, weak fadePlayer] item, _ in
            guard item.status == .readyToPlay, let self, let fadePlayer else { return }
            DispatchQueue.main.async {
                self.crossfadePlayerStatusObserver = nil
                fadePlayer.play()

                // Recompute remaining from the live player position so the ramp
                // duration matches what's actually left of the outgoing track.
                let liveRemaining: TimeInterval
                if let outgoing = self.player,
                   let outgoingItem = outgoing.currentItem {
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

        fadePlayer.play() // start buffering immediately even before readyToPlay
    }

    private func rampCrossfadeVolumes(fadePlayer: AVPlayer, over duration: TimeInterval) {
        let fps: TimeInterval = 30
        let totalSteps = max(1, Int(duration * fps))
        let stepInterval = duration / Double(totalSteps)
        let startTime = Date()

        crossfadeTimer?.invalidate()
        crossfadeTimer = Timer.scheduledTimer(withTimeInterval: stepInterval, repeats: true) { [weak self, weak fadePlayer] timer in
            guard let self, let fadePlayer else { timer.invalidate(); return }
            let elapsed = Date().timeIntervalSince(startTime)
            let progress = min(Float(elapsed / duration), 1.0)
            self.player?.volume = 1.0 - progress
            fadePlayer.volume = progress

            if progress >= 1.0 {
                timer.invalidate()
                self.crossfadeTimer = nil
                self.player?.volume = 0
            }
        }
        RunLoop.main.add(crossfadeTimer!, forMode: .common)
    }

    private func promoteCrossfadePlayer(_ fadePlayer: AVPlayer, trackID: String?, urlString: String) {
        // Detach time observer from old player
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let stalledObserver { NotificationCenter.default.removeObserver(stalledObserver) }
        if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }
        timeObserver = nil; statusObserver = nil; bufferEmptyObserver = nil
        keepUpObserver = nil; timeControlObserver = nil
        endObserver = nil; stalledObserver = nil; failedObserver = nil
        player?.pause()

        crossfadeTimer?.invalidate(); crossfadeTimer = nil
        crossfadePlayerStatusObserver = nil

        // Promote
        fadePlayer.volume = 1.0
        player = fadePlayer
        crossfadePlayer = nil
        crossfadeStarted = false
        crossfadeNextURLString = nil
        currentTrackID = trackID
        currentURLString = urlString
        lastErrorMessage = nil
        wantsPlayback = true

        if let item = fadePlayer.currentItem {
            let d = resolvedDuration(for: item)
            if d > 0 { duration = d }
            let t = fadePlayer.currentTime().seconds
            if t.isFinite, t >= 0 {
                currentTime = t
                if duration > 0 { progress = min(max(t / duration, 0), 1) }
            }
        }

        isPlaying = true
        isBuffering = fadePlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate

        // Promote should always have a currentItem, but if it's somehow missing
        // we'd rather skip reattach than crash on a bad URL.
        if let liveItem = fadePlayer.currentItem {
            reattachObservers(player: fadePlayer, item: liveItem)
        } else if let fallbackURL = URL(string: urlString) {
            let fallbackItem = AVPlayerItem(url: fallbackURL)
            reattachObservers(player: fadePlayer, item: fallbackItem)
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
        guard var components = URLComponents(string: raw) else { return nil }

        let host = components.host ?? ""
        let isIPHost = host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
        let shouldDowngradeToHTTP = components.scheme == "https" && components.port == 3001 && (host == "localhost" || host == "127.0.0.1" || isIPHost)

        if shouldDowngradeToHTTP {
            components.scheme = "http"
        }

        return components.string
    }

    private func registerPlaybackFailure(_ error: Error?, fallback: String) {
        wantsPlayback = false
        isPlaying = false
        isBuffering = false
        lastErrorMessage = fallback
        onPlaybackFailed?()

        if let nsError = error as NSError? {
            if nsError.domain == NSURLErrorDomain {
                switch nsError.code {
                case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost:
                    lastErrorMessage = "Server unreachable."
                    return
                case NSURLErrorTimedOut:
                    lastErrorMessage = "Stream timed out."
                    return
                default:
                    break
                }
            }

            let description = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if !description.isEmpty, description != "The operation could not be completed" {
                lastErrorMessage = description
            }
        }
    }

    // Detect track end
    func onTrackEnd(_ action: @Sendable @escaping () -> Void) {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player?.currentItem,
            queue: .main
        ) { _ in action() }
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

        // Reuse cached artwork if URL hasn't changed
        if let cached = cachedArtwork, cachedArtworkURL == track.artwork {
            info[MPMediaItemPropertyArtwork] = cached
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        lastNowPlayingElapsedSecond = Int(currentTime.rounded(.down))
        lastNowPlayingDuration = duration > 0 ? duration : (track.duration ?? 0)

        // Load artwork async if needed
        let artURLString = track.artwork ?? ""
        let trackTitle = track.title
        let trackArtist = track.artist
        let trackAlbum = track.album
        let trackDuration = track.duration
        if cachedArtworkURL != artURLString,
           let artUrl = Self.normalizedPlaybackURLString(artURLString),
           let url = URL(string: artUrl) {
            Task { [weak self] in
                if let result = try? await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: 1024) {
                    let image = result.image
                    let artwork = MPMediaItemArtwork(boundsSize: image.platformSize) { _ in image }
                    await MainActor.run {
                        guard let self else { return }
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

    // Callbacks for skip next/previous — set by PlayerStore
    var onRemoteNext: (() -> Void)?
    var onRemotePrevious: (() -> Void)?
    var onPlaybackProgress: ((TimeInterval) -> Void)?
    var onPlaybackPaused: (() -> Void)?
    var onPlaybackResumed: (() -> Void)?
    var onPlaybackFailed: (() -> Void)?

    // MARK: - Debug

    func debugSeek(to target: CMTime, completion: @Sendable @escaping (Bool, Double) -> Void) {
        guard let player else { completion(false, -1); return }
        let beforeTime = player.currentTime().seconds
        NSLog("[SeekDebug] before=\(beforeTime) target=\(target.seconds) itemStatus=\(player.currentItem?.status.rawValue ?? -1)")
        NSLog("[SeekDebug] seekableRanges=\(player.currentItem?.seekableTimeRanges.map { $0.timeRangeValue } ?? [])")
        NSLog("[SeekDebug] loadedRanges=\(player.currentItem?.loadedTimeRanges.map { $0.timeRangeValue } ?? [])")

        player.seek(to: target, toleranceBefore: .positiveInfinity, toleranceAfter: .positiveInfinity) { finished in
            let afterTime = player.currentTime().seconds
            NSLog("[SeekDebug] DONE finished=\(finished) afterTime=\(afterTime)")
            completion(finished, afterTime)
        }
    }

    func debugGetRanges(completion: @Sendable @escaping (String, String, String) -> Void) {
        guard let item = player?.currentItem else {
            completion("no item", "no item", "no item")
            return
        }

        let seekable = item.seekableTimeRanges.map { r in
            let v = r.timeRangeValue
            return "\(String(format: "%.1f", v.start.seconds))-\(String(format: "%.1f", (v.start + v.duration).seconds))"
        }.joined(separator: ", ")

        let loaded = item.loadedTimeRanges.map { r in
            let v = r.timeRangeValue
            return "\(String(format: "%.1f", v.start.seconds))-\(String(format: "%.1f", (v.start + v.duration).seconds))"
        }.joined(separator: ", ")

        let status: String
        switch item.status {
        case .unknown: status = "unknown"
        case .readyToPlay: status = "ready"
        case .failed: status = "FAILED: \(item.error?.localizedDescription ?? "?")"
        @unknown default: status = "other"
        }

        completion(seekable.isEmpty ? "(empty)" : seekable, loaded.isEmpty ? "(empty)" : loaded, status)
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.resume()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.togglePlayPause()
            return .success
        }

        // Skip next/previous — required for Lock Screen & Control Center buttons
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self, let handler = self.onRemoteNext else { return .commandFailed }
            handler()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self, let handler = self.onRemotePrevious else { return .commandFailed }
            handler()
            return .success
        }

        // Seek via Lock Screen scrubber
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            var dur = self.duration
            if dur <= 0 { dur = PlayerStore.shared.currentTrack?.duration ?? 0 }
            guard dur > 0 else { return .commandFailed }
            let fraction = e.positionTime / dur
            self.seek(to: fraction)
            return .success
        }
    }
}
