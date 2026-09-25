import Foundation

// MARK: - Playlist import models

struct ImportResult: Codable {
    let source: String?
    let title: String?
    let totalTracks: Int?
    let matchedCount: Int?
    let matches: [ImportMatch]
    let error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        totalTracks = try c.decodeIfPresent(Int.self, forKey: .totalTracks)
        matchedCount = try c.decodeIfPresent(Int.self, forKey: .matchedCount)
        matches = (try? c.decode([ImportMatch].self, forKey: .matches)) ?? []
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    enum CodingKeys: String, CodingKey {
        case source, title, totalTracks, matchedCount, matches, error
    }
}

struct IdentifiedImportMatch: Identifiable {
    let id: String
    let match: ImportMatch
}

extension ImportResult {
    /// Stable, unique row IDs even when the source playlist repeats a track.
    var identifiedMatches: [IdentifiedImportMatch] {
        var occurrences: [String: Int] = [:]
        return matches.map { match in
            let key = match.match?.id ?? "\(match.artist)|\(match.title)"
            let seen = occurrences[key, default: 0]
            occurrences[key] = seen + 1
            return IdentifiedImportMatch(id: seen == 0 ? key : "\(key)#\(seen)", match: match)
        }
    }
}

struct ImportMatch: Codable {
    let title: String
    let artist: String
    let album: String?
    let durationSec: Int?
    let confidence: String
    let match: ImportMatchTrack?
    let matchSource: String?
}

struct ImportMatchTrack: Codable {
    let id: String
    let title: String
    let artist: String
    let source: String?

    enum CodingKeys: String, CodingKey {
        case id, title, artist, source
    }
}

struct SaveResponse: Codable {
    let ok: Bool?
    let id: String?
    let trackCount: Int?
}
