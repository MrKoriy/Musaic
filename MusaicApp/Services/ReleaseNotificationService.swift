import Foundation
import UserNotifications

/// Polls the server for new artist releases and surfaces them as local
/// notifications. Runs on the main actor; the network calls are async.
@MainActor
final class ReleaseNotificationService {
    static let shared = ReleaseNotificationService()

    private let api = APIService.shared
    private let defaults = UserDefaults.standard
    private let lastCheckKey = "release_notification_last_check"

    private init() {}

    /// Request notification permission (call once at launch).
    func requestAuthorizationIfNeeded() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
    }

    /// Check for new releases and notify. Throttled to at most once per hour.
    func checkForNewReleasesIfNeeded(force: Bool = false) async {
        let now = Date().timeIntervalSince1970
        let last = defaults.double(forKey: lastCheckKey)
        if !force, now - last < 3_600 { return }
        defaults.set(now, forKey: lastCheckKey)

        do {
            let releases = try await api.getNewReleases(limit: 20)
            guard !releases.isEmpty else { return }

            for release in releases.prefix(5) {
                scheduleNotification(for: release)
            }
            try await api.ackReleases(ids: releases.map(\.id))
        } catch {
            // Transient network/server errors are fine — we retry next launch.
        }
    }

    private func scheduleNotification(for release: APIService.Release) {
        let content = UNMutableNotificationContent()
        content.title = "\(release.artist) — \(release.title)"
        content.body = release.year.map { "New release • \($0)" } ?? "New release"
        if let count = release.trackCount { content.body += " • \(count) tracks" }
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "release-\(release.id)",
            content: content,
            trigger: nil // deliver immediately
        )
        UNUserNotificationCenter.current().add(request)
    }
}
