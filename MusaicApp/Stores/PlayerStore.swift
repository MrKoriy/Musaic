import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - Player Store

@Observable
@MainActor
final class PlayerStore {
    static let shared = PlayerStore()

    private struct ActiveListeningContext {
        let track: Track
        let eventId: String
        let requestId: String?
        let surface: String
        let position: Int
        var playedSeconds: TimeInterval
        var lastPosition: TimeInterval
    }

    private enum DynamicStationMode {
        case myVibe
        case autoMix
    }

    private let audio = AudioPlayer.shared
    private let api = APIService.shared
    private let publisher = NowPlayingPublisher.shared

    var currentTrack: Track?
    var queue: [Track] = []
    var queueIndex: Int = 0
    var repeatMode: RepeatMode = .off
    var isShuffled = false
    /// Short AI DJ line shown once when the wave station starts.
    var djIntroMessage: String?
    private var djIntroVisibleUntil: Date?
    private var originalQueue: [Track] = []
    private var stationMode: DynamicStationMode?
    private var stationSeedTracks: [Track] = []
    private var stationFilters: MyVibeFilters = .default
    private static let maxStationIDsCap = 500
    private var stationKnownTrackIDs = Set<String>()
    private var stationSeenTrackIDs = Set<String>()
    private var stationSeenTrackOrder: [String] = []
    private var stationSeenCanonicalKeys = Set<String>()
    private var stationSessionId: String?
    private var stationRecentOutcomes: [StationOutcomeBody] = []
    private var stationSkipStreak = 0
    private var stationLoadingMore = false
    private var stationLastReactionRefreshAt: Date?
    private var recommendationRequestIds: [String: String] = [:]
    private var recommendationPositions: [String: Int] = [:]
    private var recentPlaybackHistory: [Track] = []
    private var organicListeningSessionId = UUID().uuidString
    private var activeListeningContext: ActiveListeningContext?
    private var queueSurface = "organic"

    // Failed tracks auto-skip ahead, but only a few times in a row so a dead
    // connection doesn't burn through the whole queue.
    private static let maxConsecutiveFailureSkips = 3
    @ObservationIgnored private var consecutiveFailureSkips = 0
    @ObservationIgnored private var failureSkipTask: Task<Void, Never>?

    /// Position of a restored (not yet loaded) current track.
    @ObservationIgnored private var restoredPosition: TimeInterval?
    @ObservationIgnored private var persistTask: Task<Void, Never>?
    @ObservationIgnored private var lastPersistedPositionBucket = -1
    @ObservationIgnored private var lastMailboxCheck = Date.distantPast
    @ObservationIgnored private var lifecycleObservers: [NSObjectProtocol] = []

    var isPlaying: Bool { audio.isPlaying }
    var playbackState: PlaybackState { audio.playbackState }
    var progress: Double { audio.progress }
    var currentTime: TimeInterval { audio.currentTime }
    var duration: TimeInterval { audio.duration }
    /// Playing or about to play (loading/buffering after a play request).
    var isPlaybackIntended: Bool { audio.isPlaying || audio.isPlaybackIntended }
    /// In-app volume 0...1 (iPod wheel, watch crown).
    var volume: Float { audio.userVolume }
    var isMyVibeActive: Bool { stationMode == .myVibe }
    var isAutoMixActive: Bool { stationMode == .autoMix }
    var currentMyVibeFilters: MyVibeFilters? { stationMode == .myVibe ? stationFilters : nil }

    // MARK: - Sleep timer
    //
    // Deadline lives on AudioPlayer so it can be ticked by the AVPlayer periodic
    // observer — that keeps firing in background audio mode where DispatchTimers
    // are unreliable. PlayerStore just proxies for SwiftUI observation.
    var sleepTimerDeadline: Date? {
        get { audio.sleepDeadline }
        set { audio.sleepDeadline = newValue }
    }
    /// When true, pause automatically at the end of the currently playing track.
    var sleepTimerEndOfTrack: Bool = false
    /// Preset (minutes) the active countdown was started with.
    private(set) var sleepTimerPresetMinutes: Int?

    /// Seconds remaining on the active countdown (0 when inactive). Computed fresh for UI.
    var sleepTimerRemaining: TimeInterval {
        guard let deadline = sleepTimerDeadline else { return 0 }
        return max(0, deadline.timeIntervalSinceNow)
    }

    var sleepTimerActive: Bool {
        sleepTimerDeadline != nil || sleepTimerEndOfTrack
    }

