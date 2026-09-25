import Foundation
#if os(iOS)
import ActivityKit
import AppIntents
#endif

/// App-Group-backed snapshot of the current track, shared with the widget and
/// watch targets. The widget cannot reach the network reliably, so the app
/// writes a lightweight Codable snapshot whenever playback settles.
struct NowPlayingSnapshot: Codable, Equatable, Sendable {
    let trackId: String
    let title: String
    let artist: String
    let artworkURL: String?
    let isPlaying: Bool
    let updatedAt: Int
    // Optional so snapshots written by older builds still decode.
    var album: String? = nil
    /// Playback position (seconds) sampled at `positionTimestamp`.
    var position: Double? = nil
    var duration: Double? = nil
    /// Seconds since 1970 when `position` was sampled.
    var positionTimestamp: Double? = nil

    /// Wall-clock range the current track spans while playing; drives
    /// self-updating `ProgressView(timerInterval:)` without app refreshes.
    var playbackInterval: ClosedRange<Date>? {
        guard isPlaying, let position, let duration, duration > 0, let positionTimestamp else { return nil }
        let start = Date(timeIntervalSince1970: positionTimestamp - position)
        return start...start.addingTimeInterval(duration)
    }

    var progressFraction: Double {
        guard let position, let duration, duration > 0 else { return 0 }
        return min(max(position / duration, 0), 1)
    }
}

enum NowPlayingShared {
    static let appGroupID = "group.com.leonid.musaic"
    static let widgetKind = "MusaicNowPlaying"
    private static let key = "now_playing_snapshot"
    private static let legacyCommandKey = "pending_command"
    private static let commandQueueKey = "pending_commands_v2"
    /// Darwin notification the extension posts after mailing a command so a
    /// running app can drain it immediately.
    static let commandSignalName = "com.leonid.musaic.pending-command"
    private static let maxQueuedCommands = 16
    /// Commands older than this are dropped: a "next" tapped long ago must not
    /// fire when the app finally launches.
    static let commandMaxAge: TimeInterval = 120

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupID)
    }

    static func save(_ snapshot: NowPlayingSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults?.set(data, forKey: key)
    }

    static func load() -> NowPlayingSnapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(NowPlayingSnapshot.self, from: data)
    }

    /// Removes the snapshot and artwork (nothing playing / logout).
    static func clear() {
        defaults?.removeObject(forKey: key)
        removeArtworkFiles(keeping: nil)
    }

    /// Drops commands still waiting in the mailbox (logout).
    static func clearPendingCommands() {
        defaults?.removeObject(forKey: commandQueueKey)
        defaults?.removeObject(forKey: legacyCommandKey)
    }

    // MARK: - Widget / Live Activity command mailbox
    //
    // Fallback path only: `MusaicPlaybackIntent` normally runs inside the app
    // process. When it runs in the extension instead, commands are queued here
    // (in order, so rapid taps are not lost) and drained by the app.

    private struct QueuedCommand: Codable {
        let command: String
        let issuedAt: Double
    }

    static func enqueueCommand(_ command: String) {
        guard let defaults else { return }
        var queue = loadQueue(defaults)
        queue.append(QueuedCommand(command: command, issuedAt: Date().timeIntervalSince1970))
        if queue.count > maxQueuedCommands {
            queue.removeFirst(queue.count - maxQueuedCommands)
        }
        if let data = try? JSONEncoder().encode(queue) {
            defaults.set(data, forKey: commandQueueKey)
        }
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(commandSignalName as CFString),
            nil, nil, true
        )
    }

    /// Returns all fresh pending commands in the order they were issued and
    /// clears the mailbox.
    static func drainCommands() -> [String] {
        guard let defaults else { return [] }
        var commands: [String] = []
        if let legacy = defaults.string(forKey: legacyCommandKey) {
            defaults.removeObject(forKey: legacyCommandKey)
            commands.append(legacy)
        }
        let queue = loadQueue(defaults)
        guard !queue.isEmpty else { return commands }
        defaults.removeObject(forKey: commandQueueKey)
        let cutoff = Date().timeIntervalSince1970 - commandMaxAge
        commands.append(contentsOf: queue.filter { $0.issuedAt >= cutoff }.map(\.command))
        return commands
    }

    /// Returns the oldest pending command (clearing the mailbox), or nil.
    static func drainCommand() -> String? {
        drainCommands().first
    }

    /// Drains the mailbox on the main actor whenever an extension posts the
    /// command signal. Kept nonisolated: C callbacks can't carry isolation.
    static func addCommandSignalObserver() {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            nil,
            { _, _, _, _, _ in
                Task { @MainActor in NowPlayingCommandRouter.drainMailbox() }
            },
            commandSignalName as CFString,
            nil,
            .deliverImmediately
        )
    }

    private static func loadQueue(_ defaults: UserDefaults) -> [QueuedCommand] {
        guard let data = defaults.data(forKey: commandQueueKey) else { return [] }
        return (try? JSONDecoder().decode([QueuedCommand].self, from: data)) ?? []
    }

    // MARK: - Artwork shared with the widget / Live Activity
    //
    // Widgets and Live Activities can't load remote images (AsyncImage never
    // resolves there), so the app writes a small downsampled JPEG per track
    // into the App Group container.

    private static var artworkDirectory: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent("NowPlaying", isDirectory: true)
    }

    static func artworkFileURL(for trackId: String) -> URL? {
        let safe = String(trackId.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_" ? Character(scalar) : "_"
        }.prefix(120))
        return artworkDirectory?.appendingPathComponent("artwork-\(safe).jpg")
    }

    static func loadArtworkData(for trackId: String) -> Data? {
        guard let url = artworkFileURL(for: trackId) else { return nil }
        return try? Data(contentsOf: url)
    }

    @discardableResult
    static func writeArtwork(_ data: Data, for trackId: String) -> Bool {
        guard let directory = artworkDirectory, let url = artworkFileURL(for: trackId) else { return false }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            removeArtworkFiles(keeping: url.lastPathComponent)
            return true
        } catch {
            return false
        }
    }

    static func removeArtworkFiles(keeping fileName: String?) {
        guard let directory = artworkDirectory,
              let files = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for file in files where file != fileName {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file))
        }
    }
}

