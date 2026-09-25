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
                subtitle: String(localized: "Sources, accounts, playback defaults and server control.")
            )

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    statusChip(title: String(localized: "Server"), state: connectionLabel, showsConnectionDot: true)
                    statusChip(title: String(localized: "Yandex"), state: yandexState)
                    statusChip(title: "VK", state: vkState)
                    statusChip(title: String(localized: "Cache"), state: cacheSize)
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

    private func statusChip(title: String, state: String, showsConnectionDot: Bool = false) -> some View {
        HStack(spacing: 8) {
            if showsConnectionDot {
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
            Text(String(localized: "VK is no longer used for search or recommendations — only your already-liked VK tracks still play. Connect VK below to keep them playing."))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ProfilePlaybackSection: View {
    @Binding var streamQuality: String
    @Binding var crossfadeSeconds: Int
    @Binding var gapless: Bool
    @Binding var normalization: Bool

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Playback")) {
            ProfileSettingRow(title: String(localized: "Stream Quality"), value: streamQualityLabel) {
                let options = ["low", "normal", "high"]
                let index = options.firstIndex(of: streamQuality) ?? 2
                streamQuality = options[(index + 1) % options.count]
            }
            ProfileSettingRow(
                title: String(localized: "Crossfade"),
                value: crossfadeSeconds == 0 ? String(localized: "Off") : String(localized: "\(crossfadeSeconds)s")
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
            ProfileSourceToggle(title: String(localized: "Volume Normalization"), isOn: $normalization)
            Text(String(localized: "Stream Quality applies to Yandex (real bitrate tiers); other sources serve a fixed quality. Gapless uses a short seamless bridge between tracks when Crossfade is Off."))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var streamQualityLabel: String {
        switch streamQuality {
        case "low": return String(localized: "Low (128)")
        case "normal": return String(localized: "Normal (192)")
        default: return String(localized: "High (320)")
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
    let cacheSize: String
    let clearing: Bool
    let onClearCache: () -> Void

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Storage")) {
            ProfileSettingRow(title: String(localized: "Cache Size"), value: cacheSize)
            Button(clearing ? String(localized: "Clearing…") : String(localized: "Clear Cache"), action: onClearCache)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
                .disabled(clearing)
            Text(String(localized: "Removes cached artwork and server responses. Downloads are kept."))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ProfileServerSection: View {
    let serverURL: String
    let connectionButtonLabel: String
    let testing: Bool
    var message: String? = nil
    @Binding var editingServer: Bool
    @Binding var serverDraft: String
    let onSave: () -> Void
    let onTestConnection: () -> Void

    var body: some View {
        ProfileSettingsCard(title: String(localized: "Server")) {
            if editingServer {
                VStack(spacing: 10) {
                    ServerAddressField(text: $serverDraft)

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
                        Text(String(localized: "Tap to change the server address (e.g. a LAN IP)."))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }

            if let message {
                Text(message)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                onTestConnection()
            } label: {
                Text(testing ? String(localized: "Testing…") : connectionButtonLabel)
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
                Button(String(localized: "Sign Out"), role: .destructive) {
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
                Text(verbatim: "Musaic")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                Text(appVersionLabel)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                Text(String(localized: "A personal music player for your own server: local files, Yandex Music, YouTube and SoundCloud."))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textMuted)
            }
        }
    }
}
