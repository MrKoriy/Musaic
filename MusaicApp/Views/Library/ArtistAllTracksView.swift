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
