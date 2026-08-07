import Foundation

// MARK: - Core Models

struct Track: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let artist: String
    var album: String?
    var canonicalFamilyId: String?
    var artwork: String?
    var artworkColor: String?
    var url: String
    var duration: TimeInterval?
    let source: TrackSource

    enum TrackSource: String, Codable, Hashable {
        case local, vk, soundcloud, yandex, youtube

        var displayTag: String {
            switch self {
            case .local: return "LOCAL"
            case .vk: return "VK"
            case .soundcloud: return "SC"
            case .yandex: return "YANDEX"
            case .youtube: return "YT"
            }
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, title, artist, album, canonicalFamilyId, artwork, artworkColor, url, duration, source
        case coverUrl
        case cover_url
        case streamUrl
        case stream_url
    }

    init(
        id: String,
        title: String,
        artist: String,
        album: String? = nil,
        canonicalFamilyId: String? = nil,
        artwork: String? = nil,
        artworkColor: String? = nil,
        url: String,
        duration: TimeInterval? = nil,
        source: TrackSource
    ) {
        self.id = id
        self.title = title
        self.artist = artist
        self.album = album
        self.canonicalFamilyId = canonicalFamilyId
        self.artwork = artwork
        self.artworkColor = artworkColor
        self.url = url
        self.duration = duration
        self.source = source
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Unknown Title"
        artist = try container.decodeIfPresent(String.self, forKey: .artist) ?? "Unknown Artist"
        album = try container.decodeIfPresent(String.self, forKey: .album)
        canonicalFamilyId = try container.decodeIfPresent(String.self, forKey: .canonicalFamilyId)
        artwork = try container.decodeIfPresent(String.self, forKey: .artwork)
            ?? container.decodeIfPresent(String.self, forKey: .coverUrl)
            ?? container.decodeIfPresent(String.self, forKey: .cover_url)
        artworkColor = try container.decodeIfPresent(String.self, forKey: .artworkColor)
        url = try container.decodeIfPresent(String.self, forKey: .url)
            ?? container.decodeIfPresent(String.self, forKey: .streamUrl)
            ?? container.decodeIfPresent(String.self, forKey: .stream_url)
            ?? ""
        duration = try container.decodeIfPresent(TimeInterval.self, forKey: .duration)
        source = (try? container.decode(TrackSource.self, forKey: .source)) ?? .local
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(artist, forKey: .artist)
        try container.encodeIfPresent(album, forKey: .album)
        try container.encodeIfPresent(canonicalFamilyId, forKey: .canonicalFamilyId)
        try container.encodeIfPresent(artwork, forKey: .artwork)
        try container.encodeIfPresent(artworkColor, forKey: .artworkColor)
        try container.encode(url, forKey: .url)
        try container.encodeIfPresent(duration, forKey: .duration)
        try container.encode(source, forKey: .source)
    }
}

struct Album: Identifiable, Codable, Hashable {
    var id: String { "\(source ?? "unknown")__\(album)__\(artist)" }
    let album: String
    let artist: String
    let trackCount: Int
    var coverUrl: String?
    var source: String? = nil

    enum CodingKeys: String, CodingKey {
        case album, artist
        case trackCount = "track_count"
        case coverUrl = "cover_url"
        case source
    }
}

struct Artist: Identifiable, Codable, Hashable {
    var id: String { artist }
    let artist: String
    let trackCount: Int
    let albumCount: Int
    var coverUrl: String?
    var source: String? = nil

    enum CodingKeys: String, CodingKey {
        case artist
        case trackCount = "track_count"
        case albumCount = "album_count"
        case coverUrl = "cover_url"
        case source
    }
}

struct SearchArtist: Identifiable, Codable, Hashable {
    let id: String
    let source: String
    let artist: String
    let trackCount: Int
    let albumCount: Int
    var coverUrl: String?
    var sourceId: String?
    var handle: String?
    var subtitle: String?

