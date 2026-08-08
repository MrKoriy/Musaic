import SwiftUI

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
                .accessibilityLabel(Text(audio.isPlaying ? String(localized: "Pause") : String(localized: "Play")))

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
                .accessibilityLabel(Text(String(localized: "Next Track")))
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
