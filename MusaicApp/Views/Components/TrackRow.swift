import SwiftUI
import ImageIO

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

                // Download button/indicator
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
                .accessibilityLabel(isLiked ? "Unlike" : "Like")
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
                    Label("Add to Playlist", systemImage: "text.badge.plus")
                }
            }
            if let onAddToQueue {
                Button { onAddToQueue() } label: {
                    Label("Add to Queue", systemImage: "text.append")
                }
            }
            if downloadManager.isDownloaded(track.id) {
                Button(role: .destructive) {
                    downloadManager.deleteDownload(trackId: track.id)
                } label: {
                    Label("Remove Download", systemImage: "trash")
                }
            } else {
                Button {
                    downloadManager.downloadTrack(track)
                } label: {
                    Label("Download (AAC 128k)", systemImage: "arrow.down.circle")
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
                .accessibilityLabel("Downloaded")
        case .downloading:
            ProgressView()
                .scaleEffect(0.6)
                .frame(width: 32, height: 32)
                .accessibilityLabel("Downloading")
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
            .accessibilityLabel("Download failed, tap to retry")
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
            .accessibilityLabel("Download track")
        }
    }
}

private enum ArtworkDebugPhase: Equatable {
    case idle
    case missingURL
    case invalidURL
    case loading
    case cached
    case loaded
    case failed

    var label: String {
        switch self {
        case .idle: return "Idle"
        case .missingURL: return "Missing URL"
        case .invalidURL: return "Invalid URL"
        case .loading: return "Loading"
        case .cached: return "Loaded from cache"
        case .loaded: return "Loaded"
        case .failed: return "Failed"
        }
    }
}

private struct ArtworkDebugSnapshot {
    var phase: ArtworkDebugPhase = .idle
    var rawURL: String?
    var resolvedURL: String?
    var statusCode: Int?
    var byteCount: Int?
    var imageSize: String?
    var errorMessage: String?
}

enum ArtworkImageCache {
    nonisolated(unsafe) static let shared: NSCache<NSString, PlatformImage> = {
        let cache = NSCache<NSString, PlatformImage>()
        cache.countLimit = 320
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()
}

struct ArtworkLoadResult {
    let image: PlatformImage
    let statusCode: Int?
    let byteCount: Int?
    let cacheHit: Bool
}

actor ArtworkPipeline {
    static let shared = ArtworkPipeline()

    private var inflight: [String: Task<ArtworkLoadResult, Error>] = [:]
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        configuration.urlCache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 128 * 1024 * 1024,
            diskPath: "musaic-artwork-cache"
        )
        session = URLSession(configuration: configuration)
    }

    func loadImage(from url: URL, maxPixelSize: Int) async throws -> ArtworkLoadResult {
        let cacheKey = "\(url.absoluteString)|\(maxPixelSize)" as NSString
        if let cached = ArtworkImageCache.shared.object(forKey: cacheKey) {
            return ArtworkLoadResult(image: cached, statusCode: nil, byteCount: nil, cacheHit: true)
        }

        let requestKey = cacheKey as String
        if let inflightTask = inflight[requestKey] {
            return try await inflightTask.value
        }

        let task = Task<ArtworkLoadResult, Error> { [session] in
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            request.timeoutInterval = 20

            let (data, response) = try await session.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            if let statusCode, !(200..<300).contains(statusCode) {
                throw URLError(.badServerResponse)
            }

            guard let image = Self.downsampledImage(from: data, maxPixelSize: maxPixelSize) else {
                throw CocoaError(.fileReadCorruptFile)
            }

            let cost = Self.imageCost(for: image)
            ArtworkImageCache.shared.setObject(image, forKey: cacheKey, cost: cost)
            return ArtworkLoadResult(image: image, statusCode: statusCode, byteCount: data.count, cacheHit: false)
        }

        inflight[requestKey] = task
        defer { inflight[requestKey] = nil }
        return try await task.value
    }

    private static func downsampledImage(from data: Data, maxPixelSize: Int) -> PlatformImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return PlatformImage.platformImage(from: data)
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(64, maxPixelSize),
        ]

        if let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) {
            return PlatformImage.platformImage(cgImage: cgImage)
        }

        return PlatformImage.platformImage(from: data)
    }

    private static func imageCost(for image: PlatformImage) -> Int {
        let scale = image.platformScale
        let pixels = Int(image.platformSize.width * scale * image.platformSize.height * scale)
        return pixels * 4
    }
}

struct InspectableArtworkView<Placeholder: View>: View {
    let urlString: String?
    let debugLabel: String
    let contentMode: ContentMode
    let maxPixelSize: Int
    let placeholder: () -> Placeholder

    @State private var image: PlatformImage?
    @State private var loadedURL: String?
    @State private var debugSnapshot = ArtworkDebugSnapshot()
    #if DEBUG
    @State private var showDebugSheet = false
    #endif

    init(
        urlString: String?,
        debugLabel: String,
        contentMode: ContentMode = .fill,
        maxPixelSize: Int = 720,
        @ViewBuilder placeholder: @escaping () -> Placeholder
    ) {
        self.urlString = urlString
        self.debugLabel = debugLabel
        self.contentMode = contentMode
        self.maxPixelSize = maxPixelSize
        self.placeholder = placeholder
    }

