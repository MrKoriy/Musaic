import SwiftUI

func normalizedLibraryText(_ value: String?) -> String {
    value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func libraryArtistName(for track: Track) -> String? {
    let artist = normalizedLibraryText(track.artist)
    return artist.isEmpty ? nil : artist
}

func libraryAlbumTitle(for track: Track) -> String {
    let album = normalizedLibraryText(track.album)
    if !album.isEmpty { return album }

    let title = normalizedLibraryText(track.title)
    return title.isEmpty ? "Untitled Single" : title
}

func trackBelongs(to album: Album, track: Track) -> Bool {
    guard libraryArtistName(for: track) == album.artist else { return false }
    guard libraryAlbumTitle(for: track) == album.album else { return false }
    if let source = album.source {
        return track.source.rawValue == source
    }
    return true
}

func trackBelongs(to artist: Artist, track: Track) -> Bool {
    libraryArtistName(for: track) == artist.artist
}
