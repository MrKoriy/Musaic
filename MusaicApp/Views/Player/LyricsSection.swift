import SwiftUI

struct LyricsSheet: View {
    let track: Track
    @State private var rawLrc: String?
    @State private var timeline: LyricsTimeline = .empty
    /// Bumped on every (re)load; restarts the highlight loop and re-centers.
    @State private var timelineVersion = 0
    @State private var loading = true
    @State private var generating = false
    @State private var activeLine: Int = 0
    @State private var activeWordIndex: Int? = nil
    @State private var loadError: String?
    @State private var tappedLineId: Int?
    @State private var userScrolledAway = false
    /// Scroll bookkeeping lives in a plain object: it changes on every drag
    /// event and must not invalidate the view.
    @State private var scrollActivity = ScrollActivity()
    @State private var resumeAutoScrollTask: Task<Void, Never>?
    @State private var generateTask: Task<Void, Never>?
    @State private var showManualSearch = false
    @State private var manualArtist = ""
    @State private var manualTitle = ""
    /// Server lead for this lyrics source plus the user's per-track tweak.
    @State private var sourceOffset: Double = SyncedLyricsPayload.defaultSourceOffset
    @State private var userOffset: Double = 0
    @State private var showTiming = false
    @State private var offsetSaveTask: Task<Void, Never>?
    @State private var offsetSaveFailed = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let audio = AudioPlayer.shared
    private let player = PlayerStore.shared
    private let api = APIService.shared

    /// Resume auto-scroll this long after the user's last scroll.
    private let autoScrollResumeDelay: TimeInterval = 4

    private var lines: [LyricsLine] { timeline.lines }
    private var effectiveOffset: Double { sourceOffset + userOffset }

