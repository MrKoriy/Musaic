import Foundation
import WatchConnectivity

/// The watch's single WCSession delegate: restores the last state from the
/// application context at launch, applies live pushes from the phone and
/// sends control commands (queued with `transferUserInfo` when the phone is
/// unreachable).
@MainActor
final class WatchPhoneLink: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchPhoneLink()

    @Published private(set) var snapshot: NowPlayingSnapshot?
    @Published private(set) var liked = false
    @Published private(set) var artworkData: Data?
    @Published private(set) var lyricLine: String?
    @Published private(set) var volume: Double = 1
    @Published private(set) var isReachable = false
    /// Last known position and when it was sampled; the UI interpolates.
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    @Published private(set) var positionTimestamp = Date()

    private var artworkTrackID: String?

    private override init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.delegate !== self else { return }
        session.delegate = self
        session.activate()
    }

    /// Estimated playback position right now.
    func estimatedPosition(at date: Date = Date()) -> Double {
        guard let snapshot, snapshot.isPlaying else { return position }
        let estimate = position + date.timeIntervalSince(positionTimestamp)
        return duration > 0 ? min(estimate, duration) : estimate
    }

    // MARK: - Commands

    func send(command: String, value: Double? = nil) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        let issuedAt = Date().timeIntervalSince1970
        applyOptimistically(command: command, value: value)
        let message = Self.commandPayload(command: command, value: value, issuedAt: issuedAt)
        if session.isReachable {
            session.sendMessage(message, replyHandler: nil) { _ in
                // Delivery failed mid-flight: queue it instead.
                Self.queue(command: command, value: value, issuedAt: issuedAt)
            }
        } else if Self.isQueueable(command) {
            _ = session.transferUserInfo(message)
        }
    }

    /// Continuous controls (volume, scrub) are pointless to deliver late.
    private nonisolated static func isQueueable(_ command: String) -> Bool {
        command != "volume" && command != "sync"
    }

    private nonisolated static func commandPayload(command: String, value: Double?, issuedAt: Double) -> [String: Any] {
        var message: [String: Any] = ["musaic": command, "ts": issuedAt]
        if let value { message["value"] = value }
        return message
    }

    private nonisolated static func queue(command: String, value: Double?, issuedAt: Double) {
        guard isQueueable(command) else { return }
        _ = WCSession.default.transferUserInfo(commandPayload(command: command, value: value, issuedAt: issuedAt))
    }

    private func applyOptimistically(command: String, value: Double?) {
        switch command {
        case "play", "pause":
            guard let current = snapshot else { return }
            position = estimatedPosition()
            positionTimestamp = Date()
            snapshot = NowPlayingSnapshot(
                trackId: current.trackId,
                title: current.title,
                artist: current.artist,
                artworkURL: current.artworkURL,
                isPlaying: command == "play",
                updatedAt: current.updatedAt,
                album: current.album,
                position: current.position,
                duration: current.duration,
                positionTimestamp: current.positionTimestamp
            )
        case "like":
            liked.toggle()
        case "volume":
            if let value { volume = value }
        case "seek":
            if let value, duration > 0 {
                position = value * duration
                positionTimestamp = Date()
            }
        default:
            break
        }
    }

    // MARK: - WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        let push = WatchPush(session.receivedApplicationContext)
        let reachable = session.isReachable
        Task { @MainActor in
            self.apply(push)
            self.isReachable = reachable
            if reachable { self.send(command: "sync") }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            let becameReachable = reachable && !self.isReachable
            self.isReachable = reachable
            if becameReachable { self.send(command: "sync") }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        let push = WatchPush(message)
        Task { @MainActor in self.apply(push) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let push = WatchPush(applicationContext)
        Task { @MainActor in self.apply(push) }
    }

    private func apply(_ push: WatchPush) {
        if push.cleared {
            snapshot = nil
            artworkData = nil
            artworkTrackID = nil
            lyricLine = nil
            position = 0
            duration = 0
            return
        }
        if let snap = push.snapshot {
            let trackChanged = snap.trackId != snapshot?.trackId
            if trackChanged {
                lyricLine = nil
                if artworkTrackID != snap.trackId {
                    artworkData = nil
                    artworkTrackID = nil
                }
            }
            snapshot = snap
            if let pos = snap.position {
                position = pos
                positionTimestamp = snap.positionTimestamp.map(Date.init(timeIntervalSince1970:)) ?? Date()
            }
            if let dur = snap.duration { duration = dur }
            if let artwork = push.artwork {
                artworkData = artwork
                artworkTrackID = snap.trackId
            }
        }
        if let pos = push.position {
            position = pos
            positionTimestamp = push.positionTimestamp.map(Date.init(timeIntervalSince1970:)) ?? Date()
        }
        if let dur = push.duration, dur > 0 { duration = dur }
        if let isPlaying = push.isPlaying, let current = snapshot, current.isPlaying != isPlaying {
            snapshot = NowPlayingSnapshot(
                trackId: current.trackId,
                title: current.title,
                artist: current.artist,
                artworkURL: current.artworkURL,
                isPlaying: isPlaying,
                updatedAt: current.updatedAt,
                album: current.album,
                position: position,
                duration: duration > 0 ? duration : current.duration,
                positionTimestamp: positionTimestamp.timeIntervalSince1970
            )
        }
        if let l = push.liked { liked = l }
        if let v = push.volume { volume = v }
        if let lyric = push.lyric { lyricLine = lyric.isEmpty ? nil : lyric }
    }
}

/// Sendable view of a phone payload, extracted before hopping actors.
private struct WatchPush: Sendable {
    var snapshot: NowPlayingSnapshot?
    var liked: Bool?
    var artwork: Data?
    var lyric: String?
    var volume: Double?
    var position: Double?
    var positionTimestamp: Double?
    var duration: Double?
    var isPlaying: Bool?
    var cleared = false

    init(_ payload: [String: Any]) {
        if let data = payload["snapshot"] as? Data {
            snapshot = try? JSONDecoder().decode(NowPlayingSnapshot.self, from: data)
        }
        liked = payload["liked"] as? Bool
        artwork = payload["artwork"] as? Data
        lyric = payload["lyric"] as? String
        volume = payload["volume"] as? Double
        position = payload["position"] as? Double
        positionTimestamp = payload["positionTimestamp"] as? Double
        duration = payload["duration"] as? Double
        isPlaying = payload["isPlaying"] as? Bool
        cleared = payload["cleared"] as? Bool ?? false
    }
}
