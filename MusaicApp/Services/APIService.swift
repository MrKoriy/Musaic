import Foundation

// MARK: - API Service

@Observable
@MainActor
final class APIService {
    static let shared = APIService()

    static let defaultServer = "http://94-103-1-126.nip.io:3001"
    /// Interactive requests fail fast instead of spinning while offline.
    static let interactiveTimeout: TimeInterval = 15
    private static let maxRetries = 2
    private static let retryableStatusCodes: Set<Int> = [502, 503, 504]
    private static let retryableURLErrorCodes: Set<URLError.Code> = [
        .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
    ]

    private(set) var serverURL: String
    let urlCache: URLCache
    private let session: URLSession
    private let pingSession: URLSession
    private let inFlightGETRequests = InFlightRequests()

    init() {
        let cache = URLCache(memoryCapacity: 32 * 1024 * 1024, diskCapacity: 128 * 1024 * 1024, diskPath: "musaic-api-cache")
        self.urlCache = cache

        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = Self.interactiveTimeout
        // Upper bound for the few long-running calls (playlist import) that
        // raise their own per-request timeout.
        configuration.timeoutIntervalForResource = 330
        configuration.requestCachePolicy = .reloadRevalidatingCacheData
        configuration.urlCache = cache
        self.session = URLSession(configuration: configuration)

        let pingConfig = URLSessionConfiguration.ephemeral
        pingConfig.waitsForConnectivity = false
        pingConfig.timeoutIntervalForRequest = 5
        pingConfig.timeoutIntervalForResource = 8
        self.pingSession = URLSession(configuration: pingConfig)

        let storedServer = UserDefaults.standard.string(forKey: "server_url")
        let normalizedStoredServer = Self.normalizedServerURL(storedServer)
        self.serverURL = normalizedStoredServer ?? Self.defaultServer

        if let normalizedStoredServer, normalizedStoredServer != storedServer {
            UserDefaults.standard.set(normalizedStoredServer, forKey: "server_url")
        }
        APICredentials.shared.setServerURL(serverURL)
    }

    func setServerURL(_ url: String) {
        guard let normalized = Self.normalizedServerURL(url) else {
            resetServerURL()
            return
        }
        applyServerURL(normalized)
        UserDefaults.standard.set(normalized, forKey: "server_url")
    }

    func resetServerURL() {
        UserDefaults.standard.removeObject(forKey: "server_url")
        applyServerURL(Self.defaultServer)
    }

    private func applyServerURL(_ normalized: String) {
        guard normalized != serverURL else { return }
        serverURL = normalized
        APICredentials.shared.setServerURL(normalized)
        clearSessionCaches()
    }

    /// Normalized server address, or nil when the input can't be a server URL.
    static func validatedServerURL(_ raw: String) -> String? {
        normalizedServerURL(raw)
    }

    var usesInsecurePublicHTTP: Bool {
        guard let url = URL(string: serverURL), url.scheme == "http", let host = url.host else { return false }
        return host != "localhost" && host != "127.0.0.1" && host != "::1"
    }

    /// Drops per-account in-memory and HTTP caches (logout, server switch).
    func clearSessionCaches() {
        playlistTracksCache.removeAll()
        urlCache.removeAllCachedResponses()
    }

    // MARK: - HTTP Methods

    func authenticatedRequest(for url: URL, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if url.path.hasPrefix("/api/stream/") || url.path.hasPrefix("/api/downloads/") ||
            url.path.hasPrefix("/api/yandex/") || url.path.hasPrefix("/api/vk/") {
            request.cachePolicy = .reloadIgnoringLocalCacheData
        }
        if let token = APICredentials.shared.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func makeURL(_ path: String) throws -> URL {
        guard let url = URL(string: "\(serverURL)\(path)") else {
            throw APIError.invalidURL(endpoint: path)
        }
        return url
    }

    func get<T: Decodable & SendableMetatype>(_ path: String) async throws -> T {
        let url = try makeURL(path)
        let request = authenticatedRequest(for: url)
        let data = try await inFlightGETRequests.value(for: getRequestKey(for: path)) { [self] in
            try await self.requestData(path, request: request)
        }
        return try await Self.decode(data)
    }

    private func getRequestKey(for path: String) -> String {
        // Never join requests across server or account changes, without
        // keeping the bearer token itself in the deduplication table.
        var hasher = Hasher()
        hasher.combine(serverURL)
        hasher.combine(APICredentials.shared.token ?? "")
        hasher.combine(path)
        return String(hasher.finalize())
    }

    /// Generic POST for ad-hoc client calls. Prefer `postJSON` for Sendable
    /// bodies so encoding happens off the main actor.
    func post<T: Decodable & SendableMetatype>(_ path: String, body: Encodable) async throws -> T {
        let url = try makeURL(path)
        var request = authenticatedRequest(for: url, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let data = try await requestData(path, request: request)
        return try await Self.decode(data)
    }

    func postJSON<B: Encodable & Sendable, T: Decodable & SendableMetatype>(_ path: String, body: B, timeout: TimeInterval? = nil) async throws -> T {
        try await sendJSON(method: "POST", path, body: body, timeout: timeout)
    }

    private func patchJSON<B: Encodable & Sendable, T: Decodable & SendableMetatype>(_ path: String, body: B) async throws -> T {
        try await sendJSON(method: "PATCH", path, body: body, timeout: nil)
    }

    private func delete<T: Decodable & SendableMetatype>(_ path: String) async throws -> T {
        let url = try makeURL(path)
        let request = authenticatedRequest(for: url, method: "DELETE")
        let data = try await requestData(path, request: request)
        return try await Self.decode(data)
    }

    private func sendJSON<B: Encodable & Sendable, T: Decodable & SendableMetatype>(
        method: String,
        _ path: String,
        body: B,
        timeout: TimeInterval?
    ) async throws -> T {
        let url = try makeURL(path)
        var request = authenticatedRequest(for: url, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let timeout { request.timeoutInterval = timeout }
        request.httpBody = try await Self.encode(body)
        let data = try await requestData(path, request: request)
        return try await Self.decode(data)
    }

    // Nonisolated async functions run on the global executor, keeping large
    // library/playlist payloads off the main thread.
    nonisolated private static func decode<T: Decodable & SendableMetatype>(_ data: Data) async throws -> sending T {
        try JSONDecoder().decode(T.self, from: data)
    }

    nonisolated private static func encode<B: Encodable & Sendable>(_ body: B) async throws -> Data {
        try JSONEncoder().encode(body)
    }

    private func requestData(_ path: String, request: URLRequest) async throws -> Data {
        let (data, response) = try await send(request, endpoint: path)
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 {
                // An expired session must not erase the local library. Keep the
                // token and cached likes until the user explicitly logs out.
                SettingsStore.shared.markSessionExpired()
            }
            throw httpError(for: response, data: data, endpoint: path)
        }
        return data
    }

    /// Sends a request. Only idempotent requests are retried, and only on
    /// transient failures, with a short exponential backoff.
    private func send(_ request: URLRequest, endpoint: String) async throws -> (data: Data, response: HTTPURLResponse) {
        let method = request.httpMethod ?? "GET"
        let retryAllowed = method == "GET" || method == "HEAD"
        var attempt = 0

        while true {
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse(endpoint: endpoint)
                }
                if retryAllowed, attempt < Self.maxRetries, Self.retryableStatusCodes.contains(http.statusCode) {
                    attempt += 1
                    try await Self.backoff(attempt: attempt)
                    continue
                }
                return (data, http)
            } catch {
                if error.isCancellation || Task.isCancelled { throw CancellationError() }
                if let apiError = error as? APIError { throw apiError }
                guard let urlError = error as? URLError else { throw error }
                if retryAllowed, attempt < Self.maxRetries, Self.retryableURLErrorCodes.contains(urlError.code) {
                    attempt += 1
                    try await Self.backoff(attempt: attempt)
                    continue
                }
                #if DEBUG
                print("[APIService] network code=\(urlError.code.rawValue) host=\(request.url?.host ?? "?") endpoint=\(endpoint)")
                #endif
                throw APIError.network(code: urlError.code, endpoint: endpoint)
            }
        }
    }