    private init() {
        audio.onRemoteNext = { [weak self] in self?.skipNext() }
        audio.onRemotePrevious = { [weak self] in self?.skipPrevious() }
        audio.onRemotePlay = { [weak self] in self?.resumePlayback() }
        audio.onRemotePause = { [weak self] in self?.pausePlayback() }
        audio.onRemoteTogglePlayPause = { [weak self] in self?.togglePlayPause() }
        audio.onRemoteSeek = { [weak self] fraction in self?.seekTo(fraction) }
        audio.onPlaybackProgress = { [weak self] position in
            self?.handlePlaybackTick(position)
        }
        audio.onPlaybackPaused = { [weak self] in
            self?.handlePlaybackPaused()
        }
        audio.onPlaybackResumed = { [weak self] in
            self?.handlePlaybackResumed()
        }
        audio.onPlaybackFailed = { [weak self] in
            self?.handlePlaybackFailure()
        }
        audio.onPlaybackStateChange = { [weak self] state in
            self?.handlePlaybackStateChange(state)
        }
        audio.onPlaybackSeeked = { [weak self] _ in
            self?.publishNowPlaying(force: true)
        }
        audio.onTrackEnd { [weak self] in self?.handleTrackEnd() }

        restoreQueueIfAvailable()
        observeLifecycle()

        // Publishing touches other singletons (watch link, library), so it
        // runs after this initializer has returned.
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Router first: commands mailed before launch act on the restored queue.
            NowPlayingCommandRouter.install { [weak self] command in
                self?.perform(remoteCommand: command)
            }
            self.publishNowPlaying(force: true)
        }
    }

    // MARK: - Playback

    func playTrack(_ track: Track, restartIfCurrent: Bool = true) {
        startPlayback(of: track, restartIfCurrent: restartIfCurrent, startAt: 0)
    }

    private func startPlayback(of track: Track, restartIfCurrent: Bool, startAt: TimeInterval) {
        let normalizedTrack = api.normalizedTrack(track)
        finalizeCurrentPlayback(action: "skip")
        failureSkipTask?.cancel()
        failureSkipTask = nil
        restoredPosition = nil

        #if os(iOS)
        if currentTrack?.id != normalizedTrack.id {
            WatchControlHandler.shared.trackDidChange(normalizedTrack)
        }
        #endif
        currentTrack = normalizedTrack
        audio.play(track: normalizedTrack, restartIfSame: restartIfCurrent, startAt: startAt)
        audio.updateNowPlayingInfo(track: normalizedTrack)
        publishNowPlaying(force: true)

        // Tell AudioPlayer what track comes next for preload / crossfade.
        updateCrossfadeNext()
        schedulePersist()

        if audio.lastErrorMessage == nil {
            activeListeningContext = ActiveListeningContext(
                track: normalizedTrack,
                eventId: UUID().uuidString,
                requestId: recommendationRequestIds[normalizedTrack.id],
                surface: currentPlaybackSurface,
                position: recommendationPositions[normalizedTrack.id] ?? queueIndex,
                playedSeconds: 0,
                lastPosition: audio.currentTime
            )
        }

        if isMyVibeActive || isAutoMixActive {
            Task { @MainActor in
                await extendDynamicStationIfNeeded(minimumUpcoming: 6)
            }
        }
    }

    /// Index of the track that plays after the current one, honoring repeat.
    private var upcomingIndex: Int? {
        guard !queue.isEmpty, repeatMode != .track else { return nil }
        if queueIndex + 1 < queue.count { return queueIndex + 1 }
        if repeatMode == .queue, queue.count > 1 { return 0 }
        return nil
    }

    private func updateCrossfadeNext() {
        // Repeat-one and "pause after this track" must never fade into
        // another item.
        guard !sleepTimerEndOfTrack,
              let index = upcomingIndex,
              let next = queue[safe: index].map({ api.normalizedTrack($0) }) else {
            audio.setCrossfadeNextURL(nil)
            return
        }
        let url = DownloadManager.shared.localFileURL(for: next.id)?.absoluteString ?? next.url
        audio.setCrossfadeNextURL(url, loudnessLufs: next.loudnessLufs)
    }

    /// Call after every queue / index / repeat mutation: refreshes the
    /// preloaded next item and persists the queue.
    private func queueDidChange() {
        if queue.isEmpty {
            queueIndex = 0
        } else if !queue.indices.contains(queueIndex) {
            queueIndex = max(0, min(queueIndex, queue.count - 1))
        }
        updateCrossfadeNext()
        schedulePersist()
    }

    @discardableResult
    func setQueue(
        _ tracks: [Track],
        startAt index: Int,
        surface: String = "organic",
        requestId: String? = nil
    ) -> Bool {
        guard tracks.indices.contains(index) else { return false }
        let shouldOpenNowPlaying = currentTrack == nil
        clearDynamicStation()
        consecutiveFailureSkips = 0
        queueSurface = surface
        recommendationRequestIds.removeAll()
        recommendationPositions.removeAll()
        if let requestId {
            for (position, track) in tracks.enumerated() {
                recommendationRequestIds[track.id] = requestId
                recommendationPositions[track.id] = position
            }
        }
        originalQueue = tracks
        if isShuffled {
            var shuffled = tracks
            let selected = shuffled.remove(at: index)
            shuffled.shuffle()
            shuffled.insert(selected, at: 0)
            queue = shuffled
            queueIndex = 0
        } else {
            queue = tracks
            queueIndex = index
        }
        if let track = queue[safe: queueIndex] {
            playTrack(track)
        }
        return shouldOpenNowPlaying
    }

    @MainActor
    func startMyVibe(from likedTracks: [Track], filters: MyVibeFilters = .default, knownTrackIds: Set<String> = []) async {
        // Liked lists can contain the same track twice; keep the first.
        let dedupedSeeds = Array(Dictionary(
            likedTracks.map { ($0.id, api.normalizedTrack($0)) },
            uniquingKeysWith: { first, _ in first }
        ).values)
        var seeds = dedupedSeeds.shuffled()
        if let currentTrack {
            let normalizedCurrent = api.normalizedTrack(currentTrack)
            seeds.removeAll { $0.id == normalizedCurrent.id }
            seeds.insert(normalizedCurrent, at: 0)
        }
        seeds = Array(seeds.prefix(16))
        guard !seeds.isEmpty else { return }

        stationMode = .myVibe
        stationSessionId = UUID().uuidString
        stationRecentOutcomes.removeAll()
        stationSkipStreak = 0
        stationSeenCanonicalKeys.removeAll()
        stationSeenTrackOrder.removeAll()
        stationSeedTracks = seeds
        stationFilters = filters
        stationKnownTrackIDs = knownTrackIds
        stationSeenTrackIDs.removeAll()
        if let currentTrack { rememberStationTrack(currentTrack) }
        recommendationRequestIds.removeAll()
        recommendationPositions.removeAll()
        queue = []
        originalQueue = []
        queueIndex = 0
        consecutiveFailureSkips = 0

        await extendDynamicStationIfNeeded(force: true, minimumUpcoming: 18)
        if let first = queue.first {
            queueIndex = 0
            playTrack(first)
        }
        await fetchDjIntro(for: seeds)
    }

    /// Ask the server for a one-shot AI DJ line about this station start.
    /// Fire-and-forget: failures leave the previous intro cleared.
    private func fetchDjIntro(for seeds: [Track]) async {
        djIntroMessage = nil
        djIntroVisibleUntil = nil
        struct DjIntroResponse: Decodable { let intro: String }
        do {
            let response: DjIntroResponse = try await api.post(
                "/api/recommendations/dj-intro",
                body: ["seeds": seeds.prefix(8).map { ["artist": $0.artist, "title": $0.title] }]
            )
            guard !response.intro.isEmpty else { return }
            djIntroMessage = response.intro
            djIntroVisibleUntil = Date().addingTimeInterval(7)
        } catch {
            // Silent: the DJ intro is pure garnish.
        }
    }

    /// Whether the DJ intro is still within its display window.
    var isDjIntroVisible: Bool {
        guard let message = djIntroMessage else { return false }
        return Date() < (djIntroVisibleUntil ?? .distantPast)
    }

    @MainActor
    func toggleAutoMix() async {
        guard let currentTrack else { return }

        if isAutoMixActive {
            clearDynamicStation()
            return
        }

        stationMode = .autoMix
        stationSessionId = UUID().uuidString
        stationRecentOutcomes.removeAll()
        stationSkipStreak = 0
        stationSeenCanonicalKeys.removeAll()
        stationSeenTrackOrder.removeAll()
        stationSeedTracks = autoMixSeedTracks(around: currentTrack)
        stationFilters = .default
        stationKnownTrackIDs.removeAll()
        stationSeenTrackIDs.removeAll()
        queue.forEach { _ = rememberStationTrack($0) }
        rememberStationTrack(currentTrack)

        if queue.isEmpty {
            queue = [currentTrack]
            originalQueue = [currentTrack]
            queueIndex = 0
            queueDidChange()
        }

        await extendDynamicStationIfNeeded(force: true, minimumUpcoming: 10)
    }

    func togglePlayPause() {
        if loadRestoredTrackIfNeeded() { return }
        audio.togglePlayPause()
    }

    func resumePlayback() {
        if loadRestoredTrackIfNeeded() { return }
        audio.resume()
    }

    func pausePlayback() {
        audio.pause()
    }

    /// After launch the restored track isn't loaded into the engine yet; the
    /// first play request loads it at the saved position.
    private func loadRestoredTrackIfNeeded() -> Bool {
        guard !audio.hasLoadedItem, let track = currentTrack else { return false }
        startPlayback(of: track, restartIfCurrent: true, startAt: restoredPosition ?? 0)
        return true
    }

    /// Executes a control command from the widget, Live Activity, watch or
    /// intents. `value` carries the fraction for "seek" and the level for
    /// "volume".
    func perform(remoteCommand command: String, value: Double? = nil) {
        switch command {
        case "toggle": togglePlayPause()
        case "play": resumePlayback()
        case "pause": pausePlayback()
        case "next": skipNext()
        case "previous": skipPrevious()
        case "like":
            if let track = currentTrack {
                LibraryStore.shared.toggleLike(track: track)
                publishNowPlaying(force: true)
            }
        case "seek":
            if let value { seekTo(value) }
        case "volume":
            if let value { setVolume(Float(value)) }
        case "sync":
            publishNowPlaying(force: true)
        default:
            break
        }
    }

    /// Drains commands mailed by the widget / Live Activity while the intent
    /// couldn't run in-process. Safe to call any time.
    func processPendingWidgetCommands() {
        NowPlayingCommandRouter.drainMailbox()
    }

    // MARK: - Sleep timer

    /// Set a countdown timer in minutes, or nil to cancel.
    @MainActor
    func setSleepTimer(minutes: Int?) {
        let hadEndOfTrack = sleepTimerEndOfTrack
        sleepTimerEndOfTrack = false
        audio.cancelVolumeFade()
        if let minutes, minutes > 0 {
            sleepTimerDeadline = Date().addingTimeInterval(TimeInterval(minutes * 60))
            sleepTimerPresetMinutes = minutes
        } else {
            sleepTimerDeadline = nil
            sleepTimerPresetMinutes = nil
        }
        if hadEndOfTrack { updateCrossfadeNext() }
    }

    /// Arm pause-at-end-of-current-track.
    @MainActor
    func setSleepTimerEndOfTrack() {
        audio.cancelVolumeFade()
        sleepTimerDeadline = nil
        sleepTimerPresetMinutes = nil
        sleepTimerEndOfTrack = true
        updateCrossfadeNext()
    }

    /// Cancel / clear the sleep timer. `silent=true` is used by AudioPlayer's
    /// internal tick when the timer has just fired — avoids calling cancelVolumeFade
    /// again (volume was already reset by the tick).
    @MainActor
    func clearSleepTimer(silent: Bool = false) {
        if !silent { audio.cancelVolumeFade() }
        let hadEndOfTrack = sleepTimerEndOfTrack
        sleepTimerDeadline = nil
        sleepTimerPresetMinutes = nil
        sleepTimerEndOfTrack = false
        if hadEndOfTrack { updateCrossfadeNext() }
    }

    func seekTo(_ fraction: Double) {
        guard fraction.isFinite else { return }
        if !audio.hasLoadedItem, let track = currentTrack {
            // Restored but not loaded: move the resume position.
            let dur = resolvedDuration > 0 ? resolvedDuration : (track.duration ?? 0)
            guard dur > 0 else { return }
            let position = max(0, min(1, fraction)) * dur
            restoredPosition = position
            audio.presentRestoredPosition(position, duration: dur)
            schedulePersist()
            publishNowPlaying(force: true)
            return
        }
        audio.seek(to: fraction)
        if var context = activeListeningContext {
            context.lastPosition = audio.currentTime
            activeListeningContext = context
        }
    }

    /// Manual "next": always advances, even in repeat-one (only a natural
    /// track end repeats the track).
    func skipNext() {
        finalizeCurrentPlayback(action: "skip")
        guard !queue.isEmpty else {
            handleQueueFinished()
            return
        }

        if queueIndex >= queue.count - 1, isMyVibeActive || isAutoMixActive {
            Task { @MainActor in
                await extendDynamicStationIfNeeded(force: true, minimumUpcoming: 6)
                if queueIndex < queue.count - 1 {
                    queueIndex += 1
                    if let track = queue[safe: queueIndex] {
                        playTrack(track)
                    }
                } else {
                    handleQueueFinished()
                }
            }
            return
        }

        var nextIndex = queueIndex + 1
        if nextIndex >= queue.count {
            guard repeatMode == .queue else {
                handleQueueFinished()
                return
            }
            nextIndex = 0
        }
        queueIndex = nextIndex
        if let track = queue[safe: queueIndex] {
            playTrack(track)
        }

        if isMyVibeActive || isAutoMixActive {
            Task { @MainActor in
                await extendDynamicStationIfNeeded(minimumUpcoming: 6)
            }
        }
    }

    func skipPrevious() {
        guard !queue.isEmpty else { return }
        // Single tap restarts once we're >3 s in; otherwise go back a track.
        let atStart = queueIndex == 0 && repeatMode != .queue
        if audio.livePlaybackTime() > 3 || atStart {
            restartCurrentTrack()
            return
        }
        queueIndex = queueIndex > 0 ? queueIndex - 1 : queue.count - 1
        if let track = queue[safe: queueIndex] {
            playTrack(track)
        }
    }

    func restartCurrentTrack() {
        guard let track = currentTrack else { return }
        guard audio.hasLoadedItem else {
            restoredPosition = 0
            audio.presentRestoredPosition(0, duration: track.duration ?? 0)
            schedulePersist()
            publishNowPlaying(force: true)
            return
        }
        if activeListeningContext != nil {
            recordPlaybackProgress(audio.currentTime)
            let listenedRatio = audio.duration > 0
                ? (activeListeningContext?.playedSeconds ?? 0) / audio.duration
                : 0
            let action = listenedRatio >= 0.5 ? "play" : "pause"
            finalizeCurrentPlayback(action: action)
        }
        let normalizedTrack = api.normalizedTrack(track)
        currentTrack = normalizedTrack
        audio.restartCurrentTrack()
        audio.updateNowPlayingInfo(track: normalizedTrack)
        activeListeningContext = ActiveListeningContext(
            track: normalizedTrack,
            eventId: UUID().uuidString,
            requestId: recommendationRequestIds[normalizedTrack.id],
            surface: currentPlaybackSurface,
            position: recommendationPositions[normalizedTrack.id] ?? queueIndex,
            playedSeconds: 0,
            lastPosition: 0
        )
    }

    /// Jump to a queue row without rebuilding the queue (keeps stations,
    /// shuffle order and recommendation context intact).
    func selectQueueTrack(at index: Int) {
        guard queue.indices.contains(index) else { return }
        let track = queue[index]
        let isSameSelection = index == queueIndex && currentTrack?.id == track.id
        if isSameSelection {
            if !isPlaybackIntended { resumePlayback() }
            return
        }
        consecutiveFailureSkips = 0
        queueIndex = index
        playTrack(track)
    }

    func addToQueue(_ track: Track) {
        queue.append(track)
        originalQueue.append(track)
        queueDidChange()
    }

    /// Inserts `track` right after the current one.
    func playNext(_ track: Track) {
        guard !queue.isEmpty else {
            addToQueue(track)
            return
        }
        queue.insert(track, at: min(queueIndex + 1, queue.count))
        if let current = currentTrack, let originalIndex = originalQueue.firstIndex(where: { $0.id == current.id }) {
            originalQueue.insert(track, at: originalIndex + 1)
        } else {
            originalQueue.append(track)
        }
        queueDidChange()
    }

    /// Records an explicit negative signal, removes the current item, and
    /// advances immediately so a disliked recommendation cannot replay.
    func dislikeCurrentTrack() {
        guard let track = currentTrack else { return }
        finalizeCurrentPlayback(action: "dislike")
        recommendationRequestIds.removeValue(forKey: track.id)
        recommendationPositions.removeValue(forKey: track.id)
        originalQueue.removeAll { $0.id == track.id }

        if queue.indices.contains(queueIndex) {
            queue.remove(at: queueIndex)
        }
        guard !queue.isEmpty else {
            stopAndClearNowPlaying()
            queueDidChange()
            return
        }
        queueIndex = min(queueIndex, queue.count - 1)
        playTrack(queue[queueIndex])
        queueDidChange()
    }

    func removeFromQueue(at index: Int) {
        removeFromQueue(atOffsets: IndexSet(integer: index))
    }

    /// Removes queue rows. Removing the playing row moves on to the track that
    /// followed it (or parks on the new last row / stops when nothing is left).
    func removeFromQueue(atOffsets offsets: IndexSet) {
        let indices = offsets.filter { queue.indices.contains($0) }.sorted(by: >)
        guard !indices.isEmpty else { return }
        let removingCurrent = indices.contains(queueIndex)
        let wasPlaying = isPlaybackIntended
        // Descending order keeps the remaining indices valid while removing.
        for index in indices {
            let removed = queue.remove(at: index)
            if let originalIndex = originalQueue.firstIndex(where: { $0.id == removed.id }) {
                originalQueue.remove(at: originalIndex)
            }
            if index < queueIndex { queueIndex -= 1 }
        }

        if removingCurrent {
            finalizeCurrentPlayback(action: "skip")
            if queue.isEmpty {
                stopAndClearNowPlaying()
            } else if queueIndex >= queue.count {
                queueIndex = queue.count - 1
                parkOnCurrentIndex()
            } else if wasPlaying {
                playTrack(queue[queueIndex])
            } else {
                parkOnCurrentIndex()
            }
        }
        queueDidChange()
    }

    /// Reorders the queue (List `onMove` semantics); the playing track keeps
    /// playing and `queueIndex` follows it.
    func moveQueue(fromOffsets source: IndexSet, toOffset destination: Int) {
        let moving = source.filter { queue.indices.contains($0) }.sorted()
        guard !moving.isEmpty, (0...queue.count).contains(destination) else { return }
        let movingSet = Set(moving)
        var order = queue.indices.filter { !movingSet.contains($0) }
        let insertAt = destination - moving.filter { $0 < destination }.count
        order.insert(contentsOf: moving, at: max(0, min(insertAt, order.count)))
        guard order != Array(queue.indices) else { return }

        let previousQueue = queue
        let previousIndex = queueIndex
        queue = order.map { previousQueue[$0] }
        queueIndex = order.firstIndex(of: previousIndex) ?? 0
        // A manual order becomes the base order unless shuffle is on (turning
        // shuffle off restores the pre-shuffle order).
        if !isShuffled { originalQueue = queue }
        queueDidChange()
    }

    func clearQueue() {
        clearDynamicStation()
        recommendationRequestIds.removeAll()
        recommendationPositions.removeAll()
        // The playing track stays as the only entry so the queue and the
        // player never disagree.
        if let currentTrack {
            queue = [currentTrack]
            originalQueue = [currentTrack]
        } else {
            queue = []
            originalQueue = []
        }
        queueIndex = 0
        queueDidChange()
    }

    // MARK: - Modes

    func toggleRepeat() {
        switch repeatMode {
        case .off: repeatMode = .queue
        case .queue: repeatMode = .track
        case .track: repeatMode = .off
        }
        queueDidChange()
    }

    func toggleShuffle() {
        isShuffled.toggle()
        if isShuffled {
            var rest = queue
            let current = rest.indices.contains(queueIndex) ? rest.remove(at: queueIndex) : nil
            rest.shuffle()
            if let current { rest.insert(current, at: 0) }
            queue = rest
            queueIndex = 0
        } else {
            let currentId = currentTrack?.id
            queue = originalQueue
            queueIndex = queue.firstIndex(where: { $0.id == currentId }) ?? 0
        }
        queueDidChange()
    }

    /// In-app volume 0...1.
    func setVolume(_ value: Float) {
        audio.setUserVolume(value)
        #if os(iOS)
        WatchControlHandler.shared.pushVolume(audio.userVolume)
        #endif
    }

    // MARK: - Logout

    /// Stops playback and wipes every trace of the session: queue (memory and
    /// disk), lock-screen info, Live Activity, widget/watch snapshot.
    func resetForLogout() {
        failureSkipTask?.cancel()
        failureSkipTask = nil
        persistTask?.cancel()
        persistTask = nil
        // No play logging: the session (and its token) is going away.
        activeListeningContext = nil
        // Cleared before stopping so the resulting state change publishes
        // "nothing playing" rather than the old track.
        currentTrack = nil
        queue = []
        originalQueue = []
        queueIndex = 0
        audio.sleepDeadline = nil
        sleepTimerEndOfTrack = false
        sleepTimerPresetMinutes = nil
        audio.setCrossfadeNextURL(nil)
        audio.stop()
        audio.clearNowPlayingInfo()
        clearDynamicStation()
        recommendationRequestIds.removeAll()
        recommendationPositions.removeAll()
        recentPlaybackHistory.removeAll()
        djIntroMessage = nil
        djIntroVisibleUntil = nil
        restoredPosition = nil
        consecutiveFailureSkips = 0
        organicListeningSessionId = UUID().uuidString
        QueuePersistence.delete()
        // A save already in flight must not resurrect the file.
        let previousWrite = persistWriteTask
        persistWriteTask = Task.detached(priority: .utility) {
            await previousWrite?.value
            QueuePersistence.delete()
        }
        publisher.clear()
        NowPlayingShared.clearPendingCommands()
        #if os(iOS)
        WatchControlHandler.shared.trackDidChange(nil)
        #endif
    }

    // MARK: - Private

    private func handleTrackEnd() {
        finalizeCurrentPlayback(action: "complete", forceComplete: true)
        // Honour end-of-track sleep timer before advancing
        if sleepTimerEndOfTrack {
            sleepTimerEndOfTrack = false
            audio.pauseAll()
            updateCrossfadeNext()
            publisher.endActivity(dismissAfter: 60)
            return
        }
        if repeatMode == .track {
            restartCurrentTrack()
            return
        }
        if isMyVibeActive || isAutoMixActive {
            Task { @MainActor in
                await extendDynamicStationIfNeeded(minimumUpcoming: 6)
                skipNext()
            }
            return
        }
        skipNext()
    }

    /// End of the queue: stop, rewind the last track so Play works again, and
    /// let the Live Activity go.
    private func handleQueueFinished() {
        audio.pause()
        audio.restartCurrentTrack()
        publisher.endActivity(dismissAfter: 60)
        schedulePersist()
    }

    /// Shows `queue[queueIndex]` as the current track without playing it.
    private func parkOnCurrentIndex() {
        guard let track = queue[safe: queueIndex].map({ api.normalizedTrack($0) }) else { return }
        audio.stop()
        currentTrack = track
        restoredPosition = 0
        audio.presentRestoredPosition(0, duration: track.duration ?? 0)
        audio.updateNowPlayingInfo(track: track)
        publishNowPlaying(force: true)
        #if os(iOS)
        WatchControlHandler.shared.trackDidChange(track)
        #endif
    }

    private func stopAndClearNowPlaying() {
        audio.stop()
        audio.clearNowPlayingInfo()
        currentTrack = nil
        queueIndex = 0
        restoredPosition = nil
        publisher.clear()
        #if os(iOS)
        WatchControlHandler.shared.trackDidChange(nil)
        #endif
    }

    private func handlePlaybackTick(_ position: TimeInterval) {
        recordPlaybackProgress(position)
        #if os(iOS)
        WatchControlHandler.shared.playbackTimeDidChange(position, duration: resolvedDuration, isPlaying: audio.isPlaying)
        #endif
        let bucket = Int(position / 10)
        if bucket != lastPersistedPositionBucket {
            lastPersistedPositionBucket = bucket
            schedulePersist()
        }
        let now = Date()
        if now.timeIntervalSince(lastMailboxCheck) >= 5 {
            lastMailboxCheck = now
            NowPlayingCommandRouter.drainMailbox()
        }
    }

    private func handlePlaybackStateChange(_ state: PlaybackState) {
        switch state {
        case .playing:
            consecutiveFailureSkips = 0
        case .paused, .idle:
            schedulePersist()
        case .loading, .buffering, .failed:
            break
        }
        publishNowPlaying()
    }

    private func handlePlaybackFailure() {
        finalizeCurrentPlayback(action: "pause")
        publishNowPlaying(force: true)
        let hasNext = queueIndex + 1 < queue.count
            || (repeatMode == .queue && queue.count > 1)
            || isMyVibeActive || isAutoMixActive
        guard hasNext, consecutiveFailureSkips < Self.maxConsecutiveFailureSkips else { return }
        consecutiveFailureSkips += 1
        let failedTrackID = currentTrack?.id
        failureSkipTask?.cancel()
        failureSkipTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard let self, !Task.isCancelled, self.currentTrack?.id == failedTrackID,
                  case .failed = self.audio.playbackState else { return }
            self.skipNext()
        }
    }

    // MARK: - Queue persistence

    private func schedulePersist() {
        persistTask?.cancel()
        persistTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard let self, !Task.isCancelled else { return }
            self.persistTask = nil
            self.writePersistedQueue(synchronously: false)
        }
    }

    /// Immediate save (backgrounding / termination).
    private func flushPersistence() {
        persistTask?.cancel()
        persistTask = nil
        writePersistedQueue(synchronously: true)
    }

    @ObservationIgnored private var persistWriteTask: Task<Void, Never>?

    private func writePersistedQueue(synchronously: Bool) {
        guard let snapshot = makePersistedQueue() else {
            QueuePersistence.delete()
            return
        }
        if synchronously {
            QueuePersistence.save(snapshot)
            return
        }
        let previous = persistWriteTask
        persistWriteTask = Task.detached(priority: .utility) {
            await previous?.value
            QueuePersistence.save(snapshot)
        }
    }

    private func makePersistedQueue() -> PersistedQueue? {
        guard SettingsStore.shared.isLoggedIn, queue.indices.contains(queueIndex) else { return nil }
        // Long station queues are trimmed around the current position.
        let lower = max(0, queueIndex - 100)
        let upper = min(queue.count, queueIndex + 400)
        let window = Array(queue[lower..<upper])
        let position = restoredPosition ?? audio.currentTime
        return PersistedQueue(
            queue: window,
            originalQueue: isShuffled ? Array(originalQueue.prefix(600)) : window,
            queueIndex: queueIndex - lower,
            position: position.isFinite ? max(0, position) : 0,
            isShuffled: isShuffled,
            repeatMode: repeatMode.rawValue,
            surface: queueSurface,
            savedAt: Date().timeIntervalSince1970
        )
    }

    private func restoreQueueIfAvailable() {
        guard SettingsStore.shared.isLoggedIn,
              let saved = QueuePersistence.load(),
              saved.queue.indices.contains(saved.queueIndex) else { return }
        queue = saved.queue.map { api.normalizedTrack($0) }
        let base = saved.originalQueue.isEmpty ? saved.queue : saved.originalQueue
        originalQueue = base.map { api.normalizedTrack($0) }
        queueIndex = saved.queueIndex
        isShuffled = saved.isShuffled
        repeatMode = RepeatMode(rawValue: saved.repeatMode) ?? .off
        queueSurface = saved.surface
        let track = queue[queueIndex]
        currentTrack = track
        let position = saved.position.isFinite ? max(0, saved.position) : 0
        restoredPosition = position
        lastPersistedPositionBucket = Int(position / 10)
        audio.presentRestoredPosition(position, duration: track.duration ?? 0)
        updateCrossfadeNext()
    }

    private func observeLifecycle() {
        #if canImport(UIKit)
        let names: [Notification.Name] = [
            UIApplication.didEnterBackgroundNotification,
            UIApplication.willTerminateNotification,
        ]
        #elseif canImport(AppKit)
        let names: [Notification.Name] = [
            NSApplication.didResignActiveNotification,
            NSApplication.willTerminateNotification,
        ]
        #else
        let names: [Notification.Name] = []
        #endif
        for name in names {
            let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                // Synchronous on purpose: termination won't wait for a Task hop.
                MainActor.assumeIsolated {
                    PlayerStore.shared.flushPersistence()
                }
            }
            lifecycleObservers.append(token)
        }
    }

    private func canonicalKey(for track: Track) -> String {
        if let family = track.canonicalFamilyId, !family.isEmpty { return family }
        let normalize: (String) -> String = { value in
            value.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
        }
        return "\(normalize(track.artist))|\(normalize(track.title))"
    }

    @discardableResult
    private func rememberStationTrack(_ track: Track, canonicalFamilyId: String? = nil) -> Bool {
        let canonical = canonicalFamilyId.flatMap { $0.isEmpty ? nil : $0 } ?? canonicalKey(for: track)
        guard !stationSeenTrackIDs.contains(track.id), !stationSeenCanonicalKeys.contains(canonical) else { return false }
        stationSeenTrackIDs.insert(track.id)
        stationSeenCanonicalKeys.insert(canonical)
        stationSeenTrackOrder.append(track.id)
        if stationSeenTrackOrder.count > Self.maxStationIDsCap {
            let excess = stationSeenTrackOrder.count - Self.maxStationIDsCap
            let removed = Array(stationSeenTrackOrder.prefix(excess))
            stationSeenTrackOrder.removeFirst(excess)
            removed.forEach { stationSeenTrackIDs.remove($0) }
            // Canonical keys stay bounded by rebuilding from known queue/history.
            stationSeenCanonicalKeys = Set((queue + recentPlaybackHistory).suffix(Self.maxStationIDsCap).map(canonicalKey))
        }
        return true
    }

    private func pruneStationSets() {
        if stationKnownTrackIDs.count > Self.maxStationIDsCap {
            stationKnownTrackIDs = Set(stationKnownTrackIDs.sorted().suffix(Self.maxStationIDsCap))
        }
    }

    private func clearDynamicStation() {
        stationMode = nil
        stationSeedTracks = []
        stationFilters = .default
        stationKnownTrackIDs.removeAll()
        stationSeenTrackIDs.removeAll()
        stationSeenTrackOrder.removeAll()
        stationSeenCanonicalKeys.removeAll()
        stationSessionId = nil
        stationRecentOutcomes.removeAll()
        stationSkipStreak = 0
        stationLastReactionRefreshAt = nil
        stationLoadingMore = false
    }

    @MainActor
    private func refreshUpcomingStationTracks() async {
        guard stationMode != nil, !stationLoadingMore else { return }
        if let last = stationLastReactionRefreshAt, Date().timeIntervalSince(last) < 60 { return }
        guard queueIndex + 1 < queue.count, !stationSeedTracks.isEmpty else { return }

        stationLastReactionRefreshAt = Date()
        stationLoadingMore = true
        defer { stationLoadingMore = false }
        do {
            let tail = Array(queue.prefix(queueIndex + 1).suffix(12))
            let response: RecoResponse
            switch stationMode {
            case .myVibe:
                response = try await api.getMyVibeTracks(
                    seeds: stationSeedTracks,
                    excludeIds: Array(stationSeenTrackIDs),
                    filters: stationFilters,
                    limit: 12,
                    sessionId: stationSessionId,
                    recentOutcomes: stationRecentOutcomes,
                    queueTail: tail,
                    skipStreak: stationSkipStreak,
                    reactionRefresh: true
                )
            case .autoMix:
                response = try await api.getAutoMixTracks(
                    seeds: stationSeedTracks,
                    excludeIds: Array(stationSeenTrackIDs),
                    limit: 12,
                    sessionId: stationSessionId,
                    recentOutcomes: stationRecentOutcomes,
                    queueTail: tail,
                    skipStreak: stationSkipStreak,
                    reactionRefresh: true
                )
            case nil:
                return
            }
            let replacement = Array(response.tracks.compactMap { serverTrack -> Track? in
                let track = api.toAppTrack(serverTrack)
                return rememberStationTrack(track, canonicalFamilyId: serverTrack.canonicalFamilyId) ? track : nil
            }.prefix(6))
            guard !replacement.isEmpty else { return }

            let start = queueIndex + 1
            let count = min(6, queue.count - start)
            let removed = Array(queue[start..<(start + count)])
            removed.forEach {
                recommendationRequestIds.removeValue(forKey: $0.id)
                recommendationPositions.removeValue(forKey: $0.id)
            }
            queue.replaceSubrange(start..<(start + count), with: replacement)
            if originalQueue.count >= start + count {
                originalQueue.replaceSubrange(start..<(start + count), with: replacement)
            }
            if let requestId = response.requestId {
                for (offset, track) in replacement.enumerated() {
                    recommendationRequestIds[track.id] = requestId
                    recommendationPositions[track.id] = start + offset
                }
            }
            stationSkipStreak = 0
            queueDidChange()
        } catch {
            stationLastReactionRefreshAt = nil
        }
    }

    @MainActor
    private func extendDynamicStationIfNeeded(force: Bool = false, minimumUpcoming: Int) async {
        guard stationMode != nil else { return }
        let upcoming = max(0, queue.count - queueIndex - 1)
        guard force || upcoming < minimumUpcoming else { return }
        guard !stationLoadingMore else { return }

        if stationMode == .autoMix, let currentTrack {
            stationSeedTracks = autoMixSeedTracks(around: currentTrack)
            queue.forEach { _ = rememberStationTrack($0) }
            pruneStationSets()
        }

        guard !stationSeedTracks.isEmpty else { return }

        stationLoadingMore = true
        defer { stationLoadingMore = false }

        do {
            var excludeIDs = stationSeenTrackIDs
            if stationFilters.character == .unfamiliar {
                excludeIDs.formUnion(stationKnownTrackIDs)
            }

            let response: RecoResponse
            switch stationMode {
            case .myVibe:
                response = try await api.getMyVibeTracks(
                    seeds: stationSeedTracks,
                    excludeIds: Array(excludeIDs),
                    filters: stationFilters,
                    limit: max(18, minimumUpcoming * 3),
                    sessionId: stationSessionId,
                    recentOutcomes: stationRecentOutcomes,
                    queueTail: Array(queue.prefix(queueIndex + 1).suffix(12)),
                    skipStreak: stationSkipStreak
                )
            case .autoMix:
                response = try await api.getAutoMixTracks(
                    seeds: stationSeedTracks,
                    excludeIds: Array(excludeIDs),
                    limit: max(16, minimumUpcoming * 3),
                    sessionId: stationSessionId,
                    recentOutcomes: stationRecentOutcomes,
                    queueTail: Array(queue.prefix(queueIndex + 1).suffix(12)),
                    skipStreak: stationSkipStreak
                )
            case nil:
                return
            }
            let freshTracks = response.tracks.compactMap { serverTrack -> Track? in
                let track = api.toAppTrack(serverTrack)
                return rememberStationTrack(track, canonicalFamilyId: serverTrack.canonicalFamilyId) ? track : nil
            }

            if !freshTracks.isEmpty {
                if let requestId = response.requestId {
                    for (position, track) in freshTracks.enumerated() {
                        recommendationRequestIds[track.id] = requestId
                        recommendationPositions[track.id] = position
                    }
                }
                queue.append(contentsOf: freshTracks)
                originalQueue.append(contentsOf: freshTracks)
                queueDidChange()
            }
        } catch {
            if queue.isEmpty {
                let fallbackTracks = stationSeedTracks.filter { rememberStationTrack($0) }
                queue.append(contentsOf: fallbackTracks)
                originalQueue.append(contentsOf: fallbackTracks)
                queueDidChange()
            }
        }
    }

    private func autoMixSeedTracks(around track: Track) -> [Track] {
        var seeds: [Track] = [api.normalizedTrack(track)]
        for recent in recentPlaybackHistory.reversed() {
            let normalized = api.normalizedTrack(recent)
            guard seeds.contains(where: { $0.id == normalized.id }) == false else { continue }
            seeds.append(normalized)
            if seeds.count >= 6 { break }
        }
        return seeds
    }

    private func recordPlaybackContext(with track: Track) {
        recentPlaybackHistory.removeAll { $0.id == track.id }
        recentPlaybackHistory.append(api.normalizedTrack(track))
        if recentPlaybackHistory.count > 12 {
            recentPlaybackHistory.removeFirst(recentPlaybackHistory.count - 12)
        }
    }

    private var currentPlaybackSurface: String {
        switch stationMode {
        case .myVibe: return "my_vibe"
        case .autoMix: return "auto_mix"
        case nil: return queueSurface
        }
    }

    func analyticsContext(for trackId: String) -> (surface: String, sessionId: String, requestId: String?, position: Int)? {
        guard let context = activeListeningContext, context.track.id == trackId else { return nil }
        return (context.surface, stationSessionId ?? organicListeningSessionId, context.requestId, context.position)
    }

    private func recordPlaybackProgress(_ position: TimeInterval) {
        guard position.isFinite, var context = activeListeningContext else { return }
        let delta = position - context.lastPosition
        // AVPlayer reports position jumps after a seek. Counting only normal
        // playback-sized deltas prevents a drag to 90% from becoming a false
        // long listen while still tolerating delayed background callbacks.
        if audio.isPlaying, delta > 0, delta <= 2.5 {
            context.playedSeconds += delta
        }
        context.lastPosition = position
        activeListeningContext = context
    }

    private func handlePlaybackPaused() {
        recordPlaybackProgress(audio.currentTime)
        guard let context = activeListeningContext else { return }
        logPlaybackSnapshot(context: context, action: "pause", eventId: UUID().uuidString)
    }

    private func handlePlaybackResumed() {
        guard var context = activeListeningContext else { return }
        context.lastPosition = audio.currentTime
        activeListeningContext = context
    }

    private func logPlaybackSnapshot(
        context: ActiveListeningContext,
        action: String,
        eventId: String
    ) {
        let durationSeconds = max(0, audio.duration)
        let durationMs = durationSeconds > 0 ? Int((durationSeconds * 1_000).rounded()) : nil
        let playedMs = Int((max(0, context.playedSeconds) * 1_000).rounded())
        let isOrganic = !["my_vibe", "auto_mix", "home", "daily_mix", "mood"].contains(context.surface)
        Task {
            await api.logPlay(
                trackId: context.track.id,
                action: action,
                eventId: eventId,
                playedMs: playedMs,
                durationMs: durationMs,
                sessionId: stationSessionId ?? organicListeningSessionId,
                requestId: context.requestId,
                surface: context.surface,
                isOrganic: isOrganic,
                position: context.position
            )
        }
    }

    private func finalizeCurrentPlayback(action: String, forceComplete: Bool = false) {
        recordPlaybackProgress(audio.currentTime)
        guard var context = activeListeningContext else { return }
        activeListeningContext = nil

        let durationSeconds = max(0, audio.duration)
        if forceComplete, durationSeconds > 0 {
            context.playedSeconds = max(context.playedSeconds, durationSeconds)
        }
        let ratio = durationSeconds > 0 ? context.playedSeconds / durationSeconds : 0

        if forceComplete || ratio >= 0.5 {
            recordPlaybackContext(with: context.track)
        }
        if stationMode != nil {
            let effectiveAction = forceComplete ? "complete" : action
            stationRecentOutcomes.append(StationOutcomeBody(track: context.track, action: effectiveAction, completionRatio: ratio))
            if stationRecentOutcomes.count > 20 { stationRecentOutcomes.removeFirst(stationRecentOutcomes.count - 20) }
            if effectiveAction == "skip" && ratio < 0.25 { stationSkipStreak += 1 } else if ratio >= 0.5 || effectiveAction == "complete" { stationSkipStreak = 0 }
            if ratio >= 0.5 || effectiveAction == "complete" {
                stationSeedTracks.removeAll { $0.id == context.track.id }
                stationSeedTracks.insert(context.track, at: 0)
                stationSeedTracks = Array(stationSeedTracks.prefix(16))
            }
            if effectiveAction == "dislike" || stationSkipStreak >= 3 {
                Task { @MainActor [weak self] in
                    await self?.refreshUpcomingStationTracks()
                }
            }
        }

        logPlaybackSnapshot(context: context, action: action, eventId: context.eventId)
    }

    // MARK: - System surfaces (widget, Live Activity, watch)

    private var resolvedDuration: TimeInterval {
        audio.duration > 0 ? audio.duration : (currentTrack?.duration ?? 0)
    }

    /// Pushes the settled playback state to the widget, Live Activity and
    /// watch. Cheap to call often: the publisher de-duplicates and throttles.
    private func publishNowPlaying(force: Bool = false) {
        guard let track = currentTrack else {
            publisher.clear()
            return
        }
        publisher.publish(
            track: track,
            isPlaying: isPlaybackIntended,
            position: restoredPosition ?? audio.currentTime,
            duration: resolvedDuration,
            force: force
        )
    }

    /// Re-sends the current state to every surface (e.g. when the watch app
    /// becomes reachable).
    func republishNowPlaying() {
        publishNowPlaying(force: true)
    }


    #if DEBUG
    func seedDebugNowPlayingIfNeeded(autoplay: Bool = true) {
        guard currentTrack == nil else { return }

        let sampleTrack = api.normalizedTrack(Track(
            id: "sc_2284447115",
            title: "I Know It's Wrong (prod. me)",
            artist: "PureSnow",
            album: nil,
            artwork: "https://i1.sndcdn.com/artworks-4ZFUcPD7PSD1qL0O-pz9qOw-t500x500.png",
            url: api.streamURL(forTrackID: "sc_2284447115", source: .soundcloud),
            duration: 166,
            source: .soundcloud
        ))

        originalQueue = [sampleTrack]
        queue = [sampleTrack]
        queueIndex = 0
        if autoplay {
            playTrack(sampleTrack)
        } else {
            currentTrack = sampleTrack
            restoredPosition = 0
            audio.updateNowPlayingInfo(track: sampleTrack)
            publishNowPlaying(force: true)
        }
        queueDidChange()
    }
    #endif
}

// MARK: - Safe Array Access

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
