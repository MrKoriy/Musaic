import Foundation
import Testing
@testable import MusaicMac

@Suite("Audit regression contracts")
struct AuditRegressionTests {
    private func track() -> Track {
        Track(id: "test-track", title: "Track", artist: "Artist",
              artwork: "https://example.test/art", url: "https://example.test/audio?token=must-not-export",
              duration: 180, source: .local)
    }
    @Test("Legacy downloads manifests decode without track metadata")
    func legacyManifest() throws {
        let data = Data(#"{"trackId":"t","fileName":"track.m4a","sizeBytes":1000,"downloadedAt":0,"bitrate":128}"#.utf8)
        let decoded = try JSONDecoder().decode(DownloadedTrack.self, from: data)
        #expect(decoded.track == nil)
        #expect(decoded.bitrate == 128)
    }
    @Test("New manifests preserve metadata across a relaunch")
    func metadataRoundtrip() throws {
        let original = DownloadedTrack(trackId: "test-track", fileName: "track.m4a", sizeBytes: 1000,
                                       downloadedAt: Date(), bitrate: 256, track: track())
        let decoded = try JSONDecoder().decode(DownloadedTrack.self, from: JSONEncoder().encode(original))
        #expect(decoded.track?.title == "Track")
        #expect(decoded.bitrate == 256)
    }
    @Test("Exports contain metadata but never stream credentials")
    func exports() throws {
        let json = String(decoding: try PlaylistExport.data(name: "Favorites", tracks: [track()], json: true), as: UTF8.self)
        #expect(!json.contains("must-not-export"))
        #expect(!json.contains("example.test/audio"))
        #expect(json.contains("test-track"))
        let m3u = String(decoding: try PlaylistExport.data(name: "Favorites", tracks: [track()], json: false), as: UTF8.self)
        #expect(m3u.hasPrefix("#EXTM3U"))
        #expect(m3u.contains("musaic://track/test-track"))
        #expect(!m3u.contains("token="))
    }
    @Test("Cursor pages and alternative source metadata decode")
    func cursorContracts() throws {
        let response = try JSONDecoder().decode(SearchResponse.self, from: Data(#"{"tracks":[{"id":"a","source":"local","title":"Song","artist":"Artist","duration":180,"versions":[{"id":"b","source":"soundcloud","title":"Song","artist":"Artist","duration":180}]}],"hasMore":true,"nextCursor":"cursor"}"#.utf8))
        #expect(response.nextCursor == "cursor")
        #expect(response.tracks.first?.versions?.first?.source == .soundcloud)
        let page = try JSONDecoder().decode(PlaylistTrackPage.self, from: Data(#"{"tracks":[],"hasMore":false}"#.utf8))
        #expect(page.nextCursor == nil)
    }
    @Test("Durable outbox survives reconstruction, de-duplicates IDs and scopes accounts")
    func durableOutbox() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("events.json")
        let body = LogPlayBody(trackId: "t", action: "complete", eventId: "event", playedAt: 1_000,
            playedMs: 180_000, durationMs: 180_000, playedRatio: 1, sessionId: nil, requestId: nil,
            surface: "organic", isOrganic: true, position: nil)
        let record = PendingPlaybackEvent(userId: "one", serverURL: "https://example.test", body: body)
        let storage = PlaybackEventStorage(url: url)
        try await storage.append(record)
        try await storage.append(record)
        let restarted = PlaybackEventStorage(url: url)
        let loaded = try await restarted.load()
        #expect(loaded.count == 1)
        #expect(loaded[0].body.playedAt == 1_000)
        #expect(loaded[0].belongsTo(userId: "one", serverURL: "https://example.test"))
        #expect(!loaded[0].belongsTo(userId: "two", serverURL: "https://example.test"))
        #expect(!loaded[0].belongsTo(userId: "one", serverURL: "https://other.test"))
        try await restarted.remove(id: "event")
        #expect(try await PlaybackEventStorage(url: url).load().isEmpty)
    }
}