    enum CodingKeys: String, CodingKey {
        case id, source, artist, handle, subtitle
        case trackCount = "track_count"
        case albumCount = "album_count"
        case coverUrl = "cover_url"
        case sourceId = "source_id"
    }

    var sourceLabel: String {
        switch source {
        case "local": return "Local"
        case "vk": return "VK"
        case "soundcloud": return "SoundCloud"
        case "yandex": return "Yandex"
        case "youtube": return "YouTube"
        case "mixed": return "All sources"
        default: return source.capitalized
        }
    }
}

func normalizedArtistText(_ value: String?) -> String {
    value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
}

func artistSourceDisplayName(_ source: String?) -> String {
    switch source ?? "all" {
    case "all": return "All"
    case "local": return "Local"
    case "vk": return "VK"
    case "soundcloud": return "SoundCloud"
    case "yandex": return "Yandex"
    case "youtube": return "YouTube"
    case "mixed": return "Mixed"
    default: return (source ?? "All").capitalized
    }
}

func artistSourceIcon(_ source: String) -> String {
    switch source {
    case "all": return "square.stack.3d.up"
    case "local": return "externaldrive.fill"
    case "soundcloud": return "cloud.fill"
    case "vk": return "person.2.fill"
    case "yandex": return "y.square.fill"
    case "youtube": return "play.rectangle.fill"
    case "mixed": return "square.stack.3d.up.fill"
    default: return "music.note"
    }
}

func artistSourceRank(_ source: String?) -> Int {
    switch source ?? "all" {
    case "all": return 0
    case "local": return 1
    case "yandex": return 2
    case "youtube": return 3
    case "soundcloud": return 4
    case "vk": return 5
    case "mixed": return 6
    default: return 7
    }
}

func artistDisplayTracks(_ tracks: [Track]) -> [Track] {
    var seen = Set<String>()
    var result: [Track] = []
    for track in tracks.sorted(by: artistTrackSort) {
        let key = "\(normalizedArtistText(track.artist))|\(normalizedArtistText(track.title))"
        guard !seen.contains(key) else { continue }
        seen.insert(key)
        result.append(track)
    }
    return result
}

func artistTrackSort(_ lhs: Track, _ rhs: Track) -> Bool {
    let sourceOrder = artistSourceRank(lhs.source.rawValue) - artistSourceRank(rhs.source.rawValue)
    if sourceOrder != 0 { return sourceOrder < 0 }
    let albumOrder = normalizedArtistText(lhs.album).localizedCaseInsensitiveCompare(normalizedArtistText(rhs.album))
    if albumOrder != .orderedSame { return albumOrder == .orderedAscending }
    return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
}

struct Playlist: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var description: String?
    var tracks: [Track]
    var createdAt: TimeInterval

    enum CodingKeys: String, CodingKey {
        case id, name, description, tracks
        case createdAt = "created_at"
    }

    init(id: String, name: String, description: String? = nil, tracks: [Track] = [], createdAt: TimeInterval = Date().timeIntervalSince1970) {
        self.id = id
        self.name = name
        self.description = description
        self.tracks = tracks
        self.createdAt = createdAt
    }
}

// MARK: - Server Response Models

struct ServerTrack: Codable {
    let id: String
    let source: Track.TrackSource
    let title: String
    let artist: String
    var album: String?
    var duration: TimeInterval
    var canonicalFamilyId: String?
    var coverUrl: String?
    var localPath: String?
    var waveformUrl: String?
    var streamUrl: String?

    // Server uses both snake_case and camelCase
    enum CodingKeys: String, CodingKey {
        case id, source, title, artist, album, duration, canonicalFamilyId
        case coverUrl = "cover_url"
        case localPath = "local_path"
        case waveformUrl = "waveform_url"
        case streamUrl = "stream_url"
    }
}

