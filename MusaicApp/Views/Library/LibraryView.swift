import SwiftUI

struct LibraryView: View {
    @Binding var showNowPlaying: Bool
    @AppStorage("library_selected_tab") private var selectedTab = "Liked"
    @State private var playlists: [ServerPlaylist] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var loadUnauthorized = false
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
    private let settings = SettingsStore.shared

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    LibraryHeaderView(
                        selectedTab: selectedTab,
                        likedCount: library.likedTrackIds.count,
                        albumCount: library.likedAlbums.count,
                        playlistCount: playlists.count,
                        onImport: { showImport = true },
                        onNewPlaylist: { showNewPlaylist = true }
                    )

                    ChipSelector(
                        options: tabs,
                        label: tabTitle,
                        isSelected: { selectedTab == $0 },
                        onSelect: { selectedTab = $0 }
                    )

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
            .sheet(item: $playlistPickerTrack) { track in
                PlaylistPickerView(track: track)
            }
            .sheet(isPresented: $showImport) {
                ImportPlaylistView(showNowPlaying: $showNowPlaying)
            }
            .navigationBarHiddenCompat(true)
        }
    }

    private var likedView: some View {
        let allLiked = library.displayedLikedTracks
        let liked = downloadedOnly ? allLiked.filter { downloadManager.isDownloaded($0.id) } : allLiked

        return VStack(spacing: 12) {
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
                    libraryEmptyState(
                        title: String(localized: "No downloads"),
                        subtitle: String(localized: "Tap the arrow icon on any track to download it for offline listening."),
                        icon: "arrow.down.circle"
                    )
                } else if library.likedTrackIds.isEmpty {
                    libraryEmptyState(
                        title: String(localized: "No liked songs"),
                        subtitle: String(localized: "Tap the heart icon on any track to pin it here."),
                        icon: "heart"
                    )
                } else {
                    libraryEmptyState(
                        title: String(localized: "Restoring liked songs"),
                        subtitle: String(localized: "Your saved likes are syncing back into the library."),
                        icon: "heart.fill"
                    )
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
        LibraryPlaylistSection(
            playlists: playlists,
            loading: loading,
            loadError: loadError,
            loadUnauthorized: loadUnauthorized,
            showNowPlaying: $showNowPlaying,
            showNewPlaylist: $showNewPlaylist,
            newPlaylistName: $newPlaylistName,
            onCreatePlaylist: createPlaylist,
            onRetry: { Task { await loadData() } },
            onSignIn: { settings.logout() }
        )
    }

    private var albumsView: some View {
        Group {
            if library.likedAlbums.isEmpty {
                libraryEmptyState(
                    title: String(localized: "No albums yet"),
                    subtitle: String(localized: "Like tracks and their releases will show up here."),
                    icon: "opticaldisc"
                )
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
                libraryEmptyState(
                    title: String(localized: "No artists yet"),
                    subtitle: String(localized: "Like tracks to build your artist pages here."),
                    icon: "person.2"
                )
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

    private func tabTitle(_ tab: String) -> String {
        switch tab {
        case "Playlists": return String(localized: "Playlists")
        case "Albums": return String(localized: "Albums")
        case "Artists": return String(localized: "Artists")
        case "Liked": return String(localized: "Liked")
        default: return tab
        }
    }

    private func libraryEmptyState(title: String, subtitle: String, icon: String) -> some View {
        EmptyStateView(title: title, message: subtitle, systemImage: icon)
            .padding(.horizontal, 18)
            .padding(.top, 24)
    }

    private func loadData() async {
        loading = true
        loadError = nil
        loadUnauthorized = false
        defer { loading = false }

        await library.hydrateLikedTracksIfNeeded()
        do {
            playlists = try await api.getPlaylists()
        } catch {
            playlists = []
            loadError = error.localizedDescription
            loadUnauthorized = (error as? APIError)?.statusCode == 401
        }
    }

    private func createPlaylist() {
        let trimmedName = newPlaylistName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }
        Task {
            do {
                _ = try await api.createPlaylist(name: trimmedName)
            } catch {
                loadError = error.localizedDescription
                loadUnauthorized = (error as? APIError)?.statusCode == 401
                return
            }
            newPlaylistName = ""
            await loadData()
        }
    }
}
