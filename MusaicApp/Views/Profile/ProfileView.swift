import SwiftUI

struct ProfileView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectionOk: Bool?
    @State private var testing = false
    @State private var serverDraft = ""
    @State private var editingServer = false
    @State private var cacheSize = "Tap to check"
    @State private var authState = ProfileAuthState()

    private let api = APIService.shared
    private let settings = SettingsStore.shared

    /// Reads CFBundleShortVersionString / CFBundleVersion from Info.plist so the
    /// About card always reflects the actual build instead of a stale literal.
    private var appVersionLabel: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String
        if let build, !build.isEmpty, build != version {
            return "Version \(version) (\(build))"
        }
        return "Version \(version)"
    }

    var body: some View {
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
                        sourceYandex: Binding(
                            get: { settings.sourceYandex },
                            set: { settings.sourceYandex = $0 }
                        ),
                        sourceYoutube: Binding(
                            get: { settings.sourceYoutube },
                            set: { settings.sourceYoutube = $0 }
                        ),
                        sourceSoundcloud: Binding(
                            get: { settings.sourceSoundcloud },
                            set: { settings.sourceSoundcloud = $0 }
                        ),
                        sourceVK: Binding(
                            get: { settings.sourceVK },
                            set: { settings.sourceVK = $0 }
                        )
                    )

                    ProfileAppearanceSection(
                        theme: Binding(
                            get: { settings.theme },
                            set: { settings.theme = $0 }
                        )
                    )

                    if settings.sourceYandex {
                        ProfileYandexSection(auth: authState)
                    }

                    if settings.sourceVK {
                        ProfileVKSection(auth: authState)
                    }

                    ProfilePlaybackSection(
                        streamQuality: Binding(
                            get: { settings.streamQuality },
                            set: { settings.streamQuality = $0 }
                        ),
                        crossfadeSeconds: Binding(
                            get: { settings.crossfadeSec },
                            set: { settings.crossfadeSec = $0 }
                        ),
                        gapless: Binding(
                            get: { settings.gapless },
                            set: { settings.gapless = $0 }
                        )
                    )

                    ProfileDownloadsSection()

                    ProfileStorageSection(
                        cacheSize: $cacheSize,
                        onClearCache: clearCache
                    )

                    ProfileServerSection(
                        serverURL: api.serverURL,
                        connectionButtonLabel: connectionButtonLabel,
                        testing: testing,
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
            .onAppear {
                serverDraft = api.serverURL
                // Reset so re-opening the view shows "checking" instead of stale red
                if connectionOk == false { connectionOk = nil }
            }
            .onChange(of: scenePhase) { _, phase in
                // Returning from the browser after authorizing Yandex: re-check
                // status immediately so the token the server captured is picked up.
                if phase == .active, !authState.yandexUserCode.isEmpty {
                    Task { await authState.checkYandexDeviceOnce() }
                }
            }
            .task {
                let ok = await api.ping()
                connectionOk = ok
                await authState.refreshVKStatus()
                await authState.refreshYandexStatus()
                // Auto-retry once after a short delay if initial ping failed
                if !ok {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    connectionOk = await api.ping()
                }
            }
        }
    }

    private var connectionLabel: String {
        if connectionOk == true { return String(localized: "Online") }
        if connectionOk == false { return String(localized: "Offline") }
        return String(localized: "Unknown")
    }

    private var connectionButtonLabel: String {
        if connectionOk == true { return String(localized: "Connected") }
        if connectionOk == false { return String(localized: "Retry Connection") }
        return String(localized: "Test Connection")
    }

    private func testConnection() {
        testing = true
        connectionOk = nil
        Task {
            connectionOk = await api.ping()
            testing = false
        }
    }

    private func saveServer() {
        api.setServerURL(serverDraft)
        editingServer = false
        connectionOk = nil
    }

    private func clearCache() {
        if let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: cacheDir)
            try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
            cacheSize = "0 MB"
        }
    }
}
