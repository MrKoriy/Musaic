import SwiftUI
import WatchConnectivity

@main
struct MusaicWatchApp: App {
    init() {
        if WCSession.isSupported() {
            WCSession.default.delegate = WatchSessionDelegate.shared
            WCSession.default.activate()
        }
    }

    var body: some Scene {
        WindowGroup {
            WatchNowPlayingView()
        }
    }
}

final class WatchSessionDelegate: NSObject, WCSessionDelegate {
    nonisolated(unsafe) static let shared = WatchSessionDelegate()

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
}
