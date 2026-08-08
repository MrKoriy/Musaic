import Foundation

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

    var currentTrack: Track?
    var queue: [Track] = []
    var queueIndex: Int = 0
    var repeatMode: RepeatMode = .off
    var isShuffled = false
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

    var isPlaying: Bool { audio.isPlaying }
    var playbackState: PlaybackState { audio.playbackState }
    var progress: Double { audio.progress }
    var currentTime: TimeInterval { audio.currentTime }
    var duration: TimeInterval { audio.duration }
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
        audio.onPlaybackProgress = { [weak self] position in
            self?.recordPlaybackProgress(position)
        }
        audio.onPlaybackPaused = { [weak self] in
            self?.handlePlaybackPaused()
        }
        audio.onPlaybackResumed = { [weak self] in
            self?.handlePlaybackResumed()
        }
        audio.onPlaybackFailed = { [weak self] in
            self?.finalizeCurrentPlayback(action: "pause")
        }
    }

    // MARK: - Playback

    func playTrack(_ track: Track, restartIfCurrent: Bool = true) {
        let normalizedTrack = api.normalizedTrack(track)
        finalizeCurrentPlayback(action: "skip")

        currentTrack = normalizedTrack
        audio.play(track: normalizedTrack, restartIfSame: restartIfCurrent)
        audio.updateNowPlayingInfo(track: normalizedTrack)
        audio.onTrackEnd { [weak self] in self?.handleTrackEnd() }

        // Tell AudioPlayer what track comes next for crossfade
        updateCrossfadeNext()

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

    private func updateCrossfadeNext() {
        let nextTrack = queue[safe: queueIndex + 1].map { api.normalizedTrack($0) }
        if let next = nextTrack {
            let url: String
            if let localURL = DownloadManager.shared.localFileURL(for: next.id) {
                url = localURL.absoluteString
            } else {
                url = next.url
            }
            audio.setCrossfadeNextURL(url)
        } else {
            audio.setCrossfadeNextURL(nil)
        }
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
        let dedupedSeeds = Array(Dictionary(
            uniqueKeysWithValues: likedTracks.map { ($0.id, api.normalizedTrack($0)) }
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

        await extendDynamicStationIfNeeded(force: true, minimumUpcoming: 18)
        if let first = queue.first {
            queueIndex = 0
            playTrack(first)
        }
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
        }

        await extendDynamicStationIfNeeded(force: true, minimumUpcoming: 10)
    }

    func togglePlayPause() {
        audio.togglePlayPause()
        if let track = currentTrack {
            audio.updateNowPlayingInfo(track: track)
        }
    }

    // MARK: - Sleep timer

    /// Set a countdown timer in minutes, or nil to cancel.
    @MainActor
    func setSleepTimer(minutes: Int?) {
        sleepTimerEndOfTrack = false
        audio.cancelVolumeFade()
        guard let minutes, minutes > 0 else {
            sleepTimerDeadline = nil
            return
        }
        sleepTimerDeadline = Date().addingTimeInterval(TimeInterval(minutes * 60))
    }

    /// Arm pause-at-end-of-current-track.
    @MainActor
    func setSleepTimerEndOfTrack() {
        audio.cancelVolumeFade()
        sleepTimerDeadline = nil
        sleepTimerEndOfTrack = true
    }

    /// Cancel / clear the sleep timer. `silent=true` is used by AudioPlayer's
    /// internal tick when the timer has just fired — avoids calling cancelVolumeFade
    /// again (volume was already reset by the tick).
    @MainActor
    func clearSleepTimer(silent: Bool = false) {
        if !silent { audio.cancelVolumeFade() }
        sleepTimerDeadline = nil
        sleepTimerEndOfTrack = false
    }

    func seekTo(_ fraction: Double) {
        audio.seek(to: fraction)
        if var context = activeListeningContext {
            context.lastPosition = audio.currentTime
            activeListeningContext = context
        }
    }

    func skipNext() {
        finalizeCurrentPlayback(action: "skip")
        guard !queue.isEmpty else { return }
        if repeatMode == .track {
            restartCurrentTrack()
            return
        }

        if queueIndex >= queue.count - 1 {
            if isMyVibeActive || isAutoMixActive {
                Task { @MainActor in
                    await extendDynamicStationIfNeeded(force: true, minimumUpcoming: 6)
                    if queueIndex < queue.count - 1 {
                        queueIndex += 1
                        if let track = queue[safe: queueIndex] {
                            playTrack(track)
                        }
                    } else {
                        audio.pause()
                    }
                }
                return
            }
        }

        queueIndex += 1
        if queueIndex >= queue.count {
            if repeatMode == .queue {
                queueIndex = 0
            } else {
                queueIndex = queue.count - 1
                audio.pause()
                return
            }
        }
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
        // Double-tap to go to previous track, single tap restarts if >3s in
        if audio.currentTime > 3 {
            restartCurrentTrack()
            return
        }
        queueIndex = max(0, queueIndex - 1)
        if let track = queue[safe: queueIndex] {
            playTrack(track)
        }
    }

    func restartCurrentTrack() {
        guard let track = currentTrack else { return }
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
            lastPosition: audio.currentTime
        )
    }

    func selectQueueTrack(at index: Int) {
        guard queue.indices.contains(index) else { return }
        let track = queue[index]
        let isSameSelection = index == queueIndex && currentTrack?.id == track.id
        if isSameSelection { return }
        queueIndex = index
        playTrack(track)
    }

    func addToQueue(_ track: Track) {
        queue.append(track)
        originalQueue.append(track)
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
            currentTrack = nil
            queueIndex = 0
            audio.pauseAll()
            return
        }
        queueIndex = min(queueIndex, queue.count - 1)
        playTrack(queue[queueIndex])
    }

    func removeFromQueue(at index: Int) {
        guard queue.indices.contains(index) else { return }
        queue.remove(at: index)
        if index < queueIndex { queueIndex -= 1 }
    }

    func clearQueue() {
        queue.removeAll()
        originalQueue.removeAll()
        queueIndex = 0
        recommendationRequestIds.removeAll()
        recommendationPositions.removeAll()
        clearDynamicStation()
    }

    // MARK: - Modes

    func toggleRepeat() {
        switch repeatMode {
        case .off: repeatMode = .queue
        case .queue: repeatMode = .track
        case .track: repeatMode = .off
        }
    }

    func toggleShuffle() {
        isShuffled.toggle()
        if isShuffled {
            let current = queue[safe: queueIndex]
            var rest = queue
            if let idx = rest.firstIndex(where: { $0.id == current?.id }) {
                rest.remove(at: idx)
            }
            rest.shuffle()
            if let current { rest.insert(current, at: 0) }
            queue = rest
            queueIndex = 0
        } else {
            let currentId = currentTrack?.id
            queue = originalQueue
            queueIndex = queue.firstIndex(where: { $0.id == currentId }) ?? 0
        }
    }

    // MARK: - Private

    private func handleTrackEnd() {
        Task { @MainActor in
            finalizeCurrentPlayback(action: "complete", forceComplete: true)
            // Honour end-of-track sleep timer before advancing
            if sleepTimerEndOfTrack {
                sleepTimerEndOfTrack = false
                audio.pauseAll()
                return
            }
            if isMyVibeActive || isAutoMixActive {
                await extendDynamicStationIfNeeded(minimumUpcoming: 6)
            }
            skipNext()
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
            updateCrossfadeNext()
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
            }
        } catch {
            if queue.isEmpty {
                let fallbackTracks = stationSeedTracks.filter { rememberStationTrack($0) }
                queue.append(contentsOf: fallbackTracks)
                originalQueue.append(contentsOf: fallbackTracks)
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
            audio.updateNowPlayingInfo(track: sampleTrack)
        }
    }
    #endif
}

// MARK: - Safe Array Access

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
