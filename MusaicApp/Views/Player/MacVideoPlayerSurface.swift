#if os(macOS)
import AVKit
import SwiftUI

/// Music-video surface for the macOS Now Playing player: replaces the artwork
/// while a matched clip plays. Controls stay on the regular transport deck —
/// the AVKit view is display-only.
struct MacVideoPlayerSurface: View {
    let player: AVPlayer
    let height: CGFloat

    var body: some View {
        VideoPlayer(player: player)
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
#endif
