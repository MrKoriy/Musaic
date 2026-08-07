#if os(iOS)
import PhotosUI
#endif
import SwiftUI
import UniformTypeIdentifiers

private func normalizedLibraryText(_ value: String?) -> String {
    value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func libraryArtistName(for track: Track) -> String? {
    let artist = normalizedLibraryText(track.artist)
    return artist.isEmpty ? nil : artist
}

private func libraryAlbumTitle(for track: Track) -> String {
    let album = normalizedLibraryText(track.album)
    if !album.isEmpty { return album }

    let title = normalizedLibraryText(track.title)
    return title.isEmpty ? "Untitled Single" : title
}

private func trackBelongs(to album: Album, track: Track) -> Bool {
    guard libraryArtistName(for: track) == album.artist else { return false }
    guard libraryAlbumTitle(for: track) == album.album else { return false }
    if let source = album.source {
        return track.source.rawValue == source
    }
    return true
}

private func trackBelongs(to artist: Artist, track: Track) -> Bool {
    libraryArtistName(for: track) == artist.artist
}

struct LibraryView: View {
    @Binding var showNowPlaying: Bool
    // Persisted so it survives sheet dismiss / view recreation
    @AppStorage("library_selected_tab") private var selectedTab = "Liked"
    @State private var playlists: [ServerPlaylist] = []
    @State private var loading = false
    @State private var showNewPlaylist = false
    @State private var showImport = false
    @State private var newPlaylistName = ""
    @State private var playlistPickerTrack: Track?
    @State private var currentTrackId: String?
    @State private var downloadedOnly = false

    private let tabs = ["Playlists", "Albums", "Artists", "Liked"]
    private let downloadManager = DownloadManager.shared
    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    headerSection

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(tabs, id: \.self) { tab in
                                Button(tab) {
                                    selectedTab = tab
                                }
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .liquidChipSurface(selected: selectedTab == tab)
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 18)
                    }

                    Group {
                        switch selectedTab {
                        case "Liked":
                            likedView
                        case "Playlists":
                            playlistsView
                        case "Albums":
                            albumsView
                        case "Artists":
                            artistsView
                        default:
                            EmptyView()
                        }
                    }
                }
                .padding(.top, 12)
                .padding(.bottom, Layout.playerBottomInset)
            }
            .background(AppBackdrop())
            .scrollIndicators(.hidden)
            .task {
                await library.ensureSynced()
                await loadData()
            }
            .refreshable { await loadData() }
            .onAppear { currentTrackId = player.currentTrack?.id }
            .onChange(of: player.currentTrack?.id) { _, newId in currentTrackId = newId }
            .alert("New Playlist", isPresented: $showNewPlaylist) {
                TextField("Playlist name", text: $newPlaylistName)
                Button("Create") { createPlaylist() }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $playlistPickerTrack) { track in
                PlaylistPickerView(track: track)
            }
            .sheet(isPresented: $showImport) {
                ImportPlaylistView(showNowPlaying: $showNowPlaying)
            }
            .navigationBarHiddenCompat(true)
        }
    }

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                LiquidSectionHeader(title: "Your Library", subtitle: "Albums, artists, playlists and the tracks you keep around.")
                Spacer(minLength: 12)
                if selectedTab == "Playlists" {
                    HStack(spacing: 8) {
                        LiquidIconButton(systemName: "square.and.arrow.down") {
                            showImport = true
                        }
                        LiquidIconButton(systemName: "plus") {
                            showNewPlaylist = true
                        }
                    }
                }
            }

            HStack(spacing: 12) {
                libraryStat(title: "Liked", value: "\(library.likedTrackIds.count)")
                libraryStat(title: "Albums", value: "\(library.likedAlbums.count)")
                libraryStat(title: "Playlists", value: "\(playlists.count)")
            }
        }
        .padding(.horizontal, 18)
    }

    private var likedView: some View {
        let allLiked = library.displayedLikedTracks
        let liked = downloadedOnly ? allLiked.filter { downloadManager.isDownloaded($0.id) } : allLiked

        return VStack(spacing: 12) {
            // Downloaded only toggle
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(downloadedOnly ? .green : Color.textSecondary)
                    Text("Downloaded only")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                }
                Spacer()
                Toggle("", isOn: $downloadedOnly)
                    .labelsHidden()
                    .tint(Color.accentStrong)
            }
            .padding(.horizontal, 18)

            if liked.isEmpty {
                if downloadedOnly {
                    emptyState(title: "No downloads", subtitle: "Tap the arrow icon on any track to download it for offline listening.", icon: "arrow.down.circle")
                } else if library.likedTrackIds.isEmpty {
                    emptyState(title: "No liked songs", subtitle: "Tap the heart icon on any track to pin it here.", icon: "heart")
                } else {
                    emptyState(title: "Restoring liked songs", subtitle: "Your saved likes are syncing back into the library.", icon: "heart.fill")
                }
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(liked.indices, id: \.self) { idx in
                        let track = liked[idx]
                        TrackRow(
                            track: track,
                            index: idx + 1,
                            isCurrent: currentTrackId == track.id,
                            isLiked: true,
                            onTap: {
                                if player.setQueue(liked, startAt: idx) {
                                    showNowPlaying = true
                                }
                            },
                            onLike: { library.toggleLike(track: track) },
                            onAddToQueue: { player.addToQueue(track) },
                            onAddToPlaylist: { playlistPickerTrack = track }
                        )
                    }
                }
            }
        }
    }

    private var playlistsView: some View {
        VStack(spacing: 14) {
            Button {
                showNewPlaylist = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color.textPrimary)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle()
                                .fill(Color.clear)
                                .liquidProminentSurface(cornerRadius: 18, accent: Color(hex: "d9b17b"))
                        )
                    VStack(alignment: .leading, spacing: 4) {
                        Text("New Playlist")
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text("Create a fresh playlist and start filling it right away.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                }
                .padding(14)
                .glassCard(cornerRadius: 24, intensity: 0.10)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 18)

            if playlists.isEmpty {
                emptyState(title: "No playlists yet", subtitle: "Create one and give it a custom cover from Photos or Files.", icon: "music.note.list")
            } else {
                LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 14) {
                    ForEach(playlists, id: \.id) { playlist in
                        NavigationLink {
                            PlaylistDetailView(playlistId: playlist.id, initialPlaylist: playlist, showNowPlaying: $showNowPlaying)
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                PlaylistArtworkView(coverURL: api.artworkURL(for: playlist.coverUrl))
                                    .aspectRatio(1, contentMode: .fit)

                                Text(playlist.name)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text("\(playlist.trackCount) tracks")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Color.textSecondary)
                            }
                            .padding(12)
                            .glassCard(cornerRadius: 26, intensity: 0.10)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
            }
        }
    }

    private var albumsView: some View {
        Group {
            if library.likedAlbums.isEmpty {
                emptyState(title: "No albums yet", subtitle: "Like tracks and their releases will show up here.", icon: "opticaldisc")
            } else {
                LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 14) {
                    ForEach(library.likedAlbums) { album in
                        NavigationLink {
                            AlbumDetailView(album: album, showNowPlaying: $showNowPlaying)
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                ArtworkTile(urlString: api.artworkURL(for: album.coverUrl), icon: "opticaldisc")
                                    .aspectRatio(1, contentMode: .fit)
                                Text(album.album)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text(album.artist)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Color.textSecondary)
                                    .lineLimit(1)
                            }
                            .padding(12)
                            .glassCard(cornerRadius: 26, intensity: 0.10)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
            }
        }
    }

    private var artistsView: some View {
        Group {
            if library.likedArtists.isEmpty {
                emptyState(title: "No artists yet", subtitle: "Like tracks to build your artist pages here.", icon: "person.2")
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(library.likedArtists) { artist in
                        NavigationLink {
                            ArtistDetailView(artist: artist, showNowPlaying: $showNowPlaying)
                        } label: {
                            HStack(spacing: 14) {
                                Circle()
                                    .fill(Color.white.opacity(0.08))
                                    .frame(width: 58, height: 58)
                                    .overlay(
                                        InspectableArtworkView(
                                            urlString: api.artworkURL(for: artist.coverUrl),
                                            debugLabel: "library-artist: \(artist.artist)",
                                            contentMode: .fill,
                                            maxPixelSize: 220
                                        ) {
                                            Image(systemName: "person.fill")
                                                .foregroundStyle(Color.textPrimary)
                                        }
                                        .clipShape(Circle())
                                    )
                                    .overlay(Circle().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(artist.artist)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(Color.textPrimary)
                                    Text("\(artist.albumCount) albums • \(artist.trackCount) tracks")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.textSecondary)
                                }
                                Spacer()
                            }
                            .padding(14)
                            .glassCard(cornerRadius: 24, intensity: 0.10)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 18)
                    }
                }
            }
        }
    }

    private func emptyState(title: String, subtitle: String, icon: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Text(title)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(subtitle)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .glassCard(cornerRadius: 28, intensity: 0.08)
        .padding(.horizontal, 18)
        .padding(.top, 24)
    }

    private func libraryStat(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 22, tint: Color.accentStrong, intensity: 0.10)
    }

    private func loadData() async {
        loading = true
        await library.hydrateLikedTracksIfNeeded()
        playlists = (try? await api.getPlaylists()) ?? []
        loading = false
    }

    private func createPlaylist() {
        let trimmedName = newPlaylistName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }
        Task {
            _ = try? await api.createPlaylist(name: trimmedName)
            newPlaylistName = ""
            await loadData()
        }
    }
}