    private static func backoff(attempt: Int) async throws {
        let base = 0.4 * pow(3, Double(attempt - 1))
        try await Task.sleep(for: .seconds(base + Double.random(in: 0...0.2)))
    }

    private func httpError(for response: HTTPURLResponse, data: Data, endpoint: String) -> APIError {
        if response.statusCode == 401 {
            return .unauthorized(endpoint: endpoint)
        }

        let message: String?
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            message = (object["error"] as? String ?? object["message"] as? String)?.prefix(200).description
        } else {
            message = nil
        }
        return .httpStatus(statusCode: response.statusCode, endpoint: endpoint, message: message)
    }

    // MARK: - Auth

    struct AuthResponse: Codable {
        let ok: Bool?
        let user: AuthUser?
        let token: String?
        let error: String?
    }

    struct AuthUser: Codable {
        let id: String
        let username: String
        let displayName: String
    }

    /// Auth requests parse JSON body even on 4xx errors (e.g. 409 "Username taken")
    private func authPost<B: Encodable & Sendable>(_ path: String, body: B) async throws -> AuthResponse {
        let url = try makeURL(path)
        var request = authenticatedRequest(for: url, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try await Self.encode(body)
        let (data, response) = try await send(request, endpoint: path)
        if let authResponse = try? JSONDecoder().decode(AuthResponse.self, from: data) {
            // Preserve server-provided validation messages while still surfacing
            // unexpected non-JSON error statuses to callers.
            if !(200..<300).contains(response.statusCode), authResponse.error == nil {
                throw httpError(for: response, data: data, endpoint: path)
            }
            return authResponse
        }
        throw httpError(for: response, data: data, endpoint: path)
    }

    func register(username: String, password: String, displayName: String?) async throws -> AuthResponse {
        struct Body: Codable, Sendable { let username: String; let password: String; let displayName: String? }
        return try await authPost("/api/auth/register", body: Body(username: username, password: password, displayName: displayName))
    }

    func login(username: String, password: String) async throws -> AuthResponse {
        struct Body: Codable, Sendable { let username: String; let password: String }
        return try await authPost("/api/auth/login", body: Body(username: username, password: password))
    }

    func logout() async {
        // Best-effort: local credentials are removed even if the server is offline.
        let _: OkResponse? = try? await postJSON("/api/auth/logout", body: EmptyBody(), timeout: 5)
        SettingsStore.shared.logout()
    }

    // MARK: - Health

    enum ConnectionCheck: Equatable {
        case ok
        case invalidAddress
        case httpStatus(Int)
        case unreachable(String)

        var message: String {
            switch self {
            case .ok: return String(localized: "Server is reachable.")
            case .invalidAddress: return String(localized: "Enter a valid server address, e.g. 192.168.1.10:3001.")
            case .httpStatus(let code): return String(localized: "The server answered with HTTP \(code).")
            case .unreachable(let reason): return reason
            }
        }
    }

    /// GET /health on `server` (default: the saved server) without saving it.
    func checkConnection(to server: String? = nil) async -> ConnectionCheck {
        let base = server.map(Self.normalizedServerURL) ?? serverURL
        guard let base, let url = URL(string: "\(base)/health") else { return .invalidAddress }
        do {
            let (_, response) = try await pingSession.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return status == 200 ? .ok : .httpStatus(status)
        } catch {
            if error.isCancellation { return .unreachable(String(localized: "Cancelled.")) }
            return .unreachable(error.localizedDescription)
        }
    }

    func ping() async -> Bool {
        await checkConnection() == .ok
    }

    // MARK: - Tracks

    func searchTracks(query: String, sources: String = SettingsStore.shared.enabledSourcesParam, limit: Int = 30, offset: Int = 0) async throws -> (tracks: [ServerTrack], hasMore: Bool) {
        let q = encodedQueryValue(query)
        let response: SearchResponse = try await get("/api/search?q=\(q)&sources=\(sources)&limit=\(limit)&offset=\(offset)")
        return (response.tracks, response.hasMore ?? (response.tracks.count >= limit))
    }

    func searchWithPlaylists(query: String, sources: String = SettingsStore.shared.enabledSourcesParam, limit: Int = 30, offset: Int = 0) async throws -> (tracks: [ServerTrack], playlists: [ExternalPlaylist], artists: [SearchArtist], hasMore: Bool, errors: [String: String]) {
        let q = encodedQueryValue(query)
        let response: SearchResponse = try await get("/api/search?q=\(q)&sources=\(sources)&limit=\(limit)&offset=\(offset)")
        return (response.tracks, response.playlists ?? [], response.artists ?? [], response.hasMore ?? (response.tracks.count >= limit), response.errors ?? [:])
    }

    func getExternalPlaylistTracks(playlistId: String) async throws -> [ServerTrack] {
        let encoded = playlistId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? playlistId
        let response: TracksResponse = try await get("/api/search/playlist/\(encoded)/tracks")
        return response.tracks
    }

    func getTracks(source: String? = nil, limit: Int = 30) async throws -> [ServerTrack] {
        var path = "/api/tracks?limit=\(limit)"
        if let source { path += "&source=\(source)" }
        let response: TracksResponse = try await get(path)
        return response.tracks
    }

    func getTracks(ids: [String]) async throws -> [ServerTrack] {
        let uniqueIDs = Array(Set(ids)).sorted()
        guard !uniqueIDs.isEmpty else { return [] }

        // The server caps /api/tracks/by-ids at 500 ids per request. Fetch in
        // chunks so large libraries (e.g. imported Yandex likes) hydrate fully.
        var collected: [ServerTrack] = []
        for batchStart in stride(from: 0, to: uniqueIDs.count, by: 400) {
            let batch = uniqueIDs[batchStart..<min(batchStart + 400, uniqueIDs.count)]
            let encodedIDs = batch.map {
                $0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0
            }.joined(separator: ",")

            let response: TracksResponse = try await get("/api/tracks/by-ids?ids=\(encodedIDs)")
            collected.append(contentsOf: response.tracks)
        }
        return collected
    }

    // MARK: - Recommendations

    /// One seed per track ID (duplicates in the queue must not crash or skew the seed list).
    private func uniqueSeedBodies(_ seeds: [Track]) -> [MyVibeSeedBody] {
        var seen = Set<String>()
        return seeds.compactMap { seen.insert($0.id).inserted ? MyVibeSeedBody(track: $0) : nil }
    }

    func getHomeRecommendations() async throws -> RecoResponse {
        try await get("/api/recommendations/home")
    }

    func getDailyMix(refresh: Bool = false) async throws -> DailyMixResponse {
        let timeZone = encodedQueryValue(TimeZone.current.identifier)
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        let localDate = formatter.string(from: Date())
        let path = "/api/recommendations/daily-mix?timezone=\(timeZone)&localDate=\(localDate)\(refresh ? "&refresh=1" : "")"
        return try await get(path)
    }

    func getMoodTracks(mood: String, limit: Int = 20) async throws -> MoodResponse {
        let m = mood.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? mood
        return try await get("/api/recommendations/mood?mood=\(m)&limit=\(limit)")
    }

    func getMyVibeTracks(
        seeds: [Track],
        excludeIds: [String] = [],
        filters: MyVibeFilters = .default,
        limit: Int = 24,
        sessionId: String? = nil,
        recentOutcomes: [StationOutcomeBody] = [],
        queueTail: [Track] = [],
        skipStreak: Int = 0,
        reactionRefresh: Bool = false
    ) async throws -> RecoResponse {
        let uniqueSeeds = uniqueSeedBodies(seeds)
        let body = MyVibeRequestBody(
            seeds: uniqueSeeds,
            excludeIds: Array(Set(excludeIds)),
            limit: limit,
            filters: MyVibeFiltersBody(filters: filters),
            sessionId: sessionId,
            recentOutcomes: Array(recentOutcomes.suffix(20)),
            queueTail: Array(queueTail.suffix(12)).map(MyVibeSeedBody.init),
            skipStreak: min(max(skipStreak, 0), 20),
            reactionRefresh: reactionRefresh,
            enabledSources: SettingsStore.shared.enabledRecommendationSources
        )
        return try await postJSON("/api/recommendations/my-vibe", body: body)
    }

    func getAutoMixTracks(
        seeds: [Track],
        excludeIds: [String] = [],
        limit: Int = 20,
        sessionId: String? = nil,
        recentOutcomes: [StationOutcomeBody] = [],
        queueTail: [Track] = [],
        skipStreak: Int = 0,
        reactionRefresh: Bool = false
    ) async throws -> RecoResponse {
        let uniqueSeeds = uniqueSeedBodies(seeds)
        let body = AutoMixRequestBody(
            seeds: uniqueSeeds,
            excludeIds: Array(Set(excludeIds)),
            limit: limit,
            sessionId: sessionId,
            recentOutcomes: Array(recentOutcomes.suffix(20)),
            queueTail: Array(queueTail.suffix(12)).map(MyVibeSeedBody.init),
            skipStreak: min(max(skipStreak, 0), 20),
            reactionRefresh: reactionRefresh,
            enabledSources: SettingsStore.shared.enabledRecommendationSources
        )
        return try await postJSON("/api/recommendations/auto-mix", body: body)
    }

    // MARK: - Library

    func getAlbums(source: String? = nil) async throws -> [Album] {
        let q = source.map { "?source=\(encodedQueryValue($0))" } ?? ""
        let response: AlbumsResponse = try await get("/api/albums\(q)")
        return response.albums
    }

    func getArtists(source: String? = nil) async throws -> [Artist] {
        let q = source.map { "?source=\(encodedQueryValue($0))" } ?? ""
        let response: ArtistsResponse = try await get("/api/artists\(q)")
        return response.artists
    }

    func getAlbumTracks(album: String, artist: String? = nil, source: String? = nil) async throws -> [ServerTrack] {
        var q = "album=\(encodedQueryValue(album))"
        if let artist { q += "&artist=\(encodedQueryValue(artist))" }
        if let source { q += "&source=\(encodedQueryValue(source))" }
        let response: TracksResponse = try await get("/api/albums/tracks?\(q)")
        return response.tracks
    }

    func getArtistTracks(artist: String, source: String? = nil) async throws -> [ServerTrack] {
        var q = "artist=\(encodedQueryValue(artist))"
        if let source { q += "&source=\(encodedQueryValue(source))" }
        let response: TracksResponse = try await get("/api/artists/tracks?\(q)")
        return response.tracks
    }

    func getArtistProfile(artist: SearchArtist, sources: String = SettingsStore.shared.enabledSourcesParam, limit: Int = 100) async throws -> ArtistProfileResponse {
        var params = [
            "artist=\(encodedQueryValue(artist.artist))",
            "sources=\(encodedQueryValue(sources))",
            "source=\(encodedQueryValue(artist.source))",
            "limit=\(limit)",
        ]
        if let sourceId = artist.sourceId, !sourceId.isEmpty {
            params.append("sourceId=\(encodedQueryValue(sourceId))")
        }
        return try await get("/api/artists/profile?\(params.joined(separator: "&"))")
    }

    /// Library variant — fetch profile by artist name only.
    /// Used by `ArtistDetailView` to enrich the library Artist (which lacks a
    /// `source_id` or external `source`) with real popular tracks + albums
    /// from VK/SoundCloud instead of only the user's liked subset.
    func getArtistProfile(artistName: String, sources: String = SettingsStore.shared.enabledSourcesParam, limit: Int = 100) async throws -> ArtistProfileResponse {
        let params = [
            "artist=\(encodedQueryValue(artistName))",
            "sources=\(encodedQueryValue(sources))",
            "limit=\(limit)",
        ]
        return try await get("/api/artists/profile?\(params.joined(separator: "&"))")
    }

    // MARK: - Playlists

    func getPlaylists() async throws -> [ServerPlaylist] {
        let response: PlaylistsResponse = try await get("/api/playlists")
        return response.playlists
    }

    func getPlaylist(id: String) async throws -> ServerPlaylist {
        let response: PlaylistResponse = try await get("/api/playlists/\(id)")
        return response.playlist
    }

    func createPlaylist(name: String, description: String? = nil) async throws -> String {
        let body = CreatePlaylistBody(name: name, description: description)
        let response: CreatePlaylistResponse = try await postJSON("/api/playlists", body: body)
        return response.id
    }

    func deletePlaylist(id: String) async throws {
        let _: OkResponse = try await delete("/api/playlists/\(id)")
    }

    func getPlaylistTracks(playlistId: String) async throws -> [ServerTrack] {
        let response: TracksResponse = try await get("/api/playlists/\(playlistId)/tracks")
        return response.tracks
    }

    // MARK: - Playlist tracks cache
    //
    // Reopening a playlist shows its tracks instantly (stale-while-revalidate):
    // cached rows render first, then the fresh response replaces them. Server
    // ETag + URLCache keep the revalidation round-trip tiny (304).

    @ObservationIgnored private var playlistTracksCache: [String: (tracks: [ServerTrack], fetchedAt: Date)] = [:]
    private static let playlistCacheTTL: TimeInterval = 60
    private static let playlistCacheMaxEntries = 16

    func cachedPlaylistTracks(playlistId: String) -> [ServerTrack]? {
        guard let entry = playlistTracksCache[playlistId] else { return nil }
        return Date().timeIntervalSince(entry.fetchedAt) < Self.playlistCacheTTL ? entry.tracks : nil
    }

    func storePlaylistTracks(_ tracks: [ServerTrack], playlistId: String) {
        playlistTracksCache[playlistId] = (tracks, Date())
        if playlistTracksCache.count > Self.playlistCacheMaxEntries {
            let oldest = playlistTracksCache.min { $0.value.fetchedAt < $1.value.fetchedAt }?.key
            if let oldest { playlistTracksCache.removeValue(forKey: oldest) }
        }
    }

    func invalidatePlaylistTracksCache(playlistId: String) {
        playlistTracksCache.removeValue(forKey: playlistId)
    }

    /// `position` pins the slot explicitly so concurrent batch adds keep order.
    func addToPlaylist(playlistId: String, trackId: String, position: Int? = nil) async throws {
        let body = AddTrackBody(trackId: trackId, position: position)
        let _: OkResponse = try await postJSON("/api/playlists/\(playlistId)/tracks", body: body)
        invalidatePlaylistTracksCache(playlistId: playlistId)
    }

    func removeFromPlaylist(playlistId: String, trackId: String) async throws {
        let _: OkResponse = try await delete("/api/playlists/\(playlistId)/tracks/\(encodedTrackID(trackId))")
        invalidatePlaylistTracksCache(playlistId: playlistId)
    }

    func updatePlaylist(id: String, name: String? = nil, description: String? = nil) async throws {
        let body = UpdatePlaylistBody(name: name, description: description)
        let _: OkResponse = try await patchJSON("/api/playlists/\(id)", body: body)
        invalidatePlaylistTracksCache(playlistId: id)
    }

    /// Downsamples and re-encodes the picked image off the main actor before
    /// upload (the server caps covers at 4 MB).
    func uploadPlaylistCover(playlistId: String, data: Data, mimeType: String) async throws -> String? {
        let base64 = await Task.detached(priority: .userInitiated) {
            ImageDownsampler.jpegData(from: data, maxPixelSize: 1024)?.base64EncodedString()
        }.value
        guard let base64 else { throw APIError.unsupportedImage }
        let body = UploadPlaylistCoverBody(imageBase64: base64, mimeType: "image/jpeg")
        let response: PlaylistCoverUploadResponse = try await postJSON("/api/playlists/\(playlistId)/image", body: body)
        invalidatePlaylistTracksCache(playlistId: playlistId)
        return response.coverUrl
    }

    func deletePlaylistCover(playlistId: String) async throws {
        let _: OkResponse = try await delete("/api/playlists/\(playlistId)/image")
        invalidatePlaylistTracksCache(playlistId: playlistId)
    }

    // MARK: - Playlist import

    /// Matching a large external playlist can take minutes server-side.
    func importPlaylist(url: String) async throws -> ImportResult {
        struct Body: Encodable, Sendable { let url: String }
        return try await postJSON("/api/import/playlist", body: Body(url: url), timeout: 300)
    }

    func saveImportedPlaylist(name: String, trackIds: [String]) async throws -> SaveResponse {
        struct Body: Encodable, Sendable { let name: String; let trackIds: [String] }
        return try await postJSON("/api/import/save", body: Body(name: name, trackIds: trackIds))
    }

    // MARK: - VK Auth

    func vkMe() async throws -> VKMeResponse {
        return try await get("/api/vk/me")
    }

    func vkOAuthURL() async throws -> VKOAuthURLResponse {
        try await get("/api/vk/oauth-url")
    }

    func vkSetToken(token: String, username: String?, state: String? = nil) async throws {
        let body = VKTokenBody(token: token, username: username, state: state)
        let _: OkResponse = try await postJSON("/api/vk/auth-token", body: body)
    }

    func vkLogout() async throws {
        let _: OkResponse = try await postJSON("/api/vk/logout", body: EmptyBody())
    }

    func vkPlaylists() async throws -> [VKPlaylist] {
        let response: VKPlaylistsResponse = try await get("/api/vk/playlists")
        return response.playlists
    }

    // MARK: - Yandex Auth

    func yandexStatus() async throws -> YandexStatusResponse {
        try await get("/api/yandex/me")
    }

    /// Connect Yandex with an account OAuth token. Server validates it and
    /// reports the login + whether Plus is active (needed for full tracks).
    func yandexConnect(token: String) async throws -> YandexConnectResponse {
        try await postJSON("/api/yandex/token", body: YandexTokenBody(token: token))
    }

    func yandexLogout() async throws {
        let _: OkResponse = try await postJSON("/api/yandex/logout", body: EmptyBody())
    }

    /// Begin Yandex OAuth device flow → returns a short code to enter at ya.ru/device.
    func yandexDeviceStart() async throws -> YandexDeviceStartResponse {
        try await postJSON("/api/yandex/device/start", body: EmptyBody())
    }

    /// Read device-flow status. The server captures the token in the background,
    /// so this works even after the app backgrounded to authorize in a browser.
    func yandexDeviceStatus() async throws -> YandexDeviceStatusResponse {
        try await get("/api/yandex/device/status")
    }

    // MARK: - Stats

    func logPlay(
        trackId: String,
        action: String = "play",
        eventId: String? = nil,
        playedMs: Int? = nil,
        durationMs: Int? = nil,
        sessionId: String? = nil,
        requestId: String? = nil,
        surface: String? = nil,
        isOrganic: Bool? = nil,
        position: Int? = nil
    ) async {
        let ratio: Double?
        if let playedMs, let durationMs, durationMs > 0 {
            ratio = min(2, Double(playedMs) / Double(durationMs))
        } else {
            ratio = nil
        }
        let body = LogPlayBody(
            trackId: trackId,
            action: action,
            eventId: eventId,
            playedMs: playedMs,
            durationMs: durationMs,
            playedRatio: ratio,
            sessionId: sessionId,
            requestId: requestId,
            surface: surface,
            isOrganic: isOrganic,
            position: position
        )
        let _: OkResponse? = try? await postJSON("/api/history", body: body)
    }

    // MARK: - Likes Sync

    func syncLikes(
        trackIds: [String],
        tracks: [Track] = [],
        removedTrackIds: [String] = []
    ) async throws -> [String] {
        struct Body: Encodable, Sendable {
            let trackIds: [String]
            let tracks: [LikeTrackBody]
            let removedTrackIds: [String]
        }
        struct Resp: Codable { let trackIds: [String] }
        let resp: Resp = try await postJSON(
            "/api/auth/likes/sync",
            body: Body(
                trackIds: trackIds,
                tracks: tracks.map(LikeTrackBody.init),
                removedTrackIds: removedTrackIds
            )
        )
        return resp.trackIds
    }

    func toggleLikeOnServer(trackId: String) async throws {
        struct Body: Codable, Sendable { let trackId: String }
        struct Resp: Codable { let liked: Bool }
        let _: Resp = try await postJSON("/api/auth/likes/toggle", body: Body(trackId: trackId))
    }

    func setLikeOnServer(track: Track, liked: Bool) async throws {
        struct Body: Encodable, Sendable { let trackId: String; let liked: Bool; let track: LikeTrackBody }
        struct Resp: Codable { let liked: Bool }
        let normalized = normalizedTrack(track)
        let _: Resp = try await postJSON(
            "/api/auth/likes/set",
            body: Body(trackId: normalized.id, liked: liked, track: LikeTrackBody(track: normalized))
        )
    }

    func getServerLikes() async throws -> [String] {
        struct Resp: Codable { let trackIds: [String] }
        let resp: Resp = try await get("/api/auth/likes")
        return resp.trackIds
    }

    func importYandexLikes() async throws -> YandexLikesImportResponse {
        try await postJSON("/api/yandex/likes/import", body: EmptyBody())
    }

    func getStatsOverview() async throws -> StatsOverview {
        return try await get("/api/stats/overview")
    }

    func getTopTracks(period: String = "month", limit: Int = 5) async throws -> [StatsTopTrack] {
        struct Resp: Codable { let tracks: [StatsTopTrack] }
        let resp: Resp = try await get("/api/stats/top-tracks?period=\(period)&limit=\(limit)")
        return resp.tracks
    }

    func getTopArtists(period: String = "month", limit: Int = 5) async throws -> [StatsTopArtist] {
        struct Resp: Codable { let artists: [StatsTopArtist] }
        let resp: Resp = try await get("/api/stats/top-artists?period=\(period)&limit=\(limit)")
        return resp.artists
    }

    // MARK: - Lyrics

    func getLyrics(trackId: String, artist: String? = nil, title: String? = nil) async throws -> LyricsResponse {
        var path = "/api/lyrics/\(encodedTrackID(trackId))"
        var params: [String] = []
        if let artist { params.append("artist=\(artist.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? artist)") }
        if let title { params.append("title=\(title.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? title)") }
        if !params.isEmpty { path += "?\(params.joined(separator: "&"))" }
        return try await get(path)
    }

    func generateLyrics(trackId: String) async throws -> LyricsJobResponse {
        let body = EmptyBody()
        return try await postJSON("/api/lyrics/\(encodedTrackID(trackId))/generate", body: body)
    }

    func getLyricsJobStatus(trackId: String) async throws -> LyricsJobResponse {
        return try await get("/api/lyrics/\(encodedTrackID(trackId))/status")
    }

    func deleteLyrics(trackId: String) async throws {
        let _: OkResponse = try await delete("/api/lyrics/\(encodedTrackID(trackId))")
    }

    // MARK: - New Releases (push notifications)

    struct Release: Decodable {
        let id: String
        let artist: String
        let title: String
        let year: Int?
        let coverUrl: String?
        let trackCount: Int?
        let firstSeenAt: Int
        let notifiedAt: Int?
    }

    struct ReleasesResponse: Decodable {
        let releases: [Release]
    }

    struct AckResponse: Decodable {
        let acked: Int
    }

    func getNewReleases(limit: Int = 50) async throws -> [Release] {
        let response: ReleasesResponse = try await get("/api/releases/new?limit=\(limit)")
        return response.releases
    }

    func ackReleases(ids: [String]) async throws {
        guard !(ids.isEmpty) else { return }
        let _: AckResponse = try await postJSON("/api/releases/ack", body: ["ids": ids])
    }

    private static func normalizedServerURL(_ raw: String?) -> String? {
        guard var normalized = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !normalized.isEmpty else {
            return nil
        }

        if !normalized.hasPrefix("http://") && !normalized.hasPrefix("https://") {
            // A scheme-less server setting is the legacy/local HTTP form.
            // HTTPS remains available when the user enters it explicitly for other hosts.
            normalized = "http://\(normalized)"
        }

        guard var components = URLComponents(string: normalized) else {
            return nil
        }

        let host = components.host ?? ""
        let isIPHost = host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
        let shouldUseDevPort = components.port == nil && components.scheme == "http" && (host == "localhost" || host == "127.0.0.1" || isIPHost)
        if shouldUseDevPort {
            components.port = 3001
        }

        // Keep the live HTTP deployment reachable from iOS: ATS accepts the
        // nip.io hostname, while direct IP HTTP is rejected on some iOS builds.
        // Installs that stored the retired server are moved onto the live one;
        // it has no TLS yet, so the scheme is forced back to http.
        let legacyHosts: Set<String> = ["45.146.167.109", "45-146-167-109.nip.io"]
        if let currentHost = components.host, legacyHosts.contains(currentHost), components.port == 3001 {
            // The old deployment is gone: heal stored settings onto the live server.
            components.scheme = "http"
            components.host = "94-103-1-126.nip.io"
        }

        if components.path == "/" {
            components.path = ""
        }

        return components.string
    }

    private func encodedTrackID(_ trackId: String) -> String {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        return trackId.addingPercentEncoding(withAllowedCharacters: allowed) ?? trackId
    }

    private func encodedQueryValue(_ value: String) -> String {
        let reserved = CharacterSet(charactersIn: ":#[]@!$&'()*+,;=")
        let allowed = CharacterSet.urlQueryAllowed.subtracting(reserved)
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    // MARK: - URL Helpers

    func streamURL(forTrackID trackID: String, source: Track.TrackSource) -> String {
        // Quality is a non-sensitive playback preference. Provider URLs and
        // credentials stay server-side; authentication is supplied out-of-band.
        let quality = encodedQueryValue(SettingsStore.shared.streamQuality)
        return "\(streamEndpointURL(forTrackID: trackID, source: source))?quality=\(quality)"
    }

    /// URL used by offline downloads. It deliberately has no query string so
    /// credentials can only be sent in the Authorization header.
    func downloadStreamURL(forTrackID trackID: String, source: Track.TrackSource) -> String {
        streamEndpointURL(forTrackID: trackID, source: source)
    }

    func compressedDownloadURL(forTrackID trackID: String, bitrate: Int = 128) -> String {
        let safeBitrate = min(256, max(64, bitrate))
        return "\(serverURL)/api/downloads/compressed/\(encodedTrackID(trackID))?bitrate=\(safeBitrate)"
    }

    func streamURL(for track: ServerTrack) -> String {
        streamURL(forTrackID: track.id, source: track.source)
    }

    func artworkURL(for coverUrl: String?) -> String? {
        guard let coverUrl else { return nil }
        // Never re-wrap a URL that already goes through the server artwork
        // proxy (recursive wrapping made these URLs grow without bound).
        if coverUrl.contains("/api/artwork") || coverUrl.hasPrefix(serverURL) {
            return coverUrl.hasPrefix("http") ? coverUrl : "\(serverURL)\(coverUrl)"
        }
        if coverUrl.hasPrefix("http://") || coverUrl.hasPrefix("https://") {
            var components = URLComponents(string: "\(serverURL)/api/artwork")
            components?.queryItems = [URLQueryItem(name: "url", value: coverUrl)]
            return components?.url?.absoluteString
        }
        return "\(serverURL)\(coverUrl)"
    }

    func normalizedTrack(_ track: Track) -> Track {
        var normalized = track
        normalized.url = streamURL(forTrackID: track.id, source: track.source)
        normalized.artwork = artworkURL(for: track.artwork)
        return normalized
    }

    func toAppTrack(_ st: ServerTrack) -> Track {
        normalizedTrack(Track(
            id: st.id,
            title: st.title,
            artist: st.artist,
            album: st.album,
            canonicalFamilyId: st.canonicalFamilyId,
            artwork: st.coverUrl,
            url: streamURL(for: st),
            duration: st.duration,
            source: st.source
        ))
    }

    private func streamEndpointURL(forTrackID trackID: String, source: Track.TrackSource) -> String {
        "\(serverURL)/api/stream/\(source.rawValue)/\(encodedTrackID(trackID))"
    }
}

/// Joins concurrent identical GETs. Every caller can cancel on its own; the
/// shared request is cancelled only once no caller is waiting for it.
private actor InFlightRequests {
    private struct Entry {
        let id: UInt64
        let task: Task<Void, Never>
        var waiters: [UInt64: CheckedContinuation<Data, Error>]
    }

    private var entries: [String: Entry] = [:]
    private var nextID: UInt64 = 0

    func value(
        for key: String,
        operation: @escaping @MainActor @Sendable () async throws -> Data
    ) async throws -> Data {
        nextID &+= 1
        let waiterID = nextID
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                register(continuation, waiterID: waiterID, key: key, operation: operation)
            }
        } onCancel: {
            Task { await self.cancelWaiter(waiterID, key: key) }
        }
    }

    private func register(
        _ continuation: CheckedContinuation<Data, Error>,
        waiterID: UInt64,
        key: String,
        operation: @escaping @MainActor @Sendable () async throws -> Data
    ) {
        if Task.isCancelled {
            continuation.resume(throwing: CancellationError())
            return
        }
        if var entry = entries[key] {
            entry.waiters[waiterID] = continuation
            entries[key] = entry
            return
        }
        nextID &+= 1
        let entryID = nextID
        let task = Task.detached(priority: Task.currentPriority) {
            let result: Result<Data, Error>
            do {
                result = .success(try await operation())
            } catch {
                result = .failure(error)
            }
            await self.finish(entryID: entryID, key: key, result: result)
        }
        entries[key] = Entry(id: entryID, task: task, waiters: [waiterID: continuation])
    }

    private func finish(entryID: UInt64, key: String, result: Result<Data, Error>) {
        guard let entry = entries[key], entry.id == entryID else { return }
        entries[key] = nil
        for continuation in entry.waiters.values {
            continuation.resume(with: result)
        }
    }

    private func cancelWaiter(_ waiterID: UInt64, key: String) {
        guard var entry = entries[key],
              let continuation = entry.waiters.removeValue(forKey: waiterID) else { return }
        continuation.resume(throwing: CancellationError())
        if entry.waiters.isEmpty {
            entry.task.cancel()
            entries[key] = nil
        } else {
            entries[key] = entry
        }
    }
}

