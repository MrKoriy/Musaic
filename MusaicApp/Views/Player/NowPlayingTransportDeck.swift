import SwiftUI

/// Transport card of the Now Playing screen. Position-dependent UI lives in
/// small leaf views (`TransportScrubSection`, `TransportPlayPauseButton`) so
/// the 4 Hz playback ticks only redraw those, not the whole deck.
struct NowPlayingTransportDeckView: View {
    private let player = PlayerStore.shared

    @State private var skipNextCounter = 0
    @State private var skipPrevCounter = 0
    @State private var repeatTapCounter = 0
    @State private var autoMixCounter = 0

    var body: some View {
        VStack(spacing: 16) {
            TransportScrubSection()
                .padding(.horizontal, 16)
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

                TransportPlayPauseButton()

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
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .glassCard(cornerRadius: 34, tint: Color.accentStrong, intensity: 0.09, interactive: true)
        }
        .padding(.bottom, 8)
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
            .frame(width: 44, height: 44)
            .shadow(color: .black.opacity(0.16), radius: 10, y: 4)
        }
        .buttonStyle(PressableScale(scale: 0.90))
        .accessibilityLabel(Text(accessibilityLabel))
    }
}

/// The only part of the deck that follows the playback position.
private struct TransportScrubSection: View {
    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    var body: some View {
        let duration = audio.duration > 0 && audio.duration.isFinite
            ? audio.duration
            : (player.currentTrack?.duration ?? 0)
        ScrubBar(
            progress: audio.progress,
            currentTime: audio.currentTime,
            duration: duration,
            tint: Color.accentStrong,
            onCommit: { fraction in
                player.seekTo(fraction)
            }
        )
    }
}

/// Reads only the play state, so progress ticks never redraw it.
private struct TransportPlayPauseButton: View {
    private let player = PlayerStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Pause glyph as soon as playback is requested (covers loading).
    private var showsPause: Bool { player.isPlaybackIntended }

    var body: some View {
        Button {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: showsPause ? .medium : .rigid).impactOccurred()
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
                                Color(hex: "d7ba8d").opacity(showsPause ? 0.58 : 0.40),
                                .clear,
                            ],
                            center: .topTrailing,
                            startRadius: 4,
                            endRadius: 68
                        )
                    )
                    .blur(radius: 12)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.45), value: showsPause)

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

                Image(systemName: showsPause ? "pause.fill" : "play.fill")
                    .font(.system(size: 27, weight: .black))
                    .foregroundStyle(Color.textPrimary)
                    .offset(x: showsPause ? 0 : 2)
                    .contentTransition(.symbolEffect(.replace.downUp))
            }
            .frame(width: 76, height: 76)
            .scaleEffect(showsPause ? 1.0 : 0.97)
            .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.7), value: showsPause)
        }
        .buttonStyle(PressableScale(scale: 0.93))
        .sensoryFeedback(.impact(weight: .light), trigger: showsPause)
        .accessibilityLabel(Text(showsPause ? String(localized: "Pause") : String(localized: "Play")))
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