struct ArtworkTile: View {
    let urlString: String?
    let icon: String

    var body: some View {
        GeometryReader { geo in
            InspectableArtworkView(
                urlString: urlString,
                debugLabel: icon,
                maxPixelSize: 900
            ) {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(Image(systemName: icon).font(.system(size: 28)).foregroundStyle(Color.textSecondary))
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct PlaylistArtworkView: View {
    let coverURL: String?

    var body: some View {
        ArtworkTile(urlString: coverURL, icon: "music.note.list")
    }
}

// AlbumDetailView is defined further down — Library Album callers use the
// `album:` convenience initialiser, ArtistDetailView passes individual fields.

/// Full discography list for an artist. Pushed from `ArtistDetailView` via the
/// "Все песни" button. Preloaded tracks come from the artist profile, so no
/// extra server roundtrip is needed.
struct ArtistAllTracksView: View {
    let artistName: String
    let tracks: [Track]
    @Binding var showNowPlaying: Bool
    @State private var playlistPickerTrack: Track?

    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Button {
                        if player.setQueue(tracks, startAt: 0) {
                            showNowPlaying = true
                        }
                    } label: {
                        Label("Play All", systemImage: "play.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 13)
                            .background(
                                Capsule()
                                    .fill(Color.clear)
                                    .liquidProminentSurface(cornerRadius: 999, accent: Color(hex: "d9b17b"))
                            )
                    }
                    .buttonStyle(.plain)

                    Button {
                        var shuffled = tracks
                        shuffled.shuffle()
                        if player.setQueue(shuffled, startAt: 0) {
                            showNowPlaying = true
                        }
                    } label: {
                        Label("Shuffle", systemImage: "shuffle")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 13)
                            .glassCard(cornerRadius: 22, intensity: 0.08)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)

                LazyVStack(spacing: 10) {
                    ForEach(Array(tracks.enumerated()), id: \.element.id) { idx, track in
                        TrackRow(
                            track: track,
                            index: idx + 1,
                            isCurrent: player.currentTrack?.id == track.id,
                            isLiked: library.isLiked(track.id),
                            onTap: {
                                if player.setQueue(tracks, startAt: idx) {
                                    showNowPlaying = true
                                }
                            },
                            onLike: { library.toggleLike(track: track) },
                            onAddToQueue: { player.addToQueue(track) },
                            onAddToPlaylist: { playlistPickerTrack = track }
                        )
                    }
                }
            }
            .padding(.bottom, Layout.playerBottomInset)
        }
        .background(AppBackdrop())
        .navigationTitle(artistName)
        .navigationBarTitleDisplayModeCompat()
        .sheet(item: $playlistPickerTrack) { track in
            PlaylistPickerView(track: track)
        }
    }
}

struct ArtistDetailView: View {
    let artist: Artist
    @Binding var showNowPlaying: Bool

