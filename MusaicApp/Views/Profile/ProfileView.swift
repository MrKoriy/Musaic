import SwiftUI

struct ProfileView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectionOk: Bool?
    @State private var testing = false
    @State private var serverDraft = ""
    @State private var serverMessage: String?
    @State private var editingServer = false
    @State private var cacheSize = "…"
    @State private var clearingCache = false
    @State private var authState = ProfileAuthState()
    @State private var lastLoadedAt: Date?

    private static let staleAfter: TimeInterval = 5 * 60
    private let api = APIService.shared
    private let settings = SettingsStore.shared

    /// Reads CFBundleShortVersionString / CFBundleVersion from Info.plist so the
    /// About card always reflects the actual build instead of a stale literal.
    private var appVersionLabel: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String
        if let build, !build.isEmpty, build != version {
            return String(localized: "Version \(version) (\(build))")
        }
        return String(localized: "Version \(version)")
    }

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ProfileStatsSection()

                    ProfileStatusSection(
                        connectionOk: connectionOk,
                        connectionLabel: connectionLabel,
                        yandexState: settings.yandexAuthenticated ? String(localized: "Connected") : String(localized: "Offline"),
                        vkState: settings.vkAuthenticated ? String(localized: "Connected") : String(localized: "Offline"),
                        cacheSize: cacheSize,
                        onRetry: testConnection
                    )

                    ProfileSourcesSection(
                        sourceYandex: $settings.sourceYandex,
                        sourceYoutube: $settings.sourceYoutube,
                        sourceSoundcloud: $settings.sourceSoundcloud,
                        sourceVK: $settings.sourceVK
                    )

                    if settings.sourceYandex {
                        ProfileYandexSection(auth: authState)
                    }

                    if settings.sourceVK {
                        ProfileVKSection(auth: authState)
                    }

                    ProfilePlaybackSection(
                        streamQuality: $settings.streamQuality,
                        crossfadeSeconds: $settings.crossfadeSec,
                        gapless: $settings.gapless,
                        normalization: $settings.normalization
                    )

                    ProfileDownloadsSection()

                    ProfileStorageSection(
                        cacheSize: cacheSize,
                        clearing: clearingCache,
                        onClearCache: clearCache
                    )

                    ProfileServerSection(
                        serverURL: api.serverURL,
                        connectionButtonLabel: connectionButtonLabel,
                        testing: testing,
                        message: serverMessage,
                        editingServer: $editingServer,
                        serverDraft: $serverDraft,
                        onSave: saveServer,
                        onTestConnection: testConnection
                    )

                    ProfileAccountSection()
                    ProfileAboutSection(appVersionLabel: appVersionLabel)
                }
                .padding(.bottom, Layout.playerBottomInset)
            }
            .background(AppBackdrop())
            .navigationBarHiddenCompat(true)
            .refreshable { await refresh() }
            .onChange(of: scenePhase) { _, phase in
                // Returning from the browser after authorizing Yandex: re-check
                // status immediately so the token the server captured is picked up.
                if phase == .active, !authState.yandexUserCode.isEmpty {
                    Task { await authState.checkYandexDeviceOnce() }
                }
            }
            .task {
                if let lastLoadedAt, Date().timeIntervalSince(lastLoadedAt) < Self.staleAfter { return }
                await refresh()
            }
        }
    }

    private var connectionLabel: String {
        if connectionOk == true { return String(localized: "Online") }
        if connectionOk == false { return String(localized: "Offline") }
        return String(localized: "Unknown")
    }

    private var connectionButtonLabel: String {
        if editingServer { return String(localized: "Test Connection") }
        if connectionOk == true { return String(localized: "Connected") }
        if connectionOk == false { return String(localized: "Retry Connection") }
        return String(localized: "Test Connection")
    }

    private func refresh() async {
        serverDraft = api.serverURL
        async let ping = api.ping()
        async let usage = AppCaches.usageBytes()
        await authState.refreshVKStatus()
        await authState.refreshYandexStatus()
        let reachable = await ping
        cacheSize = AppCaches.formatted(await usage)
        guard !Task.isCancelled else { return }
        connectionOk = reachable
        lastLoadedAt = Date()
    }

    /// Tests the draft while editing (without saving), otherwise the saved server.
    private func testConnection() {
        testing = true
        serverMessage = nil
        let target = editingServer ? serverDraft : nil
        Task {
            let result = await api.checkConnection(to: target)
            if target == nil {
                connectionOk = result == .ok
            }
            serverMessage = result.message
            testing = false
        }
    }

    private func saveServer() {
        guard let normalized = APIService.validatedServerURL(serverDraft) else {
            serverMessage = APIService.ConnectionCheck.invalidAddress.message
            return
        }
        api.setServerURL(normalized)
        serverDraft = normalized
        editingServer = false
        serverMessage = nil
        connectionOk = nil
        testConnection()
    }

    private func clearCache() {
        clearingCache = true
        Task {
            await AppCaches.clearAll()
            cacheSize = AppCaches.formatted(await AppCaches.usageBytes())
            clearingCache = false
        }
    }
}