    private var lyricsSourceLabel: String {
        if !lines.isEmpty { return "Synced" }
        if let raw = rawLrc, !raw.isEmpty { return "Plain text" }
        return ""
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hex: "1a1510"), Color(hex: "0a0908"), Color(hex: "0d0b09")],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                LyricsHeaderView(
                    track: track,
                    lyricsSourceLabel: lyricsSourceLabel,
                    hasRawLyrics: rawLrc != nil,
                    generating: $generating,
                    manualArtist: $manualArtist,
                    manualTitle: $manualTitle,
                    showManualSearch: $showManualSearch,
                    onRetry: generate,
                    canAdjustTiming: !lines.isEmpty,
                    timingActive: showTiming,
                    onToggleTiming: toggleTiming
                )

                if showTiming, !lines.isEmpty {
                    LyricsOffsetControl(
                        offset: userOffset,
                        saveFailed: offsetSaveFailed,
                        onAdjust: { adjustOffset(by: $0) },
                        onReset: { setUserOffset(0) }
                    )
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                content
            }

            if generating && rawLrc != nil {
                generationBanner
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: generating)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: showTiming)
        .task(id: track.id) {
            resetLyricsState()
            await loadLyrics()
        }
        // Runs while the sheet is visible and restarts after every load.
        .task(id: "\(track.id)#\(timelineVersion)") {
            await runHighlightLoop()
        }
        .onDisappear {
            resumeAutoScrollTask?.cancel()
            resumeAutoScrollTask = nil
            generateTask?.cancel()
            generateTask = nil
        }
        .alert("Search lyrics manually", isPresented: $showManualSearch) {
            TextField("Artist", text: $manualArtist)
            TextField("Title", text: $manualTitle)
            Button(String(localized: "Search")) {
                Task { await manualSearch() }
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text("Useful for tracks with features — try \"Flo Milli, SZA, Cardi B\" as artist. Cached result will be replaced.")
        }
    }

    // MARK: - Content states

    @ViewBuilder
    private var content: some View {
        if loading {
            Spacer()
            VStack(spacing: 14) {
                ProgressView()
                    .tint(Color.textPrimary)
                    .scaleEffect(1.1)
                Text(String(localized: "Loading lyrics..."))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
        } else if let loadError {
            Spacer()
            errorView(loadError)
            Spacer()
        } else if !lines.isEmpty {
            syncedLyrics
        } else if let rawLrc, !rawLrc.isEmpty {
            ScrollView {
                Text(rawLrc)
                    .font(.system(size: 20, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.textPrimary.opacity(0.7))
                    .lineSpacing(10)
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.hidden)
        } else {
            Spacer()
            emptyView
            Spacer()
        }
    }

    private var syncedLyrics: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(lines) { line in
                            LyricsLineView(
                                lineID: line.id,
                                text: line.text,
                                isActive: activeLine == line.id,
                                isTapped: tappedLineId == line.id,
                                words: line.words,
                                activeWordIndex: activeLine == line.id ? activeWordIndex : nil,
                                onTap: { tapLine(line) }
                            )
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, Layout.playerBottomInset)
                }
                .scrollIndicators(.hidden)
                .modifier(UserScrollDetector(onChange: userScrollChanged))
                .onChange(of: activeLine) { _, _ in
                    if !userScrolledAway { scrollToActiveLine(proxy) }
                }
                .onChange(of: timelineVersion) { _, _ in
                    DispatchQueue.main.async { scrollToActiveLine(proxy, animated: false) }
                }
                .onChange(of: userScrolledAway) { _, scrolledAway in
                    // Auto-resume and "Back to lyrics" both land here.
                    if !scrolledAway { scrollToActiveLine(proxy) }
                }

                if userScrolledAway {
                    Button {
                        resumeAutoScrollTask?.cancel()
                        resumeAutoScrollTask = nil
                        userScrolledAway = false
                        scrollToActiveLine(proxy)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 11, weight: .bold))
                            Text(String(localized: "Back to lyrics"))
                                .font(.system(size: 12, weight: .bold))
                        }
                        .foregroundStyle(Color.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.white.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: userScrolledAway)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 20) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(Color.white.opacity(0.15))
            Text(String(localized: "Failed to load lyrics"))
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                self.loadError = nil
                Task { await loadLyrics() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                    Text(String(localized: "Retry"))
                }
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color.bgPrimary)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(Color.textPrimary.opacity(0.9), in: Capsule())
            }
        }
    }

    private var emptyView: some View {
        VStack(spacing: 20) {
            Image(systemName: "text.quote")
                .font(.system(size: 44))
                .foregroundStyle(Color.white.opacity(0.15))
            Text(String(localized: "No lyrics found"))
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(String(localized: "Try generating with AI"))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
            Button { generate() } label: {
                HStack(spacing: 8) {
                    Image(systemName: generating ? "hourglass" : "sparkles")
                    Text(generating ? String(localized: "Generating...") : String(localized: "Generate with AI"))
                }
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color.bgPrimary)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(Color.textPrimary.opacity(0.9), in: Capsule())
            }
            .disabled(generating)
        }
    }

    private var generationBanner: some View {
        VStack {
            Spacer()
            HStack(spacing: 10) {
                ProgressView()
                    .tint(Color.textPrimary)
                    .scaleEffect(0.85)
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(localized: "Re-aligning lyrics with AI"))
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.textPrimary)
                    Text(String(localized: "Takes ~15-25 seconds"))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.ultraThinMaterial)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.8)
            )
            .shadow(color: .black.opacity(0.4), radius: 18, y: 8)
            .padding(.bottom, Layout.playerBottomInset + 12)
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Highlight

    /// Samples the precise AVPlayer time (not the 0.25 s-granular observable)
    /// so karaoke words switch on time; state only changes when the line or
    /// word does, so the list itself stays quiet.
    private func runHighlightLoop() async {
        guard !timeline.isEmpty else { return }
        while !Task.isCancelled {
            updateActiveLine()
            let interval: Duration = audio.isPlaying ? .milliseconds(50) : .milliseconds(400)
            try? await Task.sleep(for: interval)
        }
    }

    private func updateActiveLine() {
        let time = audio.livePlaybackTime() + effectiveOffset
        guard time.isFinite, let index = timeline.lineIndex(at: time) else {
            if activeWordIndex != nil { activeWordIndex = nil }
            return
        }
        let lineID = timeline.lines[index].id
        if activeLine != lineID { activeLine = lineID }
        let word = timeline.wordIndex(inLine: index, at: time)
        if activeWordIndex != word { activeWordIndex = word }
    }

    private func scrollToActiveLine(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard !lines.isEmpty else { return }
        if animated && !reduceMotion {
            withAnimation(.smooth(duration: 0.55)) {
                proxy.scrollTo(activeLine, anchor: .center)
            }
        } else {
            proxy.scrollTo(activeLine, anchor: .center)
        }
    }

    /// Pauses auto-scroll while the user scrolls and resumes it
    /// `autoScrollResumeDelay` after they stop; more scrolling pushes it out.
    private func userScrollChanged(active: Bool) {
        scrollActivity.isInteracting = active
        scrollActivity.lastUserScrollAt = Date()
        if active, !userScrolledAway { userScrolledAway = true }
        guard userScrolledAway, resumeAutoScrollTask == nil else { return }
        let activity = scrollActivity
        let delay = autoScrollResumeDelay
        resumeAutoScrollTask = Task { @MainActor in
            while !Task.isCancelled {
                let idle = Date().timeIntervalSince(activity.lastUserScrollAt)
                if !activity.isInteracting && idle >= delay { break }
                let wait = activity.isInteracting ? 0.5 : max(0.1, delay - idle)
                try? await Task.sleep(for: .seconds(wait))
            }
            guard !Task.isCancelled else { return }
            resumeAutoScrollTask = nil
            userScrolledAway = false
        }
    }

    private func tapLine(_ line: LyricsLine) {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
        if reduceMotion {
            tappedLineId = line.id
        } else {
            withAnimation(.easeOut(duration: 0.15)) { tappedLineId = line.id }
        }
        let duration = audio.duration > 0 ? audio.duration : (track.duration ?? 0)
        if duration > 0 {
            // Land where the singing starts, so the tapped line is highlighted
            // immediately.
            player.seekTo(max(0, line.time - effectiveOffset) / duration)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            withAnimation(reduceMotion ? nil : .default) { tappedLineId = nil }
        }
    }

    // MARK: - Timing offset (stored per track on the server)

    private func toggleTiming() {
        showTiming.toggle()
    }

    private func adjustOffset(by delta: Double) {
        // Same 0.05 s grid the server rounds to.
        setUserOffset(((userOffset + delta) * 20).rounded() / 20)
    }

    private func setUserOffset(_ value: Double) {
        let clamped = min(max(value, -5), 5)
        guard abs(clamped - userOffset) > 0.0001 else { return }
        userOffset = clamped
        updateActiveLine()
        offsetSaveFailed = false
        offsetSaveTask?.cancel()
        let trackID = track.id
        // Debounced: a burst of taps results in one request.
        offsetSaveTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            do {
                let accepted = try await LyricsService.saveUserOffset(clamped, trackId: trackID)
                if !Task.isCancelled, abs(accepted - userOffset) > 0.001 {
                    userOffset = accepted
                }
            } catch {
                if !Task.isCancelled { offsetSaveFailed = true }
            }
        }
    }

    // MARK: - Loading

    private func resetLyricsState() {
        generateTask?.cancel()
        generateTask = nil
        resumeAutoScrollTask?.cancel()
        resumeAutoScrollTask = nil
        rawLrc = nil
        timeline = .empty
        timelineVersion += 1
        activeLine = 0
        activeWordIndex = nil
        loading = true
        generating = false
        loadError = nil
        tappedLineId = nil
        userScrolledAway = false
        sourceOffset = SyncedLyricsPayload.defaultSourceOffset
        userOffset = 0
        offsetSaveFailed = false
    }

    private func apply(_ payload: SyncedLyricsPayload) {
        rawLrc = payload.lrc
        sourceOffset = payload.offsetSec ?? SyncedLyricsPayload.defaultSourceOffset
        userOffset = payload.userOffsetSec
        timeline = LyricsTimeline.parse(lrc: payload.lrc ?? "", wordLines: payload.words)
        timelineVersion += 1
        updateActiveLine()
    }

    private func loadLyrics() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let payload = try await LyricsService.fetch(trackId: track.id, artist: track.artist, title: track.title)
            apply(payload)
        } catch {
            if Task.isCancelled || error is CancellationError { return }
            rawLrc = nil
            timeline = .empty
            timelineVersion += 1
            loadError = error.localizedDescription
        }
    }

    private func manualSearch() async {
        let artist = manualArtist.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = manualTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !artist.isEmpty, !title.isEmpty else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            try await api.deleteLyrics(trackId: track.id)
        } catch {
            loadError = String(localized: "Couldn't clear cached lyrics: \(error.localizedDescription)")
            return
        }
        do {
            let payload = try await LyricsService.fetch(trackId: track.id, artist: artist, title: title)
            apply(payload)
        } catch {
            rawLrc = nil
            timeline = .empty
            timelineVersion += 1
            loadError = error.localizedDescription
        }
    }

    /// Starts AI generation and waits for it via the server's status stream
    /// (polling fallback), then reloads.
    private func generate() {
        generateTask?.cancel()
        generating = true
        loadError = nil
        let trackID = track.id
        generateTask = Task { @MainActor in
            defer { generating = false }
            do {
                try await api.deleteLyrics(trackId: trackID)
            } catch {
                loadError = String(localized: "Couldn't start generation: \(error.localizedDescription)")
                return
            }
            if Task.isCancelled { return }
            do {
                _ = try await api.generateLyrics(trackId: trackID)
            } catch {
                loadError = String(localized: "Couldn't start generation: \(error.localizedDescription)")
                return
            }
            let outcome = await LyricsService.waitForGeneration(trackId: trackID)
            if outcome == .cancelled || Task.isCancelled { return }
            await loadLyrics()
            guard lines.isEmpty, rawLrc?.isEmpty ?? true else { return }
            switch outcome {
            case .failed(let message):
                loadError = message ?? String(localized: "Lyrics generation failed.")
            case .timedOut:
                loadError = String(localized: "Lyrics generation is taking too long. Try again later.")
            case .done, .notStarted, .cancelled:
                break
            }
        }
    }
}