    /// Server-hydrated discography (VK + SoundCloud + local cache). Replaces the
    /// previous "liked-tracks-only" view so Popular Tracks and Albums reflect the
    /// real artist catalog, not just what the user has hearted.
    @State private var profileArtist: SearchArtist?
    @State private var profileTracks: [Track] = []
    @State private var profileAlbums: [Album] = []
    @State private var availableSources: [String] = []
    @State private var selectedSource = "all"
    @State private var loadingProfile = true
    @State private var profileError: String?
    @State private var sourceErrors: [String: String] = [:]
    @State private var playlistPickerTrack: Track?

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

    private var enabledSources: [String] {
        ["local"]
            + (settings.sourceSoundcloud ? ["soundcloud"] : [])
            + (settings.sourceVK ? ["vk"] : [])
    }

    /// Server tracks first; fall back to liked-only if the server returned nothing
    /// (e.g. an offline-only library artist).
    private var allTracks: [Track] {
        if !profileTracks.isEmpty { return profileTracks.sorted(by: artistTrackSort) }
        return library.displayedLikedTracks
            .filter { trackBelongs(to: artist, track: $0) }
            .sorted(by: artistTrackSort)
    }

    private var sourceOptions: [String] {
        let sources = availableSources.isEmpty
            ? Array(Set(allTracks.map { $0.source.rawValue })).sorted { artistSourceRank($0) < artistSourceRank($1) }
            : availableSources.sorted { artistSourceRank($0) < artistSourceRank($1) }
        return sources.isEmpty ? ["all"] : ["all"] + sources
    }

