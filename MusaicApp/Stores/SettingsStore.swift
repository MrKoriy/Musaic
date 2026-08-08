import Foundation
import SwiftUI

// MARK: - Settings Store

enum AppTheme: String, CaseIterable, Identifiable {
    case auto
    case dark
    case light

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .auto: return nil
        case .dark: return .dark
        case .light: return .light
        }
    }

    var localizedName: String {
        switch self {
        case .auto: return String(localized: "Auto")
        case .dark: return String(localized: "Dark")
        case .light: return String(localized: "Light")
        }
    }
}

@Observable
@MainActor
final class SettingsStore {
    static let shared = SettingsStore()

    var onboardingComplete: Bool {
        get { UserDefaults.standard.bool(forKey: "onboarding_complete") }
        set { UserDefaults.standard.set(newValue, forKey: "onboarding_complete") }
    }
    var theme: AppTheme {
        get { AppTheme(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .auto }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "theme") }
    }
    var sourceVK: Bool {
        get { UserDefaults.standard.bool(forKey: "source_vk") }
        set { UserDefaults.standard.set(newValue, forKey: "source_vk") }
    }
    var sourceSoundcloud: Bool {
        get { UserDefaults.standard.bool(forKey: "source_soundcloud") }
        set { UserDefaults.standard.set(newValue, forKey: "source_soundcloud") }
    }
    // New primary sources (default ON for first run). VK is intentionally NOT a
    // discovery source anymore — it stays only for already-liked tracks.
    var sourceYandex: Bool {
        get { UserDefaults.standard.object(forKey: "source_yandex") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "source_yandex") }
    }
    var sourceYoutube: Bool {
        get { UserDefaults.standard.object(forKey: "source_youtube") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "source_youtube") }
    }
    var vkAuthenticated: Bool {
        get { UserDefaults.standard.bool(forKey: "vk_authenticated") }
        set { UserDefaults.standard.set(newValue, forKey: "vk_authenticated") }
    }
    var vkUsername: String {
        get { UserDefaults.standard.string(forKey: "vk_username") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "vk_username") }
    }
    var yandexAuthenticated: Bool {
        get { UserDefaults.standard.bool(forKey: "yandex_authenticated") }
        set { UserDefaults.standard.set(newValue, forKey: "yandex_authenticated") }
    }
    var yandexUsername: String {
        get { UserDefaults.standard.string(forKey: "yandex_username") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "yandex_username") }
    }
    var streamQuality: String {
        get { UserDefaults.standard.string(forKey: "stream_quality") ?? "high" }
        set { UserDefaults.standard.set(newValue, forKey: "stream_quality") }
    }
    var crossfadeSec: Int {
        get { UserDefaults.standard.integer(forKey: "crossfade_sec") }
        set { UserDefaults.standard.set(newValue, forKey: "crossfade_sec") }
    }
    var gapless: Bool {
        get { UserDefaults.standard.object(forKey: "gapless") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "gapless") }
    }
    var normalization: Bool {
        get { UserDefaults.standard.bool(forKey: "normalization") }
        set { UserDefaults.standard.set(newValue, forKey: "normalization") }
    }

    /// Comma-joined ENABLED discovery sources for search/artist/recs queries.
    /// Local is always on; VK is never a discovery source (kept for liked tracks only).
    var enabledRecommendationSources: [String] {
        var sources = ["local"]
        if sourceYandex { sources.append("yandex") }
        if sourceYoutube { sources.append("youtube") }
        if sourceSoundcloud { sources.append("soundcloud") }
        return sources // VK is intentionally excluded from recommendations.
    }

    var enabledSourcesParam: String {
        enabledRecommendationSources.joined(separator: ",")
    }

    var serverConnected = false

    // Auth
    var authToken: String? {
        get { Self.loadAuthToken() }
        set {
            if let newValue {
                // Keep the legacy value if Keychain is unavailable so a later
                // launch can retry the migration instead of losing the token.
                guard KeychainService.shared.setString(newValue, forKey: Self.authTokenKey) else { return }
                UserDefaults.standard.removeObject(forKey: Self.authTokenKey)
            } else {
                _ = KeychainService.shared.delete(forKey: Self.authTokenKey)
                UserDefaults.standard.removeObject(forKey: Self.authTokenKey)
            }
        }
    }
    var authUserId: String? {
        get { UserDefaults.standard.string(forKey: "auth_user_id") }
        set { UserDefaults.standard.set(newValue, forKey: "auth_user_id") }
    }
    var authUsername: String {
        get { UserDefaults.standard.string(forKey: "auth_username") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "auth_username") }
    }
    var authDisplayName: String {
        get { UserDefaults.standard.string(forKey: "auth_display_name") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "auth_display_name") }
    }
    var isLoggedIn: Bool

    private init() {
        isLoggedIn = Self.loadAuthToken() != nil
    }

    private static let authTokenKey = "auth_token"

    private static func loadAuthToken() -> String? {
        if let token = KeychainService.shared.string(forKey: authTokenKey) {
            return token
        }

        // One-time migration for installations that stored the session in defaults.
        guard let legacyToken = UserDefaults.standard.string(forKey: authTokenKey) else { return nil }
        if KeychainService.shared.setString(legacyToken, forKey: authTokenKey) {
            UserDefaults.standard.removeObject(forKey: authTokenKey)
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
        guard KeychainService.shared.setString(token, forKey: Self.authTokenKey) else {
            isLoggedIn = false
            return false
        }
        UserDefaults.standard.removeObject(forKey: Self.authTokenKey)
        authUserId = userId
        authUsername = username
        authDisplayName = displayName
        isLoggedIn = true
        return true
    }

    func logout() {
        LibraryStore.shared.clearLocalLikes()
        authToken = nil
        authUserId = nil
        authUsername = ""
        authDisplayName = ""
        isLoggedIn = false
    }
}
