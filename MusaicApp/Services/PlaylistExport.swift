import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// Exports metadata, never bearer tokens, filesystem paths or signed provider URLs.
enum PlaylistExport {
    private struct TrackMetadata: Codable {
        let id: String
        let title: String
        let artist: String
        let album: String?
        let duration: TimeInterval?
        let source: String
    }
    private struct Snapshot: Codable { let version: Int; let name: String; let tracks: [TrackMetadata] }
    static func data(name: String, tracks: [Track], json: Bool) throws -> Data {
        if json {
            let snapshot = Snapshot(version: 1, name: name, tracks: tracks.map {
                TrackMetadata(id: $0.id, title: $0.title, artist: $0.artist, album: $0.album,
                    duration: $0.duration, source: $0.source.rawValue)
            })
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            return try encoder.encode(snapshot)
        }
        let clean: (String) -> String = { $0.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ") }
        var lines = ["#EXTM3U", "#PLAYLIST:\(clean(name))"]
        for track in tracks {
            lines.append("#EXTINF:\(Int(track.duration ?? -1)),\(clean(track.artist)) - \(clean(track.title))")
            lines.append("musaic://track/\(track.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? track.id)")
        }
        return Data((lines.joined(separator: "\n") + "\n").utf8)
    }
}
struct PlaylistExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .plainText] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
