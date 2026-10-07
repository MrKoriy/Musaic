import SwiftUI

/// Track row used across Home / Search / Library lists.
///
/// Design notes:
/// - The row body is NOT wrapped in a Button (a Button inside a Button swallows
///   taps — the download control used to trigger playback): the row plays on
///   tap via `.onTapGesture`, action controls are plain sibling Buttons.
/// - The entrance stagger plays once per row per process. LazyVStack re-fires
///   `onAppear` on every scroll-back; animating there made rows re-dance while
///   scrolling (DESIGN.md §10: stagger fade-in, 200ms ease-out, 30ms per item).
/// - A horizontal swipe reveals quick actions (like on the leading edge, queue +
///   playlist on the trailing edge) via the system swipe-actions API, which
///   coordinates with the enclosing scroll view instead of fighting it.
struct TrackRow: View {
    let track: Track
    let index: Int
    var isCurrent: Bool = false
    var isLiked: Bool = false
    var onTap: (() -> Void)?
    var onLike: (() -> Void)?
    var onAddToQueue: (() -> Void)?
    var onAddToPlaylist: (() -> Void)?
    /// Shown as a destructive swipe/context action (e.g. "Remove from Playlist").
    var onRemove: (() -> Void)? = nil

    /// macOS-only hover state — iOS never fires `.onHover`, so the default
    /// false value silently no-ops there.
    @State private var isHovered = false
    /// Stagger entrance flag — rows fade/rise in with a 30ms per-item delay.
    @State private var appeared = false
    @State private var showRecommendationReasons = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let downloadManager = DownloadManager.shared


    /// 30ms per row, capped so deep rows in long lists don't wait seconds.
    private var staggerDelay: Double {
        Double(min(max(index - 1, 0), 12)) * 0.03
    }

