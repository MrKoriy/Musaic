import SwiftUI

/// What an artist page was opened for: a library artist (name only) or a
/// search result (with provider IDs).
enum ArtistProfileSubject: Hashable {
    case library(Artist)
    case search(SearchArtist)

    var name: String {
        switch self {
        case .library(let artist): return artist.artist
        case .search(let artist): return artist.artist
        }
    }

    var coverUrl: String? {
        switch self {
        case .library(let artist): return artist.coverUrl
        case .search(let artist): return artist.coverUrl
        }
    }

    var id: String {
        switch self {
        case .library(let artist): return "library:\(artist.id)"
        case .search(let artist): return "search:\(artist.id)"
        }
    }
}

struct ArtistDetailView: View {
    let artist: Artist
    @Binding var showNowPlaying: Bool

    var body: some View {
        ArtistProfileScreen(subject: .library(artist), showNowPlaying: $showNowPlaying)
    }
}

struct ArtistSourceOption: Identifiable, Equatable {
    let id: String
    let label: String
}

struct ArtistAlbumGroup: Identifiable {
    let id: String
    let title: String
    let artist: String
    let coverUrl: String?
    let source: String?
    let tracks: [Track]
}

/// Everything the artist page renders, derived once per data/filter change
/// instead of on every body evaluation.
struct ArtistPageModel {
    var allTracks: [Track] = []
    var sourceOptions = [ArtistSourceOption(id: "all", label: artistSourceDisplayName("all"))]
    var visibleTracks: [Track] = []
    var popularTracks: [Track] = []
    var albums: [ArtistAlbumGroup] = []

    static func build(
        artistName: String,
        serverTracks: [Track],
        fallbackTracks: [Track],
        serverAlbums: [Album],
        availableSources: [String],
        selectedSource: String,
        likedIds: Set<String>
    ) -> ArtistPageModel {
        let base = serverTracks.isEmpty ? fallbackTracks : serverTracks
        var model = ArtistPageModel()
        model.allTracks = base.sorted(by: artistTrackSort)
        let deduplicated = artistDisplayTracks(model.allTracks)

        var countBySource: [String: Int] = [:]
        for track in model.allTracks { countBySource[track.source.rawValue, default: 0] += 1 }
        var seenSources = Set<String>()
        let sources = (availableSources.isEmpty ? Array(countBySource.keys) : availableSources)
            .filter { seenSources.insert($0).inserted }
            .sorted { artistSourceRank($0) < artistSourceRank($1) }
        model.sourceOptions = [ArtistSourceOption(id: "all", label: label(for: "all", count: deduplicated.count))]
            + sources.map { ArtistSourceOption(id: $0, label: label(for: $0, count: countBySource[$0] ?? 0)) }

        model.visibleTracks = selectedSource == "all"
            ? deduplicated
            : model.allTracks.filter { $0.source.rawValue == selectedSource }

        // Server order approximates popularity; liked tracks float to the top.
        let visibleIDs = Set(model.visibleTracks.map(\.id))
        let ranked = base.filter { visibleIDs.contains($0.id) }
        var seenTitles = Set<String>()
        let unique = ranked.filter { seenTitles.insert("\(normalizedArtistText($0.artist))|\(normalizedArtistText($0.title))").inserted }
        model.popularTracks = unique.filter { likedIds.contains($0.id) } + unique.filter { !likedIds.contains($0.id) }

        model.albums = albumGroups(
            artistName: artistName,
            tracks: model.visibleTracks,
            serverAlbums: serverAlbums,
            selectedSource: selectedSource
        )
        return model
    }

    private static func label(for source: String, count: Int) -> String {
        count > 0 ? "\(artistSourceDisplayName(source)) \(count)" : artistSourceDisplayName(source)
    }

