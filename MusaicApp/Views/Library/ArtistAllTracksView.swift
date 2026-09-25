import SwiftUI

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
                PlayShuffleButtons(tracks: tracks) { showNowPlaying = true }
                    .padding(.horizontal, 18)
                    .padding(.top, 16)

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
