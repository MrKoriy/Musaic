#if os(iOS)
import Foundation
import WatchConnectivity

/// Receives control commands from the watch app and drives the player.
@MainActor
final class WatchControlHandler: NSObject, WCSessionDelegate {
    static let shared = WatchControlHandler()

    private let player = PlayerStore.shared

    private override init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let command = message["musaic"] as? String else { return }
        let value = message["value"] as? Double
        Task { @MainActor in
            switch command {
            case "play": self.player.resumePlayback()
            case "pause": self.player.pausePlayback()
            case "toggle": self.player.togglePlayPause()
            case "next": self.player.skipNext()
            case "previous": self.player.skipPrevious()
            case "like":
                if let track = self.player.currentTrack {
                    LibraryStore.shared.toggleLike(track: track)
                }
            case "seek":
                if let fraction = value {
                    self.player.seekTo(fraction)
                }
            default: break
            }
        }
    }

    // MARK: - Push state to the watch

    nonisolated func pushSnapshotToWatch(_ snapshot: NowPlayingSnapshot, liked: Bool) {
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        let payload: [String: Any] = [
            "snapshot": data,
            "liked": liked,
        ]
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        }
        try? session.updateApplicationContext(payload)
    }

    nonisolated func pushProgressToWatch(_ progress: Double) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["progress": progress], replyHandler: nil, errorHandler: nil)
    }
}
#endif
