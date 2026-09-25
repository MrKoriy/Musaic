import Foundation

// MARK: - Payload

/// `GET /api/lyrics/:trackId` including the per-track user offset. Decoded
/// leniently so older servers (no `userOffsetSec`) keep working.
struct SyncedLyricsPayload: Decodable, Sendable {
    let trackId: String
    let lrc: String?
    let source: String?
    let words: [[LyricsWord]]?
    /// Server-computed highlight lead for this lyrics source.
    let offsetSec: Double?
    /// User fine-tuning stored on the server (clamped to ±5 s).
    let userOffsetSec: Double

    private enum CodingKeys: String, CodingKey {
        case trackId, lrc, source, words, offsetSec, userOffsetSec
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        trackId = try container.decodeIfPresent(String.self, forKey: .trackId) ?? ""
        lrc = try container.decodeIfPresent(String.self, forKey: .lrc)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        words = try? container.decodeIfPresent([[LyricsWord]].self, forKey: .words)
        offsetSec = try? container.decodeIfPresent(Double.self, forKey: .offsetSec)
        userOffsetSec = (try? container.decodeIfPresent(Double.self, forKey: .userOffsetSec)) ?? 0
    }

    /// Fallback lead when the server doesn't report one: human-typed LRC
    /// timestamps lag the audio by roughly 0.4 s.
    static let defaultSourceOffset: Double = 0.4
}

// MARK: - Timeline

struct LyricsLine: Identifiable, Equatable, Sendable {
    let id: Int
    let time: Double
    let text: String
    var words: [LyricsWord] = []
}

/// Parsed, time-sorted synced lyrics with fast lookups for the highlight.
struct LyricsTimeline: Sendable {
    let lines: [LyricsLine]

    static let empty = LyricsTimeline(lines: [])

    var isEmpty: Bool { lines.isEmpty }

    static func parse(lrc: String, wordLines: [[LyricsWord]]? = nil) -> LyricsTimeline {
        var lines: [LyricsLine] = []
        let pattern = /\[(\d{1,2}):(\d{2})\.(\d{1,3})\]\s*(.*)/
        for (idx, line) in lrc.split(separator: "\n").enumerated() {
            guard let match = String(line).firstMatch(of: pattern) else { continue }
            let minutes = Double(match.1) ?? 0
            let seconds = Double(match.2) ?? 0
            let fraction = Double(match.3) ?? 0
            let divisor = match.3.count == 2 ? 100.0 : (match.3.count == 1 ? 10.0 : 1000.0)
            let time = minutes * 60 + seconds + fraction / divisor
            let text = String(match.4).trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { continue }
            // Word timings arrive per lyric line, in LRC line order.
            let words = wordLines.flatMap { $0.indices.contains(lines.count) ? $0[lines.count] : [] } ?? []
            lines.append(LyricsLine(id: idx, time: time, text: text, words: words))
        }
        return LyricsTimeline(lines: lines.sorted { $0.time < $1.time })
    }