// MARK: - Response Types

struct SearchResponse: Codable {
    let tracks: [ServerTrack]
    let playlists: [ExternalPlaylist]?
    let artists: [SearchArtist]?
    let hasMore: Bool?
    let errors: [String: String]?
}
struct TracksResponse: Codable { let tracks: [ServerTrack] }
struct AlbumsResponse: Codable { let albums: [Album] }
struct ArtistsResponse: Codable { let artists: [Artist] }
struct ArtistProfileResponse: Codable {
    let artist: SearchArtist
    let tracks: [ServerTrack]
    let albums: [Album]
    let availableSources: [String]?
    let errors: [String: String]?

    enum CodingKeys: String, CodingKey {
        case artist, tracks, albums, errors
        case availableSources = "available_sources"
    }
}
struct PlaylistsResponse: Codable { let playlists: [ServerPlaylist] }
struct PlaylistResponse: Codable { let playlist: ServerPlaylist }
struct RecoResponse: Codable {
    let tracks: [ServerTrack]
    let requestId: String?
}
struct MoodResponse: Codable {
    let tracks: [ServerTrack]
    let mood: String
    let requestId: String?
}
struct DailyMixResponse: Codable {
    let name: String
    let tracks: [ServerTrack]
    let requestId: String?
}
struct OkResponse: Codable { let ok: Bool? }
struct CreatePlaylistResponse: Codable { let ok: Bool; let id: String }
struct PlaylistCoverUploadResponse: Codable {
    let ok: Bool?
    let coverUrl: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case coverUrl = "cover_url"
    }
}
struct VKMeResponse: Codable { let authenticated: Bool; let username: String? }
struct VKOAuthURLResponse: Codable { let url: String; let redirectUri: String; let clientId: String? }
struct VKPlaylistsResponse: Codable { let playlists: [VKPlaylist] }
struct YandexStatusResponse: Codable { let authenticated: Bool; let username: String?; let plus: Bool? }
struct YandexConnectResponse: Codable { let ok: Bool?; let login: String?; let plus: Bool?; let warning: String? }
struct YandexDeviceStartResponse: Codable { let userCode: String; let verificationUrl: String; let interval: Int; let expiresIn: Int }
struct YandexDeviceStatusResponse: Codable { let authenticated: Bool?; let state: String?; let login: String?; let plus: Bool?; let error: String? }
struct YandexLikesImportResponse: Codable {
    let imported: Int
    let alreadyHad: Int
    let total: Int
    let cached: Int?
}

