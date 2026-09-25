import Foundation
import UserNotifications

/// Polls the server for new artist releases and surfaces them as local
/// notifications. Releases are only acknowledged once they could be shown.
@MainActor
final class ReleaseNotificationService {
    static let shared = ReleaseNotificationService()

    private let api = APIService.shared
    private let lastCheckKey = "release_notification_last_check"

    private struct PendingNotification: Sendable {
        let id: String
        let title: String
        let body: String
    }

    private init() {}

    /// Request notification permission (call once at launch).
    func requestAuthorizationIfNeeded() {
        Task { await Self.requestAuthorizationIfUndetermined() }
    }

    /// Check for new releases and notify. Throttled to at most once per hour.
    func checkForNewReleasesIfNeeded(force: Bool = false) async {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        if !force, now - defaults.double(forKey: lastCheckKey) < 3_600 { return }
        // Without permission nothing can be shown: leave releases un-acked so
        // they surface once notifications are allowed.
        guard await Self.canDeliverNotifications() else { return }

        do {
            let releases = try await api.getNewReleases(limit: 20)
            defaults.set(now, forKey: lastCheckKey)
            guard !releases.isEmpty else { return }

            let pending = releases.prefix(5).map { release in
                var body = release.year.map { String(localized: "New release • \($0)") } ?? String(localized: "New release")
                if let count = release.trackCount { body += " • " + String(localized: "\(count) tracks") }
                return PendingNotification(id: release.id, title: "\(release.artist) — \(release.title)", body: body)
            }
            // The first five stand in for the rest; ack only if something was shown.
            guard await Self.deliver(Array(pending)) > 0 else { return }
            try await api.ackReleases(ids: releases.map(\.id))
        } catch {
            // Transient network/server errors are fine — we retry next time.
        }
    }

    // UserNotifications work stays in nonisolated helpers so no framework
    // objects cross into the main actor.
    nonisolated private static func requestAuthorizationIfUndetermined() async {
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    nonisolated private static func canDeliverNotifications() async -> Bool {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        #if os(iOS)
        if status == .ephemeral { return true }
        #endif
        return status == .authorized || status == .provisional
    }

    nonisolated private static func deliver(_ notifications: [PendingNotification]) async -> Int {
        let center = UNUserNotificationCenter.current()
        var delivered = 0
        for item in notifications {
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.body
            content.sound = .default
            let request = UNNotificationRequest(identifier: "release-\(item.id)", content: content, trigger: nil)
            if (try? await center.add(request)) != nil { delivered += 1 }
        }
        return delivered
    }
}
