import CryptoKit
import Foundation

// MARK: - Download Manager

struct DownloadedTrack: Codable, Sendable {
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

/// Live progress of one download. Only the view showing this track observes
/// it, so progress ticks don't invalidate every row in a list.
@Observable
@MainActor
final class DownloadProgress {
    var fraction: Double = 0
}

/// Metadata carried in `URLSessionTask.taskDescription`, so downloads that
/// finish after a relaunch can still be filed under the right track.
private struct DownloadTaskInfo: Codable, Sendable {
    let trackId: String
    let artist: String
    let title: String
    let bitrate: Int

    init(trackId: String, artist: String, title: String, bitrate: Int) {
        self.trackId = trackId
        self.artist = artist
        self.title = title
        self.bitrate = bitrate
    }

    init?(task: URLSessionTask) {
        guard let data = task.taskDescription?.data(using: .utf8),
              let info = try? JSONDecoder().decode(DownloadTaskInfo.self, from: data) else { return nil }
        self = info
    }

    var encoded: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }
}

private enum DownloadOutcome: Sendable {
    case success(fileName: String, sizeBytes: Int64)
    case failure(String)
}

private struct MaintenanceResult: Sendable {
    var renamed: [String: String] = [:]
    var missing: Set<String> = []
}

@Observable
@MainActor
final class DownloadManager {
    static let shared = DownloadManager()
    static let sessionIdentifier = "\(Bundle.main.bundleIdentifier ?? "com.leonid.musaic").downloads"

    private let api = APIService.shared
    private let bitrate = 128

    private(set) var downloads: [String: DownloadedTrack] = [:]
    /// Cached so rows can check "downloaded" without touching the disk.
    private(set) var downloadedTrackIds: Set<String> = []
    /// Phase per track (`.downloading` carries 0; live progress lives in `DownloadProgress`).
    private(set) var activeDownloads: [String: DownloadState] = [:]

    @ObservationIgnored private var progressByTrack: [String: DownloadProgress] = [:]
    @ObservationIgnored private var lastProgressEventAt: [String: Date] = [:]
    @ObservationIgnored private var cancelledTrackIds: Set<String> = []
    @ObservationIgnored private var backgroundCompletionHandler: (() -> Void)?
    @ObservationIgnored private var backgroundEventsFinishedEarly = false
    @ObservationIgnored private let manifest = JSONFileStore<[String: DownloadedTrack]>(fileName: "downloads.json")
    @ObservationIgnored private let session: URLSession

    var totalSizeBytes: Int64 {
        downloads.values.reduce(0) { $0 + $1.sizeBytes }
    }

    var totalSizeFormatted: String {
        ByteCountFormatter.string(fromByteCount: totalSizeBytes, countStyle: .file)
    }

    var downloadCount: Int { downloads.count }

    private init() {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        session = URLSession(configuration: configuration, delegate: DownloadSessionDelegate(), delegateQueue: nil)

        loadManifest()
        runMaintenance()
        reconnectRunningTasks()
    }

    // MARK: - Public API

    func isDownloaded(_ trackId: String) -> Bool {
        downloadedTrackIds.contains(trackId)
    }

    func localFileURL(for trackId: String) -> URL? {
        guard let download = downloads[trackId] else { return nil }
        return DownloadStorage.existingFileURL(for: download.fileName)
    }

    func downloadState(for trackId: String) -> DownloadState {
        if let state = activeDownloads[trackId] {
            if state.isActive { return .downloading(progress: progress(for: trackId).fraction) }
            return state
        }
        return isDownloaded(trackId) ? .completed : .idle
    }

    /// Phase without reading live progress (no per-tick observation).
    func phase(for trackId: String) -> DownloadState {
        activeDownloads[trackId] ?? (isDownloaded(trackId) ? .completed : .idle)
    }

    func progress(for trackId: String) -> DownloadProgress {
        if let existing = progressByTrack[trackId] { return existing }
        let created = DownloadProgress()
        progressByTrack[trackId] = created
        return created
    }

