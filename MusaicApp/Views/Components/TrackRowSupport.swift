import SwiftUI

struct PlayingIndicator: View {
    @State private var animate = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<3) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accent)
                    .frame(width: 3, height: animate ? CGFloat.random(in: 6...14) : 4)
                    .animation(
                        reduceMotion
                            ? nil
                            : .easeInOut(duration: 0.4)
                                .repeatForever(autoreverses: true)
                                .delay(Double(i) * 0.15),
                        value: animate
                    )
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            animate = true
        }
    }
}

extension Track.TrackSource {
    /// Colour of the tiny source badge dot at the track row artwork corner.
    /// Brand-derived hues, slightly softened to sit well on the dark warm UI.
    var dotColor: Color {
        switch self {
        case .local: return Color.accentStrong
        case .vk: return Color(hex: "4c8dff")
        case .soundcloud: return Color(hex: "ff6a33")
        case .yandex: return Color(hex: "ffcc33")
        case .youtube: return Color(hex: "ff4d4d")
        }
    }
}

func formatDuration(_ seconds: TimeInterval) -> String {
    guard seconds.isFinite, !seconds.isNaN else { return "0:00" }
    let s = Int(max(0, seconds))
    return "\(s / 60):\(String(format: "%02d", s % 60))"
}
