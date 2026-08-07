import SwiftUI

struct SearchView: View {
    @Binding var showNowPlaying: Bool
    @State private var query = ""
    @State private var results: [Track] = []
    @State private var playlists: [ExternalPlaylist] = []
    @State private var artists: [SearchArtist] = []
    @State private var loading = false
    @State private var loadingMore = false
    @State private var hasMore = true
    @State private var sourceFilter = "all"
    @State private var playlistPickerTrack: Track?
    @State private var searchTask: Task<Void, Never>?
    @State private var searchRequestTask: Task<Void, Never>?
    @State private var loadMoreTask: Task<Void, Never>?
    @State private var expandedPlaylist: ExternalPlaylist?
    @State private var searchGeneration = 0
    @State private var nextOffset = 0
    @State private var searchErrors: [String: String] = [:]
    private let pageSize = 30

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

    private let moods: [(String, String)] = [
        ("Energise", "bolt.fill"),
        ("Feel good", "face.smiling.fill"),
        ("Relax", "cloud.moon.fill"),
        ("Workout", "figure.run"),
        ("Sad", "cloud.rain.fill"),
        ("Party", "party.popper.fill"),
        ("Focus", "target"),
        ("Romance", "heart.fill"),
        ("Sleep", "moon.fill"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 14) {
                        LiquidSectionHeader(title: "Search", subtitle: "One input across local files, VK and SoundCloud.")

                        HStack(spacing: 12) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(Color.textSecondary)

                            TextField("Search tracks, artists, albums", text: $query)
                                .textFieldStyle(.plain)
                                .submitLabel(.search)
                                .foregroundStyle(Color.textPrimary)
                                .onSubmit { search() }

                            if loading {
                                ProgressView()
                                    .tint(Color.textPrimary)
                            } else if !query.isEmpty {
                                Button {
                                    searchTask?.cancel()
                                    searchRequestTask?.cancel()
                                    loadMoreTask?.cancel()
                                    query = ""
                                    results = []
                                    playlists = []
                                    artists = []
                                    loading = false
                                    loadingMore = false
                                    hasMore = true
                                    nextOffset = 0
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(Color.textMuted)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .glassCard(cornerRadius: 28, tint: Color.accentStrong, intensity: 0.12)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(sources, id: \.0) { id, label in
                                Button(label) {
                                    sourceFilter = id
                                    if !query.isEmpty { search() }
                                }
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .liquidChipSurface(selected: sourceFilter == id)
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 18)
                    }

                    if !searchErrors.isEmpty {
                        ArtistSourceWarning(errors: searchErrors)
                            .padding(.horizontal, 18)
                    }

                    if results.isEmpty && query.count < 2 {
                        VStack(alignment: .leading, spacing: 12) {
                            LiquidSectionHeader(title: "Browse by mood", subtitle: "Tap a mood to build a fast queue.")
                                .padding(.horizontal, 18)

                            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
                                ForEach(moods, id: \.0) { mood, icon in
                                    Button {
                                        query = mood
                                        search()
                                    } label: {
                                        VStack(alignment: .leading, spacing: 18) {
                                            Image(systemName: icon)
                                                .font(.system(size: 22, weight: .semibold))
                                            Text(mood)
                                                .font(.system(size: 15, weight: .semibold))
                                            Spacer(minLength: 0)
                                        }
                                        .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
                                        .padding(16)
                                        .foregroundStyle(Color.textPrimary)
                                        .glassCard(cornerRadius: 24, intensity: 0.10)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 18)
                        }
                    } else if loading && results.isEmpty && playlists.isEmpty && artists.isEmpty {
                        VStack(spacing: 14) {
                            ProgressView()
                                .tint(Color.textPrimary)
                            Text("Searching \(sourceLabel)")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 90)
                    } else if results.isEmpty && playlists.isEmpty && artists.isEmpty && query.count >= 2 && !loading {
                        ContentUnavailableView("No results", systemImage: "magnifyingglass", description: Text("Nothing matched \"\(query)\"."))
                            .padding(.top, 80)
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            if !artists.isEmpty {
                                VStack(alignment: .leading, spacing: 10) {
                                    LiquidSectionHeader(title: "Artists", subtitle: "\(artists.count) found")
                                        .padding(.horizontal, 18)

                                    ScrollView(.horizontal, showsIndicators: false) {
                                        HStack(spacing: 12) {
                                            ForEach(artists) { artist in
                                                NavigationLink {
                                                    SearchArtistDetailView(artist: artist, showNowPlaying: $showNowPlaying)
                                                } label: {
                                                    ArtistSearchCard(artist: artist)
                                                }
                                                .buttonStyle(.plain)
                                            }
                                        }
                                        .padding(.horizontal, 18)
                                    }
                                }
                                .padding(.bottom, 6)
                            }

                            // Playlists section (top, only first page)
                            if !playlists.isEmpty {
                                VStack(alignment: .leading, spacing: 10) {
                                    LiquidSectionHeader(title: "Playlists", subtitle: "\(playlists.count) found")
                                        .padding(.horizontal, 18)

                                    ScrollView(.horizontal, showsIndicators: false) {
                                        HStack(spacing: 12) {
                                            ForEach(playlists) { playlist in
                                                PlaylistSearchCard(playlist: playlist) {
                                                    expandedPlaylist = playlist
                                                }
                                            }
                                        }
                                        .padding(.horizontal, 18)
                                    }
                                }
                                .padding(.bottom, 6)
                            }

                            if !results.isEmpty {
                                LiquidSectionHeader(title: "\(results.count) Tracks", subtitle: "Source: \(sourceLabel)")
                                    .padding(.horizontal, 18)

                                LazyVStack(spacing: 10) {
                                    ForEach(Array(results.enumerated()), id: \.element.id) { idx, track in
                                        TrackRow(
                                            track: track,
                                            index: idx + 1,
                                            isCurrent: player.currentTrack?.id == track.id,
                                            isLiked: library.isLiked(track.id),
                                            onTap: {
                                                if player.setQueue(results, startAt: idx) {
                                                    showNowPlaying = true
                                                }
                                            },
                                            onLike: { library.toggleLike(track: track) },
                                            onAddToQueue: { player.addToQueue(track) },
                                            onAddToPlaylist: { playlistPickerTrack = track }
                                        )
                                        .onAppear {
                                            // Load more when approaching end
                                            if idx >= results.count - 5 && hasMore && !loadingMore {
                                                loadMore()
                                            }
                                        }
                                    }

                                    if loadingMore {
                                        ProgressView()
                                            .tint(Color.textPrimary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 16)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, Layout.playerBottomInset)
            }
            .background(AppBackdrop())
            .scrollIndicators(.hidden)
            .navigationBarHiddenCompat(true)
            .onChange(of: query) { _, new in
                if new.count >= 2 {
                    searchTask?.cancel()
                    searchRequestTask?.cancel()
                    searchTask = Task {
                        try? await Task.sleep(for: .milliseconds(320))
                        guard !Task.isCancelled else { return }
                        search()
                    }
                } else {
                    searchTask?.cancel()
                    searchRequestTask?.cancel()
                    loadMoreTask?.cancel()
                    loading = false
                    loadingMore = false
                    hasMore = true
                    nextOffset = 0
                    artists = []
                    searchErrors = [:]
                }
            }
            .sheet(item: $playlistPickerTrack) { track in
                PlaylistPickerView(track: track)
            }
            .sheet(item: $expandedPlaylist) { playlist in
                ExternalPlaylistSheet(playlist: playlist, showNowPlaying: $showNowPlaying)
            }
        }
    }

    private var sources: [(String, String)] {
        var items: [(String, String)] = [("all", "All"), ("local", "Local")]
        if settings.sourceYandex { items.append(("yandex", "Yandex")) }
        if settings.sourceYoutube { items.append(("youtube", "YouTube")) }
        if settings.sourceSoundcloud { items.append(("soundcloud", "SoundCloud")) }
        return items
    }

    private var sourceLabel: String {
        sources.first(where: { $0.0 == sourceFilter })?.1 ?? "All"
    }

    private var currentSources: String {
        // "all" → every enabled discovery source (VK excluded by design).
        return sourceFilter == "all" ? settings.enabledSourcesParam : sourceFilter
    }

    private func search() {
        guard query.count >= 2 else {
            searchRequestTask?.cancel()
            loadMoreTask?.cancel()
            results = []
            playlists = []
            artists = []
            searchErrors = [:]
            loading = false
            hasMore = true
            nextOffset = 0
            return
        }

        searchRequestTask?.cancel()
        loadMoreTask?.cancel()
        loading = true
        loadingMore = false
        hasMore = true
        nextOffset = 0
        playlists = []
        artists = []
        searchErrors = [:]
        let src = currentSources
        let q = query
        searchGeneration += 1
        let generation = searchGeneration
        searchRequestTask = Task {
            do {
                let result = try await api.searchWithPlaylists(query: q, sources: src, limit: pageSize, offset: 0)
                guard !Task.isCancelled, generation == searchGeneration, q == query, src == currentSources else { return }
                results = result.tracks.map(api.toAppTrack)
                playlists = result.playlists
                artists = result.artists
                searchErrors = result.errors
                hasMore = result.hasMore
                nextOffset = pageSize
            } catch {
                guard generation == searchGeneration else { return }
                results = []
                playlists = []
                artists = []
                searchErrors = [:]
                hasMore = false
            }
            if generation == searchGeneration {
                loading = false
                searchRequestTask = nil
            }
        }
    }

    private func loadMore() {
        guard !loadingMore, hasMore, query.count >= 2 else { return }
        loadingMore = true
        let src = currentSources
        let q = query
        let offset = nextOffset
        let generation = searchGeneration
        loadMoreTask?.cancel()
        loadMoreTask = Task {
            do {
                let result = try await api.searchTracks(query: q, sources: src, limit: pageSize, offset: offset)
                guard !Task.isCancelled, generation == searchGeneration, q == query, src == currentSources else { return }
                nextOffset = offset + pageSize
                let newTracks = result.tracks.map(api.toAppTrack)
                // Deduplicate against already-loaded results
                let existingIds = Set(results.map(\.id))
                let unique = newTracks.filter { !existingIds.contains($0.id) }
                results.append(contentsOf: unique)
                hasMore = result.hasMore
            } catch {
                if generation == searchGeneration {
                    hasMore = false
                }
            }
            if generation == searchGeneration {
                loadingMore = false
                loadMoreTask = nil
            }
        }
    }
}

struct PlaylistPickerView: View {
    let track: Track
    @State private var playlists: [ServerPlaylist] = []
    @State private var loading = true
    @State private var newName = ""
    @State private var showNew = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if loading {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 30)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(playlists, id: \.id) { playlist in
                                Button {
                                    Task {
                                        try? await APIService.shared.addToPlaylist(playlistId: playlist.id, trackId: track.id)
                                        dismiss()
                                    }
                                } label: {
                                    HStack(spacing: 12) {
                                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .fill(Color.white.opacity(0.08))
                                            .frame(width: 52, height: 52)
                                            .overlay(Image(systemName: "music.note.list").foregroundStyle(Color.textPrimary))

                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(playlist.name)
                                                .font(.system(size: 15, weight: .semibold))
                                                .foregroundStyle(Color.textPrimary)
                                            Text("\(playlist.trackCount) tracks")
                                                .font(.system(size: 12, weight: .medium))
                                                .foregroundStyle(Color.textSecondary)
                                        }

                                        Spacer()
                                    }
                                    .padding(14)
                                    .glassCard(cornerRadius: 22, intensity: 0.10)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if showNew {
                        VStack(spacing: 12) {
                            TextField("Playlist name", text: $newName)
                                .textFieldStyle(.plain)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .glassCard(cornerRadius: 20, intensity: 0.08)

                            Button("Create and add track") {
                                Task {
                                    let id = try? await APIService.shared.createPlaylist(name: newName)
                                    if let id {
                                        try? await APIService.shared.addToPlaylist(playlistId: id, trackId: track.id)
                                    }
                                    dismiss()
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background {
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .fill(Color.clear)
                                    .opacity(newName.isEmpty ? 0.55 : 1)
                                    .liquidProminentSurface(cornerRadius: 20, accent: Color(hex: "d9b17b"))
                            }
                            .foregroundStyle(newName.isEmpty ? Color.textSecondary : Color.textPrimary)
                            .disabled(newName.isEmpty)
                        }
                    } else {
                        Button {
                            showNew = true
                        } label: {
                            Label("New Playlist", systemImage: "plus")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .glassCard(cornerRadius: 20, intensity: 0.08)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(18)
                .padding(.bottom, 24)
            }
            .background(AppBackdrop())
            .navigationTitle("Add to Playlist")
            .navigationBarTitleDisplayModeCompat()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
            .task {
                playlists = (try? await APIService.shared.getPlaylists()) ?? []
                loading = false
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Artist Search Card

struct ArtistSearchCard: View {
    let artist: SearchArtist

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Circle()
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        InspectableArtworkView(
                            urlString: APIService.shared.artworkURL(for: artist.coverUrl),
                            debugLabel: "artist: \(artist.artist)",
                            contentMode: .fill,
                            maxPixelSize: 420
                        ) {
                            Image(systemName: "person.fill")
                                .font(.system(size: 28, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                        }
                        .clipShape(Circle())
                    )
                    .frame(width: 86, height: 86)

                Text(sourceBadge(artist.source))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.ultraThinMaterial, in: Capsule())
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(artist.artist)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)
                    .frame(minHeight: 34, alignment: .topLeading)

                Text(artist.subtitle?.isEmpty == false ? artist.subtitle! : artist.sourceLabel)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)

                Text("\(artist.trackCount) tracks")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textMuted)
                    .lineLimit(1)
            }
        }
        .frame(width: 150, alignment: .leading)
        .padding(12)
        .glassCard(cornerRadius: 24, intensity: 0.10)
    }
}

private func sourceBadge(_ source: String) -> String {
    switch source {
    case "local": return "LOCAL"
    case "vk": return "VK"
    case "soundcloud": return "SC"
    case "mixed": return "ALL"
    default: return source.uppercased()
    }
}

private func sourceDisplayName(_ source: String) -> String {
    switch source {
    case "all": return "All"
    case "local": return "Local"
    case "vk": return "VK"
    case "soundcloud": return "SoundCloud"
    default: return source.capitalized
    }
}

// MARK: - Playlist Search Card

struct PlaylistSearchCard: View {
    let playlist: ExternalPlaylist
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                // Cover
                ZStack {
                    if let url = playlist.coverUrl {
                        InspectableArtworkView(
                            urlString: APIService.shared.artworkURL(for: url),
                            debugLabel: "playlist: \(playlist.title)"
                        ) {
                            Color.white.opacity(0.06)
                        }
                    } else {
                        Color.white.opacity(0.06)
                    }

                    // Playlist badge
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            HStack(spacing: 4) {
                                Image(systemName: "list.bullet")
                                    .font(.system(size: 9, weight: .bold))
                                Text("\(playlist.trackCount)")
                                    .font(.system(size: 10, weight: .bold))
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(6)
                        }
                    }
                }
                .frame(width: 140, height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                // Info
                Text(playlist.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)

                HStack(spacing: 4) {
                    Text(playlist.source.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.textMuted)
                    Text("•")
                        .foregroundStyle(Color.textMuted)
                    Text(playlist.author)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.textSecondary)
                }
                .lineLimit(1)
            }
            .frame(width: 140)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Artist Detail

struct SearchArtistDetailView: View {
    let artist: SearchArtist
    @Binding var showNowPlaying: Bool

    @State private var profileArtist: SearchArtist?
    @State private var tracks: [Track] = []
    @State private var albums: [Album] = []
    @State private var availableSources: [String] = []
    @State private var selectedSource = "all"
    @State private var loading = true
    @State private var loadError: String?
    @State private var sourceErrors: [String: String] = [:]
    @State private var playlistPickerTrack: Track?

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

    private var displayArtist: SearchArtist { profileArtist ?? artist }

    private var enabledSources: [String] {
        settings.enabledSourcesParam.split(separator: ",").map(String.init)
    }

    private var sourceOptions: [String] {
        let sources = availableSources.isEmpty
            ? Array(Set(tracks.map { $0.source.rawValue })).sorted(by: sourceSort)
            : availableSources.sorted(by: sourceSort)
        return sources.isEmpty ? ["all"] : ["all"] + sources
    }

    private var filteredTracks: [Track] {
        selectedSource == "all"
            ? artistDisplayTracks(tracks)
            : tracks.filter { $0.source.rawValue == selectedSource }.sorted(by: artistTrackSort)
    }

    private var filteredAlbums: [Album] {
        guard selectedSource != "all" else { return albums }
        return albums.filter { !tracksForAlbum($0, source: selectedSource).isEmpty }
    }

    private var heroArtwork: String? {
        api.artworkURL(for: displayArtist.coverUrl)
            ?? filteredTracks.compactMap(\.artwork).first
            ?? tracks.compactMap(\.artwork).first
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                hero

                VStack(alignment: .leading, spacing: 20) {
                    if loading {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 44)
                    } else if let loadError {
                        ContentUnavailableView("Artist unavailable", systemImage: "person.crop.circle.badge.exclamationmark", description: Text(loadError))
                            .padding(.top, 44)
                    } else if tracks.isEmpty {
                        ContentUnavailableView("No tracks", systemImage: "music.mic", description: Text("No playable tracks were found for \(displayArtist.artist)."))
                            .padding(.top, 44)
                    } else {
                        sourceFilter
                            .padding(.top, 18)

                        if !sourceErrors.isEmpty {
                            ArtistSourceWarning(errors: sourceErrors)
                                .padding(.horizontal, 18)
                        }

                        queueButtons(for: filteredTracks)

                        tracksSection

                        albumsSection
                    }
                }
                .padding(.bottom, Layout.playerBottomInset)
            }
        }
        .background(AppBackdrop())
        .navigationTitle(displayArtist.artist)
        .navigationBarTitleDisplayModeCompat()
        .task(id: artist.id) {
            await loadProfile()
        }
        .sheet(item: $playlistPickerTrack) { track in
            PlaylistPickerView(track: track)
        }
    }

