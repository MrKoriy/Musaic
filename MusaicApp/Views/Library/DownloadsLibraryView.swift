import SwiftUI

struct DownloadsLibraryView: View {
    @Binding var showNowPlaying: Bool
    private let downloads = DownloadManager.shared
    private let library = LibraryStore.shared
    private let player = PlayerStore.shared

    var body: some View {
        let tracks = downloads.offlineTracks
        VStack(alignment: .leading, spacing: 16) {
            ForEach(downloads.offlinePlaylists.keys.sorted(), id: \.self) { id in
                if let snapshot = downloads.offlinePlaylist(id: id), !snapshot.tracks.isEmpty {
                    NavigationLink {
                        PlaylistDetailView(playlistId: id, initialPlaylist: snapshot.playlist, showNowPlaying: $showNowPlaying)
                    } label: {
                        Label(snapshot.playlist.name, systemImage: "music.note.list")
                            .font(.headline).padding(.horizontal, 18)
                    }
                }
            }
            if !downloads.activeDownloads.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(String(localized: "Download queue")).font(.headline)
                    ForEach(downloads.activeDownloads.keys.sorted(), id: \.self) { id in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(library.likedTracks.first(where: { $0.id == id })?.title ?? id)
                                    .font(.subheadline).lineLimit(2)
                                if case .failed(let message) = downloads.phase(for: id) {
                                    Text(message).font(.caption).foregroundStyle(Color.textSecondary)
                                } else {
                                    ProgressView(value: downloads.progress(for: id).fraction)
                                }
                            }
                            Spacer()
                            Button { downloads.cancelDownload(trackId: id) } label: {
                                Image(systemName: "xmark.circle").frame(width: 44, height: 44)
                            }
                            .accessibilityLabel(Text(String(localized: "Cancel download")))
                        }
                    }
                }
                .padding(.horizontal, 18)
            }
            if tracks.isEmpty {
                EmptyStateView(title: String(localized: "No downloads"),
                    message: String(localized: "Download tracks or playlists to listen without a connection."),
                    systemImage: "arrow.down.circle")
            } else {
                HStack {
                    Text(downloads.totalSizeFormatted).font(.caption).foregroundStyle(Color.textSecondary)
                    Spacer()
                    PlayShuffleButtons(tracks: tracks) { showNowPlaying = true }
                }
                .padding(.horizontal, 18)
                LazyVStack(spacing: 10) {
                    ForEach(tracks.listItems) { item in
                        TrackRow(track: item.track, index: item.index + 1,
                            isCurrent: player.currentTrack?.id == item.track.id,
                            isLiked: library.isLiked(item.track.id),
                            onTap: { if player.setQueue(tracks, startAt: item.index) { showNowPlaying = true } },
                            onLike: { library.toggleLike(track: item.track) },
                            onAddToQueue: { player.addToQueue(item.track) })
                    }
                }
            }
        }
    }
}
