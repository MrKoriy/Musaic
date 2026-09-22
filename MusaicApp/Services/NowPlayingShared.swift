import Foundation
#if os(iOS)
import ActivityKit
#if canImport(AppIntents)
import AppIntents
#endif
#endif

/// App-Group-backed snapshot of the current track, shared with the widget and
/// watch targets. The widget cannot reach the network reliably, so the app
/// writes a lightweight Codable snapshot whenever playback changes.
struct NowPlayingSnapshot: Codable {
    let trackId: String
    let title: String
    let artist: String
    let artworkURL: String?
    let isPlaying: Bool
    let updatedAt: Int
}

enum NowPlayingShared {
    static let appGroupID = "group.com.leonid.musaic"
    private static let key = "now_playing_snapshot"
    private static let commandKey = "pending_command"

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

    // MARK: - Widget / Live Activity command mailbox
    //
    // Buttons in the widget extension and the Live Activity run outside the
    // app process and cannot touch the player, so they drop a small command
    // string here; the app drains it on its next playback tick / activation.

    static func enqueueCommand(_ command: String) {
        defaults?.set(command, forKey: commandKey)
    }

    /// Returns the pending command (clearing the mailbox), or nil.
    static func drainCommand() -> String? {
        guard let command = defaults?.string(forKey: commandKey) else { return nil }
        defaults?.removeObject(forKey: commandKey)
        return command
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
    }
}

/// Owns the single "Now Playing" Live Activity: starts it alongside the first
/// track and keeps its content in sync with playback state.
@MainActor
final class NowPlayingActivityController {
    static let shared = NowPlayingActivityController()

    /// Live Activity updates are budgeted by the system — progress is pushed
    /// at most every few seconds, state changes go out immediately.
    private var lastPushedAt: Date = .distantPast
    private let progressMinInterval: TimeInterval = 4

    private init() {}

    func update(
        trackId: String,
        title: String,
        artist: String,
        artworkURL: String?,
        isPlaying: Bool,
        progress: Double
    ) {
        let state = MusaicLiveActivityAttributes.ContentState(
            trackId: trackId,
            title: title,
            artist: artist,
            artworkURL: artworkURL,
            isPlaying: isPlaying,
            progress: progress
        )
        lastPushedAt = Date()
        Task { await push(state) }
    }

    func updateProgress(_ progress: Double) {
        guard Date().timeIntervalSince(lastPushedAt) >= progressMinInterval else { return }
        guard let activity = Activity<MusaicLiveActivityAttributes>.activities.first else { return }
        var state = activity.content.state
        state.progress = progress
        lastPushedAt = Date()
        Task { await push(state) }
    }

    private func push(_ state: MusaicLiveActivityAttributes.ContentState) async {
        if let activity = Activity<MusaicLiveActivityAttributes>.activities.first {
            await activity.update(using: state)
        } else {
            let content = ActivityContent(state: state, staleDate: nil)
            _ = try? Activity.request(attributes: MusaicLiveActivityAttributes(), content: content)
        }
    }
}
#endif

#if os(iOS) && canImport(AppIntents)
/// Button action used by the widget and the Live Activity. It runs in the
/// extension process, so it only mails a command to the app via the App Group.
struct MusaicPlaybackIntent: AppIntent {
    static var title: LocalizedStringResource { "Musaic Playback" }
    static var description: IntentDescription? { IntentDescription("Controls Musaic playback") }

    @Parameter(title: "Command")
    var command: String

    init() {
        self.command = "toggle"
    }

    init(command: String) {
        self.command = command
    }

    func perform() async throws -> some IntentResult {
        NowPlayingShared.enqueueCommand(command)
        return .result()
    }
}
#endif
