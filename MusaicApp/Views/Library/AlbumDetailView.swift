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
                    ContentUnavailableView("No tracks", systemImage: "opticaldisc", description: Text(loadError ?? "No tracks were found for this album."))
                        .padding(.top, 40)
                } else {
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
