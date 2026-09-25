import Foundation
import Testing
@testable import MusaicMac

@Suite("LyricsTimeline")
struct LyricsTimelineTests {
    @Test("parses timestamps with 1-, 2- and 3-digit fractions and sorts lines")
    func parsesAndSorts() {
        let lrc = """
        [ti:Metadata tag]
        [00:12.5] Third
        [00:01.25] First

        [00:05.500] Second
        [00:20.00]
        """
        let timeline = LyricsTimeline.parse(lrc: lrc)
        #expect(timeline.lines.map(\.text) == ["First", "Second", "Third"])
        #expect(timeline.lines.map(\.time) == [1.25, 5.5, 12.5])
    }

    @Test("finds the current line by time")
    func lineLookup() {
        let timeline = LyricsTimeline.parse(lrc: "[00:01.00] A\n[00:03.00] B\n[00:06.00] C")
        #expect(timeline.lineIndex(at: 0) == 0)
        #expect(timeline.lineIndex(at: 1) == 0)
        #expect(timeline.lineIndex(at: 2.99) == 0)
        #expect(timeline.lineIndex(at: 3) == 1)
        #expect(timeline.lineIndex(at: 100) == 2)
        #expect(LyricsTimeline.empty.lineIndex(at: 1) == nil)
    }

    @Test("attaches word timings per line in LRC order and finds the sung word")
    func wordTimings() {
        let words: [[LyricsWord]] = [
            [LyricsWord(text: "Hello", start: 1.0, end: 1.4), LyricsWord(text: "world", start: 1.5, end: 2.0)],
            [LyricsWord(text: "Again", start: 3.0, end: nil)],
        ]
        let timeline = LyricsTimeline.parse(lrc: "[00:01.00] Hello world\n[00:03.00] Again", wordLines: words)
        #expect(timeline.lines[0].words.map(\.text) == ["Hello", "world"])
        #expect(timeline.lines[1].words.map(\.text) == ["Again"])
        #expect(timeline.wordIndex(inLine: 0, at: 0.5) == nil)
        #expect(timeline.wordIndex(inLine: 0, at: 1.45) == 0)
        #expect(timeline.wordIndex(inLine: 0, at: 1.9) == 1)
        #expect(timeline.wordIndex(inLine: 5, at: 1.9) == nil)
    }

    @Test("tolerates fewer word lines than lyric lines")
    func missingWordLines() {
        let words: [[LyricsWord]] = [[LyricsWord(text: "Only", start: 1, end: 2)]]
        let timeline = LyricsTimeline.parse(lrc: "[00:01.00] Only\n[00:02.00] Unaligned", wordLines: words)
        #expect(timeline.lines[1].words.isEmpty)
    }
}

@Suite("SyncedLyricsPayload")
struct SyncedLyricsPayloadTests {
    private func decode(_ json: String) throws -> SyncedLyricsPayload {
        try JSONDecoder().decode(SyncedLyricsPayload.self, from: Data(json.utf8))
    }

    @Test("decodes the server payload with word timings and the user offset")
    func fullPayload() throws {
        let payload = try decode("""
        {"trackId":"t1","lrc":"[00:01.00] Hi","source":"aligned",
         "words":[[{"t":"Hi","s":1.0,"e":1.3}]],"offsetSec":0,"userOffsetSec":-0.35,"cached":true}
        """)
        #expect(payload.trackId == "t1")
        #expect(payload.source == "aligned")
        #expect(payload.words?.first?.first?.text == "Hi")
        #expect(payload.offsetSec == 0)
        #expect(payload.userOffsetSec == -0.35)
    }

    @Test("older servers without offsets or with malformed words still decode")
    func lenientPayload() throws {
        let payload = try decode(#"{"trackId":"t2","lrc":null,"source":null,"words":"oops"}"#)
        #expect(payload.lrc == nil)
        #expect(payload.words == nil)
        #expect(payload.offsetSec == nil)
        #expect(payload.userOffsetSec == 0)
    }
}
