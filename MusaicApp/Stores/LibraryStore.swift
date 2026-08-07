import Foundation

// MARK: - Library Store

private func normalizedLibraryValue(_ value: String?) -> String {
    value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func likedArtistName(for track: Track) -> String? {
    let artist = normalizedLibraryValue(track.artist)
    return artist.isEmpty ? nil : artist
}

private func likedAlbumTitle(for track: Track) -> String {
    let album = normalizedLibraryValue(track.album)
    if !album.isEmpty { return album }

    let title = normalizedLibraryValue(track.title)
    return title.isEmpty ? "Untitled Single" : title
}

@Observable
final class LibraryStore: @unchecked Sendable {
    static let shared = LibraryStore()

    private let likedIdsKey = "liked_track_ids"
    private let likedOrderKey = "liked_track_order"
    private let likedTracksKey = "liked_tracks"
    private let pendingUnlikedIdsKey = "pending_unliked_track_ids"
    private let legacyLikedIdsMigratedKey = "legacy_mmkv_liked_track_ids_migrated"
    private let api = APIService.shared
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let hydrationTTL: TimeInterval = 120

    private var hydrationTask: Task<[Track], Never>?
    private var hydrationTaskID: UUID?
    private var lastHydratedFingerprint: String?
    private var lastHydratedAt: Date?
    private var rebuildTask: Task<Void, Never>?

    var likedTrackIds: Set<String> = []
    /// Ordered list of liked track IDs — newest first (preserves insertion order)
    var likedTrackOrder: [String] = []
    var likedTracks: [Track] = []
    private var pendingUnlikedTrackIds = Set<String>()
    private(set) var displayedLikedTracks: [Track] = []
    private(set) var likedAlbums: [Album] = []
    private(set) var likedArtists: [Artist] = []

    private var syncedUserId: String?
    private var syncedFingerprint: String?

    private init() {
        loadLiked()
        Task { @MainActor in
            await hydrateLikedTracksIfNeeded()
        }
    }

    /// Call from view .task to ensure sync happens after login
    @MainActor
    func ensureSynced(force: Bool = false) async {
        guard SettingsStore.shared.isLoggedIn else {
            syncedUserId = nil
            syncedFingerprint = nil
            return
        }
        let currentUserId = SettingsStore.shared.authUserId ?? SettingsStore.shared.authToken ?? "authenticated"
        let currentFingerprint = hydrationFingerprint()
        guard force || syncedUserId != currentUserId || syncedFingerprint != currentFingerprint else { return }
        guard await syncLikesWithServer() else { return }
        syncedUserId = currentUserId
        syncedFingerprint = hydrationFingerprint()
        await hydrateLikedTracksIfNeeded(force: true)
    }

    // MARK: - Liked

    func isLiked(_ trackId: String) -> Bool {
        likedTrackIds.contains(trackId)
    }

    func toggleLike(track: Track) {
        let normalizedTrack = api.normalizedTrack(track)
        let action: String
        let isNowLiked: Bool

        if likedTrackIds.contains(normalizedTrack.id) {
            likedTrackIds.remove(normalizedTrack.id)
            likedTrackOrder.removeAll { $0 == normalizedTrack.id }
            likedTracks.removeAll { $0.id == normalizedTrack.id }
            pendingUnlikedTrackIds.insert(normalizedTrack.id)
            action = "unlike"
            isNowLiked = false
        } else {
            likedTrackIds.insert(normalizedTrack.id)
            pendingUnlikedTrackIds.remove(normalizedTrack.id)
            likedTrackOrder.insert(normalizedTrack.id, at: 0) // newest first
            if let existingIndex = likedTracks.firstIndex(where: { $0.id == normalizedTrack.id }) {
                likedTracks[existingIndex] = normalizedTrack
            } else {
                likedTracks.insert(normalizedTrack, at: 0)
            }
            action = "like"
            isNowLiked = true
        }
        normalizeLikedState()
        rebuildDerivedCollections()
        markHydrationDirty()
        markLikesSyncDirty()
        saveLiked()
        Task {
            let playbackContext = PlayerStore.shared.analyticsContext(for: normalizedTrack.id)
            await api.logPlay(
                trackId: normalizedTrack.id,
                action: action,
                eventId: UUID().uuidString,
                sessionId: playbackContext?.sessionId,
                requestId: playbackContext?.requestId,
                surface: playbackContext?.surface ?? "organic",
                isOrganic: playbackContext == nil,
                position: playbackContext?.position
            )
            do {
                try await api.setLikeOnServer(track: normalizedTrack, liked: isNowLiked)
                if !isNowLiked {
                    await MainActor.run {
                        self.pendingUnlikedTrackIds.remove(normalizedTrack.id)
                        self.saveLiked()
                    }
                }
            } catch {
                await MainActor.run {
                    self.markLikesSyncDirty()
                }
            }
        }
    }

    /// Sync liked tracks with server — merges local + server likes
    @MainActor
    @discardableResult
    func syncLikesWithServer() async -> Bool {
        guard SettingsStore.shared.isLoggedIn else { return false }
        do {
            let pendingRemovals = pendingUnlikedTrackIds
            // Upload local likes to server, get back merged set
            let serverIds = try await api.syncLikes(
                trackIds: Array(likedTrackIds),
                tracks: likedTracks,
                removedTrackIds: Array(pendingRemovals)
            )
            pendingUnlikedTrackIds.subtract(pendingRemovals)
            saveLiked()
            let merged = Set(serverIds)
            if merged != likedTrackIds {
                // Add server-only likes locally
                for id in merged where !likedTrackIds.contains(id) {
                    likedTrackIds.insert(id)
                }
                normalizeLikedState()
                rebuildDerivedCollections()
                saveLiked()
                markHydrationDirty()
                await hydrateLikedTracksIfNeeded(force: true)
            }
            return true
        } catch {
            print("[LibraryStore] Likes sync failed: \(error)")
            return false
        }
    }

    @MainActor
    func hydrateLikedTracksIfNeeded(force: Bool = false) async {
        likedTracks = likedTracks.map(api.normalizedTrack)
        normalizeLikedState()
        rebuildDerivedCollections()

        let fingerprint = hydrationFingerprint()
        guard shouldHydrate(force: force, fingerprint: fingerprint) else { return }

        if let hydrationTask {
            likedTracks = mergeHydratedTracks(await hydrationTask.value)
            normalizeLikedState()
            rebuildDerivedCollections()
            saveLiked()
            return
        }

        let orderedIDs = likedTrackOrder
        let cachedTracks = likedTracks
        let taskID = UUID()
        let task = Task<[Track], Never> { [api] in
            var mergedTracks = cachedTracks.map(api.normalizedTrack)

            if !orderedIDs.isEmpty {
                do {
                    let serverTracks = try await api.getTracks(ids: orderedIDs)
                    let restoredTracks = serverTracks.map(api.toAppTrack)
                    if !restoredTracks.isEmpty {
                        var tracksByID = Dictionary(uniqueKeysWithValues: mergedTracks.map { ($0.id, $0) })
                        for track in restoredTracks {
                            tracksByID[track.id] = track
                        }
                        mergedTracks = orderedIDs.compactMap { tracksByID[$0] }
                    }
                } catch {
                    // Keep the local cache even if the server-side refresh fails.
                }
            }

            return mergedTracks
        }

        hydrationTaskID = taskID
        hydrationTask = task

        likedTracks = mergeHydratedTracks(await task.value)
        if hydrationTaskID == taskID {
            hydrationTask = nil
            hydrationTaskID = nil
        }

        lastHydratedFingerprint = fingerprint
        lastHydratedAt = Date()
        normalizeLikedState()
        rebuildDerivedCollections()
        saveLiked()
    }

    // MARK: - Persistence

    private func loadLiked() {
        if let data = UserDefaults.standard.data(forKey: likedIdsKey),
           let ids = try? decoder.decode([String].self, from: data) {
            likedTrackIds = Set(ids)
        }
        if let data = UserDefaults.standard.data(forKey: likedOrderKey),
           let order = try? decoder.decode([String].self, from: data) {
            likedTrackOrder = order
        }
        // Migrate: if order is empty but ids exist, build order from tracks array
        if likedTrackOrder.isEmpty && !likedTrackIds.isEmpty {
            likedTrackOrder = Array(likedTrackIds)
        }
        if let data = UserDefaults.standard.data(forKey: likedTracksKey),
           let tracks = try? decoder.decode([Track].self, from: data) {
            likedTracks = tracks
        }
        if let data = UserDefaults.standard.data(forKey: pendingUnlikedIdsKey),
           let ids = try? decoder.decode([String].self, from: data) {
            pendingUnlikedTrackIds = Set(ids)
        }

        let migratedLegacyLikes = migrateLegacyMMKVLikedIdsIfNeeded()
        likedTracks = likedTracks.map(api.normalizedTrack)
        normalizeLikedState()
        rebuildDerivedCollections()
        if migratedLegacyLikes {
            markLikesSyncDirty()
            saveLiked()
        }
    }

    private func saveLiked() {
        if let data = try? encoder.encode(Array(likedTrackIds)) {
            UserDefaults.standard.set(data, forKey: likedIdsKey)
        }
        if let data = try? encoder.encode(likedTrackOrder) {
            UserDefaults.standard.set(data, forKey: likedOrderKey)
        }
        if let data = try? encoder.encode(likedTracks) {
            UserDefaults.standard.set(data, forKey: likedTracksKey)
        }
        if let data = try? encoder.encode(Array(pendingUnlikedTrackIds)) {
            UserDefaults.standard.set(data, forKey: pendingUnlikedIdsKey)
        }
    }

    private func normalizeLikedState() {
        // Keep order in sync with ids
        likedTrackOrder = likedTrackOrder.filter { likedTrackIds.contains($0) }
        // Add any ids missing from order (e.g. from server sync)
        for id in likedTrackIds where !likedTrackOrder.contains(id) {
            likedTrackOrder.append(id)
        }

        if likedTrackIds.isEmpty {
            likedTracks = []
            return
        }

        // Reorder likedTracks to match likedTrackOrder
        let trackById = Dictionary(likedTracks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        likedTracks = likedTrackOrder.compactMap { trackById[$0] }
    }

    private func rebuildDerivedCollections() {
        displayedLikedTracks = likedTracks

        // Debounce: cancel pending rebuild and schedule new one after 150ms
        rebuildTask?.cancel()
        let tracks = displayedLikedTracks
        rebuildTask = Task.detached(priority: .userInitiated) { [weak self] in
            let albums = Self.computeAlbums(from: tracks)
            let artists = Self.computeArtists(from: tracks)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.likedAlbums = albums
                self?.likedArtists = artists
            }
        }
    }

    private static func computeAlbums(from tracks: [Track]) -> [Album] {
        let grouped = Dictionary(grouping: tracks) { track in
            let artist = normalizedLibraryValue(track.artist)
            let album = {
                let a = normalizedLibraryValue(track.album)
                if !a.isEmpty { return a }
                let t = normalizedLibraryValue(track.title)
                return t.isEmpty ? "Untitled Single" : t
            }()
            return "\(track.source.rawValue)|\(artist.lowercased())|\(album.lowercased())"
        }
        return grouped.values
            .compactMap { tracks in
                guard let first = tracks.first else { return nil }
                let artist = normalizedLibraryValue(first.artist)
                guard !artist.isEmpty else { return nil }
                let album = {
                    let a = normalizedLibraryValue(first.album)
                    if !a.isEmpty { return a }
                    let t = normalizedLibraryValue(first.title)
                    return t.isEmpty ? "Untitled Single" : t
                }()
                return Album(
                    album: album,
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

    private static func computeArtists(from tracks: [Track]) -> [Artist] {
        let grouped = Dictionary(grouping: tracks) { track in
            normalizedLibraryValue(track.artist).lowercased()
        }
        return grouped.values
            .compactMap { tracks in
                guard let first = tracks.first else { return nil }
                let artist = normalizedLibraryValue(first.artist)
                guard !artist.isEmpty else { return nil }
                let albumCount = Set(tracks.map { track in
                    let a = normalizedLibraryValue(track.album)
                    if !a.isEmpty { return a }
                    let t = normalizedLibraryValue(track.title)
                    return t.isEmpty ? "Untitled Single" : t
                }).count
                return Artist(
                    artist: artist,
                    trackCount: tracks.count,
                    albumCount: albumCount,
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

    private func hydrationFingerprint() -> String {
        likedTrackIds.sorted().joined(separator: "|")
    }

    private func mergeHydratedTracks(_ hydratedTracks: [Track]) -> [Track] {
        var tracksByID = Dictionary(uniqueKeysWithValues: likedTracks.map { ($0.id, $0) })
        for track in hydratedTracks {
            tracksByID[track.id] = track
        }
        return likedTrackOrder.compactMap { tracksByID[$0] }
    }

    private func shouldHydrate(force: Bool, fingerprint: String) -> Bool {
        if force { return !likedTrackIds.isEmpty }
        if likedTrackIds.isEmpty { return false }
        if displayedLikedTracks.count != likedTrackIds.count { return true }
        if lastHydratedFingerprint != fingerprint { return true }
        guard let lastHydratedAt else { return true }
        return Date().timeIntervalSince(lastHydratedAt) > hydrationTTL
    }

    private func markHydrationDirty() {
        lastHydratedFingerprint = nil
        lastHydratedAt = nil
    }

    private func markLikesSyncDirty() {
        syncedFingerprint = nil
    }

    private func migrateLegacyMMKVLikedIdsIfNeeded() -> Bool {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: legacyLikedIdsMigratedKey) else { return false }
        defer { defaults.set(true, forKey: legacyLikedIdsMigratedKey) }

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