    var body: some View {
        rowWithSwipeActions
            .padding(.horizontal, 16)
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared ? 0 : 8)
            .onAppear(perform: playEntranceIfNeeded)
            .alert(String(localized: "Recommendation signals"), isPresented: $showRecommendationReasons) {
                Button(String(localized: "OK"), role: .cancel) {}
            } message: {
                Text(track.recommendationReasonSummary)
            }
    }

    /// Quick actions ride on the system's swipe implementation: the rows declare
    /// `.swipeActions`, and the enclosing scroll view opts in with
    /// `.musaicSwipeContainer()`. A hand-rolled drag gesture used to live here and
    /// fought the scroll view — after dismissing the player sheet the list would
    /// stop scrolling. The system version coordinates with the scroll view instead
    /// of competing with it; older SDKs simply keep the context menu.
    @ViewBuilder
    private var rowWithSwipeActions: some View {
        #if compiler(>=6.3)
        if #available(iOS 27.0, macOS 27.0, *) {
            rowContent
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    if let onLike {
                        Button {
                            #if os(iOS)
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            #endif
                            onLike()
                        } label: {
                            Label(
                                isLiked ? String(localized: "Unlike") : String(localized: "Like"),
                                systemImage: isLiked ? "heart.slash" : "heart"
                            )
                        }
                        .tint(Color.accentStrong)
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    if let onAddToQueue {
                        Button { onAddToQueue() } label: {
                            Label(String(localized: "Add to Queue"), systemImage: "text.append")
                        }
                    }
                    if let onAddToPlaylist {
                        Button { onAddToPlaylist() } label: {
                            Label(String(localized: "Add to Playlist"), systemImage: "text.badge.plus")
                        }
                    }
                }
        } else {
            rowContent
        }
        #else
        rowContent
        #endif
    }

    // MARK: - Row content

    private var rowContent: some View {
        HStack(spacing: 12) {
            ZStack {
                if isCurrent {
                    PlayingIndicator()
                } else {
                    Text("\(index)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 20)

            InspectableArtworkView(
                urlString: track.artwork,
                debugLabel: "\(track.source.rawValue): \(track.artist) - \(track.title)",
                maxPixelSize: 256
            ) {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Color(hex: "4d3f30"), Color(hex: "241c15")],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .overlay(
                        Image(systemName: "music.note")
                            .musaicFont(size: 16, weight: .medium)
                            .foregroundStyle(Color.textSecondary)
                    )
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(track.source.dotColor)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().strokeBorder(Color.bgPrimary, lineWidth: 1.5))
                    .padding(3)
                    .accessibilityHidden(true)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundStyle(isCurrent ? Color.accentStrong : Color.textPrimary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                Text(track.artist)
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let dur = track.duration {
                Text(formatDuration(dur))
                    .font(.caption2)
                    .foregroundStyle(Color.textMuted)
                    .frame(width: 38, alignment: .trailing)
            }

            TrackDownloadButton(track: track)

            likeButton
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(rowBackgroundColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(isCurrent ? 0.15 : (isHovered ? 0.12 : 0.06)), lineWidth: 0.5)
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: isCurrent)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isHovered)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture { onTap?() }
        .onHover { hovering in isHovered = hovering }
        .accessibilityLabel(Text("\(track.title), \(track.artist)"))
        .accessibilityHint(Text(String(localized: "Plays this track")))
        .contextMenu {
            if !(track.recommendationReasons ?? []).isEmpty {
                Button { showRecommendationReasons = true } label: {
                    Label(String(localized: "Why this track?"), systemImage: "info.circle")
                }
            }
            if let onAddToPlaylist {
                Button { onAddToPlaylist() } label: {
                    Label(String(localized: "Add to Playlist"), systemImage: "text.badge.plus")
                }
            }
            if let onAddToQueue {
                Button { onAddToQueue() } label: {
                    Label(String(localized: "Add to Queue"), systemImage: "text.append")
                }
            }
            if let onRemove {
                Button(role: .destructive) { onRemove() } label: {
                    Label(String(localized: "Remove from Playlist"), systemImage: "minus.circle")
                }
            }
            if downloadManager.isDownloaded(track.id) {
                Button(role: .destructive) {
                    downloadManager.deleteDownload(trackId: track.id)
                } label: {
                    Label(String(localized: "Remove Download"), systemImage: "trash")
                }
            } else {
                Button {
                    downloadManager.downloadTrack(track)
                } label: {
                    Label(String(localized: "Download (AAC \(SettingsStore.shared.downloadBitrate)k)"), systemImage: "arrow.down.circle")
                }
                .disabled(downloadManager.phase(for: track.id).isActive)
            }
        }
    }

    private var likeButton: some View {
        Button(action: {
            Haptics.impact(.soft)
            onLike?()
        }) {
            Image(systemName: isLiked ? "heart.fill" : "heart")
                .musaicFont(size: 15)
                .foregroundStyle(isLiked ? Color.accentStrong : Color.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .contentTransition(.symbolEffect(.replace.downUp))
                .musaicBounce(value: isLiked)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: isLiked)
        .accessibilityLabel(Text(isLiked ? String(localized: "Unlike") : String(localized: "Like")))
    }

    /// Row fill colour varies by state. Hover brightens the row on macOS
    /// (the gesture is a no-op on iOS, so isHovered stays false there).
    private var rowBackgroundColor: Color {
        if isCurrent { return Color.white.opacity(0.12) }
        if isHovered { return Color.white.opacity(0.09) }
        return Color.white.opacity(0.05)
    }

    // MARK: - Entrance

    private func playEntranceIfNeeded() {
        guard !appeared else { return }
        let firstAppearance = RowEntranceRegistry.shared.shouldAnimate("\(track.id)#\(index)")
        if reduceMotion || !firstAppearance {
            appeared = true
        } else {
            withAnimation(.easeOut(duration: 0.2).delay(staggerDelay)) {
                appeared = true
            }
        }
    }
}

/// Download control for a row. Reads only this track's phase; live progress
/// is observed by the ring alone, so ticks re-render nothing else.
private struct TrackDownloadButton: View {
    let track: Track
    private let downloadManager = DownloadManager.shared

    var body: some View {
        switch downloadManager.phase(for: track.id) {
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .musaicFont(size: 14)
                .foregroundStyle(.green.opacity(0.7))
                .frame(width: 44, height: 44)
                .accessibilityLabel(Text(String(localized: "Downloaded")))
        case .downloading:
            DownloadProgressRing(progress: downloadManager.progress(for: track.id))
                .frame(width: 44, height: 44)
                .accessibilityLabel(Text(String(localized: "Downloading")))
        case .failed(let message):
            Button {
                downloadManager.downloadTrack(track)
            } label: {
                Image(systemName: "exclamationmark.circle")
                    .musaicFont(size: 14)
                    .foregroundStyle(.red.opacity(0.7))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(message)
            .accessibilityLabel(Text(String(localized: "Download failed, tap to retry")))
        case .idle:
            Button {
                downloadManager.downloadTrack(track)
            } label: {
                Image(systemName: "arrow.down.circle")
                    .musaicFont(size: 14)
                    .foregroundStyle(Color.textSecondary.opacity(0.5))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Download track")))
        }
    }
}

private struct DownloadProgressRing: View {
    let progress: DownloadProgress

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.12), lineWidth: 2)
            Circle()
                .trim(from: 0, to: max(0.04, progress.fraction))
                .stroke(Color.accentStrong, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 16, height: 16)
        .accessibilityValue(Text("\(Int(progress.fraction * 100))%"))
    }
}

extension View {
    /// Opts a scroll container into the system swipe actions so its rows can
    /// declare `.swipeActions` (iOS 27 / macOS 27). On older SDKs or OS versions
    /// this is a no-op and the rows fall back to their context menu.
    @ViewBuilder
    func musaicSwipeContainer() -> some View {
        #if compiler(>=6.3)
        if #available(iOS 27.0, macOS 27.0, *) {
            swipeActionsContainer()
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// Process-wide registry so the entrance stagger plays once per row even
/// though LazyVStack drops and recreates rows while scrolling.
@MainActor
private final class RowEntranceRegistry {
    static let shared = RowEntranceRegistry()
    private var animated: Set<String> = []

    private init() {}

    func shouldAnimate(_ id: String) -> Bool {
        guard !animated.contains(id) else { return false }
        animated.insert(id)
        return true
    }
}

struct QueueTrackRow: View {
    let track: Track
    let index: Int
    let isCurrent: Bool
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if isCurrent {
                Image(systemName: "speaker.wave.2.fill")
                    .musaicFont(size: 12)
                    .foregroundStyle(Color.accentStrong)
                    .frame(width: 20)
            } else {
                Text("\(index + 1)")
                    .font(.caption2)
                    .foregroundStyle(Color.textMuted)
                    .frame(width: 20)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .musaicFont(size: 14, weight: isCurrent ? .bold : .medium)
                    .foregroundStyle(isCurrent ? Color.accentStrong : Color.textPrimary)
                    .lineLimit(1)
                Text(track.artist)
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if let dur = track.duration {
                Text(formatDuration(dur))
                    .font(.caption2)
                    .foregroundStyle(Color.textMuted)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }
}

struct ImportTrackRow: View {
    let match: ImportMatch

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                switch match.confidence {
                case "high":
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case "medium":
                    Image(systemName: "checkmark.circle")
                        .foregroundStyle(.yellow)
                default:
                    Image(systemName: "xmark.circle")
                        .foregroundStyle(.red.opacity(0.6))
                }
            }
            .musaicFont(size: 16)
            .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(match.title)
                    .musaicFont(size: 14, weight: .medium)
                    .foregroundStyle(match.confidence != "none" ? Color.textPrimary : Color.textMuted)
                    .lineLimit(1)
                Text(match.artist)
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                if let matchSource = match.matchSource {
                    Text("Found on \(matchSource)")
                        .musaicFont(size: 10, weight: .semibold)
                        .foregroundStyle(Color.textSecondary.opacity(0.7))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let dur = match.durationSec {
                Text(formatDuration(TimeInterval(dur)))
                    .font(.caption2)
                    .foregroundStyle(Color.textMuted)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(match.confidence != "none" ? Color.white.opacity(0.05) : Color.white.opacity(0.02))
        )
        .padding(.horizontal, 16)
    }
}
