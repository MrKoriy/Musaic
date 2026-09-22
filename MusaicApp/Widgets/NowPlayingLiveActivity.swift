#if os(iOS)
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Lock Screen + Dynamic Island UI for the "Now Playing" Live Activity.
///
/// Buttons use `MusaicPlaybackIntent`, which mails the command to the app via
/// the App Group (the extension cannot reach the AVPlayer directly).
struct MusaicLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MusaicLiveActivityAttributes.self) { context in
            LockScreenLiveActivity(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    LiveActivityArtwork(urlString: context.state.artworkURL)
                        .frame(width: 46, height: 46)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.title)
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                            .lineLimit(1)
                        Text(context.state.artist)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 22) {
                        liveControlButton(command: "previous", systemName: "backward.fill")
                        liveControlButton(
                            command: "toggle",
                            systemName: context.state.isPlaying ? "pause.fill" : "play.fill"
                        )
                        liveControlButton(command: "next", systemName: "forward.fill")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 6)
                }
            } compactLeading: {
                LiveActivityArtwork(urlString: context.state.artworkURL)
                    .frame(width: 24, height: 24)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } compactTrailing: {
                liveControlButton(
                    command: "toggle",
                    systemName: context.state.isPlaying ? "pause.fill" : "play.fill",
                    size: 15
                )
            } minimal: {
                Image(systemName: "waveform")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(hex: "cdb69a"))
            }
        }
    }

    private func liveControlButton(command: String, systemName: String, size: CGFloat = 18) -> some View {
        Button(intent: MusaicPlaybackIntent(command: command)) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(Color(hex: "fbf7f1"))
        }
        .buttonStyle(.plain)
    }
}

/// Full-width Lock Screen / notification-banner layout.
private struct LockScreenLiveActivity: View {
    let state: MusaicLiveActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            LiveActivityArtwork(urlString: state.artworkURL)
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                Text(state.title)
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .lineLimit(1)
                Text(state.artist)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                ProgressView(value: state.progress)
                    .tint(Color(hex: "cdb69a"))
            }

            Spacer(minLength: 8)

            HStack(spacing: 16) {
                Button(intent: MusaicPlaybackIntent(command: "toggle")) {
                    Image(systemName: state.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color(hex: "fbf7f1"))
                }
                .buttonStyle(.plain)

                Button(intent: MusaicPlaybackIntent(command: "next")) {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color(hex: "fbf7f1"))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
    }
}

/// Best-effort network artwork — the system caches it after the first fetch.
private struct LiveActivityArtwork: View {
    let urlString: String?

    var body: some View {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                placeholder
            }
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        Color.white.opacity(0.10)
            .overlay {
                Image(systemName: "music.note")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
    }
}
#endif
