#if os(iOS)
import Foundation
import WatchConnectivity

/// A control command from the watch, extracted before hopping actors.
private struct WatchCommand: Sendable {
    let name: String
    let value: Double?
    let issuedAt: Double?
}

/// Phone side of the watch remote: receives control commands (live messages
/// and queued `transferUserInfo`), and pushes playback state, artwork and the
/// current lyric line to the watch.
@MainActor
final class WatchControlHandler: NSObject, WCSessionDelegate {
    static let shared = WatchControlHandler()

    // Computed so creating this singleton never re-enters PlayerStore.init.
    private var player: PlayerStore { PlayerStore.shared }

    /// Queued commands older than this are ignored (a "next" from an hour ago
    /// must not fire when the phone app wakes up).
    private let queuedCommandMaxAge: TimeInterval = 60

    private var lastArtworkSentTrackID: String?
    private var lastProgressPushAt = Date.distantPast
    private var lastVolumePushAt = Date.distantPast

    // Current lyric line relay (only while the watch app is reachable).
    private var lyricsTrack: Track?
    private var lyricsTimeline: LyricsTimeline?
    private var lyricsOffset: Double = 0
    private var lyricsTask: Task<Void, Never>?
    private var lastSentLyricIndex: Int?

    private override init() {
        super.init()
    }

    /// Called from `MusaicApp.init`, i.e. on every launch — including silent
    /// background launches for widget / Live Activity intents.
    func activate() {
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
        // Create the player now so its intent and remote-command hooks exist
        // even when no UI scene is built (background intent launch).
        _ = player
    }

