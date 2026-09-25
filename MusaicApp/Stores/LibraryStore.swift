import Foundation

// MARK: - Library Store

private func normalizedLibraryValue(_ value: String?) -> String {
    value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

/// On-disk library state (Application Support/…/library.json).
struct LibrarySnapshot: Codable, Sendable {
    var likedTrackOrder: [String] = []
    var likedTracks: [Track] = []
    /// Local likes/unlikes the server hasn't confirmed yet.
    var pendingLikedTrackIds: [String] = []
    var pendingUnlikedTrackIds: [String] = []
    var lastServerSyncAt: Date?
    var syncedUserId: String?
}

@Observable
@MainActor
final class LibraryStore {
    static let shared = LibraryStore()

    /// Server likes are re-read at most this often unless something changed locally.
    private static let syncInterval: TimeInterval = 10 * 60

    private(set) var likedTrackIds: Set<String> = []
    /// Liked track IDs, newest first.
    private(set) var likedTrackOrder: [String] = []
    private(set) var likedTracks: [Track] = []
    private(set) var displayedLikedTracks: [Track] = []
    private(set) var likedAlbums: [Album] = []
    private(set) var likedArtists: [Artist] = []

    @ObservationIgnored private var pendingLikedTrackIds = Set<String>()
    @ObservationIgnored private var pendingUnlikedTrackIds = Set<String>()
    @ObservationIgnored private var lastServerSyncAt: Date?
    @ObservationIgnored private var syncedUserId: String?
    @ObservationIgnored private var syncTask: Task<Bool, Never>?
    @ObservationIgnored private var hydrationTask: Task<Void, Never>?
    @ObservationIgnored private var rebuildTask: Task<Void, Never>?
    @ObservationIgnored private var likeWorkers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var desiredLikeState: [String: LikeIntent] = [:]
    @ObservationIgnored private let store = JSONFileStore<LibrarySnapshot>(fileName: "library.json")
    private let api = APIService.shared

    private struct LikeIntent {
        let liked: Bool
        let track: Track
    }

    private init() {
        loadPersistedState()
        Task { await hydrateLikedTracksIfNeeded() }
    }

    // MARK: - Sync

    /// Syncs likes when something changed locally, the account changed, the
    /// last sync is stale, or `force` is set. Cheap to call on every foreground.
    func ensureSynced(force: Bool = false) async {
        guard SettingsStore.shared.isLoggedIn else { return }
        let userId = SettingsStore.shared.authUserId
        let hasPendingChanges = !pendingLikedTrackIds.isEmpty || !pendingUnlikedTrackIds.isEmpty
        let isStale = lastServerSyncAt.map { Date().timeIntervalSince($0) > Self.syncInterval } ?? true
        guard force || hasPendingChanges || isStale || syncedUserId != userId else { return }
        guard await syncLikesWithServer() else { return }
        await hydrateLikedTracksIfNeeded()
    }

    /// Uploads only unconfirmed local changes (or just reads the server list
    /// when there are none) and adopts the server's ordered like list.
    @discardableResult
    func syncLikesWithServer() async -> Bool {
        if let syncTask { return await syncTask.value }
        let task = Task { await performSync() }
        syncTask = task
        let succeeded = await task.value
        syncTask = nil
        return succeeded
    }

    private func performSync() async -> Bool {
        guard SettingsStore.shared.isLoggedIn else { return false }
        let sentLikes = pendingLikedTrackIds
        let sentRemovals = pendingUnlikedTrackIds
        do {
            let serverIds: [String]
            if sentLikes.isEmpty && sentRemovals.isEmpty {
                serverIds = try await api.getServerLikes()
            } else {
                let orderedLikes = likedTrackOrder.filter { sentLikes.contains($0) }
                let tracksByID = trackIndex()
                serverIds = try await api.syncLikes(
                    trackIds: orderedLikes,
                    tracks: orderedLikes.compactMap { tracksByID[$0] },
                    removedTrackIds: Array(sentRemovals)
                )
            }
            // A logout/account switch cancels the sync; never resurrect old likes.
            guard !Task.isCancelled, SettingsStore.shared.isLoggedIn else { return false }
            // Only the intents that were sent are confirmed; taps made while
            // the request was in flight stay pending.
            pendingLikedTrackIds.subtract(sentLikes)
            pendingUnlikedTrackIds.subtract(sentRemovals)
            applyServerLikes(serverIds)
            lastServerSyncAt = Date()
            syncedUserId = SettingsStore.shared.authUserId
            persist()
            return true
        } catch {
            #if DEBUG
            if !error.isCancellation { print("[LibraryStore] Likes sync failed: \(error)") }
            #endif
            return false
        }
    }

    /// Adopts the server order, overlaying local intents that are still pending.
    private func applyServerLikes(_ serverIds: [String]) {
        var seen = Set<String>()
        var ids = serverIds.filter { seen.insert($0).inserted }
        let pendingLikes = likedTrackOrder.filter { pendingLikedTrackIds.contains($0) && !seen.contains($0) }
        ids.insert(contentsOf: pendingLikes, at: 0)
        seen.formUnion(pendingLikes)
        if !pendingUnlikedTrackIds.isEmpty {
            ids.removeAll { pendingUnlikedTrackIds.contains($0) }
            seen.subtract(pendingUnlikedTrackIds)
        }
        guard ids != likedTrackOrder else { return }
        likedTrackOrder = ids
        likedTrackIds = seen
        let tracksByID = trackIndex()
        likedTracks = ids.compactMap { tracksByID[$0] }
        rebuildDerivedCollections()
    }

    /// Fetches metadata for liked IDs we have no track for; `force` refreshes all.
    func hydrateLikedTracksIfNeeded(force: Bool = false) async {
        if let hydrationTask {
            await hydrationTask.value
            if !force { return }
        }
        let known = Set(likedTracks.map(\.id))
        let targetIDs = force ? likedTrackOrder : likedTrackOrder.filter { !known.contains($0) }
        guard !targetIDs.isEmpty, SettingsStore.shared.isLoggedIn else { return }

        let task = Task {
            do {
                let serverTracks = try await api.getTracks(ids: targetIDs)
                mergeHydratedTracks(serverTracks.map(api.toAppTrack))
            } catch {
                // Keep the local cache when the refresh fails.
            }
        }
        hydrationTask = task
        await task.value
        hydrationTask = nil
    }

    private func mergeHydratedTracks(_ hydrated: [Track]) {
        guard !hydrated.isEmpty else { return }
        var tracksByID = trackIndex()
        for track in hydrated { tracksByID[track.id] = track }
        likedTracks = likedTrackOrder.compactMap { tracksByID[$0] }
        rebuildDerivedCollections()
        persist()
    }

    // MARK: - Liked

    func isLiked(_ trackId: String) -> Bool {
        likedTrackIds.contains(trackId)
    }

    /// Prevent a previous account's local likes from being uploaded to a new account.
    func prepareForUser(_ userId: String) {
        guard let currentUserId = SettingsStore.shared.authUserId, currentUserId == userId else {
            clearLocalLikes()
            return
        }
    }

    func clearLocalLikes() {
        likeWorkers.values.forEach { $0.cancel() }
        likeWorkers.removeAll()
        desiredLikeState.removeAll()
        syncTask?.cancel()
        hydrationTask?.cancel()
        likedTrackIds.removeAll()
        likedTrackOrder.removeAll()
        likedTracks.removeAll()
        pendingLikedTrackIds.removeAll()
        pendingUnlikedTrackIds.removeAll()
        lastServerSyncAt = nil
        syncedUserId = nil
        rebuildDerivedCollections()
        persist()
        store.flush()
    }

    func toggleLike(track: Track) {
        let normalizedTrack = api.normalizedTrack(track)
        let id = normalizedTrack.id
        let isNowLiked = !likedTrackIds.contains(id)

        likedTrackOrder.removeAll { $0 == id }
        likedTracks.removeAll { $0.id == id }
        if isNowLiked {
            likedTrackIds.insert(id)
            likedTrackOrder.insert(id, at: 0)
            likedTracks.insert(normalizedTrack, at: 0)
            pendingUnlikedTrackIds.remove(id)
            pendingLikedTrackIds.insert(id)
        } else {
            likedTrackIds.remove(id)
            pendingLikedTrackIds.remove(id)
            pendingUnlikedTrackIds.insert(id)
        }
        rebuildDerivedCollections()
        persist()
        logLikeEvent(for: normalizedTrack, liked: isNowLiked)
        enqueueLikeRequest(LikeIntent(liked: isNowLiked, track: normalizedTrack))
    }

    /// One request in flight per track; rapid taps collapse so the latest
    /// intent is what the server ends up with.
    private func enqueueLikeRequest(_ intent: LikeIntent) {
        let id = intent.track.id
        desiredLikeState[id] = intent
        guard likeWorkers[id] == nil else { return }
        likeWorkers[id] = Task { await runLikeWorker(trackId: id) }
    }

    private func runLikeWorker(trackId: String) async {
        defer { likeWorkers[trackId] = nil }
        while let intent = desiredLikeState[trackId], !Task.isCancelled {
            do {
                try await api.setLikeOnServer(track: intent.track, liked: intent.liked)
            } catch {
                // The intent stays in the pending sets; the next sync retries it.
                desiredLikeState[trackId] = nil
                return
            }
            if let latest = desiredLikeState[trackId], latest.liked != intent.liked {
                continue
            }
            desiredLikeState[trackId] = nil
            if intent.liked {
                pendingLikedTrackIds.remove(trackId)
            } else {
                pendingUnlikedTrackIds.remove(trackId)
            }
            persist()
        }
    }

    private func logLikeEvent(for track: Track, liked: Bool) {
        let playbackContext = PlayerStore.shared.analyticsContext(for: track.id)
        Task {
            await api.logPlay(
                trackId: track.id,
                action: liked ? "like" : "unlike",
                eventId: UUID().uuidString,
                sessionId: playbackContext?.sessionId,
                requestId: playbackContext?.requestId,
                surface: playbackContext?.surface ?? "organic",
                isOrganic: playbackContext == nil,
                position: playbackContext?.position
            )
        }
    }

    // MARK: - Persistence

    /// Writes pending state to disk immediately (call when backgrounding).
    func flushPendingWrites() {
        store.flush()
    }

    private func persist() {
        store.save(LibrarySnapshot(
            likedTrackOrder: likedTrackOrder,
            likedTracks: likedTracks,
            pendingLikedTrackIds: Array(pendingLikedTrackIds),
            pendingUnlikedTrackIds: Array(pendingUnlikedTrackIds),
            lastServerSyncAt: lastServerSyncAt,
            syncedUserId: syncedUserId
        ))
    }

    private func loadPersistedState() {
        let snapshot: LibrarySnapshot
        var needsSave = false
        if let stored = store.load() {
            snapshot = stored
        } else {
            snapshot = migrateFromUserDefaults()
            needsSave = true
        }

        likedTrackOrder = snapshot.likedTrackOrder
        likedTrackIds = Set(snapshot.likedTrackOrder)
        likedTracks = snapshot.likedTracks.map(api.normalizedTrack)
        pendingLikedTrackIds = Set(snapshot.pendingLikedTrackIds)
        pendingUnlikedTrackIds = Set(snapshot.pendingUnlikedTrackIds)
        lastServerSyncAt = snapshot.lastServerSyncAt
        syncedUserId = snapshot.syncedUserId

        if migrateLegacyMMKVLikedIdsIfNeeded() { needsSave = true }
        normalizeLikedState()
        rebuildDerivedCollections()
        if needsSave { persist() }
    }

    /// One-time move of the old UserDefaults blobs into the snapshot file.
    /// Every local like is marked pending so nothing liked offline is lost.
    private func migrateFromUserDefaults() -> LibrarySnapshot {
        let defaults = UserDefaults.standard
        let decoder = JSONDecoder()
        func decoded<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
            defaults.data(forKey: key).flatMap { try? decoder.decode(type, from: $0) }
        }

        let ids = decoded([String].self, "liked_track_ids") ?? []
        var order = decoded([String].self, "liked_track_order") ?? []
        if order.isEmpty { order = ids }
        let tracks = decoded([Track].self, "liked_tracks") ?? []
        let pendingUnliked = decoded([String].self, "pending_unliked_track_ids") ?? []

        for key in ["liked_track_ids", "liked_track_order", "liked_tracks", "pending_unliked_track_ids"] {
            defaults.removeObject(forKey: key)
        }
        return LibrarySnapshot(
            likedTrackOrder: order,
            likedTracks: tracks,
            pendingLikedTrackIds: order,
            pendingUnlikedTrackIds: pendingUnliked
        )
    }

    /// O(n): keeps order, ID set and track list consistent and duplicate-free.
    private func normalizeLikedState() {
        var seen = Set<String>()
        var order = likedTrackOrder.filter { likedTrackIds.contains($0) && seen.insert($0).inserted }
        for id in likedTrackIds where !seen.contains(id) {
            order.append(id)
        }
        likedTrackOrder = order
        let tracksByID = trackIndex()
        likedTracks = order.compactMap { tracksByID[$0] }
    }

    private func trackIndex() -> [String: Track] {
        Dictionary(likedTracks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    private func rebuildDerivedCollections() {
        displayedLikedTracks = likedTracks

        // Debounced: bursts of changes (sync, hydration, rapid likes) collapse
        // into one album/artist regrouping 150 ms after the last change.
        rebuildTask?.cancel()
        let tracks = likedTracks
        rebuildTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            let (albums, artists) = await Task.detached(priority: .userInitiated) {
                (Self.computeAlbums(from: tracks), Self.computeArtists(from: tracks))
            }.value
            guard !Task.isCancelled else { return }
            self?.likedAlbums = albums
            self?.likedArtists = artists
        }
    }

    private nonisolated static func albumTitle(for track: Track) -> String {
        let album = normalizedLibraryValue(track.album)
        if !album.isEmpty { return album }
        let title = normalizedLibraryValue(track.title)
        return title.isEmpty ? String(localized: "Untitled Single") : title
    }

    private nonisolated static func computeAlbums(from tracks: [Track]) -> [Album] {
        let grouped = Dictionary(grouping: tracks) { track in
            let artist = normalizedLibraryValue(track.artist)
            return "\(track.source.rawValue)|\(artist.lowercased())|\(albumTitle(for: track).lowercased())"
        }
        return grouped.values
            .compactMap { tracks in
                guard let first = tracks.first else { return nil }
                let artist = normalizedLibraryValue(first.artist)
                guard !artist.isEmpty else { return nil }
                return Album(
                    album: albumTitle(for: first),
                    artist: artist,
                    trackCount: tracks.count,
                    coverUrl: tracks.compactMap(\.artwork).first,
                    source: first.source.rawValue
                )
            }
            .sorted {
                let artistOrder = $0.artist.localizedCaseInsensitiveCompare($1.artist)
                if artistOrder == .orderedSame {
                    return $0.album.localizedCaseInsensitiveCompare($1.album) == .orderedAscending
                }
                return artistOrder == .orderedAscending
            }
    }

    private nonisolated static func computeArtists(from tracks: [Track]) -> [Artist] {
        let grouped = Dictionary(grouping: tracks) { track in
            normalizedLibraryValue(track.artist).lowercased()
        }
        return grouped.values
            .compactMap { tracks in
                guard let first = tracks.first else { return nil }
                let artist = normalizedLibraryValue(first.artist)
                guard !artist.isEmpty else { return nil }
                return Artist(
                    artist: artist,
                    trackCount: tracks.count,
                    albumCount: Set(tracks.map(albumTitle(for:))).count,
                    coverUrl: tracks.compactMap(\.artwork).first
                )
            }
            .sorted { lhs, rhs in
                if lhs.trackCount == rhs.trackCount {
                    return lhs.artist.localizedCaseInsensitiveCompare(rhs.artist) == .orderedAscending
                }
                return lhs.trackCount > rhs.trackCount
            }
    }

    // MARK: - Legacy migration

    private func migrateLegacyMMKVLikedIdsIfNeeded() -> Bool {
        let defaults = UserDefaults.standard
        let migratedKey = "legacy_mmkv_liked_track_ids_migrated"
        guard !defaults.bool(forKey: migratedKey) else { return false }
        defer { defaults.set(true, forKey: migratedKey) }

        guard let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return false
        }
        let legacyURL = documentsURL.appendingPathComponent("mmkv/musaic-library")
        guard let data = try? Data(contentsOf: legacyURL),
              let legacyIds = Self.extractLegacyLikedIds(from: data),
              !legacyIds.isEmpty else {
            return false
        }

        var changed = false
        for id in legacyIds {
            let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !likedTrackIds.contains(trimmed) else { continue }
            likedTrackIds.insert(trimmed)
            likedTrackOrder.append(trimmed)
            pendingLikedTrackIds.insert(trimmed)
            changed = true
        }
        return changed
    }

    private static func extractLegacyLikedIds(from data: Data) -> [String]? {
        let marker = Data("liked_track_ids".utf8)
        guard let markerRange = data.range(of: marker) else { return nil }
        let tail = data[markerRange.upperBound...]
        guard let jsonStart = tail.firstIndex(of: 91),
              let jsonEnd = data[jsonStart...].firstIndex(of: 93) else {
            return nil
        }
        let jsonData = Data(data[jsonStart...jsonEnd])
        return try? JSONDecoder().decode([String].self, from: jsonData)
    }
}
