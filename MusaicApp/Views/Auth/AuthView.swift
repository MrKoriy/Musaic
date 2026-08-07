import SwiftUI

struct AuthView: View {
    @State private var isRegistering = false
    @State private var username = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var error: String?
    @State private var loading = false

    private let api = APIService.shared
    private let settings = SettingsStore.shared

    var body: some View {
        ZStack {
            AppBackdrop()

            ScrollView {
                VStack(spacing: 28) {
                    Spacer().frame(height: 60)

                    VStack(spacing: 8) {
                        Text("Musaic")
                            .font(.system(size: 42, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text(isRegistering ? "Create your account" : "Welcome back")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }

                    VStack(spacing: 14) {
                        if isRegistering {
                            field(icon: "person.fill", placeholder: "Display name", text: $displayName)
                        }
                        field(icon: "person", placeholder: "Username", text: $username)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                        field(icon: "lock", placeholder: "Password", text: $password, secure: true)
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
                            Text(isRegistering ? "Create Account" : "Sign In")
                                .font(.system(size: 16, weight: .bold, design: .rounded))
                        }
                        .foregroundStyle(Color.bgPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    }
                    .disabled(loading || username.count < 2 || password.count < 4)
                    .opacity(username.count < 2 || password.count < 4 ? 0.5 : 1)
                    .padding(.horizontal, 24)

                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            isRegistering.toggle()
                            error = nil
                        }
                    } label: {
                        Text(isRegistering ? "Already have an account? Sign In" : "Don't have an account? Register")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.textSecondary)
                    }

                    Spacer()
                }
            }
        }
    }

    private func field(icon: String, placeholder: String, text: Binding<String>, secure: Bool = false) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 20)
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

    @MainActor
    private func submit() async {
        loading = true
        error = nil
        defer { loading = false }

        do {
            let response: APIService.AuthResponse
            if isRegistering {
                response = try await api.register(
                    username: username.trimmingCharacters(in: .whitespaces),
                    password: password,
                    displayName: displayName.isEmpty ? nil : displayName
                )
            } else {
                response = try await api.login(
                    username: username.trimmingCharacters(in: .whitespaces),
                    password: password
                )
            }

            if let errMsg = response.error {
                error = errMsg
                return
            }

            guard let token = response.token, let user = response.user else {
                error = "Invalid server response"
                return
            }

            settings.setAuth(
                token: token,
                userId: user.id,
                username: user.username,
                displayName: user.displayName
            )
        } catch {
            self.error = "Connection failed: \(error.localizedDescription)"
        }
    }
}