    func downloadTrack(_ track: Track) {
        let state = phase(for: track.id)
        guard !state.isActive, state != .completed else { return }

        let urlString = api.compressedDownloadURL(forTrackID: track.id, bitrate: bitrate)
        guard let url = URL(string: urlString) else {
            activeDownloads[track.id] = .failed(String(localized: "Invalid download URL"))
            return
        }
        // Only the server proxy is used: provider stream URLs can carry
        // short-lived credentials and must never be persisted client-side.
        var request = api.authenticatedRequest(for: url)
        request.setValue("audio/*", forHTTPHeaderField: "Accept")

        let task = session.downloadTask(with: request)
        task.taskDescription = DownloadTaskInfo(
            trackId: track.id,
            artist: track.artist,
            title: track.title,
            bitrate: bitrate
        ).encoded
        cancelledTrackIds.remove(track.id)
        progress(for: track.id).fraction = 0
        activeDownloads[track.id] = .downloading(progress: 0)
        task.resume()
    }

    func deleteDownload(trackId: String) {
        cancelTasks(matching: [trackId])
        activeDownloads.removeValue(forKey: trackId)
        progressByTrack.removeValue(forKey: trackId)
        downloadedTrackIds.remove(trackId)
        if let download = downloads.removeValue(forKey: trackId) {
            DownloadStorage.removeFilesInBackground([download.fileName])
        }
        manifest.save(downloads)
    }

    func deleteAllDownloads() {
        cancelTasks(matching: nil)
        DownloadStorage.removeFilesInBackground(downloads.values.map(\.fileName))
        downloads.removeAll()
        downloadedTrackIds.removeAll()
        activeDownloads.removeAll()
        progressByTrack.removeAll()
        manifest.save(downloads)
    }

    func flushPendingWrites() {
        manifest.flush()
    }

    /// iOS app delegate hook: keep the handler until the session drains its events.
    func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == Self.sessionIdentifier else {
            completionHandler()
            return
        }
        if backgroundEventsFinishedEarly {
            backgroundEventsFinishedEarly = false
            completionHandler()
        } else {
            backgroundCompletionHandler = completionHandler
        }
    }

    // MARK: - Session events (called on the main actor by the delegate)

    fileprivate func publishProgress(trackId: String, fraction: Double) {
        guard activeDownloads[trackId]?.isActive == true else { return }
        let now = Date()
        // ~10 Hz cap so a fast local server can't flood SwiftUI.
        if fraction < 0.999, let last = lastProgressEventAt[trackId], now.timeIntervalSince(last) < 0.1 {
            return
        }
        lastProgressEventAt[trackId] = now
        progress(for: trackId).fraction = min(max(fraction, 0), 1)
    }

    fileprivate func handleFinished(_ info: DownloadTaskInfo, outcome: DownloadOutcome) {
        let trackId = info.trackId
        lastProgressEventAt.removeValue(forKey: trackId)
        progressByTrack.removeValue(forKey: trackId)

        switch outcome {
        case .success(let fileName, let sizeBytes):
            if cancelledTrackIds.remove(trackId) != nil {
                DownloadStorage.removeFilesInBackground([fileName])
                return
            }
            if let previous = downloads[trackId], previous.fileName != fileName {
                DownloadStorage.removeFilesInBackground([previous.fileName])
            }
            downloads[trackId] = DownloadedTrack(
                trackId: trackId,
                fileName: fileName,
                sizeBytes: sizeBytes,
                downloadedAt: Date(),
                bitrate: info.bitrate
            )
            downloadedTrackIds.insert(trackId)
            activeDownloads.removeValue(forKey: trackId)
            manifest.save(downloads)
        case .failure(let message):
            activeDownloads[trackId] = .failed(message)
        }
    }

    fileprivate func handleTransportFailure(trackId: String, message: String, cancelled: Bool) {
        lastProgressEventAt.removeValue(forKey: trackId)
        progressByTrack.removeValue(forKey: trackId)
        if cancelled {
            cancelledTrackIds.remove(trackId)
            if activeDownloads[trackId]?.isActive == true { activeDownloads.removeValue(forKey: trackId) }
            return
        }
        guard activeDownloads[trackId]?.isActive == true else { return }
        activeDownloads[trackId] = .failed(message)
    }

    fileprivate func finishBackgroundEvents() {
        guard let handler = backgroundCompletionHandler else {
            backgroundEventsFinishedEarly = true
            return
        }
        backgroundCompletionHandler = nil
        handler()
    }

    // MARK: - Internals

    private func cancelTasks(matching trackIds: Set<String>?) {
        if let trackIds { cancelledTrackIds.formUnion(trackIds) }
        let session = session
        Task.detached {
            for task in await session.allTasks {
                guard let info = DownloadTaskInfo(task: task) else { continue }
                if trackIds?.contains(info.trackId) ?? true { task.cancel() }
            }
        }
    }

    /// Restores progress UI for transfers that kept running while the app was gone.
    private func reconnectRunningTasks() {
        let session = session
        Task {
            let running = await Task.detached { () -> [(trackId: String, fraction: Double)] in
                await session.allTasks.compactMap { task in
                    guard task.state == .running || task.state == .suspended,
                          let info = DownloadTaskInfo(task: task) else { return nil }
                    let expected = task.countOfBytesExpectedToReceive
                    let fraction = expected > 0 ? Double(task.countOfBytesReceived) / Double(expected) : 0
                    return (info.trackId, fraction)
                }
            }.value
            for (trackId, fraction) in running where activeDownloads[trackId] == nil {
                activeDownloads[trackId] = .downloading(progress: 0)
                progress(for: trackId).fraction = fraction
            }
        }
    }

    private func loadManifest() {
        if let stored = manifest.load() {
            downloads = stored
        } else if let data = UserDefaults.standard.data(forKey: "downloaded_tracks"),
                  let legacy = try? JSONDecoder().decode([String: DownloadedTrack].self, from: data) {
            downloads = legacy
            manifest.save(legacy)
            UserDefaults.standard.removeObject(forKey: "downloaded_tracks")
        }
        downloadedTrackIds = Set(downloads.keys)
    }

    /// Off-main: moves files out of Documents (iCloud backup) and drops
    /// manifest entries whose file is gone.
    private func runMaintenance() {
        let fileNames = downloads.mapValues(\.fileName)
        Task {
            let result = await Task.detached(priority: .utility) {
                DownloadStorage.migrateAndVerify(fileNames: fileNames)
            }.value
            applyMaintenance(result)
        }
    }

    private func applyMaintenance(_ result: MaintenanceResult) {
        guard !result.renamed.isEmpty || !result.missing.isEmpty else { return }
        for (trackId, fileName) in result.renamed {
            guard let old = downloads[trackId] else { continue }
            downloads[trackId] = DownloadedTrack(
                trackId: trackId,
                fileName: fileName,
                sizeBytes: old.sizeBytes,
                downloadedAt: old.downloadedAt,
                bitrate: old.bitrate
            )
        }
        for trackId in result.missing where activeDownloads[trackId] == nil {
            downloads.removeValue(forKey: trackId)
            downloadedTrackIds.remove(trackId)
        }
        manifest.save(downloads)
    }
}

