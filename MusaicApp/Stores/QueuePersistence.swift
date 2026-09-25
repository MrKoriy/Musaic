import Foundation

/// On-disk copy of the playback queue so a relaunch resumes where the user
/// left off (restored paused).
struct PersistedQueue: Codable, Sendable {
    var version = 1
    var queue: [Track]
    var originalQueue: [Track]
    var queueIndex: Int
    var position: Double
    var isShuffled: Bool
    var repeatMode: String
    var surface: String
    var savedAt: Double
}

enum QueuePersistence {
    private static var fileURL: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return base
            .appendingPathComponent("Musaic", isDirectory: true)
            .appendingPathComponent("playback-queue.json")
    }

    static func load() -> PersistedQueue? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PersistedQueue.self, from: data)
    }

    static func save(_ snapshot: PersistedQueue) {
        guard let url = fileURL, let data = try? JSONEncoder().encode(snapshot) else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: url, options: .atomic)
        } catch {
            print("[QueuePersistence] save failed: \(error)")
        }
    }

    static func delete() {
        guard let url = fileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
