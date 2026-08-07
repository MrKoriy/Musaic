import Foundation

// MARK: - Download Manager

struct DownloadedTrack: Codable {
    let trackId: String
    let fileName: String
    let sizeBytes: Int64
    let downloadedAt: Date
    let bitrate: Int
}

enum DownloadState: Equatable {
    case idle
    case downloading(progress: Double)
    case completed
    case failed(String)

    var isActive: Bool {
        if case .downloading = self { return true }
        return false
    }
}

@Observable
final class DownloadManager: @unchecked Sendable {
    static let shared = DownloadManager()

    private let api = APIService.shared
    private let storageKey = "downloaded_tracks"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let bitrate = 128

    private(set) var downloads: [String: DownloadedTrack] = [:]
    private(set) var activeDownloads: [String: DownloadState] = [:]

    var totalSizeBytes: Int64 {
        downloads.values.reduce(0) { $0 + $1.sizeBytes }
    }

    var totalSizeFormatted: String {
        ByteCountFormatter.string(fromByteCount: totalSizeBytes, countStyle: .file)
    }

    var downloadCount: Int { downloads.count }

    var downloadedTrackIds: Set<String> {
        Set(downloads.keys.filter { isDownloaded($0) })
    }

    private init() {
        loadDownloads()
        Task.detached(priority: .utility) { [weak self] in
            await self?.cleanupOrphansAsync()
        }
    }

    // MARK: - Public API

    func isDownloaded(_ trackId: String) -> Bool {
        guard let dl = downloads[trackId] else { return false }
        return FileManager.default.fileExists(atPath: localFilePath(for: dl.fileName))
    }

    func localFileURL(for trackId: String) -> URL? {
        guard let dl = downloads[trackId] else { return nil }
        let path = localFilePath(for: dl.fileName)
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        return URL(fileURLWithPath: path)
    }

    func downloadState(for trackId: String) -> DownloadState {
        activeDownloads[trackId] ?? (isDownloaded(trackId) ? .completed : .idle)
    }

    @MainActor
    func downloadTrack(_ track: Track) {
        let state = downloadState(for: track.id)
        guard !state.isActive && state != .completed else { return }

        activeDownloads[track.id] = .downloading(progress: 0)

        Task.detached { [weak self] in
            await self?.performDownload(track)
        }
    }

    func deleteDownload(trackId: String) {
        guard let dl = downloads[trackId] else { return }
        let path = localFilePath(for: dl.fileName)
        try? FileManager.default.removeItem(atPath: path)
        downloads.removeValue(forKey: trackId)
        activeDownloads.removeValue(forKey: trackId)
        saveDownloads()
    }

    func deleteAllDownloads() {
        for dl in downloads.values {
            try? FileManager.default.removeItem(atPath: localFilePath(for: dl.fileName))
        }
        downloads.removeAll()
        activeDownloads.removeAll()
        saveDownloads()
    }

    // MARK: - Download Logic

    private func performDownload(_ track: Track) async {
        let trackId = track.id
        // Use the same encoding as APIService.encodedTrackID — strips / from urlPathAllowed
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let encodedId = trackId.addingPercentEncoding(withAllowedCharacters: allowed) ?? trackId
        let urlString = "\(api.serverURL)/api/downloads/compressed/\(encodedId)?bitrate=\(bitrate)"
        guard let url = URL(string: urlString) else {
            await MainActor.run { activeDownloads[trackId] = .failed("Invalid URL") }
            return
        }

        let fileName = sanitizedFileName(trackId: trackId, artist: track.artist, title: track.title)

        do {
            let dir = downloadsDirectory()
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let destPath = localFilePath(for: fileName)

            // Use a delegate-based session for progress tracking
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForResource = 300
            let session = URLSession(configuration: config)

            let (tempURL, response) = try await session.download(from: url)

            guard let http = response as? HTTPURLResponse else {
                await MainActor.run { activeDownloads[trackId] = .failed("No response") }
                return
            }

            guard (200..<300).contains(http.statusCode) else {
                let body = (try? String(contentsOf: tempURL, encoding: .utf8))?.prefix(200) ?? "unknown"
                await MainActor.run { activeDownloads[trackId] = .failed("HTTP \(http.statusCode): \(body)") }
                return
            }

            let fileSize = (try? FileManager.default.attributesOfItem(atPath: tempURL.path)[.size] as? Int64) ?? 0

            if fileSize < 1000 {
                await MainActor.run { activeDownloads[trackId] = .failed("File too small (\(fileSize) bytes)") }
                return
            }

            if FileManager.default.fileExists(atPath: destPath) {
                try FileManager.default.removeItem(atPath: destPath)
            }
            try FileManager.default.moveItem(atPath: tempURL.path, toPath: destPath)

            let dl = DownloadedTrack(
                trackId: trackId,
                fileName: fileName,
                sizeBytes: fileSize,
                downloadedAt: Date(),
                bitrate: bitrate
            )

            await MainActor.run {
                downloads[trackId] = dl
                activeDownloads[trackId] = .completed
                saveDownloads()
            }
        } catch {
            await MainActor.run {
                activeDownloads[trackId] = .failed(error.localizedDescription)
            }
        }
    }

    // MARK: - Storage

    private func downloadsDirectory() -> String {
        // .documentDirectory always exists on iOS/macOS, but fall back to the temp
        // directory just in case so we never trap on app launch.
        let docs = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first
            ?? NSTemporaryDirectory()
        return (docs as NSString).appendingPathComponent("OfflineMusic")
    }

    private func localFilePath(for fileName: String) -> String {
        (downloadsDirectory() as NSString).appendingPathComponent(fileName)
    }

    private func sanitizedFileName(trackId: String, artist: String, title: String) -> String {
        let safe = "\(artist) - \(title)"
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "\\", with: "-")
            .replacingOccurrences(of: "\"", with: "")
            .prefix(80)
        // Stable hash: convert via UInt to dodge `abs(Int.min)` overflow trap.
        var hasher = Hasher()
        hasher.combine(trackId)
        let hash = UInt(bitPattern: hasher.finalize()) & 0xFFFF
        return "\(safe)_\(String(format: "%04x", hash)).m4a"
    }

    private func loadDownloads() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let stored = try? decoder.decode([String: DownloadedTrack].self, from: data) else { return }
        downloads = stored
    }

    private func saveDownloads() {
        if let data = try? encoder.encode(downloads) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }

    private func cleanupOrphansAsync() async {
        var orphanIds: [String] = []
        for (id, dl) in downloads {
            if !FileManager.default.fileExists(atPath: localFilePath(for: dl.fileName)) {
                orphanIds.append(id)
            }
        }
        if !orphanIds.isEmpty {
            await MainActor.run {
                for id in orphanIds {
                    downloads.removeValue(forKey: id)
                }
                saveDownloads()
            }
        }
    }
}
