import Foundation

// MARK: - Settings Store

/// Stored (hence observed) settings mirrored to UserDefaults. Computed
/// properties over UserDefaults are invisible to `@Observable`, which left
/// toggles and the onboarding flow without re-renders.
@Observable
@MainActor
final class SettingsStore {
    static let shared = SettingsStore()

    private enum Keys {
        static let onboardingComplete = "onboarding_complete"
        static let sourceVK = "source_vk"
        static let sourceSoundcloud = "source_soundcloud"
        static let sourceYandex = "source_yandex"
        static let sourceYoutube = "source_youtube"
        static let vkAuthenticated = "vk_authenticated"
        static let vkUsername = "vk_username"
        static let yandexAuthenticated = "yandex_authenticated"
        static let yandexUsername = "yandex_username"
        static let streamQuality = "stream_quality"
        static let crossfadeSec = "crossfade_sec"
        static let gapless = "gapless"
        static let normalization = "normalization"
        static let authUserId = "auth_user_id"
        static let authUsername = "auth_username"
        static let authDisplayName = "auth_display_name"
        static let authToken = "auth_token"
    }

    var onboardingComplete: Bool {
        didSet { UserDefaults.standard.set(onboardingComplete, forKey: Keys.onboardingComplete) }
    }
    var sourceVK: Bool {
        didSet { UserDefaults.standard.set(sourceVK, forKey: Keys.sourceVK) }
    }
    var sourceSoundcloud: Bool {
        didSet { UserDefaults.standard.set(sourceSoundcloud, forKey: Keys.sourceSoundcloud) }
    }
    // Primary discovery sources (default ON). VK is intentionally NOT a
    // discovery source anymore — it stays only for already-liked tracks.
    var sourceYandex: Bool {
        didSet { UserDefaults.standard.set(sourceYandex, forKey: Keys.sourceYandex) }
    }
    var sourceYoutube: Bool {
        didSet { UserDefaults.standard.set(sourceYoutube, forKey: Keys.sourceYoutube) }
    }
    var vkAuthenticated: Bool {
        didSet { UserDefaults.standard.set(vkAuthenticated, forKey: Keys.vkAuthenticated) }
    }
    var vkUsername: String {
        didSet { UserDefaults.standard.set(vkUsername, forKey: Keys.vkUsername) }
    }
    var yandexAuthenticated: Bool {
        didSet { UserDefaults.standard.set(yandexAuthenticated, forKey: Keys.yandexAuthenticated) }
    }
    var yandexUsername: String {
        didSet { UserDefaults.standard.set(yandexUsername, forKey: Keys.yandexUsername) }
    }
    var streamQuality: String {
        didSet { UserDefaults.standard.set(streamQuality, forKey: Keys.streamQuality) }
    }
    var crossfadeSec: Int {
        didSet { UserDefaults.standard.set(crossfadeSec, forKey: Keys.crossfadeSec) }
    }
    var gapless: Bool {
        didSet { UserDefaults.standard.set(gapless, forKey: Keys.gapless) }
    }
    var normalization: Bool {
        didSet { UserDefaults.standard.set(normalization, forKey: Keys.normalization) }
    }

    /// Comma-joined ENABLED discovery sources for search/artist/recs queries.
    /// Local is always on; VK is never a discovery source (kept for liked tracks only).
    var enabledRecommendationSources: [String] {
        var sources = ["local"]
        if sourceYandex { sources.append("yandex") }
        if sourceYoutube { sources.append("youtube") }
        if sourceSoundcloud { sources.append("soundcloud") }
        return sources
    }

    var enabledSourcesParam: String {
        enabledRecommendationSources.joined(separator: ",")
    }

    var serverConnected = false

    // MARK: Auth