    private var hero: some View {
        ZStack(alignment: .bottom) {
            GeometryReader { geo in
                InspectableArtworkView(
                    urlString: heroArtwork,
                    debugLabel: "artist-profile: \(displayArtist.artist)",
                    contentMode: .fill,
                    maxPixelSize: 900
                ) {
                    Rectangle()
                        .fill(Color.white.opacity(0.08))
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .blur(radius: 24)
                .overlay(
                    LinearGradient(
                        colors: [Color.black.opacity(0.20), Color.black.opacity(0.78)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }
            .frame(height: 260)
            .clipped()

            VStack(spacing: 10) {
                Circle()
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 104, height: 104)
                    .overlay(
                        InspectableArtworkView(
                            urlString: heroArtwork,
                            debugLabel: "artist-profile-avatar: \(displayArtist.artist)",
                            contentMode: .fill,
                            maxPixelSize: 420
                        ) {
                            Image(systemName: "person.fill")
                                .font(.system(size: 38, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                        }
                        .clipShape(Circle())
                    )
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))

                Text(displayArtist.artist)
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .shadow(color: .black.opacity(0.45), radius: 5, y: 2)

                HStack(spacing: 8) {
                    Text(displayArtist.subtitle?.isEmpty == false ? displayArtist.subtitle! : displayArtist.sourceLabel)
                    Text("\(filteredTracks.count) tracks")
                    if !filteredAlbums.isEmpty {
                        Text("\(filteredAlbums.count) albums")
                    }
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.74))
                .lineLimit(1)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 22)
        }
        .frame(height: 260)
    }

    private var sourceFilter: some View {
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

    private var tracksSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            LiquidSectionHeader(title: "\(filteredTracks.count) Tracks", subtitle: "Source: \(artistSourceDisplayName(selectedSource))")
                .padding(.horizontal, 18)

            LazyVStack(spacing: 10) {
                ForEach(Array(filteredTracks.enumerated()), id: \.element.id) { idx, track in
                    TrackRow(
                        track: track,
                        index: idx + 1,
                        isCurrent: player.currentTrack?.id == track.id,
                        isLiked: library.isLiked(track.id),
                        onTap: {
                            if player.setQueue(filteredTracks, startAt: idx) {
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

    private var albumsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            LiquidSectionHeader(title: "Albums", subtitle: filteredAlbums.isEmpty ? "No album metadata" : "\(filteredAlbums.count) found")
                .padding(.horizontal, 18)

            if filteredAlbums.isEmpty {
                Text("Albums will appear here when VK or SoundCloud returns release metadata for this artist.")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(18)
                    .glassCard(cornerRadius: 24, intensity: 0.08)
                    .padding(.horizontal, 18)
            } else {
                LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 14) {
                    ForEach(filteredAlbums) { album in
                        let albumTracks = tracksForAlbum(album)
                        let navigationSource = selectedSource == "all" ? album.source : selectedSource
                        NavigationLink {
                            AlbumDetailView(
                                albumTitle: album.album,
                                artistName: album.artist,
                                coverUrl: album.coverUrl,
                                source: navigationSource == "mixed" ? nil : navigationSource,
                                preloadedTracks: albumTracks,
                                showNowPlaying: $showNowPlaying
                            )
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                ArtworkTile(urlString: api.artworkURL(for: album.coverUrl), icon: "opticaldisc")
                                    .aspectRatio(1, contentMode: .fit)

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(album.album)
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Color.textPrimary)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text("\(artistSourceDisplayName(album.source)) • \(albumTracks.count) tracks")
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

    private func queueButtons(for tracks: [Track]) -> some View {
        HStack(spacing: 12) {
            Button {
                if !tracks.isEmpty, player.setQueue(tracks, startAt: 0) {
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

            Button {
                var shuffled = tracks
                shuffled.shuffle()
                if !shuffled.isEmpty, player.setQueue(shuffled, startAt: 0) {
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
        }
        .padding(.horizontal, 18)
    }

    private func loadProfile() async {
        loading = true
        loadError = nil
        sourceErrors = [:]
        selectedSource = "all"

        do {
            let response = try await api.getArtistProfile(
                artist: artist,
                sources: enabledSources.joined(separator: ",")
            )
            profileArtist = response.artist
            tracks = response.tracks.map(api.toAppTrack)
            albums = response.albums
            availableSources = response.availableSources ?? Array(Set(tracks.map { $0.source.rawValue }))
            sourceErrors = response.errors ?? [:]
            if !sourceOptions.contains(selectedSource) {
                selectedSource = "all"
            }
        } catch {
            profileArtist = nil
            tracks = []
            albums = []
            availableSources = []
            sourceErrors = [:]
            loadError = error.localizedDescription
        }

        loading = false
    }

    private func sourceFilterLabel(_ source: String) -> String {
        let count = source == "all"
            ? artistDisplayTracks(tracks).count
            : tracks.filter { $0.source.rawValue == source }.count
        return count > 0 ? "\(artistSourceDisplayName(source)) \(count)" : artistSourceDisplayName(source)
    }

    private func tracksForAlbum(_ album: Album, source: String? = nil) -> [Track] {
        let baseTracks: [Track]
        if let source, source != "all" {
            baseTracks = tracks.filter { $0.source.rawValue == source }
        } else if selectedSource != "all" {
            baseTracks = tracks.filter { $0.source.rawValue == selectedSource }
        } else {
            baseTracks = artistDisplayTracks(tracks)
        }
        return baseTracks.filter { track in
            normalizedSearchText(track.album) == normalizedSearchText(album.album)
        }
    }

    private func sourceSort(_ lhs: String, _ rhs: String) -> Bool {
            artistSourceRank(lhs) < artistSourceRank(rhs)
    }
}

private func normalizedSearchText(_ value: String?) -> String {
    value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
}

struct ArtistSourceWarning: View {
    let errors: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Some sources did not respond", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textPrimary)

            Text(errors.keys.sorted(by: { artistSourceRank($0) < artistSourceRank($1) }).map(artistSourceDisplayName).joined(separator: ", "))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 20, intensity: 0.08)
    }
}

// MARK: - External Playlist Sheet

struct ExternalPlaylistSheet: View {
    let playlist: ExternalPlaylist
    @Binding var showNowPlaying: Bool
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var saving = false
    @State private var saved = false
    @State private var saveError: String?
    /// Local binding so the NowPlaying sheet can be shown on top of this sheet
    /// without the parent tearing this sheet down to present its own.
    @State private var localNowPlaying = false
    @Environment(\.dismiss) private var dismiss

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    private var savedStateIcon: String {
        if saved { return "checkmark" }
        if saving { return "hourglass" }
        return "plus"
    }

    private var savedStateLabel: String {
        if saved { return "Saved" }
        if saving { return "Saving..." }
        return "Add to Library"
    }

    private func saveToLibrary() async {
        guard !saving, !saved, !tracks.isEmpty else { return }
        saving = true
        saveError = nil
        defer { saving = false }

        do {
            let playlistId = try await api.createPlaylist(name: playlist.title)
            for track in tracks {
                try? await api.addToPlaylist(playlistId: playlistId, trackId: track.id)
            }
            saved = true
        } catch {
            saveError = error.localizedDescription
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()

                ScrollView {
                    VStack(spacing: 16) {
                        // Header
                        VStack(spacing: 10) {
                            ZStack {
                                if let url = playlist.coverUrl {
                                    InspectableArtworkView(
                                        urlString: api.artworkURL(for: url),
                                        debugLabel: "playlist-header: \(playlist.title)"
                                    ) {
                                        Color.white.opacity(0.06)
                                    }
                                } else {
                                    Color.white.opacity(0.06)
                                        .overlay(Image(systemName: "music.note.list").font(.system(size: 32)).foregroundStyle(Color.textSecondary))
                                }
                            }
                            .frame(width: 180, height: 180)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

                            Text(playlist.title)
                                .font(.system(size: 22, weight: .bold, design: .rounded))
                                .foregroundStyle(Color.textPrimary)
                                .multilineTextAlignment(.center)

                            HStack(spacing: 6) {
                                Text(playlist.source.uppercased())
                                    .font(.system(size: 11, weight: .bold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .glassCard(cornerRadius: 12, intensity: 0.08)
                                Text("\(playlist.trackCount) tracks")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Color.textSecondary)
                            }

                            // Play All + Save to Library
                            if !tracks.isEmpty {
                                HStack(spacing: 10) {
                                    Button {
                                        if player.setQueue(tracks, startAt: 0) {
                                            localNowPlaying = true
                                        }
                                    } label: {
                                        HStack(spacing: 6) {
                                            Image(systemName: "play.fill")
                                            Text("Play All")
                                        }
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(Color.textPrimary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 13)
                                        .background {
                                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                                .fill(Color.clear)
                                                .liquidProminentSurface(cornerRadius: 18, accent: Color(hex: "d9b17b"))
                                        }
                                    }
                                    .buttonStyle(.plain)

                                    Button {
                                        #if os(iOS)
                                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                                        #endif
                                        Task { await saveToLibrary() }
                                    } label: {
                                        HStack(spacing: 6) {
                                            Image(systemName: savedStateIcon)
                                                .contentTransition(.symbolEffect(.replace))
                                            Text(savedStateLabel)
                                        }
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(Color.textPrimary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 13)
                                        .glassCard(cornerRadius: 18, intensity: saving ? 0.14 : 0.10)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(saving || saved)
                                }
                                .padding(.horizontal, 30)
                            }
                        }
                        .padding(.top, 20)
                        .frame(maxWidth: .infinity)

                        // Tracks
                        if loading {
                            VStack {
                                ProgressView()
                                    .tint(Color.textPrimary)
                                    .padding(.top, 30)
                            }
                            .frame(maxWidth: .infinity)
                        } else if tracks.isEmpty {
                            Text("No tracks available")
                                .foregroundStyle(Color.textSecondary)
                                .padding(.top, 30)
                                .frame(maxWidth: .infinity)
                        } else {
                            VStack(spacing: 10) {
                                ForEach(Array(tracks.enumerated()), id: \.element.id) { idx, track in
                                    TrackRow(
                                        track: track,
                                        index: idx + 1,
                                        isCurrent: player.currentTrack?.id == track.id,
                                        isLiked: library.isLiked(track.id),
                                        onTap: {
                                            if player.setQueue(tracks, startAt: idx) {
                                                localNowPlaying = true
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
                    .padding(.bottom, 40)
                }
            }
            .navigationBarTitleDisplayModeCompat()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
            .task {
                do {
                    let st = try await api.getExternalPlaylistTracks(playlistId: playlist.id)
                    tracks = st.map(api.toAppTrack)
                } catch {
                    tracks = []
                }
                loading = false
            }
            .safeAreaInset(edge: .bottom) {
                // Pinned mini-player: visible while the playlist stays open.
                if player.currentTrack != nil {
                    PlaylistMiniPlayerBar(onTap: { localNowPlaying = true })
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .presentationDetents([.large])
        .sheet(isPresented: $localNowPlaying) {
            NowPlayingView()
                .presentationDetents([.large])
                .presentationDragIndicator(.hidden)
                .presentationCornerRadius(32)
                .presentationBackground(.clear)
        }
    }
}

/// Compact play/pause + track info bar used inside an `ExternalPlaylistSheet`.
/// Tapping opens the local NowPlaying sheet on top of the playlist.
private struct PlaylistMiniPlayerBar: View {
    let onTap: () -> Void

    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    var body: some View {
        if let track = player.currentTrack {
            HStack(spacing: 12) {
                ArtworkTile(urlString: track.artwork, icon: "music.note")
                    .frame(width: 42, height: 42)

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                        .lineLimit(1)
                    Text(track.artist)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    #if os(iOS)
                    UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                    #endif
                    player.togglePlayPause()
                } label: {
                    Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.textPrimary)
                        .frame(width: 34, height: 34)
                        .background(Color.white.opacity(0.10), in: Circle())
                        .contentTransition(.symbolEffect(.replace.downUp))
                }
                .buttonStyle(.plain)

                Button {
                    #if os(iOS)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    #endif
                    player.skipNext()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.textPrimary)
                        .frame(width: 34, height: 34)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(.ultraThinMaterial)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.8)
            )
            .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
            .onTapGesture(perform: onTap)
        }
    }
}
