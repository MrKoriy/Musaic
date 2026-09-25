import SwiftUI
import ImageIO

struct ArtworkLoadResult: @unchecked Sendable {
    let image: PlatformImage
    let statusCode: Int?
    let byteCount: Int?
    let cacheHit: Bool
}

/// FIFO counting semaphore for async code. A released permit is handed
/// directly to the oldest waiter; cancelled waiters leave the queue.
actor AsyncSemaphore {
    private var permits: Int
    private var waiters: [(id: UInt64, continuation: CheckedContinuation<Void, Error>)] = []
    private var nextID: UInt64 = 0

    init(permits: Int) {
        self.permits = permits
    }

    func acquire() async throws {
        try Task.checkCancellation()
        if permits > 0 {
            permits -= 1
            return
        }
        nextID &+= 1
        let id = nextID
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters.append((id, continuation))
            }
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }

    func release() {
        if waiters.isEmpty {
            permits += 1
        } else {
            waiters.removeFirst().continuation.resume()
        }
    }

    private func cancelWaiter(_ id: UInt64) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}

actor ArtworkPipeline {
    static let shared = ArtworkPipeline()

    /// A load shared by every view that wants the same image at the same size.
    private struct SharedLoad {
        let id: UInt64
        let task: Task<ArtworkLoadResult, Error>
        var waiters: Int
    }

    private var inflight: [String: SharedLoad] = [:]
    private var nextLoadID: UInt64 = 0
    private let session: URLSession
    private let urlCache: URLCache
    private let imageCache: NSCache<NSString, PlatformImage>
    /// Caps concurrent network + decode work so a 1000-row list can't start
    /// a 1000-request storm; decoding runs off this actor.
    private let loadSlots = AsyncSemaphore(permits: 8)

    init() {
        let urlCache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 128 * 1024 * 1024,
            diskPath: "musaic-artwork-cache"
        )
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        configuration.urlCache = urlCache
        self.urlCache = urlCache
        session = URLSession(configuration: configuration)
        let imageCache = NSCache<NSString, PlatformImage>()
        imageCache.countLimit = 320
        imageCache.totalCostLimit = 96 * 1024 * 1024
        self.imageCache = imageCache
    }

    /// On-disk size of the artwork HTTP cache, in bytes.
    func diskUsageBytes() -> Int {
        urlCache.currentDiskUsage
    }

    func clearCaches() {
        imageCache.removeAllObjects()
        urlCache.removeAllCachedResponses()
    }

    func loadImage(from url: URL, maxPixelSize: Int) async throws -> ArtworkLoadResult {
        let fetchURL = Self.unwrappedArtworkURL(url)
        let key = "\(fetchURL.absoluteString)|\(maxPixelSize)"
        if let cached = imageCache.object(forKey: key as NSString) {
            return ArtworkLoadResult(image: cached, statusCode: nil, byteCount: nil, cacheHit: true)
        }

        let load: SharedLoad
        if var existing = inflight[key] {
            existing.waiters += 1
            inflight[key] = existing
            load = existing
        } else {
            nextLoadID &+= 1
            let request = Self.makeRequest(for: fetchURL)
            let task = Task.detached(priority: Task.currentPriority) { [session, loadSlots] in
                try await loadSlots.acquire()
                do {
                    let result = try await Self.fetchAndDecode(request, session: session, maxPixelSize: maxPixelSize)
                    await loadSlots.release()
                    return result
                } catch {
                    await loadSlots.release()
                    throw error
                }
            }
            load = SharedLoad(id: nextLoadID, task: task, waiters: 1)
            inflight[key] = load
        }

        let loadID = load.id
        let task = load.task
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                Task { await self.leave(key: key, loadID: loadID) }
            }
            finish(key: key, loadID: loadID, result: result)
            return result
        } catch {
            finish(key: key, loadID: loadID, result: nil)
            throw error
        }
    }

    /// A view stopped waiting; the shared load is cancelled only when nobody is left.
    private func leave(key: String, loadID: UInt64) {
        guard var load = inflight[key], load.id == loadID else { return }
        load.waiters -= 1
        if load.waiters <= 0 {
            load.task.cancel()
            inflight[key] = nil
        } else {
            inflight[key] = load
        }
    }

    private func finish(key: String, loadID: UInt64, result: ArtworkLoadResult?) {
        if let result, !result.cacheHit {
            imageCache.setObject(result.image, forKey: key as NSString, cost: Self.imageCost(for: result.image))
        }
        if inflight[key]?.id == loadID {
            inflight[key] = nil
        }
    }

    private static func makeRequest(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        request.timeoutInterval = 20
        if url.path.hasPrefix("/api/artwork") || url.path.hasPrefix("/api/covers") {
            // Upstream sends Cache-Control: max-age=86400,immutable — honor
            // it so scrolling a 1000-track list never re-downloads covers.
            request.cachePolicy = .useProtocolCachePolicy
        } else if url.path.hasPrefix("/api/playlists/") && url.path.hasSuffix("/image") {
            // Custom playlist covers can change; never serve a stale one.
            request.cachePolicy = .reloadIgnoringLocalCacheData
        }
        APICredentials.shared.authorize(&request)
        return request
    }

    private static func fetchAndDecode(_ request: URLRequest, session: URLSession, maxPixelSize: Int) async throws -> ArtworkLoadResult {
        try Task.checkCancellation()
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard data.count <= 5 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
        let statusCode = (response as? HTTPURLResponse)?.statusCode
        if let statusCode, !(200..<300).contains(statusCode) {
            throw URLError(.badServerResponse)
        }
        guard let image = downsampledImage(from: data, maxPixelSize: maxPixelSize) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return ArtworkLoadResult(image: image, statusCode: statusCode, byteCount: data.count, cacheHit: false)
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

    /// Pixel sizes are bucketed so nearby display sizes share one cache entry.
    static func bucketedPixelSize(for points: CGFloat, scale: CGFloat) -> Int {
        let pixels = Int((points * max(scale, 1)).rounded(.up))
        for bucket in [96, 160, 256, 384, 512, 768, 1024] where pixels <= bucket {
            return bucket
        }
        return 1280
    }
}

