import SwiftUI

struct NowPlayingTransportDeckView: View {
    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    @State private var skipNextCounter = 0
    @State private var skipPrevCounter = 0
    @State private var repeatTapCounter = 0
    @State private var autoMixCounter = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var scrubDuration: Double {
        let d = audio.duration
        if d > 0 && d.isFinite { return d }
        return player.currentTrack?.duration ?? 0
    }

    var body: some View {
        VStack(spacing: 16) {
            ScrubBar(
                progress: audio.progress,
                currentTime: audio.currentTime,
                duration: scrubDuration,
                tint: Color.accentStrong,
                onCommit: { fraction in
                    audio.seek(to: fraction)
                }
            )
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .glassCard(cornerRadius: 28, tint: Color.accentStrong, intensity: 0.08, interactive: true)

            HStack {
                HStack(spacing: 12) {
                    transportButton(
                        systemName: player.isAutoMixActive ? "sparkles" : "wand.and.stars",
                        active: player.isAutoMixActive,
                        size: player.isAutoMixActive ? 18 : 16,
                        bounceTrigger: autoMixCounter,
                        accessibilityLabel: String(localized: "Toggle Auto Mix")
                    ) {
                        autoMixCounter += 1
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        Task { await player.toggleAutoMix() }
                    }

                    transportButton(
                        systemName: "backward.end.fill",
                        size: 21,
                        bounceTrigger: skipPrevCounter,
                        accessibilityLabel: String(localized: "Previous Track")
                    ) {
                        skipPrevCounter += 1
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        player.skipPrevious()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 8)

                playPauseButton

                Spacer(minLength: 8)

                HStack(spacing: 12) {
                    transportButton(
                        systemName: "forward.end.fill",
                        size: 21,
                        bounceTrigger: skipNextCounter,
                        accessibilityLabel: String(localized: "Next Track")
                    ) {
                        skipNextCounter += 1
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        player.skipNext()
                    }

                    transportButton(
                        systemName: player.repeatMode == .track ? "repeat.1" : "repeat",
                        active: player.repeatMode != .off,
                        bounceTrigger: repeatTapCounter,
                        accessibilityLabel: String(localized: "Toggle Repeat")
                    ) {
                        repeatTapCounter += 1
                        #if os(iOS)
                        UISelectionFeedbackGenerator().selectionChanged()
                        #endif
                        player.toggleRepeat()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .glassCard(cornerRadius: 34, tint: Color.accentStrong, intensity: 0.09, interactive: true)
        }
        .padding(.bottom, 8)
    }

    private var playPauseButton: some View {
        Button {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: audio.isPlaying ? .medium : .rigid).impactOccurred()
            #endif
            player.togglePlayPause()
        } label: {
            ZStack {
                Circle()
                    .fill(Color.black.opacity(0.34))
                    .blur(radius: 18)
                    .offset(y: 10)

                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "36271d"),
                                Color(hex: "1b1410"),
                                Color(hex: "110c09"),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(hex: "d7ba8d").opacity(audio.isPlaying ? 0.58 : 0.40),
                                .clear,
                            ],
                            center: .topTrailing,
                            startRadius: 4,
                            endRadius: 68
                        )
                    )
                    .blur(radius: 12)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.45), value: audio.isPlaying)

                Circle()
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                .white.opacity(0.24),
                                Color.accentStrong.opacity(0.34),
                                .black.opacity(0.22),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )

                Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 27, weight: .black))
                    .foregroundStyle(Color.textPrimary)
                    .offset(x: audio.isPlaying ? 0 : 2)
                    .contentTransition(.symbolEffect(.replace.downUp))
            }
            .frame(width: 82, height: 82)
            .scaleEffect(audio.isPlaying ? 1.0 : 0.97)
            .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.7), value: audio.isPlaying)
        }
        .buttonStyle(PressableScale(scale: 0.93))
        .sensoryFeedback(.impact(weight: .light), trigger: audio.isPlaying)
        .accessibilityLabel(Text(audio.isPlaying ? String(localized: "Pause") : String(localized: "Play")))
    }

    private func transportButton(
        systemName: String,
        active: Bool = false,
        size: CGFloat = 22,
        bounceTrigger: Int = 0,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: active
                                ? [
                                    Color(hex: "4d3928"),
                                    Color(hex: "231912"),
                                ]
                                : [
                                    Color(hex: "312720").opacity(0.92),
                                    Color(hex: "191412").opacity(0.90),
                                ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Circle()
                    .strokeBorder(
                        LinearGradient(
                            colors: active
                                ? [
                                    Color.accentStrong.opacity(0.28),
                                    .white.opacity(0.18),
                                    .black.opacity(0.20),
                                ]
                                : [
                                    .white.opacity(0.18),
                                    .white.opacity(0.08),
                                    .black.opacity(0.18),
                                ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )

                Image(systemName: systemName)
                    .font(.system(size: size, weight: .semibold))
                    .foregroundStyle(active ? Color.accentStrong : Color.textPrimary)
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: bounceTrigger)
            }
            .frame(width: 46, height: 46)
            .shadow(color: .black.opacity(0.16), radius: 10, y: 4)
        }
        .buttonStyle(PressableScale(scale: 0.90))
        .accessibilityLabel(Text(accessibilityLabel))
    }
}

/// Press-down scale for primary buttons — gives them tactile feel.
struct PressableScale: ButtonStyle {
    var scale: CGFloat = 0.94

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1.0)
            .animation(.spring(response: 0.25, dampingFraction: 0.72), value: configuration.isPressed)
    }
}
