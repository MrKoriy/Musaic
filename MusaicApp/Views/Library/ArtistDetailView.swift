import SwiftUI

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
                ArtistDetailBanner(
                    artworkURL: api.artworkURL(for: bannerArtworkURL),
                    artistName: artist.artist,
                    albumCount: albumGroups.count,
                    trackCount: filteredTracks.count
                )

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
                Label(String(localized: "Play All"), systemImage: "play.fill")
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
                Label(String(localized: "Shuffle"), systemImage: "shuffle")
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
        }
    }
}
