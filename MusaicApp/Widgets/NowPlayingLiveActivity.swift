#if os(iOS)
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Lock Screen + Dynamic Island UI for the "Now Playing" Live Activity.
///
/// Buttons use `MusaicPlaybackIntent`, which runs in the app process
/// (AudioPlaybackIntent / LiveActivityIntent). Artwork comes from the App
/// Group file the app writes; stale activities (app gone) dim themselves.
struct MusaicLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MusaicLiveActivityAttributes.self) { context in
            LockScreenLiveActivity(state: context.state, isStale: context.isStale)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    LiveActivityArtwork(trackId: context.state.trackId)
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
                    VStack(spacing: 8) {
                        LiveActivityProgress(state: context.state)
                        HStack(spacing: 22) {
                            liveControlButton(command: "previous", systemName: "backward.fill", label: String(localized: "Previous track"))
                            liveControlButton(
                                command: "toggle",
                                systemName: context.state.isPlaying ? "pause.fill" : "play.fill",
                                label: context.state.isPlaying ? String(localized: "Pause") : String(localized: "Play")
                            )
                            liveControlButton(command: "next", systemName: "forward.fill", label: String(localized: "Next track"))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 6)
                    .opacity(context.isStale ? 0.5 : 1)
                }
            } compactLeading: {
                LiveActivityArtwork(trackId: context.state.trackId)
                    .frame(width: 24, height: 24)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } compactTrailing: {
                liveControlButton(
                    command: "toggle",
                    systemName: context.state.isPlaying ? "pause.fill" : "play.fill",
                    label: context.state.isPlaying ? String(localized: "Pause") : String(localized: "Play"),
                    size: 15
                )
            } minimal: {
                Image(systemName: context.state.isPlaying ? "waveform" : "pause.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(hex: "cdb69a"))
            }
        }
    }

    private func liveControlButton(command: String, systemName: String, label: String, size: CGFloat = 18) -> some View {
        Button(intent: MusaicPlaybackIntent(command: command)) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(Color(hex: "fbf7f1"))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

/// Full-width Lock Screen / notification-banner layout.
private struct LockScreenLiveActivity: View {
    let state: MusaicLiveActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        HStack(spacing: 12) {
            LiveActivityArtwork(trackId: state.trackId)
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
                LiveActivityProgress(state: state)
            }

            Spacer(minLength: 8)

            HStack(spacing: 16) {
                controlButton(
                    command: "toggle",
                    systemName: state.isPlaying ? "pause.fill" : "play.fill",
                    label: state.isPlaying ? String(localized: "Pause") : String(localized: "Play")
                )
                controlButton(command: "next", systemName: "forward.fill", label: String(localized: "Next track"))
            }
        }
        .padding(14)
        .opacity(isStale ? 0.6 : 1)
    }

    private func controlButton(command: String, systemName: String, label: String) -> some View {
        Button(intent: MusaicPlaybackIntent(command: command)) {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color(hex: "fbf7f1"))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

/// Self-animating progress while playing; static when paused.
private struct LiveActivityProgress: View {
    let state: MusaicLiveActivityAttributes.ContentState

    var body: some View {
        if state.isPlaying, let start = state.playbackStart, let end = state.playbackEnd, end > start {
            ProgressView(timerInterval: start...end, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                .progressViewStyle(.linear)
                .tint(Color(hex: "cdb69a"))
        } else {
            ProgressView(value: min(max(state.progress, 0), 1))
                .progressViewStyle(.linear)
                .tint(Color(hex: "cdb69a"))
        }
    }
}

/// Artwork from the JPEG the app writes into the App Group container.
private struct LiveActivityArtwork: View {
    let trackId: String

    var body: some View {
        WidgetArtwork(data: NowPlayingShared.loadArtworkData(for: trackId), cornerRadius: 0)
    }
}
#endif