/// Routes playback commands from intents / the mailbox to the player. The app
/// installs the handler at launch; this file deliberately knows nothing about
/// `PlayerStore` because it is also compiled into the extensions.
@MainActor
enum NowPlayingCommandRouter {
    private static var handler: (@MainActor (String) -> Void)?
    private static var isObservingSignal = false

    static func install(_ handler: @escaping @MainActor (String) -> Void) {
        self.handler = handler
        observeCommandSignal()
        drainMailbox()
    }

    /// Performs the command in-process when the app installed a handler,
    /// otherwise mails it to the app.
    static func dispatch(_ command: String) {
        if let handler {
            handler(command)
        } else {
            NowPlayingShared.enqueueCommand(command)
        }
    }

    static func drainMailbox() {
        guard let handler else { return }
        for command in NowPlayingShared.drainCommands() {
            handler(command)
        }
    }

    private static func observeCommandSignal() {
        guard !isObservingSignal else { return }
        isObservingSignal = true
        NowPlayingShared.addCommandSignalObserver()
    }
}

#if os(iOS)
/// Content rendered by the Lock Screen banner and the Dynamic Island.
struct MusaicLiveActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var trackId: String
        var title: String
        var artist: String
        var artworkURL: String?
        var isPlaying: Bool
        var progress: Double
        /// Set while playing so the progress bar animates on its own.
        var playbackStart: Date? = nil
        var playbackEnd: Date? = nil
        /// Flips to true once the artwork JPEG exists in the App Group, which
        /// also forces the activity to re-render with the image.
        var hasArtwork: Bool? = nil
    }
}

/// Button action used by the widget and the Live Activity. Conforming to
/// `AudioPlaybackIntent` / `LiveActivityIntent` makes the system run
/// `perform()` in the app process (launching it in the background if needed),
/// so Play works while paused and rapid taps are handled one by one.
struct MusaicPlaybackIntent: AudioPlaybackIntent, LiveActivityIntent {
    static var title: LocalizedStringResource { "Musaic Playback" }
    static var description: IntentDescription? { IntentDescription("Controls Musaic playback") }
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Command")
    var command: String

    init() {
        self.command = "toggle"
    }

    init(command: String) {
        self.command = command
    }

    func perform() async throws -> some IntentResult {
        let command = self.command
        await NowPlayingCommandRouter.dispatch(command)
        return .result()
    }
}
#endif