    private var filteredTracks: [Track] {
        selectedSource == "all"
            ? artistDisplayTracks(allTracks)
            : allTracks.filter { $0.source.rawValue == selectedSource }.sorted(by: artistTrackSort)
    }

    /// Top tracks ordered by liked-status first (familiar hits the user already
    /// approved), then alphabetical for stable display. With server data this
    /// surfaces real popular tracks instead of a slice of the liked list.
    private var popularTracks: [Track] {
        let scored = filteredTracks.map { ($0, library.isLiked($0.id) ? 0 : 1) }
        let sorted = scored.sorted { lhs, rhs in
            if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
            return lhs.0.title.localizedCaseInsensitiveCompare(rhs.0.title) == .orderedAscending
        }
        return Array(sorted.prefix(5).map(\.0))
    }

    /// Album groups: prefer server-returned albums when available, falling back
    /// to grouping the displayed tracks by album title.
    private var albumGroups: [(album: String, coverUrl: String?, source: String?, tracks: [Track])] {
        let visibleTracks = filteredTracks
        var seen = Set<String>()
        var groups: [(album: String, coverUrl: String?, source: String?, tracks: [Track])] = []
        for track in visibleTracks {
            let albumTitle = libraryAlbumTitle(for: track)
            let key = normalizedArtistText(albumTitle)
            if !seen.contains(key) {
                seen.insert(key)
                let albumTracks = visibleTracks.filter { libraryAlbumTitle(for: $0) == albumTitle }
                let albumMeta = profileAlbums.first {
                    normalizedArtistText($0.album) == normalizedArtistText(albumTitle)
                        && (selectedSource == "all" || $0.source == selectedSource || $0.source == "mixed")
                }
                let sources = Set(albumTracks.map { $0.source.rawValue })
                let source = sources.count > 1 ? "mixed" : albumTracks.first?.source.rawValue
                groups.append((
                    album: albumTitle,
                    coverUrl: albumMeta?.coverUrl ?? albumTracks.first?.artwork,
                    source: source,
                    tracks: albumTracks
                ))
            }
        }
        return groups.sorted { $0.album.localizedCaseInsensitiveCompare($1.album) == .orderedAscending }
    }

