import SwiftUI

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
                    ContentUnavailableView(
                        String(localized: "No tracks"),
                        systemImage: "opticaldisc",
                        description: Text(loadError ?? String(localized: "No tracks were found for this album."))
                    )
                        .padding(.top, 40)
                } else {
                    PlayShuffleButtons(tracks: tracks) { showNowPlaying = true }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)

                    LazyVStack(spacing: 10) {
                        ForEach(tracks.listItems) { item in
                            TrackRow(
                                track: item.track,
                                index: item.index + 1,
                                isCurrent: player.currentTrack?.id == item.track.id,
                                isLiked: library.isLiked(item.track.id),
                                onTap: {
                                    if player.setQueue(tracks, startAt: item.index) {
                                        showNowPlaying = true
                                    }
                                },
                                onLike: { library.toggleLike(track: item.track) },
                                onAddToQueue: { player.addToQueue(item.track) },
                                onAddToPlaylist: { playlistPickerTrack = item.track }
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
                Text(String(localized: "\(tracks.count) tracks") + (source.map { " • \(artistSourceDisplayName($0))" } ?? ""))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
            }
            .padding(.horizontal, 18)
        }
        .padding(.top, 24)
    }

    private func loadTracks() async {
        guard preloadedTracks.isEmpty, tracks.isEmpty else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let server = try await api.getAlbumTracks(album: albumTitle, artist: artistName, source: source)
            tracks = server.map(api.toAppTrack)
        } catch where error.isCancellation {
            return
        } catch {
            loadError = error.localizedDescription
        }
    }
}