// MARK: - Session delegate

private final class DownloadSessionDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0, let info = DownloadTaskInfo(task: downloadTask) else { return }
        let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        Task { @MainActor in
            DownloadManager.shared.publishProgress(trackId: info.trackId, fraction: fraction)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let info = DownloadTaskInfo(task: downloadTask) else { return }
        // The temp file is deleted when this returns, so it is moved synchronously here.
        let outcome = DownloadStorage.finalize(location: location, response: downloadTask.response, info: info)
        Task { @MainActor in
            DownloadManager.shared.handleFinished(info, outcome: outcome)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let info = DownloadTaskInfo(task: task) else { return }
        let cancelled = error.isCancellation
        let message = error.localizedDescription
        Task { @MainActor in
            DownloadManager.shared.handleTransportFailure(trackId: info.trackId, message: message, cancelled: cancelled)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            DownloadManager.shared.finishBackgroundEvents()
        }
    }
}

// MARK: - Storage

private enum DownloadStorage {
    /// Application Support/<bundle id>/OfflineMusic, excluded from iCloud backup.
    static let directory: URL = {
        var url = AppStorageLocation.directory("OfflineMusic")
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url
    }()

    static let legacyDirectory: URL? =
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("OfflineMusic", isDirectory: true)

    static func existingFileURL(for fileName: String) -> URL? {
        let fileManager = FileManager.default
        let current = directory.appendingPathComponent(fileName)
        if fileManager.fileExists(atPath: current.path) { return current }
        // Not migrated yet (first launch after the move out of Documents).
        if let legacy = legacyDirectory?.appendingPathComponent(fileName),
           fileManager.fileExists(atPath: legacy.path) {
            return legacy
        }
        return nil
    }

