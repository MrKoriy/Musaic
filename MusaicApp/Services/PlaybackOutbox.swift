import Foundation
import Network
import os

struct PendingPlaybackEvent: Codable, Sendable, Identifiable {
    var id: String { body.eventId ?? "" }
    let userId: String
    let serverURL: String
    let body: LogPlayBody

    func belongsTo(userId: String, serverURL: String) -> Bool {
        self.userId == userId && self.serverURL == serverURL
    }
}

/// The disk transaction completes before attempting delivery. No credentials
/// or signed provider URLs are persisted. Retries reuse the event ID.
actor PlaybackEventStorage {
    let url: URL
    private var entries: [PendingPlaybackEvent]?

    init(url: URL) { self.url = url }

    func load() throws -> [PendingPlaybackEvent] {
        if let entries { return entries }
        if !FileManager.default.fileExists(atPath: url.path) { entries = []; return [] }
        let loaded = try JSONDecoder().decode([PendingPlaybackEvent].self, from: Data(contentsOf: url))
        entries = loaded
        return loaded
    }
    func append(_ entry: PendingPlaybackEvent) throws {
        var next = try load()
        guard !next.contains(where: { $0.id == entry.id }) else { return }
        next.append(entry)
        try persist(next)
    }
    func remove(id: String) throws {
        var next = try load(); next.removeAll { $0.id == id }; try persist(next)
    }
    private func persist(_ next: [PendingPlaybackEvent]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: url, options: [.atomic])
        entries = next
    }
}

@MainActor
@Observable
final class PlaybackOutbox {
    static let shared = PlaybackOutbox()
    private(set) var pendingCount = 0
    private(set) var lastError: String?
    @ObservationIgnored private let storage: PlaybackEventStorage
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var needsFlush = false
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    private let logger = Logger(subsystem: "com.leonid.musaic", category: "PlaybackOutbox")

    private init() {
        storage = PlaybackEventStorage(url: AppStorageLocation.directory().appendingPathComponent("playback-outbox.json"))
        monitor.pathUpdateHandler = { path in
            if path.status == .satisfied { Task { @MainActor in await PlaybackOutbox.shared.flush() } }
        }
        monitor.start(queue: DispatchQueue(label: "musaic.outbox-network"))
    }
    func enqueue(_ body: LogPlayBody, userId: String, serverURL: String) async {
        do {
            try await storage.append(PendingPlaybackEvent(userId: userId, serverURL: serverURL, body: body))
            await flush()
        } catch {
            lastError = String(localized: "Could not save listening history on this device.")
            logger.error("Unable to persist playback event: \(error.localizedDescription, privacy: .public)")
        }
    }
    func flush() async {
        if flushing { needsFlush = true; return }
        guard SettingsStore.shared.isLoggedIn,
              let userId = SettingsStore.shared.authUserId else { return }
        flushing = true
        defer { flushing = false }
        retryTask?.cancel(); retryTask = nil
        let server = APIService.shared.serverURL
        do {
            let all = try await storage.load()
            pendingCount = all.filter { $0.belongsTo(userId: userId, serverURL: server) }.count
            for entry in all.filter({ $0.belongsTo(userId: userId, serverURL: server) }).prefix(100) {
                guard SettingsStore.shared.isLoggedIn, SettingsStore.shared.authUserId == userId,
                      APIService.shared.serverURL == server else { return }
                let _: OkResponse = try await APIService.shared.postJSON("/api/history", body: entry.body)
                try await storage.remove(id: entry.id)
                pendingCount = max(0, pendingCount - 1)
            }
            lastError = nil
        } catch {
            lastError = String(localized: "Listening history will sync when the server is available.")
        }
        if pendingCount > 0 || needsFlush {
            needsFlush = false
            retryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                await self?.flush()
            }
        }
    }
}
