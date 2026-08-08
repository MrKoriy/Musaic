import SwiftUI

struct ProfileSettingsCard<Content: View>: View {
    let title: String
    private let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            content
        }
        .padding(18)
        .glassCard(cornerRadius: 28, intensity: 0.10)
        .padding(.horizontal, 18)
    }
}

struct ProfileSourceToggle: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.textPrimary)
        }
        .toggleStyle(.switch)
        .tint(Color.accentStrong)
    }
}

struct ProfileSettingRow: View {
    let title: String
    let value: String
    let action: (() -> Void)?

    init(title: String, value: String, action: (() -> Void)? = nil) {
        self.title = title
        self.value = value
        self.action = action
    }

    var body: some View {
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
}

struct ProfileStatusSection: View {
    let connectionOk: Bool?
    let connectionLabel: String
    let yandexState: String
    let vkState: String
    let cacheSize: String
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            LiquidSectionHeader(
                title: String(localized: "Settings"),
                subtitle: String(localized: "Sources, VK access, playback defaults and server control.")
            )

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    statusChip(title: "Server", state: connectionLabel)
                    statusChip(title: "Yandex", state: yandexState)
                    statusChip(title: "VK", state: vkState)
                    statusChip(title: "Cache", state: cacheSize)
                }
            }

            if connectionOk == false {
                ErrorRetryView(
                    title: String(localized: "Server unavailable"),
                    message: String(localized: "Check the server address and try again."),
                    onRetry: onRetry
                )
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
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
}

struct ProfileSourcesSection: View {
    @Binding var sourceYandex: Bool
    @Binding var sourceYoutube: Bool
    @Binding var sourceSoundcloud: Bool
    @Binding var sourceVK: Bool

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Music Sources")) {
            ProfileSourceToggle(title: String(localized: "Local Library"), isOn: .constant(true))
            ProfileSourceToggle(title: String(localized: "Yandex Music"), isOn: $sourceYandex)
            ProfileSourceToggle(title: String(localized: "YouTube Music"), isOn: $sourceYoutube)
            ProfileSourceToggle(title: String(localized: "SoundCloud"), isOn: $sourceSoundcloud)
            ProfileSourceToggle(title: String(localized: "VK (liked tracks only)"), isOn: $sourceVK)
            Text("VK is no longer used for search or recommendations — only your already-liked VK tracks still play. Connect VK below to keep them playing.")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ProfileAppearanceSection: View {
    @Binding var theme: AppTheme

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Appearance")) {
            Picker(String(localized: "Theme"), selection: $theme) {
                ForEach(AppTheme.allCases) { theme in
                    Text(theme.localizedName).tag(theme)
                }
            }
            .pickerStyle(.menu)
            .tint(Color.textPrimary)
        }
    }
}

struct ProfilePlaybackSection: View {
    @Binding var streamQuality: String
    @Binding var crossfadeSeconds: Int
    @Binding var gapless: Bool

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Playback")) {
            ProfileSettingRow(title: String(localized: "Stream Quality"), value: streamQualityLabel) {
                let options = ["low", "normal", "high"]
                let index = options.firstIndex(of: streamQuality) ?? 2
                streamQuality = options[(index + 1) % options.count]
            }
            ProfileSettingRow(
                title: String(localized: "Crossfade"),
                value: crossfadeSeconds == 0 ? String(localized: "Off") : "\(crossfadeSeconds)s"
            ) {
                let options = [0, 2, 5, 10]
                let index = options.firstIndex(of: crossfadeSeconds) ?? 0
                crossfadeSeconds = options[(index + 1) % options.count]
                AudioPlayer.shared.applyPlaybackSettings()
            }
            ProfileSourceToggle(
                title: String(localized: "Gapless Playback"),
                isOn: Binding(
                    get: { gapless },
                    set: {
                        gapless = $0
                        AudioPlayer.shared.applyPlaybackSettings()
                    }
                )
            )
            Text("Stream Quality applies to Yandex (real bitrate tiers); other sources serve a fixed quality. Gapless uses a short seamless bridge between tracks when Crossfade is Off.")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(String(localized: "Volume Normalization"))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.textMuted)
                Spacer()
                Text(String(localized: "Coming soon"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
            }
        }
    }

    private var streamQualityLabel: String {
        switch streamQuality {
        case "low": return "Low (128)"
        case "normal": return "Normal (192)"
        default: return "High (320)"
        }
    }
}

struct ProfileDownloadsSection: View {
    private let downloads = DownloadManager.shared

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Downloads")) {
            ProfileSettingRow(title: String(localized: "Offline Tracks"), value: "\(downloads.downloadCount)")
            ProfileSettingRow(title: String(localized: "Storage Used"), value: downloads.totalSizeFormatted)
            if downloads.downloadCount > 0 {
                Button(String(localized: "Delete All Downloads")) {
                    downloads.deleteAllDownloads()
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.red)
            }
        }
    }
}

struct ProfileStorageSection: View {
    @Binding var cacheSize: String
    let onClearCache: () -> Void

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Storage")) {
            ProfileSettingRow(title: String(localized: "Cache Size"), value: cacheSize)
            Button(String(localized: "Clear Cache"), action: onClearCache)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
        }
    }
}

struct ProfileServerSection: View {
    let serverURL: String
    let connectionButtonLabel: String
    let testing: Bool
    @Binding var editingServer: Bool
    @Binding var serverDraft: String
    let onSave: () -> Void
    let onTestConnection: () -> Void

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Server")) {
            if editingServer {
                VStack(spacing: 10) {
                    TextField("45.146.167.109:3001", text: $serverDraft)
                        .textFieldStyle(.plain)
                        .foregroundStyle(Color.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .glassCard(cornerRadius: 18, intensity: 0.08)

                    if serverDraft.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("http://") {
                        Text(String(localized: "HTTP is unencrypted. Use HTTPS for public servers."))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    HStack(spacing: 10) {
                        Button(String(localized: "Save"), action: onSave)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.bgPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                        Button(String(localized: "Cancel")) {
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
                    serverDraft = serverURL
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(serverURL)
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
                onTestConnection()
            } label: {
                Text(testing ? String(localized: "Testing...") : connectionButtonLabel)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .glassCard(cornerRadius: 18, intensity: 0.08)
            }
            .buttonStyle(.plain)
            .disabled(testing)
        }
    }
}

struct ProfileAccountSection: View {
    private let api = APIService.shared
    private let settings = SettingsStore.shared

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Account")) {
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
                Button(String(localized: "Sign Out")) {
                    Task { await api.logout() }
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.red)
            }
        }
    }
}

struct ProfileAboutSection: View {
    let appVersionLabel: String

    var body: some View {
        ProfileSettingsCard(title: String(localized: "About")) {
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
}