    /// Served from the in-memory credentials cache; Keychain is only read at launch.
    var authToken: String? {
        get { APICredentials.shared.token }
        set {
            if let newValue {
                // Keep the legacy value if Keychain is unavailable so a later
                // launch can retry the migration instead of losing the token.
                guard KeychainService.shared.setString(newValue, forKey: Keys.authToken) else { return }
                UserDefaults.standard.removeObject(forKey: Keys.authToken)
            } else {
                _ = KeychainService.shared.delete(forKey: Keys.authToken)
                UserDefaults.standard.removeObject(forKey: Keys.authToken)
            }
            APICredentials.shared.setToken(newValue)
        }
    }
    var authUserId: String? {
        didSet { UserDefaults.standard.set(authUserId, forKey: Keys.authUserId) }
    }
    var authUsername: String {
        didSet { UserDefaults.standard.set(authUsername, forKey: Keys.authUsername) }
    }
    var authDisplayName: String {
        didSet { UserDefaults.standard.set(authDisplayName, forKey: Keys.authDisplayName) }
    }
    var isLoggedIn: Bool
    var sessionExpired = false

    private init() {
        let defaults = UserDefaults.standard
        onboardingComplete = defaults.bool(forKey: Keys.onboardingComplete)
        sourceVK = defaults.bool(forKey: Keys.sourceVK)
        sourceSoundcloud = defaults.bool(forKey: Keys.sourceSoundcloud)
        sourceYandex = defaults.object(forKey: Keys.sourceYandex) as? Bool ?? true
        sourceYoutube = defaults.object(forKey: Keys.sourceYoutube) as? Bool ?? true
        vkAuthenticated = defaults.bool(forKey: Keys.vkAuthenticated)
        vkUsername = defaults.string(forKey: Keys.vkUsername) ?? ""
        yandexAuthenticated = defaults.bool(forKey: Keys.yandexAuthenticated)
        yandexUsername = defaults.string(forKey: Keys.yandexUsername) ?? ""
        streamQuality = defaults.string(forKey: Keys.streamQuality) ?? "high"
        crossfadeSec = defaults.integer(forKey: Keys.crossfadeSec)
        gapless = defaults.object(forKey: Keys.gapless) as? Bool ?? true
        normalization = defaults.object(forKey: Keys.normalization) as? Bool ?? true
        authUserId = defaults.string(forKey: Keys.authUserId)
        authUsername = defaults.string(forKey: Keys.authUsername) ?? ""
        authDisplayName = defaults.string(forKey: Keys.authDisplayName) ?? ""

        let token = Self.loadAuthToken()
        APICredentials.shared.setToken(token)
        isLoggedIn = token != nil
    }

    private static func loadAuthToken() -> String? {
        if let token = KeychainService.shared.string(forKey: Keys.authToken) {
            return token
        }

        // One-time migration for installations that stored the session in defaults.
        guard let legacyToken = UserDefaults.standard.string(forKey: Keys.authToken) else { return nil }
        if KeychainService.shared.setString(legacyToken, forKey: Keys.authToken) {
            UserDefaults.standard.removeObject(forKey: Keys.authToken)
            return legacyToken
        }
        // Do not enter the authenticated UI when secure storage is unavailable.
        // Keep the legacy value only so a later launch can retry migration.
        return nil
    }

    func setVkAuth(authenticated: Bool, username: String?) {
        vkAuthenticated = authenticated
        vkUsername = username ?? ""
    }

    func clearVkAuth() {
        vkAuthenticated = false
        vkUsername = ""
    }

    func setYandexAuth(authenticated: Bool, username: String?) {
        yandexAuthenticated = authenticated
        yandexUsername = username ?? ""
    }

    func clearYandexAuth() {
        yandexAuthenticated = false
        yandexUsername = ""
    }

    @discardableResult
    func setAuth(token: String, userId: String, username: String, displayName: String) -> Bool {
        guard KeychainService.shared.setString(token, forKey: Keys.authToken) else {
            isLoggedIn = false
            return false
        }
        UserDefaults.standard.removeObject(forKey: Keys.authToken)
        APICredentials.shared.setToken(token)
        authUserId = userId
        authUsername = username
        authDisplayName = displayName
        isLoggedIn = true
        sessionExpired = false
        return true
    }

    /// Local sign-out: stops playback, forgets the account's likes, caches and
    /// token. Offline downloads are kept on purpose.
    func logout() {
        PlayerStore.shared.resetForLogout()
        LibraryStore.shared.clearLocalLikes()
        APIService.shared.clearSessionCaches()
        authToken = nil
        authUserId = nil
        authUsername = ""
        authDisplayName = ""
        isLoggedIn = false
        sessionExpired = false
    }

    func markSessionExpired() {
        sessionExpired = true
    }
}