/// Per-word timing for karaoke rendering. The server sends compact `t/s/e` keys.
struct LyricsWord: Codable, Hashable, Sendable {
    let text: String
    let start: Double
    let end: Double?
    enum CodingKeys: String, CodingKey { case text = "t", start = "s", end = "e" }
}

struct LyricsResponse: Codable {
    let trackId: String
    let lrc: String?
    let source: String?
    /// Word timings per lyric line (karaoke), when the source provides them.
    let words: [[LyricsWord]]?
    /// Highlight lead in seconds for this lyrics source (server-computed).
    let offsetSec: Double?
}
struct LyricsJobResponse: Codable { let trackId: String; let status: String }

struct StatsOverview: Codable {
    let listens: ListenCounts
    let listeningTime: ListeningTime?
    let streak: Int
    let topTrack: TopTrackEntry?
    let topArtist: TopArtistEntry?
    struct ListenCounts: Codable { let today: Int; let week: Int; let month: Int; let allTime: Int }
    struct ListeningTime: Codable {
        let todaySecs: Double; let weekSecs: Double; let monthSecs: Double; let allTimeSecs: Double
    }
}

struct StatsTopTrack: Codable, Identifiable {
    var id: String { trackId }
    let trackId: String
    let title: String
    let artist: String
    let album: String?
    let coverUrl: String?
    let duration: Double?
    let playCount: Int
    enum CodingKeys: String, CodingKey {
        case trackId = "track_id"
        case title, artist, album
        case coverUrl = "cover_url"
        case duration
        case playCount = "play_count"
    }
}