    private var bannerArtworkURL: String? {
        profileArtist?.coverUrl ?? artist.coverUrl ?? filteredTracks.first?.artwork ?? allTracks.first?.artwork
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Artist Banner
                artistBanner

                VStack(spacing: 24) {
                    if loadingProfile && allTracks.isEmpty {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .padding(.top, 40)
                    } else if allTracks.isEmpty {
                        ContentUnavailableView("No Tracks", systemImage: "person.fill.questionmark", description: Text(profileError ?? "No tracks were found for this artist."))
                            .padding(.top, 40)
                    } else {
                        artistSourceFilter
                            .padding(.top, 18)

                        if !sourceErrors.isEmpty {
                            ArtistSourceWarning(errors: sourceErrors)
                                .padding(.horizontal, 18)
                        }

                        artistQueueButtons(for: filteredTracks)

                        // Popular Tracks
                        if !popularTracks.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Popular Tracks")
                                    .font(.system(size: 18, weight: .bold, design: .rounded))
                                    .foregroundStyle(Color.textPrimary)
                                    .padding(.horizontal, 18)

                                LazyVStack(spacing: 10) {
                                    ForEach(Array(popularTracks.enumerated()), id: \.element.id) { idx, track in
                                        TrackRow(
                                            track: track,
                                            index: idx + 1,
                                            isCurrent: player.currentTrack?.id == track.id,
                                            isLiked: library.isLiked(track.id),
                                            onTap: {
                                                let startIdx = filteredTracks.firstIndex(where: { $0.id == track.id }) ?? 0
                                                if player.setQueue(filteredTracks, startAt: startIdx) {
                                                    showNowPlaying = true
                                                }
                                            },
                                            onLike: { library.toggleLike(track: track) },
                                            onAddToQueue: { player.addToQueue(track) },
                                            onAddToPlaylist: { playlistPickerTrack = track }
                                        )
                                    }
                                }

                                // Push into the full discography when there are more
                                // tracks than the popular-5 preview shows.
                                if filteredTracks.count > popularTracks.count {
                                    NavigationLink {
                                        ArtistAllTracksView(
                                            artistName: artist.artist,
                                            tracks: filteredTracks,
                                            showNowPlaying: $showNowPlaying
                                        )
                                    } label: {
                                        HStack(spacing: 8) {
                                            Text("Все песни (\(filteredTracks.count))")
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

                        // Albums Grid — tap pushes into AlbumDetailView so the
                        // user can see the full track list instead of starting
                        // playback immediately.
                        if !albumGroups.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Albums")
                                    .font(.system(size: 18, weight: .bold, design: .rounded))
                                    .foregroundStyle(Color.textPrimary)
                                    .padding(.horizontal, 18)

                                LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 14) {
                                    ForEach(albumGroups, id: \.album) { group in
                                        NavigationLink {
                                            AlbumDetailView(
                                                albumTitle: group.album,
                                                artistName: artist.artist,
                                                coverUrl: group.coverUrl,
                                                source: group.source,
                                                preloadedTracks: group.tracks,
                                                showNowPlaying: $showNowPlaying
                                            )
                                        } label: {
                                            VStack(alignment: .leading, spacing: 10) {
                                                ArtworkTile(urlString: api.artworkURL(for: group.coverUrl), icon: "opticaldisc")
                                                    .aspectRatio(1, contentMode: .fit)
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text(group.album)
                                                        .font(.system(size: 13, weight: .semibold))
                                                        .foregroundStyle(Color.textPrimary)
                                                        .lineLimit(2)
                                                        .multilineTextAlignment(.leading)
                                                        .fixedSize(horizontal: false, vertical: true)
                                                        .frame(maxWidth: .infinity, alignment: .leading)
                                                    Text("\(artistSourceDisplayName(group.source)) • \(group.tracks.count) tracks")
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
                    }
                }
                .padding(.bottom, Layout.playerBottomInset)
            }
        }
        .background(AppBackdrop())
        .navigationTitle(artist.artist)
        .navigationBarTitleDisplayModeCompat()
        .task {
            await library.hydrateLikedTracksIfNeeded()
            await loadServerProfile()
        }
        .sheet(item: $playlistPickerTrack) { track in
            PlaylistPickerView(track: track)
        }
    }

    private var artistBanner: some View {
        ZStack(alignment: .bottom) {
            // Blurred artwork background
            GeometryReader { geo in
                InspectableArtworkView(
                    urlString: api.artworkURL(for: bannerArtworkURL),
                    debugLabel: "artist-banner",
                    contentMode: .fill,
                    maxPixelSize: 800
                ) {
                    Rectangle().fill(Color.white.opacity(0.08))
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .blur(radius: 24)
                .overlay(
                    LinearGradient(
                        colors: [Color.black.opacity(0.3), Color.black.opacity(0.7)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }
            .frame(height: 240)
            .clipped()

            // Artist info overlay
            VStack(spacing: 8) {
                // Avatar circle
                Circle()
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 90, height: 90)
                    .overlay(
                        InspectableArtworkView(
                            urlString: api.artworkURL(for: bannerArtworkURL),
                            debugLabel: "artist-avatar",
                            contentMode: .fill,
                            maxPixelSize: 300
                        ) {
                            Image(systemName: "person.fill")
                                .font(.system(size: 34))
                                .foregroundStyle(Color.textPrimary)
                        }
                        .clipShape(Circle())
                    )

                Text(artist.artist)
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                    .multilineTextAlignment(.center)
                    .shadow(color: .black.opacity(0.5), radius: 4, y: 2)

                Text("\(albumGroups.count) albums • \(filteredTracks.count) tracks")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.75))
            }
            .padding(.bottom, 20)
        }
        .frame(height: 240)
    }

    private var artistSourceFilter: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(sourceOptions, id: \.self) { source in
                    Button {
                        selectedSource = source
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: artistSourceIcon(source))
                                .font(.system(size: 12, weight: .semibold))
                            Text(sourceFilterLabel(source))
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(Color.textPrimary)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 10)
                        .liquidChipSurface(selected: selectedSource == source)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
        }
    }

    private func artistQueueButtons(for tracks: [Track]) -> some View {
        HStack(spacing: 12) {
            Button {
                if player.setQueue(tracks, startAt: 0) {
                    showNowPlaying = true
                }
            } label: {
                Label("Play All", systemImage: "play.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 13)
                    .background(
                        Capsule()
                            .fill(Color.clear)
                            .liquidProminentSurface(cornerRadius: 999, accent: Color(hex: "d9b17b"))
                    )
            }
            .buttonStyle(.plain)
            .disabled(tracks.isEmpty)
            .opacity(tracks.isEmpty ? 0.45 : 1)

            Button {
                var shuffled = tracks
                shuffled.shuffle()
                if player.setQueue(shuffled, startAt: 0) {
                    showNowPlaying = true
                }
            } label: {
                Label("Shuffle", systemImage: "shuffle")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 13)
                    .glassCard(cornerRadius: 22, intensity: 0.08)
            }
            .buttonStyle(.plain)
            .disabled(tracks.isEmpty)
            .opacity(tracks.isEmpty ? 0.45 : 1)
        }
        .padding(.horizontal, 18)
    }

    private func sourceFilterLabel(_ source: String) -> String {
        let count = source == "all"
            ? artistDisplayTracks(allTracks).count
            : allTracks.filter { $0.source.rawValue == source }.count
        return count > 0 ? "\(artistSourceDisplayName(source)) \(count)" : artistSourceDisplayName(source)
    }

    /// Pull the artist's full discography from the server. This is what makes
    /// Popular Tracks reflect actual popular songs (VK/SC catalog) rather than
    /// just the user's liked subset.
    @MainActor
    private func loadServerProfile() async {
        loadingProfile = true
        profileError = nil
        sourceErrors = [:]
        defer { loadingProfile = false }
        do {
            let response = try await api.getArtistProfile(artistName: artist.artist, sources: enabledSources.joined(separator: ","))
            profileArtist = response.artist
            profileTracks = response.tracks.map(api.toAppTrack)
            profileAlbums = response.albums
            availableSources = response.availableSources ?? Array(Set(profileTracks.map { $0.source.rawValue }))
            sourceErrors = response.errors ?? [:]
            if !sourceOptions.contains(selectedSource) {
                selectedSource = "all"
            }
        } catch {
            profileError = error.localizedDescription
            profileArtist = nil
            profileTracks = []
            profileAlbums = []
            availableSources = []
            sourceErrors = [:]
            // Keep `profileTracks` empty so `allTracks` falls back to liked tracks.
        }
    }
}

// MARK: - Album Detail

/// Detail screen for a single album. Lazily fetches the full track list when
/// the caller couldn't preload it (e.g. server-returned albums in the artist
/// view only carry metadata, not the tracks themselves).
struct AlbumDetailView: View {
    let albumTitle: String
    let artistName: String
    let coverUrl: String?
    let source: String?
    let preloadedTracks: [Track]
    @Binding var showNowPlaying: Bool

    @State private var tracks: [Track]
    @State private var loading: Bool
    @State private var loadError: String?
    @State private var playlistPickerTrack: Track?

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    init(
        albumTitle: String,
        artistName: String,
        coverUrl: String?,
        source: String?,
        preloadedTracks: [Track] = [],
        showNowPlaying: Binding<Bool>
    ) {
        self.albumTitle = albumTitle
        self.artistName = artistName
        self.coverUrl = coverUrl
        self.source = source
        self.preloadedTracks = preloadedTracks
        self._showNowPlaying = showNowPlaying
        self._tracks = State(initialValue: preloadedTracks)
        self._loading = State(initialValue: preloadedTracks.isEmpty)
    }

    /// Convenience init for the library Albums grid which passes an `Album`
    /// directly. The body still pulls the real tracklist from the server.
    init(album: Album, showNowPlaying: Binding<Bool>) {
        self.init(
            albumTitle: album.album,
            artistName: album.artist,
            coverUrl: album.coverUrl,
            source: album.source,
            preloadedTracks: [],
            showNowPlaying: showNowPlaying
        )
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                header

                if loading && tracks.isEmpty {
                    ProgressView()
                        .tint(Color.textPrimary)
                        .padding(.top, 40)
                } else if tracks.isEmpty {
                    ContentUnavailableView("No tracks", systemImage: "opticaldisc", description: Text(loadError ?? "No tracks were found for this album."))
                        .padding(.top, 40)
                } else {
                    HStack(spacing: 12) {
                        Button {
                            if player.setQueue(tracks, startAt: 0) {
                                showNowPlaying = true
                            }
                        } label: {
                            Label("Play All", systemImage: "play.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 13)
                                .background(
                                    Capsule()
                                        .fill(Color.clear)
                                        .liquidProminentSurface(cornerRadius: 999, accent: Color(hex: "d9b17b"))
                                )
                        }
                        .buttonStyle(.plain)

                        Button {
                            var shuffled = tracks
                            shuffled.shuffle()
                            if player.setQueue(shuffled, startAt: 0) {
                                showNowPlaying = true
                            }
                        } label: {
                            Label("Shuffle", systemImage: "shuffle")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 13)
                                .glassCard(cornerRadius: 22, intensity: 0.08)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 18)

                    LazyVStack(spacing: 10) {
                        ForEach(Array(tracks.enumerated()), id: \.element.id) { idx, track in
                            TrackRow(
                                track: track,
                                index: idx + 1,
                                isCurrent: player.currentTrack?.id == track.id,
                                isLiked: library.isLiked(track.id),
                                onTap: {
                                    if player.setQueue(tracks, startAt: idx) {
                                        showNowPlaying = true
                                    }
                                },
                                onLike: { library.toggleLike(track: track) },
                                onAddToQueue: { player.addToQueue(track) },
                                onAddToPlaylist: { playlistPickerTrack = track }
                            )
                        }
                    }
                }
            }
            .padding(.bottom, Layout.playerBottomInset)
        }
        .background(AppBackdrop())
        .navigationTitle(albumTitle)
        .navigationBarTitleDisplayModeCompat()
        .sheet(item: $playlistPickerTrack) { track in
            PlaylistPickerView(track: track)
        }
        .task {
            // Always try to refresh from the server so liked-tracks fallback
            // gets replaced with the real album tracklist when available.
            await loadTracks()
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ArtworkTile(urlString: api.artworkURL(for: coverUrl), icon: "opticaldisc")
                .frame(width: 200, height: 200)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: .black.opacity(0.4), radius: 18, y: 10)

            VStack(spacing: 6) {
                Text(albumTitle)
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                    .multilineTextAlignment(.center)
                Text(artistName)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                Text("\(tracks.count) tracks\(source.map { " • \($0.uppercased())" } ?? "")")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
            }
            .padding(.horizontal, 18)
        }
        .padding(.top, 24)
    }

    @MainActor
    private func loadTracks() async {
        // Skip server hit when we already have the tracklist.
        guard preloadedTracks.isEmpty else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let server = try await api.getAlbumTracks(album: albumTitle, artist: artistName, source: source)
            tracks = server.map(api.toAppTrack)
        } catch {
            loadError = error.localizedDescription
        }
    }
}

struct PlaylistDetailView: View {
    let playlistId: String
    @Binding var showNowPlaying: Bool