    /// O(n) grouping of tracks by album title, enriched with server album
    /// metadata (covers, albums whose tracks aren't loaded yet).
    private static func albumGroups(
        artistName: String,
        tracks: [Track],
        serverAlbums: [Album],
        selectedSource: String
    ) -> [ArtistAlbumGroup] {
        var tracksByAlbum: [String: [Track]] = [:]
        var titleByKey: [String: String] = [:]
        for track in tracks {
            let title = normalizedLibraryText(track.album)
            guard !title.isEmpty else { continue }
            let key = normalizedArtistText(title)
            tracksByAlbum[key, default: []].append(track)
            if titleByKey[key] == nil { titleByKey[key] = title }
        }

        var metaByKey: [String: Album] = [:]
        for album in serverAlbums
        where selectedSource == "all" || album.source == selectedSource || album.source == "mixed" {
            let key = normalizedArtistText(album.album)
            guard !key.isEmpty, metaByKey[key] == nil else { continue }
            metaByKey[key] = album
            if titleByKey[key] == nil { titleByKey[key] = album.album }
        }

        return titleByKey.map { key, title in
            let albumTracks = tracksByAlbum[key] ?? []
            let meta = metaByKey[key]
            let trackSources = Set(albumTracks.map(\.source.rawValue))
            let source = trackSources.count > 1 ? "mixed" : (trackSources.first ?? meta?.source)
            return ArtistAlbumGroup(
                id: key,
                title: title,
                artist: meta?.artist ?? artistName,
                coverUrl: meta?.coverUrl ?? albumTracks.first?.artwork,
                source: source,
                tracks: albumTracks
            )
        }
        .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }
}

struct ArtistProfileScreen: View {
    let subject: ArtistProfileSubject
    @Binding var showNowPlaying: Bool

    @State private var profileArtist: SearchArtist?
    @State private var serverTracks: [Track] = []
    @State private var serverAlbums: [Album] = []
    @State private var availableSources: [String] = []
    @State private var selectedSource = "all"
    @State private var loading = true
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var sourceErrors: [String: String] = [:]
    @State private var playlistPickerTrack: Track?
    @State private var model = ArtistPageModel()

    private static let popularLimit = 10
    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

    private var bannerArtworkURL: String? {
        api.artworkURL(for: profileArtist?.coverUrl ?? subject.coverUrl)
            ?? model.visibleTracks.first?.artwork
            ?? model.allTracks.first?.artwork
    }

