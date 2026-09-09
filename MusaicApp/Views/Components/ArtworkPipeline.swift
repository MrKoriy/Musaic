import SwiftUI
import ImageIO

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

struct ArtworkLoadResult: @unchecked Sendable {
    let image: PlatformImage
    let statusCode: Int?
    let byteCount: Int?
    let cacheHit: Bool
}

actor ArtworkPipeline {
    static let shared = ArtworkPipeline()

    private var inflight: [String: Task<ArtworkLoadResult, Error>] = [:]
    private let session: URLSession
    private let imageCache: NSCache<NSString, PlatformImage>

    // Opening a 1000-track playlist used to fire a 1000-image fetch storm.
    // Cap concurrent network+decode work; queued loads wait for a free slot.
    private let maxConcurrentLoads = 12
    private var activeLoads = 0
    private var loadWaiters: [CheckedContinuation<Void, Never>] = []

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
        let imageCache = NSCache<NSString, PlatformImage>()
        imageCache.countLimit = 320
        imageCache.totalCostLimit = 96 * 1024 * 1024
        self.imageCache = imageCache
    }

    private func acquireLoadSlot() async {
        if activeLoads < maxConcurrentLoads {
            activeLoads += 1
            return
        }
        await withCheckedContinuation { loadWaiters.append($0) }
        activeLoads += 1
    }

    private func releaseLoadSlot() {
        if let waiter = loadWaiters.first {
            loadWaiters.removeFirst()
            waiter.resume()
        } else {
            activeLoads -= 1
        }
    }

    func loadImage(from url: URL, maxPixelSize: Int) async throws -> ArtworkLoadResult {
        let fetchURL = Self.unwrappedArtworkURL(url)
        let cacheKey = "\(fetchURL.absoluteString)|\(maxPixelSize)" as NSString
        if let cached = imageCache.object(forKey: cacheKey) {
            return ArtworkLoadResult(image: cached, statusCode: nil, byteCount: nil, cacheHit: true)
        }

        let requestKey = cacheKey as String
        if let inflightTask = inflight[requestKey] {
            return try await inflightTask.value
        }

        await acquireLoadSlot()
        let task = Task<ArtworkLoadResult, Error> { [session] in
            defer { Task { await Self.shared.releaseLoadSlot() } }
            // Rows that scrolled out of view cancel their load; bail before
            // spending a slot on a download nobody needs.
            if Task.isCancelled { throw CancellationError() }
            var request = URLRequest(url: fetchURL)
            request.cachePolicy = .returnCacheDataElseLoad
            request.timeoutInterval = 20
            if url.path.hasPrefix("/api/artwork") || url.path.hasPrefix("/api/covers") {
                request = await MainActor.run { APIService.shared.authenticatedRequest(for: url) }
                // Upstream sends Cache-Control: max-age=86400,immutable — honor
                // it so scrolling a 1000-track list never re-downloads covers.
                request.cachePolicy = .useProtocolCachePolicy
            } else if url.path.hasPrefix("/api/playlists/") && url.path.hasSuffix("/image") {
                // Custom playlist covers can change; never serve a stale one.
                request.cachePolicy = .reloadIgnoringLocalCacheData
            }

            let (data, response) = try await session.data(for: request)
            if Task.isCancelled { throw CancellationError() }
            guard data.count <= 5 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            if let statusCode, !(200..<300).contains(statusCode) {
                throw URLError(.badServerResponse)
            }

            guard let image = Self.downsampledImage(from: data, maxPixelSize: maxPixelSize) else {
                throw CocoaError(.fileReadCorruptFile)
            }

            let cost = Self.imageCost(for: image)
            imageCache.setObject(image, forKey: cacheKey, cost: cost)
            return ArtworkLoadResult(image: image, statusCode: statusCode, byteCount: data.count, cacheHit: false)
        }

        inflight[requestKey] = task
        defer { inflight[requestKey] = nil }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
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

    /// Collapse legacy nested /api/artwork?url=/api/artwork?url=... chains that
    /// were persisted into cached liked tracks — down to the innermost proxy URL.
    /// The server also unwraps, but this keeps request URLs short (NSURLError -1013).
    private static func unwrappedArtworkURL(_ url: URL) -> URL {
        guard url.path.hasPrefix("/api/artwork") else { return url }
        var current = url
        for _ in 0..<10 {
            guard let components = URLComponents(url: current, resolvingAgainstBaseURL: false),
                  let innerRaw = components.queryItems?.first(where: { $0.name == "url" })?.value,
                  let inner = URL(string: innerRaw),
                  inner.path.hasPrefix("/api/artwork") else { return current }
            current = inner
        }
        return current
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
