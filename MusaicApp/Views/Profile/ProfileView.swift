import SwiftUI
import WebKit

private enum StatsPeriod: String, CaseIterable {
    case today, week, month, alltime
    var label: String {
        switch self {
        case .today: return "Today"
        case .week: return "Week"
        case .month: return "Month"
        case .alltime: return "All time"
        }
    }
    var apiValue: String {
        switch self {
        case .today: return "today"
        case .week: return "week"
        case .month: return "month"
        case .alltime: return "alltime"
        }
    }
    func listens(from overview: StatsOverview) -> Int {
        switch self {
        case .today: return overview.listens.today
        case .week: return overview.listens.week
        case .month: return overview.listens.month
        case .alltime: return overview.listens.allTime
        }
    }
    func secs(from overview: StatsOverview) -> Int {
        guard let t = overview.listeningTime else { return 0 }
        switch self {
        case .today: return t.todaySecs
        case .week: return t.weekSecs
        case .month: return t.monthSecs
        case .alltime: return t.allTimeSecs
        }
    }
}

struct ProfileView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectionOk: Bool?
    @State private var testing = false
    @State private var serverDraft = ""
    @State private var editingServer = false
    @State private var vkLoggingIn = false
    @State private var showVKAuth = false
    @State private var cacheSize = "Tap to check"
    @State private var vkAuthURL: URL?
    @State private var vkError: String?
    @State private var yandexToken = ""
    @State private var yandexConnecting = false
    @State private var yandexError: String?
    @State private var yandexPlusWarning: String?
    @State private var yandexUserCode = ""
    @State private var yandexVerificationURL = "https://ya.ru/device"
    @State private var showYandexPasteFallback = false
    @State private var yandexImporting = false
    @State private var yandexImportMessage: String?

    // Stats state
    @State private var statsPeriod: StatsPeriod = .month
    @State private var statsOverview: StatsOverview?
    @State private var topTracks: [StatsTopTrack] = []
    @State private var topArtists: [StatsTopArtist] = []
    @State private var statsLoading = false

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
                    statsSection

                    VStack(alignment: .leading, spacing: 18) {
                        LiquidSectionHeader(title: "Settings", subtitle: "Sources, VK access, playback defaults and server control.")

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                statusChip(title: "Server", state: connectionLabel)
                                statusChip(title: "Yandex", state: settings.yandexAuthenticated ? "Connected" : "Offline")
                                statusChip(title: "VK", state: settings.vkAuthenticated ? "Connected" : "Offline")
                                statusChip(title: "Cache", state: cacheSize)
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)

                    settingsCard(title: "Music Sources") {
                        sourceToggle("Local Library", isOn: .constant(true))
                        sourceToggle("Yandex Music", isOn: Binding(
                            get: { settings.sourceYandex },
                            set: { settings.sourceYandex = $0 }
                        ))
                        sourceToggle("YouTube Music", isOn: Binding(
                            get: { settings.sourceYoutube },
                            set: { settings.sourceYoutube = $0 }
                        ))
                        sourceToggle("SoundCloud", isOn: Binding(
                            get: { settings.sourceSoundcloud },
                            set: { settings.sourceSoundcloud = $0 }
                        ))
                        sourceToggle("VK (liked tracks only)", isOn: Binding(
                            get: { settings.sourceVK },
                            set: { settings.sourceVK = $0 }
                        ))
                        Text("VK is no longer used for search or recommendations — only your already-liked VK tracks still play. Connect VK below to keep them playing.")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if settings.sourceYandex {
                        yandexCard
                    }

                    if settings.sourceVK {
                        settingsCard(title: "VK Music") {
                            if settings.vkAuthenticated {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(settings.vkUsername.isEmpty ? "VK User" : settings.vkUsername)
                                            .font(.system(size: 15, weight: .semibold))
                                            .foregroundStyle(Color.textPrimary)
                                        Text("Token is stored on the server.")
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundStyle(Color.textSecondary)
                                    }
                                    Spacer()
                                    Button("Disconnect") { disconnectVK() }
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Color.textPrimary)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 10)
                                        .glassCard(cornerRadius: 18, intensity: 0.08)
                                }
                            } else {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text("Sign in to VK directly inside Musaic and send the token to your server.")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(Color.textSecondary)

                                    if let vkError {
                                        Text(vkError)
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundStyle(.red)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }

                                    Button {
                                        loginVK()
                                    } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: "globe")
                                            Text(vkLoggingIn ? "Opening VK..." : "Login to VK")
                                        }
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(Color.bgPrimary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(vkLoggingIn)
                                }
                            }
                        }
                    }

                    settingsCard(title: "Playback") {
                        settingRow(title: "Stream Quality", value: streamQualityLabel) {
                            let opts = ["low", "normal", "high"]
                            let idx = opts.firstIndex(of: settings.streamQuality) ?? 2
                            settings.streamQuality = opts[(idx + 1) % opts.count]
                        }
                        settingRow(title: "Crossfade", value: settings.crossfadeSec == 0 ? "Off" : "\(settings.crossfadeSec)s") {
                            let opts = [0, 2, 5, 10]
                            let idx = opts.firstIndex(of: settings.crossfadeSec) ?? 0
                            settings.crossfadeSec = opts[(idx + 1) % opts.count]
                            AudioPlayer.shared.applyPlaybackSettings()
                        }
                        sourceToggle("Gapless Playback", isOn: Binding(
                            get: { settings.gapless },
                            set: { settings.gapless = $0; AudioPlayer.shared.applyPlaybackSettings() }
                        ))
                        Text("Stream Quality applies to Yandex (real bitrate tiers); other sources serve a fixed quality. Gapless uses a short seamless bridge between tracks when Crossfade is Off.")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Text("Volume Normalization")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                            Spacer()
                            Text("Coming soon")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Color.textMuted)
                        }
                    }

                    settingsCard(title: "Downloads") {
                        settingRow(title: "Offline Tracks", value: "\(DownloadManager.shared.downloadCount)")
                        settingRow(title: "Storage Used", value: DownloadManager.shared.totalSizeFormatted)
                        if DownloadManager.shared.downloadCount > 0 {
                            Button("Delete All Downloads") {
                                DownloadManager.shared.deleteAllDownloads()
                            }
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.red)
                        }
                    }

                    settingsCard(title: "Storage") {
                        settingRow(title: "Cache Size", value: cacheSize)
                        Button("Clear Cache") {
                            clearCache()
                        }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                    }

                    settingsCard(title: "Server") {
                        if editingServer {
                            VStack(spacing: 10) {
                                TextField("45.146.167.109:3001", text: $serverDraft)
                                    .textFieldStyle(.plain)
                                    .foregroundStyle(Color.textPrimary)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 14)
                                    .glassCard(cornerRadius: 18, intensity: 0.08)

                                HStack(spacing: 10) {
                                    Button("Save") {
                                        saveServer()
                                    }
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.bgPrimary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                                    Button("Cancel") {
                                        editingServer = false
                                    }
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .glassCard(cornerRadius: 18, intensity: 0.08)
                                }
                            }
                        } else {
                            Button {
                                editingServer = true
                                serverDraft = api.serverURL
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(api.serverURL)
                                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(Color.textPrimary)
                                    Text("Public server is default. You can still switch to a LAN IP if needed.")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.textSecondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        }

                        Button {
                            testConnection()
                        } label: {
                            Text(testing ? "Testing..." : connectionButtonLabel)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .glassCard(cornerRadius: 18, intensity: 0.08)
                        }
                        .buttonStyle(.plain)
                        .disabled(testing)
                    }

                    settingsCard(title: "Account") {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 12) {
                                Image(systemName: "person.circle.fill")
                                    .font(.system(size: 28))
                                    .foregroundStyle(Color.textPrimary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(settings.authDisplayName.isEmpty ? settings.authUsername : settings.authDisplayName)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(Color.textPrimary)
                                    Text("@\(settings.authUsername)")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.textSecondary)
                                }
                                Spacer()
                            }
                            Button("Sign Out") {
                                settings.logout()
                            }
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.red)
                        }
                    }

                    settingsCard(title: "About") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Musaic")
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundStyle(Color.textPrimary)
                            Text(appVersionLabel)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textSecondary)
                            Text("A personal music player with local, VK and SoundCloud support.")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                        }
                    }
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
                if phase == .active, !yandexUserCode.isEmpty {
                    Task { await checkYandexDeviceOnce() }
                }
            }
            .task {
                async let statsTask: Void = loadStats()
                let ok = await api.ping()
                connectionOk = ok
                await refreshVKStatus()
                await refreshYandexStatus()
                _ = await statsTask
                // Auto-retry once after a short delay if initial ping failed
                if !ok {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    connectionOk = await api.ping()
                }
            }
            .sheet(isPresented: $showVKAuth, onDismiss: {
                vkLoggingIn = false
            }) {
                if let vkAuthURL {
                    VKAuthSheet(authURL: vkAuthURL) { token, userId, state in
                        finishVKLogin(token: token, userId: userId, state: state)
                    }
                }
            }
        }
    }

    // MARK: - Stats Section

    private var statsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Your Stats")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if statsLoading {
                    ProgressView()
                        .tint(Color.textSecondary)
                        .scaleEffect(0.8)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)

            // Period selector
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(StatsPeriod.allCases, id: \.self) { period in
                        Button {
                            statsPeriod = period
                            Task { await loadStats() }
                        } label: {
                            Text(period.label)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(statsPeriod == period ? Color.bgPrimary : Color.textSecondary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(
                                    Capsule()
                                        .fill(statsPeriod == period ? Color.textPrimary : Color.white.opacity(0.08))
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
            }

            // Key metrics
            if let overview = statsOverview {
                HStack(spacing: 10) {
                    statsMetricTile(
                        value: "\(statsPeriod.listens(from: overview))",
                        label: "Listens",
                        icon: "headphones"
                    )
                    statsMetricTile(
                        value: formatListeningTime(statsPeriod.secs(from: overview)),
                        label: "Time",
                        icon: "clock"
                    )
                    statsMetricTile(
                        value: "\(overview.streak)d",
                        label: "Streak",
                        icon: "flame"
                    )
                }
                .padding(.horizontal, 18)
            } else if !statsLoading {
                HStack(spacing: 10) {
                    statsMetricTile(value: "—", label: "Listens", icon: "headphones")
                    statsMetricTile(value: "—", label: "Time", icon: "clock")
                    statsMetricTile(value: "—", label: "Streak", icon: "flame")
                }
                .padding(.horizontal, 18)
            }

            // Top Tracks
            if !topTracks.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "music.note")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.accentStrong)
                        Text("Top tracks")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                    }

                    ForEach(Array(topTracks.enumerated()), id: \.element.id) { idx, track in
                        HStack(spacing: 12) {
                            Text("\(idx + 1)")
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.textMuted)
                                .frame(width: 18, alignment: .trailing)

                            ArtworkTile(urlString: api.artworkURL(for: track.coverUrl), icon: "music.note")
                                .frame(width: 40, height: 40)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(track.title)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text(track.artist)
                                    .font(.system(size: 12, weight: .regular))
                                    .foregroundStyle(Color.textSecondary)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 0)

                            Text("\(track.playCount) plays")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(16)
                .glassCard(cornerRadius: 24, intensity: 0.10)
                .padding(.horizontal, 18)
            }

            // Top Artists
            if !topArtists.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "person.2")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.accentStrong)
                        Text("Top artists")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                    }

                    ForEach(Array(topArtists.enumerated()), id: \.element.id) { idx, artist in
                        HStack(spacing: 12) {
                            Text("\(idx + 1)")
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.textMuted)
                                .frame(width: 18, alignment: .trailing)

                            ArtworkTile(urlString: api.artworkURL(for: artist.coverUrl), icon: "person")
                                .frame(width: 40, height: 40)
                                .clipShape(Circle())

                            VStack(alignment: .leading, spacing: 2) {
                                Text(artist.artist)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text("\(artist.uniqueTracks) tracks")
                                    .font(.system(size: 12, weight: .regular))
                                    .foregroundStyle(Color.textSecondary)
                            }

                            Spacer(minLength: 0)

                            Text("\(artist.playCount) plays")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(16)
                .glassCard(cornerRadius: 24, intensity: 0.10)
                .padding(.horizontal, 18)
            }
        }
    }

    private func statsMetricTile(value: String, label: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textSecondary)
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 20, intensity: 0.08)
    }

    private func formatListeningTime(_ secs: Int) -> String {
        if secs < 60 { return "\(secs)s" }
        let mins = secs / 60
        if mins < 60 { return "\(mins)m" }
        let hours = mins / 60
        let remainingMins = mins % 60
        if remainingMins == 0 { return "\(hours)h" }
        return "\(hours)h \(remainingMins)m"
    }

    private func loadStats() async {
        statsLoading = true
        defer { statsLoading = false }
        async let overview = try? api.getStatsOverview()
        async let tracks = try? api.getTopTracks(period: statsPeriod.apiValue, limit: 5)
        async let artists = try? api.getTopArtists(period: statsPeriod.apiValue, limit: 5)
        let (ov, tr, ar) = await (overview, tracks, artists)
        statsOverview = ov
        topTracks = tr ?? []
        topArtists = ar ?? []
    }

    // MARK: - Settings Helpers

    private var connectionLabel: String {
        if connectionOk == true { return "Online" }
        if connectionOk == false { return "Offline" }
        return "Unknown"
    }

    private var connectionButtonLabel: String {
        if connectionOk == true { return "Connected" }
        if connectionOk == false { return "Retry Connection" }
        return "Test Connection"
    }

    private func statusChip(title: String, state: String) -> some View {
        HStack(spacing: 8) {
            if title == "Server" {
                Circle()
                    .fill(connectionOk == true ? Color.green : connectionOk == false ? Color.red : Color.gray.opacity(0.5))
                    .frame(width: 8, height: 8)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                Text(state)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 20, intensity: 0.08)
    }

    private func settingsCard<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            content()
        }
        .padding(18)
        .glassCard(cornerRadius: 28, intensity: 0.10)
        .padding(.horizontal, 18)
    }

    private func sourceToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.textPrimary)
        }
        .toggleStyle(.switch)
        .tint(Color.accentStrong)
    }

    private func settingRow(title: String, value: String, action: (() -> Void)? = nil) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.textPrimary)
            Spacer()
            if let action {
                Button(value, action: action)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
            } else {
                Text(value)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }

    private var yandexCard: some View {
        settingsCard(title: "Yandex Music") {
            if settings.yandexAuthenticated {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(settings.yandexUsername.isEmpty ? "Yandex account" : settings.yandexUsername)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                        Text("Token is stored encrypted on the server.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                    Button("Disconnect") { disconnectYandex() }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .glassCard(cornerRadius: 18, intensity: 0.08)
                }
                HStack(spacing: 10) {
                    Button {
                        importYandexLikes()
                    } label: {
                        Label(yandexImporting ? "Syncing…" : "Sync Yandex likes", systemImage: "arrow.triangle.2.circlepath")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                    }
                    .buttonStyle(.plain)
                    .disabled(yandexImporting)
                    if let yandexImportMessage {
                        Text(yandexImportMessage)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .lineLimit(2)
                    }
                }
                if let yandexPlusWarning {
                    Text(yandexPlusWarning)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if !yandexUserCode.isEmpty {
                // Device-flow in progress: show the code + open the verification page.
                VStack(alignment: .leading, spacing: 12) {
                    Text("Open the Yandex page, sign in, and enter this code exactly as shown (valid ~5 min):")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    // Show the code verbatim — Yandex codes are lowercase and
                    // case-sensitive, so never transform the case here.
                    Text(yandexUserCode)
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(Color.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .glassCard(cornerRadius: 16, intensity: 0.08)
                    if let url = URL(string: yandexVerificationURL) {
                        Link(destination: url) {
                            HStack(spacing: 10) {
                                Image(systemName: "safari")
                                Text("Open \(yandexVerificationURL.replacingOccurrences(of: "https://", with: ""))")
                            }
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.bgPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Waiting for confirmation…")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Connect your Yandex account by code — no password typing. Full tracks require an active Yandex Plus subscription.")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let yandexError {
                        Text(yandexError)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        startYandexDeviceFlow()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "qrcode")
                            Text(yandexConnecting ? "Starting…" : "Connect with a code")
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.bgPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(yandexConnecting)

                    Button { showYandexPasteFallback.toggle() } label: {
                        Text(showYandexPasteFallback ? "Hide manual token" : "Or paste a token manually")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .buttonStyle(.plain)

                    if showYandexPasteFallback {
                        SecureField("Yandex OAuth token", text: $yandexToken)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .glassCard(cornerRadius: 14, intensity: 0.06)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            #endif
                        Button {
                            connectYandex()
                        } label: {
                            Text(yandexConnecting ? "Connecting…" : "Connect with token")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .glassCard(cornerRadius: 14, intensity: 0.06)
                        }
                        .buttonStyle(.plain)
                        .disabled(yandexConnecting || yandexToken.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
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

    private func loginVK() {
        vkLoggingIn = true
        vkError = nil
        Task {
            do {
                let response = try await api.vkOAuthURL()
                guard let url = URL(string: response.url) else {
                    await MainActor.run {
                        vkLoggingIn = false
                        vkError = "Server returned an invalid VK login URL."
                    }
                    return
                }
                await MainActor.run {
                    vkAuthURL = url
                    showVKAuth = true
                }
            } catch {
                await MainActor.run {
                    vkLoggingIn = false
                    vkError = "Could not open VK login. Check the server connection."
                }
            }
        }
    }

    private func finishVKLogin(token: String, userId: String?, state: String?) {
        Task {
            defer {
                vkLoggingIn = false
                showVKAuth = false
            }
            do {
                try await api.vkSetToken(token: token, username: userId.map { "VK User \($0)" }, state: state)
                let me = try await api.vkMe()
                await MainActor.run {
                    vkError = nil
                    settings.setVkAuth(authenticated: me.authenticated, username: me.username)
                }
            } catch {
                await MainActor.run {
                    settings.clearVkAuth()
                    vkError = "This VK login cannot access music. Reconnect with a working VK audio client on the server."
                }
            }
        }
    }

    private func refreshVKStatus() async {
        guard settings.sourceVK else { return }
        do {
            let me = try await api.vkMe()
            await MainActor.run {
                settings.setVkAuth(authenticated: me.authenticated, username: me.username)
                if me.authenticated { vkError = nil }
            }
        } catch {
            await MainActor.run {
                settings.clearVkAuth()
            }
        }
    }

    private func disconnectVK() {
        Task {
            try? await api.vkLogout()
            settings.clearVkAuth()
        }
    }

    private var streamQualityLabel: String {
        switch settings.streamQuality {
        case "low": return "Low (128)"
        case "normal": return "Normal (192)"
        default: return "High (320)"
        }
    }

    private func connectYandex() {
        let token = yandexToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        yandexConnecting = true
        yandexError = nil
        yandexPlusWarning = nil
        Task {
            defer { yandexConnecting = false }
            do {
                let res = try await api.yandexConnect(token: token)
                await MainActor.run {
                    settings.setYandexAuth(authenticated: true, username: res.login)
                    yandexToken = ""
                    if res.plus == false {
                        yandexPlusWarning = res.warning ?? "No active Yandex Plus — only 30s previews will play."
                    }
                }
                importYandexLikes()
            } catch {
                await MainActor.run {
                    settings.clearYandexAuth()
                    yandexError = "Could not connect Yandex. Check the token and that the server can reach Yandex."
                }
            }
        }
    }

    /// OAuth device flow. The SERVER polls Yandex in the background and captures
    /// the token, so this survives the app backgrounding to a browser. The app
    /// only shows the code and lightly checks /device/status (and re-checks when
    /// it returns to the foreground — see scenePhase handler).
    private func startYandexDeviceFlow() {
        yandexConnecting = true
        yandexError = nil
        yandexPlusWarning = nil
        yandexUserCode = ""
        Task {
            do {
                let start = try await api.yandexDeviceStart()
                await MainActor.run {
                    yandexUserCode = start.userCode
                    yandexVerificationURL = start.verificationUrl
                }
            } catch {
                await MainActor.run {
                    yandexConnecting = false
                    yandexUserCode = ""
                    yandexError = "Could not start Yandex authorization. Check the server connection."
                }
                return
            }
            // Light status polling — server holds the real state, so a paused/
            // resumed loop is fine. Runs up to ~6 min.
            let deadline = Date().addingTimeInterval(360)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if await checkYandexDeviceOnce() { return }
            }
            await MainActor.run {
                if !yandexUserCode.isEmpty {
                    yandexConnecting = false
                    yandexUserCode = ""
                    yandexError = "The code expired. Tap Connect to get a new one."
                }
            }
        }
    }

    /// One status check. Returns true when the flow has finished (done/expired/error).
    @discardableResult
    private func checkYandexDeviceOnce() async -> Bool {
        guard let status = try? await api.yandexDeviceStatus() else { return false } // transient → keep waiting
        switch status.state {
        case "done":
            await MainActor.run {
                settings.setYandexAuth(authenticated: true, username: status.login)
                yandexConnecting = false
                yandexUserCode = ""
                if status.plus == false {
                    yandexPlusWarning = "Connected, but no active Yandex Plus — only 30s previews will play."
                }
            }
            importYandexLikes()
            return true
        case "expired":
            await MainActor.run {
                yandexConnecting = false; yandexUserCode = ""
                yandexError = "The code expired. Tap Connect to get a new one."
            }
            return true
        case "error":
            await MainActor.run {
                yandexConnecting = false; yandexUserCode = ""
                yandexError = "Yandex rejected the authorization. Tap Connect to try again."
            }
            return true
        default:
            return false // pending
        }
    }

    private func refreshYandexStatus() async {
        guard settings.sourceYandex else { return }
        do {
            let me = try await api.yandexStatus()
            await MainActor.run {
                settings.setYandexAuth(authenticated: me.authenticated, username: me.username)
                if me.authenticated { yandexError = nil }
            }
        } catch {
            // Leave existing state; a transient server error shouldn't drop the badge.
        }
    }

    private func importYandexLikes() {
        guard settings.yandexAuthenticated, !yandexImporting else { return }
        yandexImporting = true
        yandexImportMessage = nil
        Task {
            do {
                let result = try await api.importYandexLikes()
                await MainActor.run {
                    yandexImporting = false
                    yandexImportMessage = result.imported > 0
                        ? "Added \(result.imported) likes"
                        : "Likes are up to date"
                }
            } catch {
                await MainActor.run {
                    yandexImporting = false
                    yandexImportMessage = "Could not sync likes"
                }
            }
        }
    }

    private func disconnectYandex() {
        Task {
            try? await api.yandexLogout()
            settings.clearYandexAuth()
        }
    }

    private func clearCache() {
        if let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: cacheDir)
            try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
            cacheSize = "0 MB"
        }
    }
}

struct VKAuthSheet: View {
    let authURL: URL
    let onSuccess: (String, String?, String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VKAuthWebView(authURL: authURL, onSuccess: onSuccess)
                .navigationTitle("VK Login")
                .navigationBarTitleDisplayModeCompat()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .foregroundStyle(Color.textPrimary)
                    }
                }
        }
    }
}

#if os(iOS)
struct VKAuthWebView: UIViewRepresentable {
    let authURL: URL
    let onSuccess: (String, String?, String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSuccess: onSuccess)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.load(URLRequest(url: authURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onSuccess: (String, String?, String?) -> Void
        private var handled = false

        init(onSuccess: @escaping (String, String?, String?) -> Void) {
            self.onSuccess = onSuccess
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            inspectForToken(webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @MainActor @Sendable @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if handleTokenURL(navigationAction.request.url) {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            inspectForToken(webView)
        }

        private func handleTokenURL(_ url: URL?) -> Bool {
            guard !handled, let url, url.absoluteString.contains("#access_token=") else { return false }
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
            let fragment = components.fragment ?? ""
            let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
            guard let token = params.first(where: { $0.name == "access_token" })?.value else { return false }
            let userId = params.first(where: { $0.name == "user_id" })?.value
            let state = params.first(where: { $0.name == "state" })?.value
            handled = true
            onSuccess(token, userId, state)
            return true
        }

        private func inspectForToken(_ webView: WKWebView) {
            guard !handled else { return }

            webView.evaluateJavaScript("window.location.href") { [weak self] result, _ in
                guard let self, !self.handled else { return }
                guard let href = result as? String, href.contains("#access_token=") else { return }
                guard let components = URLComponents(string: href) else { return }
                let fragment = components.fragment ?? ""
                let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
                guard let token = params.first(where: { $0.name == "access_token" })?.value else { return }
                let userId = params.first(where: { $0.name == "user_id" })?.value
                let state = params.first(where: { $0.name == "state" })?.value
                self.handled = true
                self.onSuccess(token, userId, state)
            }
        }
    }
}
#elseif os(macOS)
struct VKAuthWebView: NSViewRepresentable {
    let authURL: URL
    let onSuccess: (String, String?, String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSuccess: onSuccess)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: authURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onSuccess: (String, String?, String?) -> Void
        private var handled = false

        init(onSuccess: @escaping (String, String?, String?) -> Void) {
            self.onSuccess = onSuccess
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            inspectForToken(webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @MainActor @Sendable @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if handleTokenURL(navigationAction.request.url) {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            inspectForToken(webView)
        }

        private func handleTokenURL(_ url: URL?) -> Bool {
            guard !handled, let url, url.absoluteString.contains("#access_token=") else { return false }
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
            let fragment = components.fragment ?? ""
            let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
            guard let token = params.first(where: { $0.name == "access_token" })?.value else { return false }
            let userId = params.first(where: { $0.name == "user_id" })?.value
            let state = params.first(where: { $0.name == "state" })?.value
            handled = true
            onSuccess(token, userId, state)
            return true
        }

        private func inspectForToken(_ webView: WKWebView) {
            guard !handled else { return }

            webView.evaluateJavaScript("window.location.href") { [weak self] result, _ in
                guard let self, !self.handled else { return }
                guard let href = result as? String, href.contains("#access_token=") else { return }
                guard let components = URLComponents(string: href) else { return }
                let fragment = components.fragment ?? ""
                let params = URLComponents(string: "https://dummy?\(fragment)")?.queryItems ?? []
                guard let token = params.first(where: { $0.name == "access_token" })?.value else { return }
                let userId = params.first(where: { $0.name == "user_id" })?.value
                let state = params.first(where: { $0.name == "state" })?.value
                self.handled = true
                self.onSuccess(token, userId, state)
            }
        }
    }
}
#endif
