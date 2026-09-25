import SwiftUI

@main
struct MusaicWatchApp: App {
    init() {
        // The one and only WCSession delegate on the watch.
        WatchPhoneLink.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            WatchNowPlayingView()
        }
    }
}
