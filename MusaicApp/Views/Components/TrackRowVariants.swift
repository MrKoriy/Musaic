import SwiftUI

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
    /// Stagger entrance flag — rows fade/rise in with a 30ms per-item delay
    /// (DESIGN.md §10: "Track list item appear — stagger fade-in, 200ms ease-out").
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let downloadManager = DownloadManager.shared

    /// 30ms per row, capped so deep rows in long lists don't wait seconds.
    private var staggerDelay: Double {
        Double(min(max(index - 1, 0), 12)) * 0.03
    }

    var body: some View {
        Button(action: { onTap?() }) {
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
            .animation(.easeOut(duration: 0.25), value: isCurrent)
            .animation(.easeOut(duration: 0.18), value: isHovered)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("\(track.title), \(track.artist)"))
        .accessibilityHint(Text(String(localized: "Plays this track")))
        .padding(.horizontal, 16)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 8)
        .onAppear {
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.easeOut(duration: 0.2).delay(staggerDelay)) {
                    appeared = true
                }
            }
        }
        .onHover { hovering in isHovered = hovering }
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
