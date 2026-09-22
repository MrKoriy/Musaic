import SwiftUI
#if os(iOS)
import UIKit
#endif

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
///   playlist on the trailing edge). Implemented with a plain drag gesture so it
///   works in every container on iOS 17+/macOS 15+ — no List required.
struct TrackRow: View {
    let track: Track
    let index: Int
    var isCurrent: Bool = false
    var isLiked: Bool = false
    var onTap: (() -> Void)?
    var onLike: (() -> Void)?
    var onAddToQueue: (() -> Void)?
    var onAddToPlaylist: (() -> Void)?

    /// macOS-only hover state — iOS never fires `.onHover`, so the default
    /// false value silently no-ops there.
    @State private var isHovered = false
    /// Stagger entrance flag — rows fade/rise in with a 30ms per-item delay.
    @State private var appeared = false
    /// Swipe-reveal offset of the row content (negative = trailing actions open).
    @State private var swipeOffset: CGFloat = 0
    @State private var dragStartOffset: CGFloat?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let downloadManager = DownloadManager.shared

    private let actionSize: CGFloat = 64
    private var leadingActionsWidth: CGFloat { onLike != nil ? actionSize : 0 }
    private var trailingActionsWidth: CGFloat {
        ((onAddToQueue != nil ? 1 : 0) + (onAddToPlaylist != nil ? 1 : 0)) * actionSize
    }

    /// 30ms per row, capped so deep rows in long lists don't wait seconds.
    private var staggerDelay: Double {
        Double(min(max(index - 1, 0), 12)) * 0.03
    }

    var body: some View {
        ZStack {
            if swipeOffset != 0 {
                swipeActions
            }
            rowContent
                .offset(x: swipeOffset)
        }
        .simultaneousGesture(swipeGesture)
        .padding(.horizontal, 16)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 8)
        .onAppear(perform: playEntranceIfNeeded)
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
                            .font(.system(size: 16, weight: .medium))
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
                    .lineLimit(1)
                Text(track.artist)
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let dur = track.duration {
                Text(formatDuration(dur))
                    .font(.caption2)
                    .foregroundStyle(Color.textMuted)
                    .frame(width: 38, alignment: .trailing)
            }

            downloadButton

            likeButton
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(rowBackgroundColor)
                .background(
                    // Opaque scrim so the swipe actions behind the row don't
                    // shine through the translucent fill while swiping.
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.bgPrimary.opacity(swipeOffset == 0 ? 0 : 0.92))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color.white.opacity(isCurrent ? 0.15 : (isHovered ? 0.12 : 0.06)), lineWidth: 0.5)
        )
        .animation(.easeOut(duration: 0.25), value: isCurrent)
        .animation(.easeOut(duration: 0.18), value: isHovered)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture {
            if swipeOffset != 0 {
                closeSwipe()
            } else {
                onTap?()
            }
        }
        .onHover { hovering in isHovered = hovering }
        .accessibilityLabel(Text("\(track.title), \(track.artist)"))
        .accessibilityHint(Text(String(localized: "Plays this track")))
        .contextMenu {
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
                    Label(String(localized: "Download (AAC 128k)"), systemImage: "arrow.down.circle")
                }
            }
        }
    }

    private var likeButton: some View {
        Button(action: {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            #endif
            onLike?()
        }) {
            Image(systemName: isLiked ? "heart.fill" : "heart")
                .font(.system(size: 15))
                .foregroundStyle(isLiked ? Color.accentStrong : Color.textSecondary)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
                .contentTransition(.symbolEffect(.replace.downUp))
                .symbolEffect(.bounce.up.byLayer, value: isLiked)
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

    @ViewBuilder
    private var downloadButton: some View {
        let state = downloadManager.downloadState(for: track.id)
        switch state {
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.green.opacity(0.7))
                .frame(width: 32, height: 32)
                .accessibilityLabel(Text(String(localized: "Downloaded")))
        case .downloading:
            ProgressView()
                .scaleEffect(0.6)
                .frame(width: 32, height: 32)
                .accessibilityLabel(Text(String(localized: "Downloading")))
        case .failed:
            Button {
                downloadManager.downloadTrack(track)
            } label: {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 14))
                    .foregroundStyle(.red.opacity(0.7))
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Download failed, tap to retry")))
        case .idle:
            Button {
                downloadManager.downloadTrack(track)
            } label: {
                Image(systemName: "arrow.down.circle")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.textSecondary.opacity(0.5))
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Download track")))
        }
    }

    // MARK: - Swipe actions

    private var swipeActions: some View {
        HStack(spacing: 0) {
            if onLike != nil {
                swipeActionButton(
                    systemName: isLiked ? "heart.fill" : "heart",
                    tint: isLiked ? Color.accentStrong : Color.textPrimary,
                    label: String(localized: "Like")
                ) {
                    closeSwipe()
                    #if os(iOS)
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    #endif
                    onLike?()
                }
                .frame(width: actionSize)
            }
            Spacer(minLength: 0)
            if let onAddToPlaylist {
                swipeActionButton(systemName: "text.badge.plus", tint: Color.textPrimary, label: String(localized: "Add to Playlist")) {
                    closeSwipe()
                    onAddToPlaylist()
                }
                .frame(width: actionSize)
            }
            if let onAddToQueue {
                swipeActionButton(systemName: "text.append", tint: Color.textPrimary, label: String(localized: "Add to Queue")) {
                    closeSwipe()
                    onAddToQueue()
                }
                .frame(width: actionSize)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func swipeActionButton(
        systemName: String,
        tint: Color,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height
                // Vertical intent → let the enclosing list scroll.
                guard abs(dx) > abs(dy) else { return }
                if dragStartOffset == nil { dragStartOffset = swipeOffset }
                let base = dragStartOffset ?? 0
                swipeOffset = min(max(base + dx, -trailingActionsWidth), leadingActionsWidth)
            }
            .onEnded { value in
                defer { dragStartOffset = nil }
                let dx = value.translation.width
                guard abs(dx) > abs(value.translation.height) else {
                    withAnimation(.easeOut(duration: 0.2)) { swipeOffset = 0 }
                    return
                }
                withAnimation(.easeOut(duration: 0.22)) {
                    if swipeOffset < -actionSize * 0.5 {
                        swipeOffset = -trailingActionsWidth
                    } else if swipeOffset > actionSize * 0.5 {
                        swipeOffset = leadingActionsWidth
                    } else {
                        swipeOffset = 0
                    }
                }
            }
    }

    private func closeSwipe() {
        withAnimation(.easeOut(duration: 0.2)) { swipeOffset = 0 }
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
                    .font(.system(size: 12))
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
                    .font(.system(size: 14, weight: isCurrent ? .bold : .medium))
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
            .font(.system(size: 16))
            .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(match.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(match.confidence != "none" ? Color.textPrimary : Color.textMuted)
                    .lineLimit(1)
                Text(match.artist)
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                if let matchSource = match.matchSource {
                    Text("Found on \(matchSource)")
                        .font(.system(size: 10, weight: .semibold))
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
