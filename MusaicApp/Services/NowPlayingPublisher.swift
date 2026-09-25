import Foundation
#if os(iOS)
import ActivityKit
import UIKit
import WidgetKit
#endif

/// Fans the settled playback state out to the system surfaces: the App Group
/// snapshot (widget), the Live Activity, the watch and widget reloads.
/// PlayerStore calls `publish` on every relevant change; this type drops
/// duplicates and throttles the expensive parts.
@MainActor
final class NowPlayingPublisher {
    static let shared = NowPlayingPublisher()

    private struct PublishedState: Equatable {
        let trackId: String
        let title: String
        let artist: String
        let album: String?
        let artworkURL: String?
        let isPlaying: Bool
        let liked: Bool
        let hasArtwork: Bool
    }

    private var lastPublished: PublishedState?
    private var lastInput: (track: Track, isPlaying: Bool, position: TimeInterval, duration: TimeInterval)?
    private var isCleared = false

    #if os(iOS)
    private var artworkTrackID: String?
    private var artworkReadyTrackID: String?
    private var artworkData: Data?
    private var artworkTask: Task<Void, Never>?
    private var lastWidgetReload = Date.distantPast
    private var pendingWidgetReload: Task<Void, Never>?
    private static let widgetReloadInterval: TimeInterval = 2
    /// Widget / Live Activity artwork edge in pixels (56 pt @3x).
    private static let artworkPixelSize = 180
    #endif

    private init() {}

    func publish(track: Track, isPlaying: Bool, position: TimeInterval, duration: TimeInterval, force: Bool = false) {
        lastInput = (track, isPlaying, position, duration)
        isCleared = false

        #if os(iOS)
        refreshArtworkIfNeeded(for: track)
        let hasArtwork = artworkReadyTrackID == track.id
        let liked = LibraryStore.shared.likedTrackIds.contains(track.id)
        #else
        let hasArtwork = false
        let liked = false
        #endif

        let state = PublishedState(
            trackId: track.id,
            title: track.title,
            artist: track.artist,
            album: track.album,
            artworkURL: track.artwork,
            isPlaying: isPlaying,
            liked: liked,
            hasArtwork: hasArtwork
        )
        guard force || state != lastPublished else { return }
        lastPublished = state

        let now = Date()
        let safeDuration = duration.isFinite ? max(0, duration) : 0
        var safePosition = position.isFinite ? max(0, position) : 0
        if safeDuration > 0 { safePosition = min(safePosition, safeDuration) }
        let snapshot = NowPlayingSnapshot(
            trackId: track.id,
            title: track.title,
            artist: track.artist,
            artworkURL: track.artwork,
            isPlaying: isPlaying,
            updatedAt: Int(now.timeIntervalSince1970),
            album: track.album,
            position: safePosition,
            duration: safeDuration > 0 ? safeDuration : nil,
            positionTimestamp: now.timeIntervalSince1970
        )
        NowPlayingShared.save(snapshot)

        #if os(iOS)
        WatchControlHandler.shared.pushState(
            snapshot,
            liked: liked,
            artwork: hasArtwork ? artworkData : nil,
            volume: AudioPlayer.shared.userVolume
        )
        NowPlayingActivityController.shared.update(snapshot: snapshot, hasArtwork: hasArtwork)
        scheduleWidgetReload()
        #endif
    }

    /// Lets the Live Activity go (queue finished, sleep timer) while keeping
    /// the widget snapshot.
    func endActivity(dismissAfter seconds: TimeInterval?) {
        #if os(iOS)
        NowPlayingActivityController.shared.end(dismissAfter: seconds)
        #endif
    }

    /// Wipes every surface: snapshot, artwork, Live Activity, widget, watch.
    func clear() {
        guard !isCleared else { return }
        isCleared = true
        lastPublished = nil
        lastInput = nil
        NowPlayingShared.clear()
        #if os(iOS)
        artworkTask?.cancel()
        artworkTask = nil
        artworkTrackID = nil
        artworkReadyTrackID = nil
        artworkData = nil
        NowPlayingActivityController.shared.end(dismissAfter: nil)
        WatchControlHandler.shared.pushCleared()
        reloadWidgetsNow()
        #endif
    }

    #if os(iOS)
    // MARK: - Artwork for widget / Live Activity / watch