    /// The session when a paired watch has the app installed, else nil.
    private var watchSession: WCSession? {
        guard WCSession.isSupported() else { return nil }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return nil }
        return session
    }

    // MARK: - WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        Task { @MainActor in
            PlayerStore.shared.republishNowPlaying()
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            self.reachabilityChanged(reachable)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let command = Self.parseCommand(message) else { return }
        Task { @MainActor in self.handle(command, queued: false) }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        replyHandler([:])
        guard let command = Self.parseCommand(message) else { return }
        Task { @MainActor in self.handle(command, queued: false) }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let command = Self.parseCommand(userInfo) else { return }
        Task { @MainActor in self.handle(command, queued: true) }
    }

    // MARK: - Commands

    private nonisolated static func parseCommand(_ message: [String: Any]) -> WatchCommand? {
        guard let name = message["musaic"] as? String else { return nil }
        return WatchCommand(
            name: name,
            value: message["value"] as? Double,
            issuedAt: message["ts"] as? Double
        )
    }

    private func handle(_ command: WatchCommand, queued: Bool) {
        if queued, let issuedAt = command.issuedAt,
           Date().timeIntervalSince1970 - issuedAt > queuedCommandMaxAge,
           command.name != "like" {
            return
        }
        switch command.name {
        case "sync":
            lastArtworkSentTrackID = nil
            player.republishNowPlaying()
            sendLyricLineIfNeeded(force: true)
        default:
            player.perform(remoteCommand: command.name, value: command.value)
        }
    }

    // MARK: - Push state to the watch

    func pushState(_ snapshot: NowPlayingSnapshot, liked: Bool, artwork: Data?, volume: Float) {
        guard let session = watchSession, let data = try? JSONEncoder().encode(snapshot) else { return }
        var context: [String: Any] = [
            "snapshot": data,
            "liked": liked,
            "volume": Double(volume),
            "lyric": currentLyricText ?? "",
        ]
        // The application context is the only thing a relaunched watch app
        // sees, so it always carries the (small) artwork.
        if let artwork, artwork.count <= 48_000 {
            context["artwork"] = artwork
        }
        try? session.updateApplicationContext(context)

        guard session.isReachable else { return }
        var live = context
        if lastArtworkSentTrackID == snapshot.trackId {
            live.removeValue(forKey: "artwork")
        } else if live["artwork"] != nil {
            lastArtworkSentTrackID = snapshot.trackId
        }
        session.sendMessage(live, replyHandler: nil, errorHandler: nil)
    }

    func pushCleared() {
        lastArtworkSentTrackID = nil
        guard let session = watchSession else { return }
        let payload: [String: Any] = ["cleared": true]
        try? session.updateApplicationContext(payload)
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        }
    }

    func pushVolume(_ volume: Float) {
        guard let session = watchSession, session.isReachable else { return }
        let now = Date()
        guard now.timeIntervalSince(lastVolumePushAt) > 0.25 else { return }
        lastVolumePushAt = now
        session.sendMessage(["volume": Double(volume)], replyHandler: nil, errorHandler: nil)
    }

    /// Called on every playback tick; sends position corrections every few
    /// seconds (the watch interpolates in between) and lyric line changes.
    func playbackTimeDidChange(_ position: TimeInterval, duration: TimeInterval, isPlaying: Bool) {
        guard let session = watchSession, session.isReachable else { return }
        let now = Date()
        if now.timeIntervalSince(lastProgressPushAt) >= 5 {
            lastProgressPushAt = now
            var message: [String: Any] = [
                "position": position,
                "positionTimestamp": now.timeIntervalSince1970,
                "isPlaying": isPlaying,
            ]
            if duration > 0 {
                message["duration"] = duration
                message["progress"] = min(max(position / duration, 0), 1)
            }
            session.sendMessage(message, replyHandler: nil, errorHandler: nil)
        }
        sendLyricLineIfNeeded(position: position)
    }

    // MARK: - Lyric line relay

    func trackDidChange(_ track: Track?) {
        lyricsTask?.cancel()
        lyricsTask = nil
        lyricsTrack = track
        lyricsTimeline = nil
        lastSentLyricIndex = nil
        loadLyricsIfNeeded()
    }

    private func reachabilityChanged(_ reachable: Bool) {
        guard reachable else { return }
        lastArtworkSentTrackID = nil
        player.republishNowPlaying()
        loadLyricsIfNeeded()
    }

    /// Lyrics are fetched only while the watch app is open, so the relay costs
    /// nothing otherwise.
    private func loadLyricsIfNeeded() {
        guard lyricsTimeline == nil, lyricsTask == nil, let track = lyricsTrack,
              let session = watchSession, session.isReachable else { return }
        lyricsTask = Task { @MainActor [weak self] in
            let payload = try? await LyricsService.fetch(trackId: track.id, artist: track.artist, title: track.title)
            guard let self, !Task.isCancelled, self.lyricsTrack?.id == track.id else { return }
            self.lyricsTask = nil
            guard let payload, let lrc = payload.lrc else {
                self.lyricsTimeline = .empty
                return
            }
            self.lyricsTimeline = LyricsTimeline.parse(lrc: lrc)
            self.lyricsOffset = (payload.offsetSec ?? SyncedLyricsPayload.defaultSourceOffset) + payload.userOffsetSec
            self.sendLyricLineIfNeeded(force: true)
        }
    }

    private var currentLyricText: String? {
        guard let timeline = lyricsTimeline, let index = lastSentLyricIndex,
              timeline.lines.indices.contains(index) else { return nil }
        return timeline.lines[index].text
    }

    private func sendLyricLineIfNeeded(position: TimeInterval? = nil, force: Bool = false) {
        guard let timeline = lyricsTimeline, !timeline.isEmpty,
              let session = watchSession, session.isReachable else { return }
        let time = (position ?? AudioPlayer.shared.livePlaybackTime()) + lyricsOffset
        let index = timeline.lineIndex(at: time)
        guard force || index != lastSentLyricIndex else { return }
        lastSentLyricIndex = index
        let text = index.map { timeline.lines[$0].text } ?? ""
        session.sendMessage(["lyric": text], replyHandler: nil, errorHandler: nil)
    }
}
#endif
