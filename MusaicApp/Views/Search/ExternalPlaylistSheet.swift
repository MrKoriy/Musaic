import SwiftUI

struct ExternalPlaylistSheet: View {
    let playlist: ExternalPlaylist
    @Binding var showNowPlaying: Bool
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var saving = false
    @State private var saved = false
    @State private var saveError: String?
    /// Kept across retries so a partial failure never creates a second playlist.
    @State private var createdPlaylistId: String?
    @State private var addedTrackIds: Set<String> = []
    /// Local binding so the NowPlaying sheet can be shown on top of this sheet
    /// without the parent tearing this sheet down to present its own.
    @State private var localNowPlaying = false
    @Environment(\.dismiss) private var dismiss

    private static let maxConcurrentAdds = 4
    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    private var savedStateIcon: String {
        if saved { return "checkmark" }
        if saving { return "hourglass" }
        return saveError == nil ? "plus" : "arrow.clockwise"
    }

    private var savedStateLabel: String {
        if saved { return String(localized: "Saved") }
        if saving { return String(localized: "Saving…") }
        return saveError == nil ? String(localized: "Add to Library") : String(localized: "Retry")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()

                ScrollView {
                    VStack(spacing: 16) {
                        header

                        if loading {
                            ProgressView()
                                .tint(Color.textPrimary)
                                .padding(.top, 30)
                                .frame(maxWidth: .infinity)
                        } else if let loadError {
                            ErrorRetryView(
                                title: String(localized: "Playlist unavailable"),
                                message: loadError,
                                onRetry: { Task { await loadTracks() } }
                            )
                            .padding(.horizontal, 18)
                            .padding(.top, 20)
                        } else if tracks.isEmpty {
                            Text(String(localized: "No tracks available"))
                                .foregroundStyle(Color.textSecondary)
                                .padding(.top, 30)
                                .frame(maxWidth: .infinity)
                        } else {
                            LazyVStack(spacing: 10) {
                                ForEach(tracks.listItems) { item in
                                    TrackRow(
                                        track: item.track,
                                        index: item.index + 1,
                                        isCurrent: player.currentTrack?.id == item.track.id,
                                        isLiked: library.isLiked(item.track.id),
                                        onTap: {
                                            if player.setQueue(tracks, startAt: item.index) {
                                                localNowPlaying = true
                                            }
                                        },
                                        onLike: { library.toggleLike(track: item.track) },
                                        onAddToQueue: { player.addToQueue(item.track) }
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
                    Button(String(localized: "Done")) { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
            .task {
                guard tracks.isEmpty else { return }
                await loadTracks()
            }
            .safeAreaInset(edge: .bottom) {
                if player.currentTrack != nil {
                    MiniPlayerView(showNowPlaying: $localNowPlaying)
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

    private var header: some View {
        VStack(spacing: 10) {
            ZStack {
                if let url = playlist.coverUrl {
                    InspectableArtworkView(
                        urlString: api.artworkURL(for: url),
                        debugLabel: "playlist-header: \(playlist.title)",
                        maxPixelSize: 512
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
                Text(String(localized: "\(playlist.trackCount) tracks"))
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
                        Label(String(localized: "Play All"), systemImage: "play.fill")
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
                        Haptics.impact(.soft)
                        Task { await saveToLibrary() }
                    } label: {
                        Label(savedStateLabel, systemImage: savedStateIcon)
                            .contentTransition(.symbolEffect(.replace))
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

                if let saveError {
                    Text(saveError)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.accentStrong)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 30)
                }
            }
        }
        .padding(.top, 20)
        .frame(maxWidth: .infinity)
    }

    private func loadTracks() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let serverTracks = try await api.getExternalPlaylistTracks(playlistId: playlist.id)
            tracks = serverTracks.map(api.toAppTrack)
        } catch where error.isCancellation {
            return
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Creates the playlist once, then adds only the tracks that aren't in it
    /// yet — a retry after a partial failure resumes instead of duplicating.
    private func saveToLibrary() async {
        guard !saving, !saved, !tracks.isEmpty else { return }
        saving = true
        saveError = nil
        defer { saving = false }

        do {
            let playlistId: String
            if let createdPlaylistId {
                playlistId = createdPlaylistId
            } else {
                playlistId = try await api.createPlaylist(name: playlist.title)
                createdPlaylistId = playlistId
            }

            var seen = Set<String>()
            let pending = tracks.enumerated()
                .filter { seen.insert($0.element.id).inserted && !addedTrackIds.contains($0.element.id) }
                .map { (position: $0.offset, trackId: $0.element.id) }
            addedTrackIds.formUnion(await addTracks(pending, to: playlistId))

            let failed = seen.count - addedTrackIds.count
            if failed > 0 {
                saveError = String(localized: "\(failed) of \(seen.count) tracks couldn't be added.")
            } else {
                saved = true
            }
        } catch where error.isCancellation {
            return
        } catch {
            saveError = error.localizedDescription
        }
    }

    /// Adds tracks with bounded concurrency; explicit positions keep the order.
    private func addTracks(_ items: [(position: Int, trackId: String)], to playlistId: String) async -> Set<String> {
        let api = api
        return await withTaskGroup(of: (String, Bool).self) { group in
            var remaining = items[...]
            var added = Set<String>()

            func enqueueNext() {
                guard let item = remaining.popFirst() else { return }
                group.addTask {
                    do {
                        try await api.addToPlaylist(playlistId: playlistId, trackId: item.trackId, position: item.position)
                        return (item.trackId, true)
                    } catch {
                        return (item.trackId, false)
                    }
                }
            }

            for _ in 0..<Self.maxConcurrentAdds { enqueueNext() }
            for await (trackId, succeeded) in group {
                if succeeded { added.insert(trackId) }
                enqueueNext()
            }
            return added
        }
    }
}