struct StatsTopArtist: Codable, Identifiable {
    var id: String { artist }
    let artist: String
    let playCount: Int
    let uniqueTracks: Int
    let coverUrl: String?
    enum CodingKeys: String, CodingKey {
        case artist
        case playCount = "play_count"
        case uniqueTracks = "unique_tracks"
        case coverUrl = "cover_url"
    }
}

struct TopTrackEntry: Codable {
    let trackId: String
    let title: String
    let artist: String
    let playCount: Int
    enum CodingKeys: String, CodingKey {
        case trackId = "track_id"
        case title, artist
        case playCount = "play_count"
    }
}

struct TopArtistEntry: Codable {
    let artist: String
    let playCount: Int
    enum CodingKeys: String, CodingKey {
        case artist
        case playCount = "play_count"
    }
}

struct VKPlaylist: Codable, Identifiable {
    let id: Int
    let ownerId: Int
    let title: String
    let count: Int
    enum CodingKeys: String, CodingKey {
        case id
        case ownerId = "owner_id"
        case title, count
    }
}

// MARK: - Request Bodies

struct CreatePlaylistBody: Encodable, Sendable { let name: String; let description: String? }
struct AddTrackBody: Encodable, Sendable {
    let trackId: String
    var position: Int? = nil
}
struct VKTokenBody: Encodable, Sendable { let token: String; let username: String?; let state: String? }
struct YandexTokenBody: Encodable, Sendable { let token: String }
struct LogPlayBody: Encodable, Sendable {
    let trackId: String
    let action: String
    let eventId: String?
    let playedMs: Int?
    let durationMs: Int?
    let playedRatio: Double?
    let sessionId: String?
    let requestId: String?
    let surface: String?
    let isOrganic: Bool?
    let position: Int?
}
struct UpdatePlaylistBody: Encodable, Sendable { let name: String?; let description: String? }
struct UploadPlaylistCoverBody: Encodable, Sendable { let imageBase64: String; let mimeType: String }
struct EmptyBody: Encodable, Sendable {}
struct LikeTrackBody: Encodable, Sendable {
    let id: String
    let source: String
    let title: String
    let artist: String
    let album: String?
    let duration: TimeInterval?
    let coverUrl: String?

