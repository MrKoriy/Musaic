import SwiftUI

@Observable
@MainActor
final class ProfileAuthState {
    var vkLoggingIn = false
    var showVKAuth = false
    var vkAuthURL: URL?
    var vkError: String?

    var yandexToken = ""
    var yandexConnecting = false
    var yandexError: String?
    var yandexPlusWarning: String?
    var yandexUserCode = ""
    var yandexVerificationURL = "https://ya.ru/device"
    var showYandexPasteFallback = false
    var yandexImporting = false
    var yandexImportMessage: String?

    let api = APIService.shared
    let settings = SettingsStore.shared

    func loginVK() {
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

    func finishVKLogin(token: String, userId: String?, state: String?) {
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

    func refreshVKStatus() async {
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

    func disconnectVK() {
        Task {
            try? await api.vkLogout()
            settings.clearVkAuth()
        }
    }

    func connectYandex() {
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

    func refreshYandexStatus() async {
        guard settings.sourceYandex else { return }
        do {
            let me = try await api.yandexStatus()
            await MainActor.run {
                settings.setYandexAuth(authenticated: me.authenticated, username: me.username)
                if me.authenticated { yandexError = nil }
            }
        } catch {
            // Leave existing state; a transient server error should not drop the badge.
        }
    }

    func importYandexLikes() {
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

    func disconnectYandex() {
        Task {
            try? await api.yandexLogout()
            settings.clearYandexAuth()
        }
    }
}

struct ProfileVKSection: View {
    @Bindable var auth: ProfileAuthState
    private let settings = SettingsStore.shared

    var body: some View {
        ProfileSettingsCard(title: "VK Music") {
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
                    Button(String(localized: "Disconnect")) {
                        auth.disconnectVK()
                    }
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

                    if let vkError = auth.vkError {
                        Text(vkError)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        auth.loginVK()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "globe")
                            Text(auth.vkLoggingIn ? String(localized: "Opening VK...") : String(localized: "Login to VK"))
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.bgPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(auth.vkLoggingIn)
                }
            }
        }
        .sheet(isPresented: $auth.showVKAuth, onDismiss: {
            auth.vkLoggingIn = false
        }) {
            if let authURL = auth.vkAuthURL {
                VKAuthSheet(authURL: authURL) { token, userId, state in
                    auth.finishVKLogin(token: token, userId: userId, state: state)
                }
            }
        }
    }
}

struct ProfileYandexSection: View {
    @Bindable var auth: ProfileAuthState
    private let settings = SettingsStore.shared

    var body: some View {
        ProfileSettingsCard(title: "Yandex Music") {
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
                    Button(String(localized: "Disconnect")) {
                        auth.disconnectYandex()
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .glassCard(cornerRadius: 18, intensity: 0.08)
                }
                HStack(spacing: 10) {
                    Button {
                        auth.importYandexLikes()
                    } label: {
                        Label(
                            auth.yandexImporting ? String(localized: "Syncing…") : String(localized: "Sync Yandex likes"),
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                    }
                    .buttonStyle(.plain)
                    .disabled(auth.yandexImporting)
                    if let yandexImportMessage = auth.yandexImportMessage {
                        Text(yandexImportMessage)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .lineLimit(2)
                    }
                }
                if let yandexPlusWarning = auth.yandexPlusWarning {
                    Text(yandexPlusWarning)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if !auth.yandexUserCode.isEmpty {
                // Device-flow in progress: show the code + open the verification page.
                VStack(alignment: .leading, spacing: 12) {
                    Text("Open the Yandex page, sign in, and enter this code exactly as shown (valid ~5 min):")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    // Show the code verbatim — Yandex codes are lowercase and
                    // case-sensitive, so never transform the case here.
                    Text(auth.yandexUserCode)
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(Color.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .glassCard(cornerRadius: 16, intensity: 0.08)
                    if let url = URL(string: auth.yandexVerificationURL) {
                        Link(destination: url) {
                            HStack(spacing: 10) {
                                Image(systemName: "safari")
                                Text("Open \(auth.yandexVerificationURL.replacingOccurrences(of: "https://", with: ""))")
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

                    if let yandexError = auth.yandexError {
                        Text(yandexError)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        auth.startYandexDeviceFlow()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "qrcode")
                            Text(auth.yandexConnecting ? String(localized: "Starting…") : String(localized: "Connect with a code"))
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.bgPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(auth.yandexConnecting)

                    Button { auth.showYandexPasteFallback.toggle() } label: {
                        Text(auth.showYandexPasteFallback ? String(localized: "Hide manual token") : String(localized: "Or paste a token manually"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .buttonStyle(.plain)

                    if auth.showYandexPasteFallback {
                        SecureField("Yandex OAuth token", text: $auth.yandexToken)
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
                            auth.connectYandex()
                        } label: {
                            Text(auth.yandexConnecting ? String(localized: "Connecting…") : String(localized: "Connect with token"))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .glassCard(cornerRadius: 14, intensity: 0.06)
                        }
                        .buttonStyle(.plain)
                        .disabled(auth.yandexConnecting || auth.yandexToken.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }
}