    private var bannerSubtitle: String? {
        guard case .search(let artist) = subject else { return nil }
        let display = profileArtist ?? artist
        if let subtitle = display.subtitle, !subtitle.isEmpty { return subtitle }
        return display.sourceLabel
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ArtistDetailBanner(
                    artworkURL: bannerArtworkURL,
                    artistName: profileArtist?.artist ?? subject.name,
                    albumCount: model.albums.count,
                    trackCount: model.visibleTracks.count,
                    subtitle: bannerSubtitle
                )

                VStack(spacing: 24) {
                    if loading && model.allTracks.isEmpty {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .padding(.top, 40)
                    } else if model.allTracks.isEmpty {
                        ContentUnavailableView(
                            String(localized: "No Tracks"),
                            systemImage: "person.fill.questionmark",
                            description: Text(loadError ?? String(localized: "No tracks were found for this artist."))
                        )
                        .padding(.top, 40)
                    } else {
                        sourceFilter
                            .padding(.top, 18)

                        if !sourceErrors.isEmpty {
                            ArtistSourceWarning(errors: sourceErrors)
                                .padding(.horizontal, 18)
                        }

                        PlayShuffleButtons(tracks: model.visibleTracks) { showNowPlaying = true }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 18)

                        popularSection

                        if !model.albums.isEmpty {
                            albumsSection
                        }
                    }
                }
                .padding(.bottom, Layout.playerBottomInset)
            }
        }
        .background(AppBackdrop())
        .navigationTitle(profileArtist?.artist ?? subject.name)
        .navigationBarTitleDisplayModeCompat()
        .task(id: subject.id) {
            guard !hasLoaded else { return }
            await load()
        }
        .onChange(of: selectedSource) { rebuildModel() }
        .onChange(of: library.likedTrackIds) { rebuildModel() }
        .sheet(item: $playlistPickerTrack) { track in
            PlaylistPickerView(track: track)
        }
    }

    private var sourceFilter: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.sourceOptions) { option in
                    Button {
                        selectedSource = option.id
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: artistSourceIcon(option.id))
                                .font(.system(size: 12, weight: .semibold))
                            Text(option.label)
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(Color.textPrimary)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 10)
                        .liquidChipSurface(selected: selectedSource == option.id)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selectedSource == option.id ? .isSelected : [])
                }
            }
            .padding(.horizontal, 18)
        }
    }

    @ViewBuilder
    private var popularSection: some View {
        let popular = Array(model.popularTracks.prefix(Self.popularLimit))
        if !popular.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(String(localized: "Popular Tracks"))
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 18)

                LazyVStack(spacing: 10) {
                    ForEach(popular.listItems) { item in
                        TrackRow(
                            track: item.track,
                            index: item.index + 1,
                            isCurrent: player.currentTrack?.id == item.track.id,
                            isLiked: library.isLiked(item.track.id),
                            onTap: {
                                if player.setQueue(model.popularTracks, startAt: item.index) {
                                    showNowPlaying = true
                                }
                            },
                            onLike: { library.toggleLike(track: item.track) },
                            onAddToQueue: { player.addToQueue(item.track) },
                            onAddToPlaylist: { playlistPickerTrack = item.track }
                        )
                    }
                }

                if model.visibleTracks.count > popular.count {
                    NavigationLink {
                        ArtistAllTracksView(
                            artistName: subject.name,
                            tracks: model.visibleTracks,
                            showNowPlaying: $showNowPlaying
                        )
                    } label: {
                        HStack(spacing: 8) {
                            Text(String(localized: "All songs (\(model.visibleTracks.count))"))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(Color.textSecondary)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity)
                        .glassCard(cornerRadius: 18, intensity: 0.08)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 18)
                    .padding(.top, 4)
                }
            }
        }
    }

    private var albumsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(String(localized: "Albums"))
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .padding(.horizontal, 18)

            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 14) {
                ForEach(model.albums) { group in
                    NavigationLink {
                        AlbumDetailView(
                            albumTitle: group.title,
                            artistName: group.artist,
                            coverUrl: group.coverUrl,
                            source: group.source == "mixed" ? nil : group.source,
                            preloadedTracks: group.tracks,
                            showNowPlaying: $showNowPlaying
                        )
                    } label: {
                        VStack(alignment: .leading, spacing: 10) {
                            ArtworkTile(urlString: api.artworkURL(for: group.coverUrl), icon: "opticaldisc")
                                .aspectRatio(1, contentMode: .fit)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(group.title)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(albumCaption(group))
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Color.textSecondary)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                        }
                        .glassCard(cornerRadius: 22, intensity: 0.10)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
        }
    }

    private func albumCaption(_ group: ArtistAlbumGroup) -> String {
        let source = artistSourceDisplayName(group.source)
        return group.tracks.isEmpty ? source : "\(source) • " + String(localized: "\(group.tracks.count) tracks")
    }

    // MARK: - Data

    /// Library artists fall back to the liked subset when the server has nothing.
    private var fallbackTracks: [Track] {
        guard case .library(let artist) = subject else { return [] }
        return library.displayedLikedTracks.filter { trackBelongs(to: artist, track: $0) }
    }

    private func rebuildModel() {
        model = ArtistPageModel.build(
            artistName: subject.name,
            serverTracks: serverTracks,
            fallbackTracks: fallbackTracks,
            serverAlbums: serverAlbums,
            availableSources: availableSources,
            selectedSource: selectedSource,
            likedIds: library.likedTrackIds
        )
    }

    private func load() async {
        loading = true
        loadError = nil
        sourceErrors = [:]
        defer { loading = false }
        // Seed the page from liked tracks while the server profile loads.
        if case .library = subject {
            await library.hydrateLikedTracksIfNeeded()
            rebuildModel()
        }

        do {
            let sources = settings.enabledSourcesParam
            let response: ArtistProfileResponse
            switch subject {
            case .library(let artist):
                response = try await api.getArtistProfile(artistName: artist.artist, sources: sources)
            case .search(let artist):
                response = try await api.getArtistProfile(artist: artist, sources: sources)
            }
            profileArtist = response.artist
            serverTracks = response.tracks.map(api.toAppTrack)
            serverAlbums = response.albums
            availableSources = response.availableSources ?? []
            sourceErrors = response.errors ?? [:]
            hasLoaded = true
        } catch where error.isCancellation {
            return
        } catch {
            loadError = error.localizedDescription
            hasLoaded = true
        }
        rebuildModel()
        if !model.sourceOptions.contains(where: { $0.id == selectedSource }) {
            selectedSource = "all"
        }
    }
}
