import Foundation
import Testing
@testable import MusaicMac

@Suite("VideoStore")
struct VideoStoreTests {
    @Test("resolved video URLs count as fresh until a minute before expiry")
    func resolvedStreamFreshness() {
        let now = Date(timeIntervalSince1970: 1_893_456_000)
        #expect(VideoStore.isResolvedStreamFresh(
            expiresAt: now.addingTimeInterval(3600), now: now) == true)
        #expect(VideoStore.isResolvedStreamFresh(
            expiresAt: now.addingTimeInterval(61), now: now) == true)
        // Inside the one-minute safety margin: must be re-resolved.
        #expect(VideoStore.isResolvedStreamFresh(
            expiresAt: now.addingTimeInterval(30), now: now) == false)
        #expect(VideoStore.isResolvedStreamFresh(
            expiresAt: now.addingTimeInterval(-10), now: now) == false)
    }

    @Test("video API models decode the server contract")
    func decodesVideoInfo() throws {
        let info = try JSONDecoder().decode(TrackVideoInfo.self, from: Data(#"""
        {"available": true, "videoId": "fHI8X4OXluQ", "title": "Clip",
         "channel": "Artist", "duration": 202, "thumbnailUrl": "https://i.ytimg.com/t.jpg"}
        """#.utf8))
        #expect(info.available)
        #expect(info.videoId == "fHI8X4OXluQ")
        #expect(info.duration == 202)

        let none = try JSONDecoder().decode(TrackVideoInfo.self, from: Data(#"{"available": false}"#.utf8))
        #expect(!none.available)
        #expect(none.videoId == nil)

        let stream = try JSONDecoder().decode(ResolvedVideoStream.self, from: Data(#"""
        {"url": "https://rr3---sn.googlevideo.com/videoplayback?expire=1893456000",
         "expiresAt": 1893456000, "duration": 200}
        """#.utf8))
        #expect(stream.expiresAt == 1_893_456_000)
        #expect(stream.url.hasPrefix("https://"))
    }
}
