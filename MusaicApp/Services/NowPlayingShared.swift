import Foundation

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
}