    private func refreshArtworkIfNeeded(for track: Track) {
        guard artworkTrackID != track.id else { return }
        artworkTrackID = track.id
        artworkReadyTrackID = nil
        artworkData = nil
        artworkTask?.cancel()
        artworkTask = nil

        let trackID = track.id
        if let existing = NowPlayingShared.loadArtworkData(for: trackID) {
            artworkReadyTrackID = trackID
            artworkData = existing
            return
        }
        guard let urlString = track.artwork, let url = URL(string: urlString) else {
            NowPlayingShared.removeArtworkFiles(keeping: nil)
            return
        }
        let pixelSize = Self.artworkPixelSize
        artworkTask = Task { @MainActor [weak self] in
            guard let result = try? await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: pixelSize) else { return }
            // ~180 px: encoding is cheap enough for the main actor.
            guard let self, !Task.isCancelled, self.artworkTrackID == trackID,
                  let data = result.image.jpegData(compressionQuality: 0.78) else { return }
            guard NowPlayingShared.writeArtwork(data, for: trackID) else { return }
            self.artworkReadyTrackID = trackID
            self.artworkData = data
            // Re-render the widget / Live Activity with the image.
            self.republishLastInput()
        }
    }

    private func republishLastInput() {
        guard let input = lastInput else { return }
        publish(track: input.track, isPlaying: input.isPlaying, position: input.position, duration: input.duration, force: true)
    }

    // MARK: - Widget reloads

    /// Coalesces reloads to at most one per `widgetReloadInterval`, always
    /// ending with a trailing reload so the final state is shown.
    private func scheduleWidgetReload() {
        guard pendingWidgetReload == nil else { return }
        let elapsed = Date().timeIntervalSince(lastWidgetReload)
        if elapsed >= Self.widgetReloadInterval {
            reloadWidgetsNow()
            return
        }
        let delay = Self.widgetReloadInterval - elapsed
        pendingWidgetReload = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.pendingWidgetReload = nil
            self.reloadWidgetsNow()
        }
    }

    private func reloadWidgetsNow() {
        pendingWidgetReload?.cancel()
        pendingWidgetReload = nil
        lastWidgetReload = Date()
        WidgetCenter.shared.reloadTimelines(ofKind: NowPlayingShared.widgetKind)
    }
    #endif
}

#if os(iOS)
/// Owns the single "Now Playing" Live Activity: starts it when playback
/// starts, mirrors state changes, sets a stale date and ends it when playback
/// stops. Progress animates on its own via `playbackStart/End`, so the app
/// only pushes on real state changes.
@MainActor
final class NowPlayingActivityController {
    static let shared = NowPlayingActivityController()

    private typealias ContentState = MusaicLiveActivityAttributes.ContentState
    private var lastState: ContentState?
    /// Serializes ActivityKit calls so an end can't overtake an update.
    private var operationChain: Task<Void, Never>?

    private init() {}

    func update(snapshot: NowPlayingSnapshot, hasArtwork: Bool) {
        let interval = snapshot.playbackInterval
        let state = ContentState(
            trackId: snapshot.trackId,
            title: snapshot.title,
            artist: snapshot.artist,
            artworkURL: snapshot.artworkURL,
            isPlaying: snapshot.isPlaying,
            progress: snapshot.progressFraction,
            playbackStart: interval?.lowerBound,
            playbackEnd: interval?.upperBound,
            hasArtwork: hasArtwork
        )
        guard state != lastState else { return }
        lastState = state
        // Playing: stale shortly after the track should have ended (app gone).
        // Paused: stale after half an hour.
        let staleDate = interval.map { $0.upperBound.addingTimeInterval(30) } ?? Date().addingTimeInterval(30 * 60)
        let allowStart = snapshot.isPlaying
        enqueue {
            await Self.apply(state: state, staleDate: staleDate, allowStart: allowStart)
        }
    }

    func end(dismissAfter seconds: TimeInterval?) {
        lastState = nil
        let dismissAt = seconds.map { Date().addingTimeInterval($0) }
        enqueue {
            await Self.endAll(dismissAt: dismissAt)
        }
    }

    private func enqueue(_ operation: @escaping @Sendable () async -> Void) {
        let previous = operationChain
        operationChain = Task {
            await previous?.value
            await operation()
        }
    }

    // ActivityKit work stays nonisolated so activities never cross actors.
    private nonisolated static func apply(state: ContentState, staleDate: Date, allowStart: Bool) async {
        let activities = Activity<MusaicLiveActivityAttributes>.activities
        if activities.isEmpty {
            guard allowStart, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            // Fails when started from the background; the next foreground
            // state change retries.
            _ = try? Activity.request(
                attributes: MusaicLiveActivityAttributes(),
                content: ActivityContent(state: state, staleDate: staleDate),
                pushType: nil
            )
            return
        }
        for (index, activity) in activities.enumerated() {
            if index == 0 {
                await activity.update(ActivityContent(state: state, staleDate: staleDate))
            } else {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    private nonisolated static func endAll(dismissAt: Date?) async {
        for activity in Activity<MusaicLiveActivityAttributes>.activities {
            var finalState = activity.content.state
            finalState.isPlaying = false
            finalState.playbackStart = nil
            finalState.playbackEnd = nil
            let policy: ActivityUIDismissalPolicy = dismissAt.map { .after($0) } ?? .immediate
            await activity.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: policy)
        }
    }
}
#endif