struct ServerPlaylist: Codable {
    let id: String
    let name: String
    var description: String?
    let trackCount: Int
    let createdAt: TimeInterval
    let updatedAt: TimeInterval
    var coverUrl: String?
    var hasCustomCover: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, description
        case trackCount = "track_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case coverUrl = "cover_url"
        case hasCustomCover = "has_custom_cover"
    }

    init(
        id: String,
        name: String,
        description: String? = nil,
        trackCount: Int,
        createdAt: TimeInterval,
        updatedAt: TimeInterval,
        coverUrl: String? = nil,
        hasCustomCover: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.trackCount = trackCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.coverUrl = coverUrl
        self.hasCustomCover = hasCustomCover
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        trackCount = try container.decodeIfPresent(Int.self, forKey: .trackCount) ?? 0
        createdAt = try container.decodeIfPresent(TimeInterval.self, forKey: .createdAt) ?? 0
        updatedAt = try container.decodeIfPresent(TimeInterval.self, forKey: .updatedAt) ?? createdAt
        coverUrl = try container.decodeIfPresent(String.self, forKey: .coverUrl)

        if let boolValue = try container.decodeIfPresent(Bool.self, forKey: .hasCustomCover) {
            hasCustomCover = boolValue
        } else if let intValue = try container.decodeIfPresent(Int.self, forKey: .hasCustomCover) {
            hasCustomCover = intValue != 0
        } else if let stringValue = try container.decodeIfPresent(String.self, forKey: .hasCustomCover) {
            hasCustomCover = ["1", "true", "yes"].contains(stringValue.lowercased())
        } else {
            hasCustomCover = nil
        }
    }
}

struct ExternalPlaylist: Codable, Identifiable {
    let id: String
    let source: String
    let title: String
    let author: String
    let trackCount: Int
    var coverUrl: String?
    var duration: Double?

    enum CodingKeys: String, CodingKey {
        case id, source, title, author, duration
        case trackCount = "trackCount"
        case coverUrl = "coverUrl"
    }
}

// MARK: - Enums

enum RepeatMode: String {
    case off, track, queue
}

struct MyVibeFilters: Codable, Equatable, Hashable {
    var language: Language = .all
    var character: Character = .favorite
    var mood: Mood = .auto

    static let `default` = MyVibeFilters()

    var isDefault: Bool {
        self == .default
    }

    var summary: String {
        var parts: [String] = [character.title]
        if language != .all {
            parts.append(language.title)
        }
        if mood != .auto {
            parts.append(mood.title)
        }
        return parts.joined(separator: " • ")
    }

    enum Language: String, Codable, CaseIterable, Hashable, Identifiable {
        case all
        case russian
        case foreign

        var id: String { rawValue }

        var title: String {
            switch self {
            case .all: return "Без фильтра"
            case .russian: return "Русское"
            case .foreign: return "Иностранное"
            }
        }

        var serverValue: String? {
            self == .all ? nil : rawValue
        }
    }

    enum Character: String, Codable, CaseIterable, Hashable, Identifiable {
        case favorite
        case unfamiliar
        case popular

        var id: String { rawValue }

        var title: String {
            switch self {
            case .favorite: return "Любимое"
            case .unfamiliar: return "Незнакомое"
            case .popular: return "Популярное"
            }
        }

        var subtitle: String {
            switch self {
            case .favorite: return "Ближе к твоим лайкам"
            case .unfamiliar: return "Похоже, но менее знакомо"
            case .popular: return "Более очевидные хиты"
            }
        }
    }

    enum Mood: String, Codable, CaseIterable, Hashable, Identifiable {
        case auto
        case energy
        case feelGood
        case calm
        case focus
        case romance
        case sad
        case party
        case night

        var id: String { rawValue }

        var title: String {
            switch self {
            case .auto: return "Авто"
            case .energy: return "Бодро"
            case .feelGood: return "Светло"
            case .calm: return "Спокойно"
            case .focus: return "Фокус"
            case .romance: return "Романтика"
            case .sad: return "Грусть"
            case .party: return "Вечеринка"
            case .night: return "Поздний вечер"
            }
        }

        var serverValue: String? {
            self == .auto ? nil : rawValue
        }
    }
}