struct InspectableArtworkView<Placeholder: View>: View {
    let urlString: String?
    let debugLabel: String
    let contentMode: ContentMode
    let maxPixelSize: Int
    let placeholder: () -> Placeholder

    @State private var image: PlatformImage?
    @State private var loadedKey: LoadKey?

    private struct LoadKey: Hashable {
        let url: String
        let maxPixelSize: Int
    }

    init(
        urlString: String?,
        debugLabel: String = "",
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

    private var requestKey: LoadKey? {
        guard let raw = urlString?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, maxPixelSize > 0 else {
            return nil
        }
        return LoadKey(url: raw, maxPixelSize: maxPixelSize)
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
        .task(id: requestKey) {
            await load(requestKey)
        }
    }

    private func load(_ key: LoadKey?) async {
        guard let key else {
            // Unknown size (first layout pass) keeps whatever is shown.
            if (urlString?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty {
                image = nil
                loadedKey = nil
            }
            return
        }
        guard key != loadedKey || image == nil else { return }
        guard let url = URL(string: key.url) else {
            image = nil
            loadedKey = nil
            return
        }

        do {
            let result = try await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: key.maxPixelSize)
            guard !Task.isCancelled else { return }
            image = result.image
            loadedKey = key
        } catch {
            guard !Task.isCancelled, !error.isCancellation else { return }
            // Keep a previously shown (e.g. smaller) image when only the size changed.
            if loadedKey?.url != key.url {
                image = nil
                loadedKey = nil
            }
            #if DEBUG
            print("[Artwork] \(debugLabel) failed: \(key.url) — \(error.localizedDescription)")
            #endif
        }
    }
}