    init(track: Track) {
        self.id = track.id
        self.source = track.source.rawValue
        self.title = track.title
        self.artist = track.artist
        self.album = track.album
        self.duration = track.duration
        self.coverUrl = track.artwork
    }
}
struct StationOutcomeBody: Encodable, Sendable {
    let id: String
    let artist: String
    let title: String
    let album: String?
    let source: String
    let action: String
    let completionRatio: Double

    init(track: Track, action: String, completionRatio: Double) {
        id = track.id; artist = track.artist; title = track.title
        album = track.album; source = track.source.rawValue; self.action = action
        self.completionRatio = min(max(completionRatio, 0), 1)
    }
}
struct MyVibeRequestBody: Encodable, Sendable {
    let seeds: [MyVibeSeedBody]
    let excludeIds: [String]
    let limit: Int
    let filters: MyVibeFiltersBody
    let sessionId: String?
    let recentOutcomes: [StationOutcomeBody]
    let queueTail: [MyVibeSeedBody]
    let skipStreak: Int
    let reactionRefresh: Bool
    let enabledSources: [String]
}
struct AutoMixRequestBody: Encodable, Sendable {
    let seeds: [MyVibeSeedBody]
    let excludeIds: [String]
    let limit: Int
    let sessionId: String?
    let recentOutcomes: [StationOutcomeBody]
    let queueTail: [MyVibeSeedBody]
    let skipStreak: Int
    let reactionRefresh: Bool
    let enabledSources: [String]
}
struct MyVibeSeedBody: Encodable, Sendable {
    let id: String
    let artist: String
    let title: String
    let album: String?
    let source: String

