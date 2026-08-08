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
    @State private var searchError: String?
    @State private var searchUnauthorized = false
    private let pageSize = 30

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

    private let moods = ["Energise", "Feel good", "Relax", "Workout", "Sad", "Party", "Focus", "Romance", "Sleep"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 14) {
                        LiquidSectionHeader(title: String(localized: "Search"), subtitle: String(localized: "One input across local files, VK and SoundCloud."))

                        HStack(spacing: 12) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(Color.textSecondary)

                            TextField(String(localized: "Search tracks, artists, albums"), text: $query)
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
                                .accessibilityLabel(Text(String(localized: "Clear search")))
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

                    if let searchError, !results.isEmpty {
                        ErrorRetryView(
                            title: searchUnauthorized ? String(localized: "Session expired") : String(localized: "Search unavailable"),
                            message: searchError,
                            isUnauthorized: searchUnauthorized,
                            onRetry: { search() },
                            onSignIn: searchUnauthorized ? { settings.logout() } : nil
                        )
                        .padding(.horizontal, 18)
                    }

                    if results.isEmpty && query.count < 2 {
                        SearchMoodsView(moods: moods, onSelect: { mood in
                            query = mood
                            search()
                        })
                    } else if loading && results.isEmpty && playlists.isEmpty && artists.isEmpty {
                        VStack(spacing: 14) {
                            ProgressView()
                                .tint(Color.textPrimary)
                            Text(String(localized: "Searching \(sourceLabel)"))
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 90)
                    } else if let searchError, query.count >= 2 && !loading {
                        ErrorRetryView(
                            title: searchUnauthorized ? String(localized: "Session expired") : String(localized: "Search unavailable"),
                            message: searchError,
                            isUnauthorized: searchUnauthorized,
                            onRetry: { search() },
                            onSignIn: searchUnauthorized ? { settings.logout() } : nil
                        )
                        .padding(.horizontal, 18)
                        .padding(.top, 80)
                    } else if results.isEmpty && playlists.isEmpty && artists.isEmpty && query.count >= 2 && !loading {
                        EmptyStateView(
                            title: String(localized: "No results"),
                            message: String(localized: "Nothing matched \"\(query)\"."),
                            systemImage: "magnifyingglass",
                            actionTitle: String(localized: "Clear search"),
                            action: { query = "" }
                        )
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
                    searchError = nil
                    searchUnauthorized = false
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
        var items: [(String, String)] = [("all", String(localized: "All")), ("local", String(localized: "Local"))]
        if settings.sourceYandex { items.append(("yandex", String(localized: "Yandex"))) }
        if settings.sourceYoutube { items.append(("youtube", String(localized: "YouTube"))) }
        if settings.sourceSoundcloud { items.append(("soundcloud", String(localized: "SoundCloud"))) }
        return items
    }

    private var sourceLabel: String {
        sources.first(where: { $0.0 == sourceFilter })?.1 ?? String(localized: "All")
    }

    private var currentSources: String {
        sourceFilter == "all" ? settings.enabledSourcesParam : sourceFilter
    }

    private func search() {
        guard query.count >= 2 else {
            searchRequestTask?.cancel()
            loadMoreTask?.cancel()
            results = []
            playlists = []
            artists = []
            searchErrors = [:]
            searchError = nil
            searchUnauthorized = false
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
        searchError = nil
        searchUnauthorized = false
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
                searchError = nil
                searchUnauthorized = false
                hasMore = result.hasMore
                nextOffset = pageSize
            } catch {
                guard generation == searchGeneration else { return }
                results = []
                playlists = []
                artists = []
                searchErrors = [:]
                searchError = error.localizedDescription
                searchUnauthorized = (error as? APIError)?.statusCode == 401
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
                let existingIds = Set(results.map(\.id))
                let unique = newTracks.filter { !existingIds.contains($0.id) }
                results.append(contentsOf: unique)
                hasMore = result.hasMore
            } catch {
                if generation == searchGeneration {
                    hasMore = false
                    searchError = error.localizedDescription
                    searchUnauthorized = (error as? APIError)?.statusCode == 401
                }
            }
            if generation == searchGeneration {
                loadingMore = false
                loadMoreTask = nil
            }
        }
    }
}
