import SwiftUI

struct LyricsHeaderView: View {
    let track: Track
    let lyricsSourceLabel: String
    let hasRawLyrics: Bool
    @Binding var generating: Bool
    @Binding var manualArtist: String
    @Binding var manualTitle: String
    @Binding var showManualSearch: Bool
    let onRetry: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 36, height: 36)
                    .background(Color.white.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain)

            Spacer()

            VStack(spacing: 2) {
                Text(track.title)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                Text(track.artist)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                if !lyricsSourceLabel.isEmpty {
                    Text(lyricsSourceLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.textMuted)
                }
            }

            Spacer()

            HStack(spacing: 8) {
                Button {
                    manualArtist = track.artist
                    manualTitle = track.title
                    showManualSearch = true
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.textSecondary)
                        .frame(width: 36, height: 36)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)

                if hasRawLyrics {
                    Button(action: onRetry) {
                        Group {
                            if generating {
                                ProgressView()
                                    .tint(Color.textPrimary)
                                    .scaleEffect(0.8)
                            } else {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 14, weight: .bold))
                                    .foregroundStyle(Color.textSecondary)
                            }
                        }
                        .frame(width: 36, height: 36)
                        .background(Color.white.opacity(0.08), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(generating)
                    .accessibilityLabel(Text(String(localized: "Re-align lyrics with AI")))
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .padding(.bottom, 12)
    }
}
