import SwiftUI

struct PlayingIndicator: View {
    @State private var animate = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Deterministic per-bar heights — randomness in body would re-trigger
    // view updates and defeat row diffing in long track lists.
    private let barHeights: [CGFloat] = [6, 12, 9]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<3) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accent)
                    .frame(width: 3, height: animate ? barHeights[i] : 4)
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
        case .unknown: return Color.textMuted
        }
    }
}

func formatDuration(_ seconds: TimeInterval) -> String {
    guard seconds.isFinite, !seconds.isNaN else { return "0:00" }
    let s = Int(max(0, seconds))
    return "\(s / 60):\(String(format: "%02d", s % 60))"
}

/// A track at a list position, with an ID that stays stable across re-sorts
/// and is unique even when the same track appears more than once.
struct TrackListItem: Identifiable {
    let id: String
    let index: Int
    let track: Track
}

extension Array where Element == Track {
    var listItems: [TrackListItem] {
        var occurrences: [String: Int] = [:]
        return enumerated().map { index, track in
            let seen = occurrences[track.id, default: 0]
            occurrences[track.id] = seen + 1
            return TrackListItem(id: seen == 0 ? track.id : "\(track.id)#\(seen)", index: index, track: track)
        }
    }
}
