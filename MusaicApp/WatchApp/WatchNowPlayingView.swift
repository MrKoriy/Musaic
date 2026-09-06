import SwiftUI
import WatchKit
import WatchConnectivity

/// watchOS remote for the Musaic iOS app. The phone owns playback; the watch
/// receives snapshot pushes over WatchConnectivity and sends control commands.
struct WatchNowPlayingView: View {
    @State private var snapshot: NowPlayingSnapshot?
    @State private var progress: Double = 0
    @State private var liked = false
    @State private var sessionDelegate = WatchPhoneLink.shared

    var body: some View {
        VStack(spacing: 8) {
            if let snapshot {
                artwork(snapshot.artworkURL)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                Text(snapshot.title)
                    .font(.system(size: 14, weight: .bold))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)

                Text(snapshot.artist)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(Color.accentColor)

                HStack(spacing: 24) {
                    Button {
                        sendRemote(.previous)
                    } label: {
                        Image(systemName: "backward.end.fill")
                    }
                    .buttonStyle(.plain)

                    Button {
                        sendRemote(.toggle)
                    } label: {
                        Image(systemName: snapshot.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 22, weight: .bold))
                    }
                    .buttonStyle(.plain)

                    Button {
                        sendRemote(.next)
                    } label: {
                        Image(systemName: "forward.end.fill")
                    }
                    .buttonStyle(.plain)

                    Button {
                        sendRemote(.like)
                    } label: {
                        Image(systemName: liked ? "heart.fill" : "heart")
                            .foregroundStyle(liked ? Color.red : Color.primary)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                ProgressView()
                Text("Nothing playing")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .onAppear {
            snapshot = sessionDelegate.snapshot
            liked = sessionDelegate.liked
        }
        .onReceive(sessionDelegate.$snapshot) { snap in
            snapshot = snap
            progress = 0
        }
        .onReceive(sessionDelegate.$progress) { progress = $0 }
        .onReceive(sessionDelegate.$liked) { liked = $0 }
    }

    @ViewBuilder
    private func artwork(_ url: String?) -> some View {
        if let url, let u = URL(string: url) {
            AsyncImage(url: u) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.white.opacity(0.08)
            }
        } else {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.08))
                .overlay {
                    Image(systemName: "music.note")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
        }
    }

    private enum RemoteAction {
        case play, pause, toggle, next, previous
        case seek(Double)
        case like
    }

    private func sendRemote(_ action: RemoteAction) {
        switch action {
        case .play: WatchPhoneLink.shared.send(command: "play")
        case .pause: WatchPhoneLink.shared.send(command: "pause")
        case .toggle: WatchPhoneLink.shared.send(command: "toggle")
        case .next: WatchPhoneLink.shared.send(command: "next")
        case .previous: WatchPhoneLink.shared.send(command: "previous")
        case .like: WatchPhoneLink.shared.send(command: "like")
        case .seek(let fraction): WatchPhoneLink.shared.send(command: "seek", value: fraction)
        }
    }
}

/// Observable WCSession wrapper: pushes snapshots/progress from the phone and
/// sends control commands to it.
@MainActor
final class WatchPhoneLink: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchPhoneLink()

    @Published var snapshot: NowPlayingSnapshot?
    @Published var progress: Double = 0
    @Published var liked = false

    override private init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func send(command: String, value: Double? = nil) {
        var message: [String: Any] = ["musaic": command]
        if let value { message["value"] = value }
        if WCSession.default.isReachable {
            WCSession.default.sendMessage(message, replyHandler: nil, errorHandler: nil)
        } else {
            // Deliver when the phone becomes reachable again.
            try? WCSession.default.updateApplicationContext(message)
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handlePush(message)
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        handlePush(applicationContext)
    }

    nonisolated private func handlePush(_ message: [String: Any]) {
        let snapshotData = message["snapshot"] as? Data
        let progressValue = message["progress"] as? Double
        let likedValue = message["liked"] as? Bool
        Task { @MainActor in
            if let data = snapshotData,
               let snap = try? JSONDecoder().decode(NowPlayingSnapshot.self, from: data) {
                self.snapshot = snap
            }
            if let p = progressValue { self.progress = p }
            if let l = likedValue { self.liked = l }
        }
    }
}