    init(track: Track) {
        self.id = track.id
        self.artist = track.artist
        self.title = track.title
        self.album = track.album
        self.source = track.source.rawValue
    }
}
struct MyVibeFiltersBody: Encodable, Sendable {
    let language: String?
    let character: String
    let mood: String?

    init(filters: MyVibeFilters) {
        self.language = filters.language.serverValue
        self.character = filters.character.rawValue
        self.mood = filters.mood.serverValue
    }
}

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidURL(endpoint: String)
    case invalidResponse(endpoint: String)
    case unauthorized(endpoint: String)
    case httpStatus(statusCode: Int, endpoint: String, message: String?)
    case network(code: URLError.Code, endpoint: String)
    case requestFailed(String)
    case unsupportedImage

    var statusCode: Int? {
        switch self {
        case .unauthorized:
            return 401
        case .httpStatus(let statusCode, _, _):
            return statusCode
        case .invalidURL, .invalidResponse, .network, .requestFailed, .unsupportedImage:
            return nil
        }
    }

    var errorDescription: String? {
        switch self {
        case .invalidURL(let endpoint):
            let path = Self.safeEndpoint(endpoint)
            return String(localized: "Invalid request path: \(path)")
        case .invalidResponse(let endpoint):
            let path = Self.safeEndpoint(endpoint)
            return String(localized: "Invalid server response from \(path)")
        case .unauthorized(let endpoint):
            let path = Self.safeEndpoint(endpoint)
            return String(localized: "Authentication required for \(path).")
        case .httpStatus(let statusCode, let endpoint, let message):
            let path = Self.safeEndpoint(endpoint)
            let suffix = message.map { ": \($0)" } ?? ""
            return String(localized: "HTTP \(statusCode) for \(path)\(suffix)")
        case .network(_, let endpoint):
            return String(localized: "Can't reach the server. Check your connection and try again.")
                + " (\(Self.safeEndpoint(endpoint)))"
        case .requestFailed(let path):
            let safePath = Self.safeEndpoint(path)
            return String(localized: "Request failed: \(safePath)")
        case .unsupportedImage:
            return String(localized: "This image format isn't supported.")
        }
    }

    private static func safeEndpoint(_ endpoint: String) -> String {
        guard let components = URLComponents(string: endpoint), !components.path.isEmpty else {
            return endpoint
        }
        return components.path
    }
}

extension Error {
    /// Cancelled work (view disappeared, request superseded) is never shown to the user.
    var isCancellation: Bool {
        if self is CancellationError { return true }
        if let urlError = self as? URLError { return urlError.code == .cancelled }
        let nsError = self as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    var isUnauthorized: Bool {
        (self as? APIError)?.statusCode == 401
    }
}