    static func finalize(location: URL, response: URLResponse?, info: DownloadTaskInfo) -> DownloadOutcome {
        guard let http = response as? HTTPURLResponse else {
            return .failure(String(localized: "No response from the server"))
        }
        if http.statusCode == 401 {
            return .failure(String(localized: "Session expired. Sign in again to download."))
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = (try? String(contentsOf: location, encoding: .utf8)).map { String($0.prefix(200)) } ?? ""
            return .failure("HTTP \(http.statusCode)" + (body.isEmpty ? "" : ": \(body)"))
        }

        let sizeBytes = Int64((try? location.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        guard sizeBytes >= 1000 else {
            return .failure(String(localized: "The server returned an empty file."))
        }

        let fileName = makeFileName(
            trackId: info.trackId,
            artist: info.artist,
            title: info.title,
            fileExtension: fileExtension(mimeType: http.mimeType, suggestedFilename: http.suggestedFilename)
        )
        let destination = directory.appendingPathComponent(fileName)
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            return .failure(error.localizedDescription)
        }
        return .success(fileName: fileName, sizeBytes: sizeBytes)
    }

    /// Stable across launches (SHA-256 of the track ID); names written by
    /// older builds stay valid because the manifest stores each file name.
    static func makeFileName(trackId: String, artist: String, title: String, fileExtension: String) -> String {
        var safe = "\(artist) - \(title)"
        for character in ["/", ":", "\\", "\"", "?", "*", "<", ">", "|"] {
            safe = safe.replacingOccurrences(of: character, with: "-")
        }
        safe = String(safe.trimmingCharacters(in: CharacterSet(charactersIn: ". ")).prefix(80))
        let hash = SHA256.hash(data: Data(trackId.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
        return "\(safe)_\(hash).\(fileExtension)"
    }

    static func fileExtension(mimeType: String?, suggestedFilename: String?) -> String {
        switch mimeType?.lowercased() {
        case "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/x-aac", "audio/aacp": return "m4a"
        case "audio/mpeg", "audio/mp3": return "mp3"
        case "audio/flac", "audio/x-flac": return "flac"
        case "audio/wav", "audio/x-wav", "audio/wave": return "wav"
        case "audio/ogg": return "ogg"
        case "audio/opus": return "opus"
        case "audio/aiff", "audio/x-aiff": return "aiff"
        default:
            let suggested = (suggestedFilename as NSString?)?.pathExtension.lowercased() ?? ""
            let known: Set<String> = ["m4a", "mp3", "flac", "wav", "ogg", "opus", "aiff", "aac", "mp4"]
            // The compressed endpoint produces AAC in MP4; AVPlayer needs a real extension.
            return known.contains(suggested) ? suggested : "m4a"
        }
    }

    static func migrateAndVerify(fileNames: [String: String]) -> MaintenanceResult {
        let fileManager = FileManager.default
        let target = directory
        var result = MaintenanceResult()

        for (trackId, fileName) in fileNames {
            // Files from older builds used a meaningless ".audio" extension.
            let fixedName = fileName.hasSuffix(".audio") ? String(fileName.dropLast(6)) + ".m4a" : fileName
            let destination = target.appendingPathComponent(fixedName)
            if fileManager.fileExists(atPath: destination.path) {
                if fixedName != fileName { result.renamed[trackId] = fixedName }
                continue
            }
            let sources = [target.appendingPathComponent(fileName), legacyDirectory?.appendingPathComponent(fileName)]
                .compactMap { $0 }
            guard let source = sources.first(where: { fileManager.fileExists(atPath: $0.path) }) else {
                result.missing.insert(trackId)
                continue
            }
            do {
                try fileManager.moveItem(at: source, to: destination)
                if fixedName != fileName { result.renamed[trackId] = fixedName }
            } catch {
                // Leave the entry; playback falls back to the legacy location.
            }
        }

        // Remaining legacy files are orphans (no manifest entry): drop them so
        // nothing stays in the backed-up Documents folder.
        if let legacy = legacyDirectory, fileManager.fileExists(atPath: legacy.path) {
            let remaining = (try? fileManager.contentsOfDirectory(atPath: legacy.path)) ?? []
            let stillReferenced = Set(fileNames.values)
            if remaining.allSatisfy({ !stillReferenced.contains($0) }) {
                try? fileManager.removeItem(at: legacy)
            }
        }
        return result
    }

    static func removeFilesInBackground(_ fileNames: [String]) {
        guard !fileNames.isEmpty else { return }
        Task.detached(priority: .utility) {
            let fileManager = FileManager.default
            let locations = [directory, legacyDirectory].compactMap { $0 }
            for name in fileNames {
                for folder in locations {
                    try? fileManager.removeItem(at: folder.appendingPathComponent(name))
                }
            }
        }
    }
}