    @State private var playlist: ServerPlaylist
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var uploadingCover = false
    @State private var showCoverPicker = false
    @State private var showRename = false
    @State private var showDeleteConfirm = false
    @State private var renameText = ""
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @State private var showPhotosPicker = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    #endif
    @State private var showFileImporter = false

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    init(playlistId: String, initialPlaylist: ServerPlaylist, showNowPlaying: Binding<Bool>) {
        self.playlistId = playlistId
        self._showNowPlaying = showNowPlaying
        self._playlist = State(initialValue: initialPlaylist)
    }

    var body: some View {
        ZStack {
            AppBackdrop()

            ScrollView {
                VStack(spacing: 18) {
                    ZStack(alignment: .bottomTrailing) {
                        PlaylistArtworkView(coverURL: api.artworkURL(for: playlist.coverUrl))
                            .frame(width: 240, height: 240)

                        Button {
                            showCoverPicker = true
                        } label: {
                            HStack(spacing: 8) {
                                if uploadingCover {
                                    ProgressView()
                                        .tint(Color.textPrimary)
                                } else {
                                    Image(systemName: "photo")
                                }
                                Text(uploadingCover ? "Uploading..." : "Edit Cover")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .glassCard(cornerRadius: 18, intensity: 0.10)
                        }
                        .buttonStyle(.plain)
                        .padding(12)
                    }
                    .padding(.top, 16)

                    VStack(spacing: 4) {
                        Text(playlist.name)
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                            .multilineTextAlignment(.center)
                        Text("\(tracks.count) tracks")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }

                    if loading {
                        VStack {
                            ProgressView()
                                .tint(Color.textPrimary)
                                .padding(.top, 40)
                        }
                        .frame(maxWidth: .infinity)
                    } else if tracks.isEmpty {
                        ContentUnavailableView("Empty Playlist", systemImage: "music.note.list")
                            .padding(.top, 40)
                    } else {
                        HStack(spacing: 12) {
                            Button {
                                if player.setQueue(tracks, startAt: 0) {
                                    showNowPlaying = true
                                }
                            } label: {
                                Label("Play All", systemImage: "play.fill")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.bgPrimary)
                                    .padding(.horizontal, 18)
                                    .padding(.vertical, 12)
                                    .background(Color.textPrimary.opacity(0.92), in: Capsule())
                            }

                            Button {
                                var shuffled = tracks
                                shuffled.shuffle()
                                if player.setQueue(shuffled, startAt: 0) {
                                    showNowPlaying = true
                                }
                            } label: {
                                Label("Shuffle", systemImage: "shuffle")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .padding(.horizontal, 18)
                                    .padding(.vertical, 12)
                                    .glassCard(cornerRadius: 22, intensity: 0.08)
                            }
                        }
                        .padding(.horizontal, 18)

                        VStack(spacing: 10) {
                            ForEach(tracks.indices, id: \.self) { idx in
                                let track = tracks[idx]
                                TrackRow(
                                    track: track,
                                    index: idx + 1,
                                    isCurrent: player.currentTrack?.id == track.id,
                                    isLiked: library.isLiked(track.id),
                                    onTap: {
                                        if player.setQueue(tracks, startAt: idx) {
                                            showNowPlaying = true
                                        }
                                    },
                                    onLike: { library.toggleLike(track: track) },
                                    onAddToQueue: { player.addToQueue(track) }
                                )
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Layout.playerBottomInset)
            }
        }
        .navigationTitle(playlist.name)
        .navigationBarTitleDisplayModeCompat()
        .confirmationDialog("Playlist cover", isPresented: $showCoverPicker, titleVisibility: .visible) {
            #if os(iOS)
            Button("Choose from Photos") {
                showPhotosPicker = true
            }
            #endif
            Button("Choose from Files") {
                showFileImporter = true
            }
            if playlist.hasCustomCover == true {
                Button("Remove Cover", role: .destructive) {
                    removeCover()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        #if os(iOS)
        .photosPicker(isPresented: $showPhotosPicker, selection: $selectedPhotoItem, matching: .images)
        #endif
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            guard let data = try? Data(contentsOf: url) else { return }
            uploadCover(rawData: data)
        }
        #if os(iOS)
        .onChange(of: selectedPhotoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    uploadCover(rawData: data)
                }
                selectedPhotoItem = nil
            }
        }
        #endif
        .task {
            await refreshPlaylist()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailingCompat) {
                Menu {
                    Button {
                        renameText = playlist.name
                        showRename = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label("Delete Playlist", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Color.textPrimary)
                }
            }
        }
        .alert("Rename Playlist", isPresented: $showRename) {
            TextField("Playlist name", text: $renameText)
            Button("Save") {
                guard !renameText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                Task {
                    try? await api.updatePlaylist(id: playlistId, name: renameText.trimmingCharacters(in: .whitespaces))
                    await refreshPlaylist()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete Playlist?", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) {
                Task {
                    try? await api.deletePlaylist(id: playlistId)
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete \"\(playlist.name)\" and all its tracks.")
        }
    }

    private func refreshPlaylist() async {
        async let playlistTask = try? api.getPlaylist(id: playlistId)
        async let tracksTask = try? api.getPlaylistTracks(playlistId: playlistId)

        if let fetchedPlaylist = await playlistTask {
            playlist = fetchedPlaylist
        }
        if let fetchedTracks = await tracksTask {
            tracks = fetchedTracks.map(api.toAppTrack)
        }
        loading = false
    }

    private func uploadCover(rawData: Data) {
        guard let prepared = normalizedImagePayload(from: rawData) else { return }

        Task {
            uploadingCover = true
            defer { uploadingCover = false }
            _ = try? await api.uploadPlaylistCover(playlistId: playlistId, data: prepared.data, mimeType: prepared.mimeType)
            await refreshPlaylist()
        }
    }

    private func removeCover() {
        Task {
            uploadingCover = true
            defer { uploadingCover = false }
            try? await api.deletePlaylistCover(playlistId: playlistId)
            await refreshPlaylist()
        }
    }
}

private func normalizedImagePayload(from data: Data) -> (data: Data, mimeType: String)? {
    guard let image = PlatformImage.platformImage(from: data) else { return nil }
    let maxSide: CGFloat = 1600
    let size = image.platformSize
    let scale = min(1, maxSide / max(size.width, size.height))
    let targetSize = CGSize(width: size.width * scale, height: size.height * scale)

    let rendered = resizedImage(image, to: targetSize)
    if let jpeg = rendered.platformJPEGData(compressionQuality: 0.82) {
        return (jpeg, "image/jpeg")
    }
    return nil
}
