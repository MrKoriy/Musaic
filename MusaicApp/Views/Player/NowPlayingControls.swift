import SwiftUI

struct NowPlayingTopBarView: View {
    @Binding var showLyrics: Bool
    @Binding var showQueue: Bool
    @Binding var showSleepTimer: Bool
    @Environment(\.dismiss) private var dismiss

    private let audio = AudioPlayer.shared
    private let player = PlayerStore.shared

    @State private var sleepTick = Date()

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                LiquidIconButton(systemName: "chevron.down", size: 42, accessibilityLabel: String(localized: "Close player")) {
                    dismiss()
                }
                Spacer()
                LiquidGlassGroup(spacing: 10) {
                    HStack(spacing: 10) {
                        LiquidIconButton(systemName: sleepIcon, size: 42, accessibilityLabel: String(localized: "Sleep timer")) {
                            showSleepTimer = true
                        }
                        LiquidIconButton(systemName: "quote.bubble", size: 42, accessibilityLabel: String(localized: "Show lyrics")) {
                            showLyrics = true
                        }
                        LiquidIconButton(systemName: "list.bullet", size: 42, accessibilityLabel: String(localized: "Show queue")) {
                            showQueue = true
                        }
                    }
                }
            }

            VStack(spacing: 4) {
                Text(String(localized: "NOW PLAYING"))
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(3)
                    .foregroundStyle(Color.textSecondary)
                Text(trackStateLine)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(audio.isBuffering ? Color.accentStrong : Color.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .contentTransition(.numericText())
            }
        }
        .task(id: player.sleepTimerActive) {
            guard player.sleepTimerActive else { return }
            while !Task.isCancelled, player.sleepTimerActive {
                sleepTick = Date()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private var sleepIcon: String {
        player.sleepTimerActive ? "moon.zzz.fill" : "moon"
    }

    private var trackStateLine: String {
        _ = sleepTick
        let source = player.currentTrack?.source.displayTag ?? "MUSAIC"
        let resolvedDuration = audio.duration > 0 ? audio.duration : (player.currentTrack?.duration ?? 0)
        let time = resolvedDuration > 0 ? formatDuration(resolvedDuration) : "--:--"
        if player.sleepTimerEndOfTrack {
            return String(localized: "\(source) • \(time) • SLEEP AFTER TRACK")
        }
        let remaining = player.sleepTimerRemaining
        if remaining > 0 {
            let mins = Int(remaining) / 60
            let secs = Int(remaining) % 60
            return String(localized: "\(source) • \(time) • SLEEP \(mins):\(String(format: "%02d", secs))")
        }
        return String(localized: "\(source) • \(time)")
    }
}

struct NowPlayingArtworkView: View {
    let track: Track
    let side: CGFloat

    private let audio = AudioPlayer.shared

    var body: some View {
        let scale: CGFloat = audio.isPlaying ? 1.0 : 0.88

        ArtworkTile(urlString: track.artwork, icon: "music.note")
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(.white.opacity(0.12), lineWidth: 0.8)
            }
            .shadow(color: .black.opacity(audio.isPlaying ? 0.38 : 0.18), radius: audio.isPlaying ? 36 : 18, y: audio.isPlaying ? 20 : 10)
            .scaleEffect(scale)
            .animation(.spring(response: 0.5, dampingFraction: 0.72), value: audio.isPlaying)
    }
}

struct NowPlayingMetadataSectionView: View {
    let track: Track

    private let audio = AudioPlayer.shared
    private let library = LibraryStore.shared
    private let player = PlayerStore.shared

    var body: some View {
        let liked = library.likedTrackIds.contains(track.id)

        return VStack(spacing: 12) {
            Text(track.title)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.78)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.28), value: track.id)

            Text(track.artist)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(1)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.28), value: track.id)

            if let playbackLine {
                Text(playbackLine)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(audio.lastErrorMessage == nil ? Color.textMuted : Color.accentStrong)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .glassCard(cornerRadius: 18, tint: audio.lastErrorMessage == nil ? Color.white : Color.accentStrong, intensity: 0.05)
                    .transition(.opacity.combined(with: .scale(scale: 0.94)))
            }

            HStack(spacing: 10) {
                Text(track.source.displayTag)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .glassCard(cornerRadius: 18, tint: Color.accentStrong, intensity: 0.06)

                Button {
                    #if os(iOS)
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    #endif
                    library.toggleLike(track: track)
                } label: {
                    Image(systemName: liked ? "heart.fill" : "heart")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(liked ? Color.accentStrong : Color.textPrimary)
                        .frame(width: 42, height: 42)
                        .contentTransition(.symbolEffect(.replace.downUp))
                        .symbolEffect(.bounce.up.byLayer, value: liked)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(liked ? String(localized: "Remove from favorites") : String(localized: "Add to favorites")))
                .sensoryFeedback(.success, trigger: liked)
                .background(
                    Circle()
                        .fill(Color.clear)
                        .glassCard(cornerRadius: 21, tint: Color.accentStrong, intensity: 0.08)
                )

                Button(role: .destructive) {
                    #if os(iOS)
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    #endif
                    player.dislikeCurrentTrack()
                } label: {
                    Image(systemName: "hand.thumbsdown")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                        .frame(width: 42, height: 42)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(String(localized: "Dislike and skip track")))
                .background(
                    Circle()
                        .fill(Color.clear)
                        .glassCard(cornerRadius: 21, tint: Color.red, intensity: 0.08)
                )
            }
        }
    }

    private var playbackLine: String? {
        if let error = audio.lastErrorMessage, !error.isEmpty {
            return error
        }
        if audio.isBuffering {
            return String(localized: "Loading stream...")
        }
        return nil
    }
}
