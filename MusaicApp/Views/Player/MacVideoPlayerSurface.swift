#if os(macOS)
import AVKit
import SwiftUI

/// Music-video surface for the macOS Now Playing player: replaces the artwork
/// while a matched clip plays. Controls stay on the regular transport deck —
/// the AVKit view is display-only.
///
/// Backed by AppKit's AVPlayerView: SwiftUI's VideoPlayer crashes this
/// toolchain/runtime combo inside _AVKit_SwiftUI metadata setup on first use.
struct MacVideoPlayerSurface: View {
    let player: AVPlayer
    let height: CGFloat

    var body: some View {
        PlayerViewRepresentable(player: player)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(Color.black, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(.white.opacity(0.12), lineWidth: 0.8)
            }
            .shadow(color: .black.opacity(0.38), radius: 36, y: 20)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(String(localized: "Music video")))
    }
}

private struct PlayerViewRepresentable: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .none
        view.videoGravity = .resizeAspect
        view.showsFullScreenToggleButton = false
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player !== player {
            nsView.player = player
        }
    }
}
#endif