    /// Index of the last line that started at or before `time` (the first line
    /// before the lyrics begin), or nil when there are no lines.
    func lineIndex(at time: Double) -> Int? {
        guard !lines.isEmpty else { return nil }
        var low = 0
        var high = lines.count - 1
        var best = 0
        while low <= high {
            let mid = (low + high) / 2
            if lines[mid].time <= time {
                best = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }

    /// Index of the word being sung on line `index` at `time`.
    func wordIndex(inLine index: Int, at time: Double) -> Int? {
        guard lines.indices.contains(index) else { return nil }
        var result: Int?
        for (i, word) in lines[index].words.enumerated() {
            if word.start <= time { result = i } else { break }
        }
        return result
    }
}

// MARK: - Service

/// One `event: status` payload from `GET /api/lyrics/:trackId/events`.
private struct LyricsJobEvent: Decodable, Sendable {
    let status: String
    let error: String?
}

enum LyricsJobOutcome: Sendable, Equatable {
    case done
    case failed(String?)
    case notStarted
    case timedOut
    case cancelled
}

@MainActor
enum LyricsService {
    /// Overall budget for waiting on an AI generation job.
    private static let generationDeadline: TimeInterval = 180

    /// Long-lived stream session: heartbeats keep the per-packet timeout alive.
    private static let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 210
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    static func fetch(trackId: String, artist: String? = nil, title: String? = nil) async throws -> SyncedLyricsPayload {
        var path = "/api/lyrics/\(encodedTrackID(trackId))"
        var params: [String] = []
        if let artist { params.append("artist=\(encodedQueryValue(artist))") }
        if let title { params.append("title=\(encodedQueryValue(title))") }
        if !params.isEmpty { path += "?\(params.joined(separator: "&"))" }
        return try await APIService.shared.get(path)
    }

    private struct OffsetBody: Encodable { let userOffsetSec: Double }
    private struct OffsetResponse: Decodable { let userOffsetSec: Double? }

    /// Stores the user's highlight offset for a track; returns the value the
    /// server accepted (it clamps and rounds).
    @discardableResult
    static func saveUserOffset(_ offset: Double, trackId: String) async throws -> Double {
        let url = try endpointURL("/api/lyrics/\(encodedTrackID(trackId))/offset")
        var request = APIService.shared.authenticatedRequest(for: url, method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(OffsetBody(userOffsetSec: offset))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return (try? JSONDecoder().decode(OffsetResponse.self, from: data))?.userOffsetSec ?? offset
    }

    /// Waits for an AI lyrics job started with `POST …/generate`. Uses the
    /// server-sent status stream and falls back to polling `/status` with
    /// backoff when the stream is unavailable (older server, 404, network).
    static func waitForGeneration(trackId: String) async -> LyricsJobOutcome {
        let deadline = Date().addingTimeInterval(generationDeadline)
        if let outcome = await streamJobStatus(trackId: trackId, deadline: deadline) {
            return outcome
        }
        return await pollJobStatus(trackId: trackId, deadline: deadline)
    }

    /// nil means "stream unavailable, fall back to polling".
    private static func streamJobStatus(trackId: String, deadline: Date) async -> LyricsJobOutcome? {
        guard let url = try? endpointURL("/api/lyrics/\(encodedTrackID(trackId))/events") else { return nil }
        var request = APIService.shared.authenticatedRequest(for: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return await consumeStatusStream(request: request, session: streamSession, deadline: deadline)
    }

    // Runs off the main actor: the byte stream is not Sendable.
    private nonisolated static func consumeStatusStream(
        request: URLRequest,
        session: URLSession,
        deadline: Date
    ) async -> LyricsJobOutcome? {
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            var eventName = "message"
            // `lines` drops blank separator lines, so events are dispatched on
            // their `data:` line (the server sends one data line per event).
            for try await line in bytes.lines {
                if Task.isCancelled { return .cancelled }
                if Date() > deadline { return .timedOut }
                if line.hasPrefix(":") { continue }
                if line.hasPrefix("event:") {
                    eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                    continue
                }
                guard line.hasPrefix("data:") else { continue }
                let name = eventName
                eventName = "message"
                guard name == "status" || name == "message" else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let data = payload.data(using: .utf8),
                      let event = try? JSONDecoder().decode(LyricsJobEvent.self, from: data) else { continue }
                switch event.status {
                case "done": return .done
                case "failed": return .failed(event.error)
                default: continue
                }
            }
            // Closed without a terminal status: let polling settle it.
            return nil
        } catch {
            return Task.isCancelled ? .cancelled : nil
        }
    }

    private static func pollJobStatus(trackId: String, deadline: Date) async -> LyricsJobOutcome {
        var attempt = 0
        while Date() < deadline {
            let delay = min(5.0, 1.0 + Double(attempt) * 0.75)
            attempt += 1
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return .cancelled
            }
            guard let status = try? await APIService.shared.getLyricsJobStatus(trackId: trackId) else { continue }
            switch status.status {
            case "done": return .done
            case "failed": return .failed(nil)
            case "not_started": return .notStarted
            default: continue
            }
        }
        return .timedOut
    }

    private static func endpointURL(_ path: String) throws -> URL {
        guard let url = URL(string: "\(APIService.shared.serverURL)\(path)") else {
            throw URLError(.badURL)
        }
        return url
    }

    private static func encodedTrackID(_ trackId: String) -> String {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        return trackId.addingPercentEncoding(withAllowedCharacters: allowed) ?? trackId
    }

    private static func encodedQueryValue(_ value: String) -> String {
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
