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
    @State private var loadError: String?
    @State private var loadUnauthorized = false
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
    @State private var actionError: String?

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

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
                    header

                    if loading && tracks.isEmpty {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .padding(.top, 40)
                            .frame(maxWidth: .infinity)
                    } else if let loadError, tracks.isEmpty {
                        ErrorRetryView(
                            title: loadUnauthorized ? String(localized: "Session expired") : String(localized: "Playlist unavailable"),
                            message: loadError,
                            isUnauthorized: loadUnauthorized,
                            onRetry: { Task { await refreshPlaylist() } },
                            onSignIn: loadUnauthorized ? { settings.logout() } : nil
                        )
                        .padding(.horizontal, 18)
                        .padding(.top, 24)
                    } else if tracks.isEmpty {
                        ContentUnavailableView(
                            String(localized: "Empty Playlist"),
                            systemImage: "music.note.list",
                            description: Text(String(localized: "Add tracks from search or any track's menu."))
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
                                    onRemove: { remove(item.track) }
                                )
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Layout.playerBottomInset)
            }
            .refreshable { await refreshPlaylist() }
        }
        .navigationTitle(playlist.name)
        .navigationBarTitleDisplayModeCompat()
        .confirmationDialog(String(localized: "Playlist cover"), isPresented: $showCoverPicker, titleVisibility: .visible) {
            #if os(iOS)
            Button(String(localized: "Choose from Photos")) {
                showPhotosPicker = true
            }
            #endif
            Button(String(localized: "Choose from Files")) {
                showFileImporter = true
            }
            if playlist.hasCustomCover == true {
                Button(String(localized: "Remove Cover"), role: .destructive) {
                    removeCover()
                }
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        }
        #if os(iOS)
        .photosPicker(isPresented: $showPhotosPicker, selection: $selectedPhotoItem, matching: .images)
        .onChange(of: selectedPhotoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    uploadCover(rawData: data)
                } else {
                    actionError = String(localized: "Couldn't read the selected photo.")
                }
                selectedPhotoItem = nil
            }
        }
        #endif
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.image]) { result in
            switch result {
            case .success(let url):
                importCover(from: url)
            case .failure(let error):
                actionError = error.localizedDescription
            }
        }
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
                        Label(String(localized: "Rename"), systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label(String(localized: "Delete Playlist"), systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Color.textPrimary)
                }
                .accessibilityLabel(Text(String(localized: "Playlist options")))
            }
        }
        .alert(String(localized: "Rename Playlist"), isPresented: $showRename) {
            TextField(String(localized: "Playlist name"), text: $renameText)
            Button(String(localized: "Save")) { rename() }
            Button(String(localized: "Cancel"), role: .cancel) {}
        }
        .alert(String(localized: "Delete Playlist?"), isPresented: $showDeleteConfirm) {
            Button(String(localized: "Delete"), role: .destructive) { deletePlaylist() }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text(String(localized: "This will permanently delete \"\(playlist.name)\" and all its tracks."))
        }
        .alert(
            String(localized: "Something went wrong"),
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button(String(localized: "OK"), role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    private var header: some View {
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
                        Text(uploadingCover ? String(localized: "Uploading…") : String(localized: "Edit Cover"))
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .glassCard(cornerRadius: 18, intensity: 0.10)
                }
                .buttonStyle(.plain)
                .disabled(uploadingCover)
                .padding(12)
            }
            .padding(.top, 16)

            VStack(spacing: 4) {
                Text(playlist.name)
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                    .multilineTextAlignment(.center)
                Text(String(localized: "\(tracks.count) tracks"))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }

    // MARK: - Actions

    private func refreshPlaylist() async {
        // Show cached tracks instantly, then revalidate — reopening a large
        // playlist (e.g. Yandex Likes with 1000+ tracks) must not show a spinner.
        if tracks.isEmpty, let cached = api.cachedPlaylistTracks(playlistId: playlistId) {
            tracks = cached.map(api.toAppTrack)
            loading = false
        }

        do {
            async let playlistTask = api.getPlaylist(id: playlistId)
            async let tracksTask = api.getPlaylistTracks(playlistId: playlistId)
            let (fetchedPlaylist, fetchedTracks) = try await (playlistTask, tracksTask)
            playlist = fetchedPlaylist
            api.storePlaylistTracks(fetchedTracks, playlistId: playlistId)
            let mapped = fetchedTracks.map(api.toAppTrack)
            if mapped != tracks {
                tracks = mapped
            }
            loadError = nil
            loadUnauthorized = false
        } catch where error.isCancellation {
            return
        } catch {
            loadError = error.localizedDescription
            loadUnauthorized = error.isUnauthorized
        }
        loading = false
    }

    /// Optimistic: the row disappears at once and comes back if the server refuses.
    private func remove(_ track: Track) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        tracks.remove(at: index)
        Task {
            do {
                try await api.removeFromPlaylist(playlistId: playlistId, trackId: track.id)
            } catch {
                tracks.insert(track, at: min(index, tracks.count))
                if !error.isCancellation {
                    actionError = String(localized: "Couldn't remove the track: \(error.localizedDescription)")
                }
            }
        }
    }

    private func rename() {
        let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            do {
                try await api.updatePlaylist(id: playlistId, name: name)
            } catch {
                actionError = String(localized: "Couldn't rename: \(error.localizedDescription)")
            }
            await refreshPlaylist()
        }
    }

    private func deletePlaylist() {
        Task {
            do {
                try await api.deletePlaylist(id: playlistId)
                dismiss()
            } catch {
                actionError = String(localized: "Couldn't delete: \(error.localizedDescription)")
            }
        }
    }

    /// Files from the document picker are security-scoped; read them off the main actor.
    private func importCover(from url: URL) {
        Task {
            let data = await Task.detached(priority: .userInitiated) { () -> Data? in
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return try? Data(contentsOf: url)
            }.value
            guard let data else {
                actionError = String(localized: "Couldn't read the selected file.")
                return
            }
            uploadCover(rawData: data)
        }
    }

    private func uploadCover(rawData: Data) {
        Task {
            uploadingCover = true
            defer { uploadingCover = false }
            do {
                // APIService downsizes and re-encodes off the main actor.
                _ = try await api.uploadPlaylistCover(playlistId: playlistId, data: rawData, mimeType: "image/jpeg")
            } catch {
                actionError = String(localized: "Couldn't upload cover: \(error.localizedDescription)")
            }
            await refreshPlaylist()
        }
    }

    private func removeCover() {
        Task {
            uploadingCover = true
            defer { uploadingCover = false }
            do {
                try await api.deletePlaylistCover(playlistId: playlistId)
            } catch {
                actionError = String(localized: "Couldn't remove cover: \(error.localizedDescription)")
            }
            await refreshPlaylist()
        }
    }
}
