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
    @State private var nextCursor: String?
    @State private var loadingMore = false
    @State private var startingPlayback = false
    @State private var loadGeneration = 0
    @State private var showExport = false
    @State private var exportType: UTType = .json
    @State private var exportDocument = PlaylistExportDocument(data: Data())
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
                        HStack(spacing: 16) {
                            Button { Task { await playPlaylist(startAt: 0, shuffled: false) } } label: {
                                Label(String(localized: "Play All"), systemImage: "play.fill")
                            }
                            Button { Task { await playPlaylist(startAt: 0, shuffled: true) } } label: {
                                Label(String(localized: "Shuffle"), systemImage: "shuffle")
                            }
                            if startingPlayback { ProgressView() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(startingPlayback)
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
                                        Task { await playPlaylist(startAt: item.index, shuffled: false) }
                                    },
                                    onLike: { library.toggleLike(track: item.track) },
                                    onAddToQueue: { player.addToQueue(item.track) },
                                    onRemove: { remove(item.track) }
                                )
                                .onAppear {
                                    if item.index >= tracks.count - 5, nextCursor != nil, !loadingMore {
                                        Task { await loadNextPage() }
                                    }
                                }
                            }
                            if loadingMore { ProgressView().padding() }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Layout.playerBottomInset)
            }
            .refreshable { await refreshPlaylist() }
            .musaicSwipeContainer()
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
                    Button {
                        Task { await downloadPlaylist() }
                    } label: {
                        Label(String(localized: "Download Playlist"), systemImage: "arrow.down.circle")
                    }
                    Button { Task { await prepareExport(type: .json) } } label: {
                        Label(String(localized: "Export JSON"), systemImage: "square.and.arrow.up")
                    }
                    Button { Task { await prepareExport(type: .plainText) } } label: {
                        Label(String(localized: "Export M3U"), systemImage: "music.note.list")
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
        .fileExporter(isPresented: $showExport, document: exportDocument,
            contentType: exportType, defaultFilename: playlist.name + (exportType == .json ? ".json" : ".m3u")) { result in
                if case .failure(let error) = result { actionError = error.localizedDescription }
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
                            .musaicFont(size: 12, weight: .semibold)
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
                    .musaicFont(size: 28, weight: .bold, design: .rounded)
                    .foregroundStyle(Color.textPrimary)
                    .multilineTextAlignment(.center)
                Text(String(localized: "\(playlist.trackCount) tracks"))
                    .musaicFont(size: 13, weight: .medium)
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }

    // MARK: - Actions

    private func refreshPlaylist() async {
        loadGeneration += 1
        let generation = loadGeneration
        if tracks.isEmpty, let snapshot = DownloadManager.shared.offlinePlaylist(id: playlistId) {
            playlist = snapshot.playlist
            tracks = snapshot.tracks
            loading = false
        } else if tracks.isEmpty, let cached = api.cachedPlaylistTracks(playlistId: playlistId) {
            tracks = cached.map(api.toAppTrack)
            loading = false
        }
        do {
            async let metadata = api.getPlaylist(id: playlistId)
            async let first = api.getPlaylistTrackPage(playlistId: playlistId)
            let (newPlaylist, page) = try await (metadata, first)
            guard generation == loadGeneration, !Task.isCancelled else { return }
            playlist = newPlaylist
            tracks = page.tracks.map(api.toAppTrack)
            nextCursor = page.nextCursor
            loadingMore = false
            if nextCursor == nil { api.storePlaylistTracks(page.tracks, playlistId: playlistId) }
            loadError = nil
            loadUnauthorized = false
        } catch {
            guard generation == loadGeneration, !error.isCancellation else { return }
            nextCursor = nil
            loadError = error.localizedDescription
            loadUnauthorized = error.isUnauthorized
        }
        loading = false
    }

    private func loadNextPage() async {
        guard !loadingMore, let cursor = nextCursor else { return }
        loadingMore = true
        let generation = loadGeneration
        defer { if generation == loadGeneration { loadingMore = false } }
        do {
            let page = try await api.getPlaylistTrackPage(playlistId: playlistId, cursor: cursor)
            guard generation == loadGeneration, !Task.isCancelled else { return }
            let known = Set(tracks.map(\.id))
            tracks.append(contentsOf: page.tracks.map(api.toAppTrack).filter { !known.contains($0.id) })
            nextCursor = page.nextCursor
        } catch {
            guard generation == loadGeneration, !error.isCancellation else { return }
            actionError = error.localizedDescription
        }
    }

    /// Playing/download/export operate on the full playlist, never just its visible page.
    private func completePlaylistTracks() async throws -> [Track] {
        if let snapshot = DownloadManager.shared.offlinePlaylist(id: playlistId), nextCursor == nil, loadError != nil {
            return snapshot.tracks
        }
        if nextCursor == nil, !loading { return tracks }
        return try await api.getPlaylistTracks(playlistId: playlistId).map(api.toAppTrack)
    }

    private func playPlaylist(startAt index: Int, shuffled: Bool) async {
        guard !startingPlayback, tracks.indices.contains(index) else { return }
        startingPlayback = true
        defer { startingPlayback = false }
        let selectedId = tracks[index].id
        do {
            var full = try await completePlaylistTracks()
            if shuffled { full.shuffle() }
            let selectedIndex = shuffled ? 0 : (full.firstIndex { $0.id == selectedId } ?? 0)
            if player.setQueue(full, startAt: selectedIndex) { showNowPlaying = true }
        } catch { actionError = error.localizedDescription }
    }

    private func downloadPlaylist() async {
        do {
            let full = try await completePlaylistTracks()
            DownloadManager.shared.saveOfflinePlaylist(playlist: playlist, tracks: full)
            DownloadManager.shared.downloadTracks(full)
        } catch { actionError = error.localizedDescription }
    }

    private func prepareExport(type: UTType) async {
        do {
            let full = try await completePlaylistTracks()
            exportDocument = PlaylistExportDocument(data: try PlaylistExport.data(name: playlist.name, tracks: full, json: type == .json))
            exportType = type
            showExport = true
        } catch { actionError = error.localizedDescription }
    }

    /// Optimistic: the row disappears at once and comes back if the server refuses.
    private func remove(_ track: Track) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        tracks.remove(at: index)
        Task {
            do {
                try await api.removeFromPlaylist(playlistId: playlistId, trackId: track.id)
                await refreshPlaylist()
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
