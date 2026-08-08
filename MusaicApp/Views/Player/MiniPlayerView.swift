import SwiftUI

struct MiniPlayerView: View {
    @Binding var showNowPlaying: Bool
    var embeddedInAccessory: Bool = false

    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    var body: some View {
        if let track = player.currentTrack {
            surface {
                VStack(spacing: 8) {
                    HStack(spacing: 12) {
                        ArtworkTile(urlString: track.artwork, icon: "music.note")
                            .frame(width: 46, height: 46)

                        VStack(alignment: .leading, spacing: 4) {
                            Text(track.title)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.74)
                            Text(audio.lastErrorMessage ?? track.artist)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(audio.lastErrorMessage == nil ? Color.textSecondary : Color.accentStrong)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        if audio.isBuffering {
                            ProgressView()
                                .tint(Color.textPrimary)
                                .scaleEffect(0.8)
                        }

                        HStack(spacing: 8) {
                             controlButton(
                                 systemName: audio.isPlaying ? "pause.fill" : "play.fill",
                                 prominent: true,
                                 accessibilityLabel: audio.isPlaying ? String(localized: "Pause") : String(localized: "Play")
                             ) {
                                #if os(iOS)
                                UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                                #endif
                                player.togglePlayPause()
                            }
                             controlButton(systemName: "forward.fill", accessibilityLabel: String(localized: "Next Track")) {
                                #if os(iOS)
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                #endif
                                player.skipNext()
                            }
                        }
                        .sensoryFeedback(.impact(weight: .light), trigger: audio.isPlaying)
                    }

                    GeometryReader { geo in
                        let safeProgress = max(0, min(1, audio.progress.isFinite ? audio.progress : 0))
                        let trackWidth = max(0, geo.size.width)
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color.white.opacity(0.12))
                                .frame(height: 3)

                            Capsule()
                                .fill(
                                    LinearGradient(
                                        colors: [
                                            Color.accentStrong.opacity(0.96),
                                            Color.textPrimary.opacity(0.98),
                                        ],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )
                                .frame(width: max(0, min(trackWidth, trackWidth * safeProgress)), height: 3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .clipped()
                    }
                    .frame(height: 3)
                }
                .frame(maxWidth: .infinity, minHeight: 60, alignment: .center)
            }
            .padding(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
            .onTapGesture { showNowPlaying = true }
            .gesture(
                DragGesture(minimumDistance: 30)
                    .onEnded { value in
                        if value.translation.height < -30 {
                            #if os(iOS)
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            #endif
                            showNowPlaying = true
                        }
                        if value.translation.width < -50 {
                            #if os(iOS)
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            #endif
                            player.skipNext()
                        }
                        if value.translation.width > 50 {
                            #if os(iOS)
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            #endif
                            player.skipPrevious()
                        }
                    }
            )
        }
    }

    @ViewBuilder
    private func surface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if embeddedInAccessory {
            content()
                .padding(.horizontal, 6)
        } else {
            content()
                .glassCard(cornerRadius: 28, tint: Color.accentStrong, intensity: 0.08, interactive: true)
        }
    }

    private func controlButton(
        systemName: String,
        prominent: Bool = false,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            miniControlGlyph(systemName: systemName, prominent: prominent)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(accessibilityLabel))
    }

    private func miniControlGlyph(systemName: String, prominent: Bool) -> some View {
        Image(systemName: systemName)
            .font(.system(size: prominent ? 14 : 13, weight: .bold))
            .foregroundStyle(Color.textPrimary)
            .frame(width: embeddedInAccessory ? 26 : 32, height: embeddedInAccessory ? 26 : 32)
            .contentTransition(.symbolEffect(.replace.downUp))
            .background {
                if prominent {
                    Circle()
                        .fill(Color.clear)
                        .liquidProminentSurface(cornerRadius: 16, accent: Color(hex: "d9b17b"))
                } else {
                    Circle()
                        .fill(Color.clear)
                        .glassCard(cornerRadius: 16, tint: .white, intensity: 0.06)
                }
            }
    }
}
