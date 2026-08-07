import Foundation
import SwiftUI

// MARK: - Settings Store

@Observable
final class SettingsStore: @unchecked Sendable {
    static let shared = SettingsStore()

    var onboardingComplete: Bool {
        get { UserDefaults.standard.bool(forKey: "onboarding_complete") }
        set { UserDefaults.standard.set(newValue, forKey: "onboarding_complete") }
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
        get { UserDefaults.standard.string(forKey: "auth_token") }
        set { UserDefaults.standard.set(newValue, forKey: "auth_token") }
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
        isLoggedIn = UserDefaults.standard.string(forKey: "auth_token") != nil
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

    func setAuth(token: String, userId: String, username: String, displayName: String) {
        authToken = token
        authUserId = userId
        authUsername = username
        authDisplayName = displayName
        isLoggedIn = true
    }

    func logout() {
        authToken = nil
        authUserId = nil
        authUsername = ""
        authDisplayName = ""
        isLoggedIn = false
    }
}
