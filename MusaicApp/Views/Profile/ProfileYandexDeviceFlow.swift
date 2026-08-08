import Foundation

extension ProfileAuthState {
    /// OAuth device flow. The SERVER polls Yandex in the background and captures
    /// the token, so this survives the app backgrounding to a browser. The app
    /// only shows the code and lightly checks /device/status.
    func startYandexDeviceFlow() {
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
    func checkYandexDeviceOnce() async -> Bool {
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
                yandexConnecting = false
                yandexUserCode = ""
                yandexError = "The code expired. Tap Connect to get a new one."
            }
            return true
        case "error":
            await MainActor.run {
                yandexConnecting = false
                yandexUserCode = ""
                yandexError = "Yandex rejected the authorization. Tap Connect to try again."
            }
            return true
        default:
            return false // pending
        }
    }
}
