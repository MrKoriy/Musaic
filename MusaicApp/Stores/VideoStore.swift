import AVFoundation
import Foundation

// MARK: - Video API models

/// Matched music video for a track (`GET /api/videos/for-track/:id`).
struct TrackVideoInfo: Decodable, Equatable, Sendable {
    let available: Bool
    let videoId: String?
    let title: String?
    let channel: String?
    let duration: Double?
    let thumbnailUrl: String?
}

/// Freshly resolved muxed stream (`GET /api/videos/:videoId/resolve`).
struct ResolvedVideoStream: Decodable, Sendable {
    let url: String
    /// googlevideo signed-URL expiry as epoch seconds; may be absent.
    let expiresAt: TimeInterval?
    let duration: Double?
}

// MARK: - Video Store

/**
 * Music-video playback state (the Now Playing clip surface, macOS for now).
 *
 * Flow: `trackDidChange` looks up the match (server-cached after the first
 * call). When the user has video mode on, we resolve a playable URL and
 * hot-swap the AVPlayer's item mid-track (`AudioPlayer.upgradeToVideo`) —
 * audio starts instantly, the clip fades in a moment later at the right
 * position. Toggling off swaps back to the audio stream the same way.
 */
@MainActor
@Observable
final class VideoStore {
    static let shared = VideoStore()

    private let api = APIService.shared
    private let audio = AudioPlayer.shared

    /// The matched clip for the current track; nil while unknown/unavailable.
    private(set) var currentVideo: TrackVideoInfo?
    /// User preference: watch the clip instead of the artwork when one exists.
    private(set) var videoModeEnabled = false

    @ObservationIgnored private var lookedUpTrackID: String?
    @ObservationIgnored private var lookupTask: Task<Void, Never>?
    @ObservationIgnored private var upgradeTask: Task<Void, Never>?
    /// One automatic re-resolve per track after a video-item failure.
    @ObservationIgnored private var retriedResolveForTrackID: String?

    // Resolved stream cache (googlevideo URLs live ~6h).
    @ObservationIgnored private var resolvedVideoID: String?
    @ObservationIgnored private var resolvedURL: URL?
    @ObservationIgnored private var resolvedExpiresAt: Date?

    private static let enabledKey = "video_mode_enabled"
    /// Fallback lifetime when the resolved URL carries no expiry hint.
    private static let assumedStreamLifetime: TimeInterval = 5 * 3600

    private init() {
        videoModeEnabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        audio.onVideoItemFailed = { [weak self] in self?.handleVideoItemFailure() }
    }

    // MARK: - Track changes

    /// Called by PlayerStore whenever the current track changes (or parks).
    func trackDidChange(_ track: Track?) {
        lookupTask?.cancel()
        upgradeTask?.cancel()
        currentVideo = nil
        lookedUpTrackID = track?.id
        retriedResolveForTrackID = nil
        resolvedVideoID = nil
        resolvedURL = nil
        resolvedExpiresAt = nil

        guard let track else { return }
        lookupTask = Task { [weak self] in
            guard let info = try? await self?.api.fetchVideoInfo(trackId: track.id),
                  !Task.isCancelled else { return }
            guard let self, self.lookedUpTrackID == track.id else { return }
            self.currentVideo = info.available ? info : nil
            if self.videoModeEnabled { self.scheduleUpgradeIfPossible() }
        }
    }

    // MARK: - Toggle

    func toggleVideoMode() {
        setVideoModeEnabled(!videoModeEnabled)
    }

    func setVideoModeEnabled(_ enabled: Bool) {
        guard enabled != videoModeEnabled else { return }
        videoModeEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        if enabled {
            scheduleUpgradeIfPossible()
        } else {
            upgradeTask?.cancel()
            audio.downgradeToAudio()
        }
    }

    /// Logout: drop per-track state; the preference itself survives.
    func reset() {
        lookupTask?.cancel()
        upgradeTask?.cancel()
        currentVideo = nil
        lookedUpTrackID = nil
        retriedResolveForTrackID = nil
        resolvedVideoID = nil
        resolvedURL = nil
        resolvedExpiresAt = nil
    }

    // MARK: - Upgrade / fallback

    private func scheduleUpgradeIfPossible() {
        guard videoModeEnabled,
              let videoId = currentVideo?.videoId,
              // Only upgrade a track that's actually loaded in the engine.
              audio.hasLoadedItem, audio.loadedTrackID == lookedUpTrackID else { return }
        let trackID = lookedUpTrackID
        upgradeTask?.cancel()
        upgradeTask = Task { [weak self] in
            guard let self else { return }
            do {
                let url = try await self.resolvedStreamURL(for: videoId)
                guard !Task.isCancelled, self.videoModeEnabled,
                      self.currentVideo?.videoId == videoId,
                      self.lookedUpTrackID == trackID,
                      self.audio.hasLoadedItem, self.audio.loadedTrackID == trackID else { return }
                self.audio.upgradeToVideo(url: url)
            } catch {
                // Resolve failed: stay on the artwork, audio keeps playing.
            }
        }
    }

    /// The video item failed mid-playback (usually an expired googlevideo
    /// URL): re-resolve once per track, then give up to plain audio.
    private func handleVideoItemFailure() {
        guard videoModeEnabled,
              let videoId = currentVideo?.videoId,
              let trackID = lookedUpTrackID else {
            audio.downgradeToAudio()
            return
        }
        guard retriedResolveForTrackID != trackID else {
            audio.downgradeToAudio()
            return
        }
        retriedResolveForTrackID = trackID
        resolvedURL = nil
        resolvedExpiresAt = nil

        upgradeTask?.cancel()
        upgradeTask = Task { [weak self] in
            guard let self else { return }
            do {
                let url = try await self.resolvedStreamURL(for: videoId)
                guard !Task.isCancelled, self.videoModeEnabled,
                      self.currentVideo?.videoId == videoId,
                      self.lookedUpTrackID == trackID else { return }
                self.audio.upgradeToVideo(url: url)
            } catch {
                self.audio.downgradeToAudio()
            }
        }
    }

    private func resolvedStreamURL(for videoId: String) async throws -> URL {
        if resolvedVideoID == videoId,
           let resolvedURL,
           let resolvedExpiresAt,
           Self.isResolvedStreamFresh(expiresAt: resolvedExpiresAt) {
            return resolvedURL
        }
        let stream = try await api.resolveVideoStream(videoId: videoId)
        guard let url = URL(string: stream.url) else {
            throw URLError(.badURL)
        }
        resolvedVideoID = videoId
        resolvedURL = url
        resolvedExpiresAt = stream.expiresAt.map { Date(timeIntervalSince1970: $0) }
            ?? Date().addingTimeInterval(Self.assumedStreamLifetime)
        return url
    }

    /// A resolved URL counts as fresh until a minute before its signed expiry,
    /// so playback never starts on a link about to die.
    nonisolated static func isResolvedStreamFresh(expiresAt: Date, now: Date = .now) -> Bool {
        expiresAt.timeIntervalSince(now) > 60
    }
}
