import SwiftUI

struct SearchMoodsView: View {
    let moods: [String]
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            LiquidSectionHeader(
                title: String(localized: "Browse by mood"),
                subtitle: String(localized: "Tap a mood to build a fast queue.")
            )
            .padding(.horizontal, 18)

            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
                ForEach(moods, id: \.self) { mood in
                    Button {
                        onSelect(mood)
                    } label: {
                        VStack(alignment: .leading, spacing: 18) {
                            Image(systemName: moodIcon(mood))
                                .font(.system(size: 22, weight: .semibold))
                            Text(mood)
                                .font(.system(size: 15, weight: .semibold))
                            Spacer(minLength: 0)
                        }
                        .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
                        .padding(16)
                        .foregroundStyle(Color.textPrimary)
                        .glassCard(cornerRadius: 24, intensity: 0.10)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
        }
    }

    private func moodIcon(_ mood: String) -> String {
        switch mood {
        case "Energise": return "bolt.fill"
        case "Feel good": return "face.smiling.fill"
        case "Relax": return "cloud.moon.fill"
        case "Workout": return "figure.run"
        case "Sad": return "cloud.rain.fill"
        case "Party": return "party.popper.fill"
        case "Focus": return "target"
        case "Romance": return "heart.fill"
        case "Sleep": return "moon.fill"
        default: return "music.note"
        }
    }
}