    var body: some View {
        ZStack {
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: urlString) {
            if let currentURL = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
               currentURL == loadedURL,
               image != nil {
                return
            }
            await loadArtwork()
        }
    }

    private func loadArtwork() async {
        await MainActor.run {
            debugSnapshot = ArtworkDebugSnapshot(rawURL: urlString)
        }

        guard let raw = urlString?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            await MainActor.run {
                image = nil
                loadedURL = nil
                debugSnapshot.phase = .missingURL
                logDebugEvent()
            }
            return
        }

        guard let url = URL(string: raw) else {
            await MainActor.run {
                image = nil
                loadedURL = nil
                debugSnapshot.phase = .invalidURL
                debugSnapshot.resolvedURL = raw
                logDebugEvent()
            }
            return
        }

        await MainActor.run {
            debugSnapshot.resolvedURL = url.absoluteString
        }

        let isAlreadyLoaded = await MainActor.run {
            url.absoluteString == loadedURL && image != nil
        }

        if isAlreadyLoaded {
            await MainActor.run {
                debugSnapshot.phase = .loaded
            }
            return
        }

        await MainActor.run {
            debugSnapshot.phase = .loading
        }

        do {
            let result = try await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: maxPixelSize)
            guard !Task.isCancelled else { return }

            await MainActor.run {
                image = result.image
                loadedURL = url.absoluteString
                debugSnapshot.statusCode = result.statusCode
                debugSnapshot.byteCount = result.byteCount
                debugSnapshot.phase = result.cacheHit ? .cached : .loaded
                debugSnapshot.imageSize = imageSizeString(for: result.image)
                logDebugEvent()
            }
        } catch {
            guard !Task.isCancelled else { return }
            await MainActor.run {
                image = nil
                loadedURL = nil
                debugSnapshot.phase = .failed
                debugSnapshot.errorMessage = error.localizedDescription
                logDebugEvent()
            }
        }
    }

    private func imageSizeString(for image: PlatformImage) -> String {
        "\(Int(image.platformSize.width))x\(Int(image.platformSize.height))"
    }

    private func logDebugEvent() {
        #if DEBUG
        let status = debugSnapshot.statusCode.map(String.init) ?? "-"
        let bytes = debugSnapshot.byteCount.map(String.init) ?? "-"
        let raw = debugSnapshot.rawURL ?? "nil"
        let resolved = debugSnapshot.resolvedURL ?? "nil"
        let error = debugSnapshot.errorMessage ?? "nil"
        print("[ArtworkDebug] \(debugLabel) phase=\(debugSnapshot.phase.label) status=\(status) bytes=\(bytes) raw=\(raw) resolved=\(resolved) error=\(error)")
        #endif
    }
}

#if DEBUG
private struct ArtworkDebugSheet: View {
    let label: String
    let snapshot: ArtworkDebugSnapshot

    var body: some View {
        NavigationStack {
            List {
                debugRow(title: "Item", value: label)
                debugRow(title: "Phase", value: snapshot.phase.label)
                debugRow(title: "Raw URL", value: snapshot.rawURL ?? "nil")
                debugRow(title: "Resolved URL", value: snapshot.resolvedURL ?? "nil")
                debugRow(title: "HTTP", value: snapshot.statusCode.map(String.init) ?? "n/a")
                debugRow(title: "Bytes", value: snapshot.byteCount.map(String.init) ?? "n/a")
                debugRow(title: "Image", value: snapshot.imageSize ?? "n/a")
                debugRow(title: "Error", value: snapshot.errorMessage ?? "none")
            }
            .navigationTitle("Artwork Debug")
            .navigationBarTitleDisplayModeCompat()
        }
    }

    @ViewBuilder
    private func debugRow(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .textSelection(.enabled)
        }
        .padding(.vertical, 4)
    }
}
#endif

// MARK: - Playing Indicator

struct PlayingIndicator: View {
    @State private var animate = false

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<3) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accent)
                    .frame(width: 3, height: animate ? CGFloat.random(in: 6...14) : 4)
                    .animation(
                        .easeInOut(duration: 0.4)
                        .repeatForever(autoreverses: true)
                        .delay(Double(i) * 0.15),
                        value: animate
                    )
            }
        }
        .onAppear { animate = true }
    }
}

// MARK: - Helpers

extension Track.TrackSource {
    /// Colour of the tiny source badge dot at the track row artwork corner.
    /// Brand-derived hues, slightly softened to sit well on the dark warm UI.
    var dotColor: Color {
        switch self {
        case .local: return Color.accentStrong
        case .vk: return Color(hex: "4c8dff")
        case .soundcloud: return Color(hex: "ff6a33")
        case .yandex: return Color(hex: "ffcc33")
        case .youtube: return Color(hex: "ff4d4d")
        }
    }
}

func formatDuration(_ seconds: TimeInterval) -> String {
    guard seconds.isFinite, !seconds.isNaN else { return "0:00" }
    let s = Int(max(0, seconds))
    return "\(s / 60):\(String(format: "%02d", s % 60))"
}
