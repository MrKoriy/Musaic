import SwiftUI

struct AuthView: View {
    @State private var isRegistering = false
    @State private var username = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var error: String?
    @State private var loading = false
    @State private var serverDraft = APIService.shared.serverURL
    @State private var serverCheck: APIService.ConnectionCheck?
    @State private var testingServer = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let api = APIService.shared
    private let settings = SettingsStore.shared

    private var canSubmit: Bool {
        !loading && username.trimmingCharacters(in: .whitespaces).count >= 2 && password.count >= 4
    }

    var body: some View {
        ZStack {
            AppBackdrop()

            ScrollView {
                VStack(spacing: 28) {
                    Spacer().frame(height: 60)

                    VStack(spacing: 8) {
                        Text(verbatim: "Musaic")
                            .font(.system(size: 42, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text(isRegistering ? String(localized: "Create your account") : String(localized: "Welcome back"))
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }

                    serverSection
                        .padding(.horizontal, 24)

                    VStack(spacing: 14) {
                        if isRegistering {
                            field(icon: "person.fill", placeholder: String(localized: "Display name"), text: $displayName)
                        }
                        field(icon: "person", placeholder: String(localized: "Username"), text: $username)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                        field(icon: "lock", placeholder: String(localized: "Password"), text: $password, secure: true)
                    }
                    .padding(.horizontal, 24)

                    if let error {
                        Text(error)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        HStack(spacing: 10) {
                            if loading {
                                ProgressView().tint(Color.bgPrimary).scaleEffect(0.8)
                            }
                            Text(isRegistering ? String(localized: "Create Account") : String(localized: "Sign In"))
                                .font(.system(size: 16, weight: .bold, design: .rounded))
                        }
                        .foregroundStyle(Color.bgPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSubmit)
                    .opacity(canSubmit || loading ? 1 : 0.5)
                    .padding(.horizontal, 24)

                    Button {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                            isRegistering.toggle()
                            error = nil
                        }
                    } label: {
                        Text(isRegistering ? String(localized: "Already have an account? Sign In") : String(localized: "Don't have an account? Register"))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .buttonStyle(.plain)

                    Spacer()
                }
            }
        }
    }

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                ServerAddressField(text: $serverDraft)
                    .onSubmit { Task { await testServer() } }
                    .onChange(of: serverDraft) { serverCheck = nil }

                Button {
                    Task { await testServer() }
                } label: {
                    Group {
                        if testingServer {
                            ProgressView().tint(Color.textPrimary)
                        } else {
                            Image(systemName: serverStatusIcon)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(serverStatusColor)
                        }
                    }
                    .frame(width: 48, height: 48)
                    .glassCard(cornerRadius: 18, intensity: 0.08)
                }
                .buttonStyle(.plain)
                .disabled(testingServer)
                .accessibilityLabel(Text(String(localized: "Test connection")))
            }

            if let serverCheck {
                Text(serverCheck.message)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(serverCheck == .ok ? Color.textSecondary : Color.accentStrong)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var serverStatusIcon: String {
        switch serverCheck {
        case .ok: return "checkmark.circle.fill"
        case .none: return "antenna.radiowaves.left.and.right"
        default: return "exclamationmark.triangle.fill"
        }
    }

    private var serverStatusColor: Color {
        switch serverCheck {
        case .ok: return .green
        case .none: return Color.textPrimary
        default: return Color.accentStrong
        }
    }

    private func field(icon: String, placeholder: String, text: Binding<String>, secure: Bool = false) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            if secure {
                SecureField(placeholder, text: text)
                    .textFieldStyle(.plain)
                    .foregroundStyle(Color.textPrimary)
            } else {
                TextField(placeholder, text: text)
                    .textFieldStyle(.plain)
                    .foregroundStyle(Color.textPrimary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
        )
    }

    private func testServer() async {
        guard !testingServer else { return }
        guard APIService.validatedServerURL(serverDraft) != nil else {
            serverCheck = .invalidAddress
            return
        }
        testingServer = true
        serverCheck = await api.checkConnection(to: serverDraft)
        testingServer = false
    }

    /// Saves the (validated) server address, then authenticates against it.
    private func applyServerDraft() -> Bool {
        guard let normalized = APIService.validatedServerURL(serverDraft) else {
            serverCheck = .invalidAddress
            return false
        }
        if normalized != api.serverURL {
            api.setServerURL(normalized)
        }
        serverDraft = normalized
        return true
    }

    private func submit() async {
        guard applyServerDraft() else { return }
        loading = true
        error = nil
        defer { loading = false }

        do {
            let trimmedUsername = username.trimmingCharacters(in: .whitespaces)
            let response: APIService.AuthResponse
            if isRegistering {
                response = try await api.register(
                    username: trimmedUsername,
                    password: password,
                    displayName: displayName.isEmpty ? nil : displayName
                )
            } else {
                response = try await api.login(username: trimmedUsername, password: password)
            }

            if let errMsg = response.error {
                error = errMsg
                return
            }

            guard let token = response.token, let user = response.user else {
                error = String(localized: "Invalid server response")
                return
            }

            LibraryStore.shared.prepareForUser(user.id)
            guard settings.setAuth(
                token: token,
                userId: user.id,
                username: user.username,
                displayName: user.displayName
            ) else {
                error = String(localized: "Unable to securely store the session. Try again.")
                return
            }
        } catch where error.isCancellation {
            return
        } catch {
            self.error = String(localized: "Connection failed: \(error.localizedDescription)")
        }
    }
}
