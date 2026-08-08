import SwiftUI

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

            Button {
                var shuffled = tracks
                shuffled.shuffle()
                if !shuffled.isEmpty, player.setQueue(shuffled, startAt: 0) {
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
