import Foundation

/// App-private storage location: Application Support/<bundle id>/.
enum AppStorageLocation {
    static func directory(_ subpath: String? = nil) -> URL {
        let fileManager = FileManager.default
        let base = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fileManager.temporaryDirectory
        // macOS builds are not sandboxed: keep our files out of the shared folder root.
        var url = base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Musaic", isDirectory: true)
        if let subpath { url.appendPathComponent(subpath, isDirectory: true) }
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

/// Debounced JSON snapshot persistence. Encoding and the atomic write happen
/// on a background actor; the newest snapshot always wins.
@MainActor
final class JSONFileStore<Value: Codable & Sendable> {
    let url: URL
    private let debounce: Duration
    private let writer: JSONFileWriter
    private var pendingWrite: Task<Void, Never>?
    private var latest: Value?
    private var version = 0

    init(fileName: String, debounce: Duration = .milliseconds(500)) {
        let url = AppStorageLocation.directory().appendingPathComponent(fileName)
        self.url = url
        self.debounce = debounce
        self.writer = JSONFileWriter(url: url)
    }

    /// Synchronous read, used once at launch.
    func load() -> Value? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    func save(_ value: Value) {
        latest = value
        version += 1
        let version = version
        let writer = writer
        let debounce = debounce
        pendingWrite?.cancel()
        pendingWrite = Task {
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            await writer.write(value, version: version)
        }
    }

    /// Writes the latest snapshot now (e.g. when the app goes to background).
    func flush() {
        pendingWrite?.cancel()
        pendingWrite = nil
        guard let latest else { return }
        let writer = writer
        let version = version
        Task { await writer.write(latest, version: version) }
    }
}

private actor JSONFileWriter {
    let url: URL
    private var writtenVersion = 0

    init(url: URL) {
        self.url = url
    }

    func write<Value: Encodable & Sendable>(_ value: Value, version: Int) {
        guard version > writtenVersion else { return }
        do {
            let data = try JSONEncoder().encode(value)
            try data.write(to: url, options: [.atomic])
            writtenVersion = version
        } catch {
            #if DEBUG
            print("[JSONFileStore] write failed for \(url.lastPathComponent): \(error)")
            #endif
        }
    }
}
