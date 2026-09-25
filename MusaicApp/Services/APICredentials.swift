import Foundation
import os

/// Lock-protected snapshot of the server address and bearer token. Code that
/// runs off the main actor (artwork loader, background downloads) authorizes
/// requests through this instead of hopping to `APIService`/Keychain.
final class APICredentials: Sendable {
    static let shared = APICredentials()

    private struct State: Sendable {
        var serverURL: URL?
        var token: String?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    private init() {}

    var token: String? { state.withLock { $0.token } }
    var serverURL: URL? { state.withLock { $0.serverURL } }

    func setToken(_ token: String?) {
        state.withLock { $0.token = token }
    }

    func setServerURL(_ string: String) {
        let url = URL(string: string)
        state.withLock { $0.serverURL = url }
    }

    /// True when `url` targets the configured Musaic server (host + port).
    func isServerURL(_ url: URL) -> Bool {
        guard let server = serverURL,
              let host = url.host?.lowercased(),
              host == server.host?.lowercased() else { return false }
        return Self.effectivePort(url) == Self.effectivePort(server)
    }

    /// Adds the bearer token, but only for requests to our own server so the
    /// token never leaks to third-party artwork hosts.
    func authorize(_ request: inout URLRequest) {
        guard let url = request.url, isServerURL(url), let token else { return }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private static func effectivePort(_ url: URL) -> Int {
        if let port = url.port { return port }
        return url.scheme?.lowercased() == "https" ? 443 : 80
    }
}