// MARK: - Offset control

/// Compact ± adjuster for the per-track highlight offset (0.1 s steps).
private struct LyricsOffsetControl: View {
    let offset: Double
    let saveFailed: Bool
    let onAdjust: (Double) -> Void
    let onReset: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(String(localized: "Lyrics timing"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text(saveFailed ? String(localized: "Not saved — check connection") : String(localized: "+ shows lines earlier"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(saveFailed ? Color.accentStrong : Color.textMuted)
            }

            Spacer(minLength: 8)

            stepButton(systemName: "minus", label: String(localized: "Show lyrics later")) { onAdjust(-0.1) }

            Text(Self.format(offset))
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .foregroundStyle(offset == 0 ? Color.textSecondary : Color.accentStrong)
                .frame(minWidth: 58)
                .contentTransition(.numericText())

            stepButton(systemName: "plus", label: String(localized: "Show lyrics earlier")) { onAdjust(0.1) }

            Button(action: onReset) {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(offset == 0 ? Color.textMuted : Color.textPrimary)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .disabled(offset == 0)
            .accessibilityLabel(Text(String(localized: "Reset lyrics timing")))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func stepButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.textPrimary)
                .frame(width: 30, height: 30)
                .background(Color.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    private static func format(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == 0 { return "0.0 s" }
        return String(format: "%+.2f s", rounded)
    }
}

// MARK: - User scroll detection

private final class ScrollActivity {
    var isInteracting = false
    var lastUserScrollAt = Date.distantPast
}

/// Reports user scrolling (true while dragging / decelerating, false when it
/// settles). Programmatic `scrollTo` is ignored.
private struct UserScrollDetector: ViewModifier {
    let onChange: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollPhaseChange { oldPhase, newPhase in
                // `.tracking` also fires for plain taps on a line; ignore it.
                let isUser: (ScrollPhase) -> Bool = { $0 == .interacting || $0 == .decelerating }
                if isUser(newPhase) {
                    onChange(true)
                } else if isUser(oldPhase) {
                    onChange(false)
                }
            }
        } else {
            content.simultaneousGesture(
                DragGesture(minimumDistance: 10)
                    .onChanged { _ in onChange(true) }
                    .onEnded { _ in onChange(false) }
            )
        }
    }
}
