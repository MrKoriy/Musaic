#if os(iOS)
import PhotosUI
#endif
import SwiftUI
import UniformTypeIdentifiers

struct PlaylistDetailView: View {
    let playlistId: String
    @Binding var showNowPlaying: Bool

    @State private var playlist: ServerPlaylist
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var uploadingCover = false
    @State private var showCoverPicker = false
    @State private var showRename = false
    @State private var showDeleteConfirm = false
    @State private var renameText = ""
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @State private var showPhotosPicker = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    #endif
    @State private var showFileImporter = false

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    init(playlistId: String, initialPlaylist: ServerPlaylist, showNowPlaying: Binding<Bool>) {
        self.playlistId = playlistId
        self._showNowPlaying = showNowPlaying
        self._playlist = State(initialValue: initialPlaylist)
    }

    var body: some View {
        ZStack {
            AppBackdrop()

            ScrollView {
                VStack(spacing: 18) {
                    ZStack(alignment: .bottomTrailing) {
                        PlaylistArtworkView(coverURL: api.artworkURL(for: playlist.coverUrl))
                            .frame(width: 240, height: 240)

                        Button {
                            showCoverPicker = true
                        } label: {
                            HStack(spacing: 8) {
                                if uploadingCover {
                                    ProgressView()
                                        .tint(Color.textPrimary)
                                } else {
                                    Image(systemName: "photo")
                                }
                                Text(uploadingCover ? "Uploading..." : "Edit Cover")
                                    .font(.system(size: 12, weight: .semibold))
                            }
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .glassCard(cornerRadius: 18, intensity: 0.10)
                        }
                        .buttonStyle(.plain)
                        .padding(12)
                    }
                    .padding(.top, 16)

                    VStack(spacing: 4) {
                        Text(playlist.name)
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                            .multilineTextAlignment(.center)
                        Text("\(tracks.count) tracks")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }

                    if loading {
                        VStack {
                            ProgressView()
                                .tint(Color.textPrimary)
                                .padding(.top, 40)
                        }
                        .frame(maxWidth: .infinity)
                    } else if tracks.isEmpty {
                        ContentUnavailableView("Empty Playlist", systemImage: "music.note.list")
                            .padding(.top, 40)
                    } else {
                        HStack(spacing: 12) {
                            Button {
                                if player.setQueue(tracks, startAt: 0) {
                                    showNowPlaying = true
                                }
                            } label: {
                                Label("Play All", systemImage: "play.fill")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.bgPrimary)
                                    .padding(.horizontal, 18)
                                    .padding(.vertical, 12)
                                    .background(Color.textPrimary.opacity(0.92), in: Capsule())
                            }

                            Button {
                                var shuffled = tracks
                                shuffled.shuffle()
                                if player.setQueue(shuffled, startAt: 0) {
                                    showNowPlaying = true
                                }
                            } label: {
                                Label("Shuffle", systemImage: "shuffle")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .padding(.horizontal, 18)
                                    .padding(.vertical, 12)
                                    .glassCard(cornerRadius: 22, intensity: 0.08)
                            }
                        }
                        .padding(.horizontal, 18)

                        VStack(spacing: 10) {
                            ForEach(tracks.indices, id: \.self) { idx in
                                let track = tracks[idx]
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
                                    onAddToQueue: { player.addToQueue(track) }
                                )
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Layout.playerBottomInset)
            }
        }
        .navigationTitle(playlist.name)
        .navigationBarTitleDisplayModeCompat()
        .confirmationDialog("Playlist cover", isPresented: $showCoverPicker, titleVisibility: .visible) {
            #if os(iOS)
            Button("Choose from Photos") {
                showPhotosPicker = true
            }
            #endif
            Button("Choose from Files") {
                showFileImporter = true
            }
            if playlist.hasCustomCover == true {
                Button("Remove Cover", role: .destructive) {
                    removeCover()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        #if os(iOS)
        .photosPicker(isPresented: $showPhotosPicker, selection: $selectedPhotoItem, matching: .images)
        #endif
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            guard let data = try? Data(contentsOf: url) else { return }
            uploadCover(rawData: data)
        }
        #if os(iOS)
        .onChange(of: selectedPhotoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    uploadCover(rawData: data)
                }
                selectedPhotoItem = nil
            }
        }
        #endif
        .task {
            await refreshPlaylist()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailingCompat) {
                Menu {
                    Button {
                        renameText = playlist.name
                        showRename = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label("Delete Playlist", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Color.textPrimary)
                }
            }
        }
        .alert("Rename Playlist", isPresented: $showRename) {
            TextField("Playlist name", text: $renameText)
            Button("Save") {
                guard !renameText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                Task {
                    try? await api.updatePlaylist(id: playlistId, name: renameText.trimmingCharacters(in: .whitespaces))
                    await refreshPlaylist()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete Playlist?", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) {
                Task {
                    try? await api.deletePlaylist(id: playlistId)
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete \"\(playlist.name)\" and all its tracks.")
        }
    }

    private func refreshPlaylist() async {
        async let playlistTask = try? api.getPlaylist(id: playlistId)
        async let tracksTask = try? api.getPlaylistTracks(playlistId: playlistId)

        if let fetchedPlaylist = await playlistTask {
            playlist = fetchedPlaylist
        }
        if let fetchedTracks = await tracksTask {
            tracks = fetchedTracks.map(api.toAppTrack)
        }
        loading = false
    }

    private func uploadCover(rawData: Data) {
        guard let prepared = normalizedImagePayload(from: rawData) else { return }

        Task {
            uploadingCover = true
            defer { uploadingCover = false }
            _ = try? await api.uploadPlaylistCover(playlistId: playlistId, data: prepared.data, mimeType: prepared.mimeType)
            await refreshPlaylist()
        }
    }

    private func removeCover() {
        Task {
            uploadingCover = true
            defer { uploadingCover = false }
            try? await api.deletePlaylistCover(playlistId: playlistId)
            await refreshPlaylist()
        }
    }
}

private func normalizedImagePayload(from data: Data) -> (data: Data, mimeType: String)? {
    guard let image = PlatformImage.platformImage(from: data) else { return nil }
    let maxSide: CGFloat = 1600
    let size = image.platformSize
    let scale = min(1, maxSide / max(size.width, size.height))
    let targetSize = CGSize(width: size.width * scale, height: size.height * scale)

    let rendered = resizedImage(image, to: targetSize)
    if let jpeg = rendered.platformJPEGData(compressionQuality: 0.82) {
        return (jpeg, "image/jpeg")
    }
    return nil
}
