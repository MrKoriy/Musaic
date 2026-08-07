import SwiftUI

private func fmtTime(_ seconds: Double) -> String {
    guard seconds.isFinite else { return "0:00" }
    let s = Int(max(0, seconds))
    return "\(s / 60):\(String(format: "%02d", s % 60))"
}

struct NowPlayingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var showLyrics = false
    @State private var showQueue = false
    @State private var showSleepTimer = false

    private let player = PlayerStore.shared

    var body: some View {
        if let track = player.currentTrack {
            ZStack {
                NowPlayingBackdrop(track: track)

                GeometryReader { geo in
                    #if os(macOS)
                    // On macOS the sheet is a resizable window; the artwork must
                    // shrink dynamically so transport controls never clip.
                    let screenInset: CGFloat = 24
                    let contentWidth = min(geo.size.width - screenInset * 2, 520)
                    // Cap artwork so all sections (header ~70 + metadata ~120 +
                    // scrub ~70 + transport ~110 + padding ~80 = ~450) fit in any
                    // reasonable window height.
                    let artSide = min(contentWidth - 16, max(220, geo.size.height - 470), 380)
                    let topInset: CGFloat = 18
                    let bottomInset: CGFloat = 18
                    #else
                    let screenInset: CGFloat = 16
                    let contentWidth = min(geo.size.width - screenInset * 2, 360)
                    let artSide = min(contentWidth - 16, geo.size.height * 0.44, 340)
                    let topInset = max(geo.safeAreaInsets.top, 18)
                    let bottomInset = max(geo.safeAreaInsets.bottom, 18)
                    #endif

                    VStack(spacing: 14) {
                        Capsule()
                            .fill(Color.white.opacity(0.35))
                            .frame(width: 42, height: 5)

                        NowPlayingTopBarView(
                            showLyrics: $showLyrics,
                            showQueue: $showQueue,
                            showSleepTimer: $showSleepTimer
                        )

                        #if os(macOS)
                        // Scrollable body so nothing ever clips if the window is
                        // resized smaller than the natural content height.
                        ScrollView(.vertical, showsIndicators: false) {
                            VStack(spacing: 20) {
                                NowPlayingArtworkView(track: track, side: artSide)
                                NowPlayingMetadataSectionView(track: track)
                                NowPlayingTransportDeckView()
                            }
                            .frame(maxWidth: contentWidth)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                        }
                        #else
                        Spacer(minLength: 6)

                        VStack(spacing: 20) {
                            NowPlayingArtworkView(track: track, side: artSide)

                            NowPlayingMetadataSectionView(track: track)

                            NowPlayingTransportDeckView()
                        }
                        .frame(maxWidth: contentWidth)

                        Spacer(minLength: 0)
                        #endif
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.horizontal, screenInset)
                    .padding(.top, topInset + 6)
                    .padding(.bottom, bottomInset)
                }
            }
            .sheet(isPresented: $showLyrics) { LyricsSheet(track: track) }
            .sheet(isPresented: $showQueue) { NowPlayingQueueView() }
            .sheet(isPresented: $showSleepTimer) {
                SleepTimerSheet()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        } else {
            ZStack {
                Color.bgPrimary.ignoresSafeArea()
                Button("Close") { dismiss() }
                    .foregroundStyle(Color.textPrimary)
            }
        }
    }
}

private struct NowPlayingTopBarView: View {
    @Binding var showLyrics: Bool
    @Binding var showQueue: Bool
    @Binding var showSleepTimer: Bool
    @Environment(\.dismiss) private var dismiss

    private let audio = AudioPlayer.shared
    private let player = PlayerStore.shared

    @State private var sleepTick = Date()

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                LiquidIconButton(systemName: "chevron.down", size: 42) {
                    dismiss()
                }
                Spacer()
                LiquidGlassGroup(spacing: 10) {
                    HStack(spacing: 10) {
                        LiquidIconButton(systemName: sleepIcon, size: 42) {
                            showSleepTimer = true
                        }
                        LiquidIconButton(systemName: "quote.bubble", size: 42) {
                            showLyrics = true
                        }
                        LiquidIconButton(systemName: "list.bullet", size: 42) {
                            showQueue = true
                        }
                    }
                }
            }

            VStack(spacing: 4) {
                Text("NOW PLAYING")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(3)
                    .foregroundStyle(Color.textSecondary)
                Text(trackStateLine)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(audio.isBuffering ? Color.accentStrong : Color.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .contentTransition(.numericText())
            }
        }
        .task(id: player.sleepTimerActive) {
            guard player.sleepTimerActive else { return }
            while !Task.isCancelled, player.sleepTimerActive {
                sleepTick = Date()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private var sleepIcon: String {
        player.sleepTimerActive ? "moon.zzz.fill" : "moon"
    }

    private var trackStateLine: String {
        _ = sleepTick // re-evaluate each second when a timer is active
        let source = player.currentTrack?.source.displayTag ?? "MUSAIC"
        let resolvedDuration = audio.duration > 0 ? audio.duration : (player.currentTrack?.duration ?? 0)
        let time = resolvedDuration > 0 ? fmtTime(resolvedDuration) : "--:--"
        if player.sleepTimerEndOfTrack {
            return "\(source) • \(time) • SLEEP AFTER TRACK"
        }
        let remaining = player.sleepTimerRemaining
        if remaining > 0 {
            let mins = Int(remaining) / 60
            let secs = Int(remaining) % 60
            return "\(source) • \(time) • SLEEP \(mins):\(String(format: "%02d", secs))"
        }
        return "\(source) • \(time)"
    }
}

private struct NowPlayingArtworkView: View {
    let track: Track
    let side: CGFloat

    private let audio = AudioPlayer.shared

    var body: some View {
        let scale: CGFloat = audio.isPlaying ? 1.0 : 0.88

        ArtworkTile(urlString: track.artwork, icon: "music.note")
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(.white.opacity(0.12), lineWidth: 0.8)
            }
            .shadow(color: .black.opacity(audio.isPlaying ? 0.38 : 0.18), radius: audio.isPlaying ? 36 : 18, y: audio.isPlaying ? 20 : 10)
            .scaleEffect(scale)
            .animation(.spring(response: 0.5, dampingFraction: 0.72), value: audio.isPlaying)
    }
}

private struct NowPlayingMetadataSectionView: View {
    let track: Track

    private let audio = AudioPlayer.shared
    private let library = LibraryStore.shared
    private let player = PlayerStore.shared

    var body: some View {
        let liked = library.likedTrackIds.contains(track.id)

        return VStack(spacing: 12) {
            Text(track.title)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.78)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.28), value: track.id)

            Text(track.artist)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(1)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.28), value: track.id)

            if let playbackLine {
                Text(playbackLine)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(audio.lastErrorMessage == nil ? Color.textMuted : Color.accentStrong)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .glassCard(cornerRadius: 18, tint: audio.lastErrorMessage == nil ? Color.white : Color.accentStrong, intensity: 0.05)
                    .transition(.opacity.combined(with: .scale(scale: 0.94)))
            }

            HStack(spacing: 10) {
                Text(track.source.displayTag)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .glassCard(cornerRadius: 18, tint: Color.accentStrong, intensity: 0.06)

                Button {
                    #if os(iOS)
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    #endif
                    library.toggleLike(track: track)
                } label: {
                    Image(systemName: liked ? "heart.fill" : "heart")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(liked ? Color.accentStrong : Color.textPrimary)
                        .frame(width: 42, height: 42)
                        .contentTransition(.symbolEffect(.replace.downUp))
                        .symbolEffect(.bounce.up.byLayer, value: liked)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(liked ? "Remove from favorites" : "Add to favorites")
                .sensoryFeedback(.success, trigger: liked)
                .background(
                    Circle()
                        .fill(Color.clear)
                        .glassCard(cornerRadius: 21, tint: Color.accentStrong, intensity: 0.08)
                )

                Button(role: .destructive) {
                    #if os(iOS)
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    #endif
                    player.dislikeCurrentTrack()
                } label: {
                    Image(systemName: "hand.thumbsdown")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                        .frame(width: 42, height: 42)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dislike and skip track")
                .background(
                    Circle()
                        .fill(Color.clear)
                        .glassCard(cornerRadius: 21, tint: Color.red, intensity: 0.08)
                )
            }
        }
    }

    private var playbackLine: String? {
        if let error = audio.lastErrorMessage, !error.isEmpty {
            return error
        }
        if audio.isBuffering {
            return "Loading stream..."
        }
        return nil
    }
}

private struct NowPlayingTransportDeckView: View {
    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    @State private var skipNextCounter = 0
    @State private var skipPrevCounter = 0
    @State private var repeatTapCounter = 0
    @State private var autoMixCounter = 0

    private var scrubDuration: Double {
        let d = audio.duration
        if d > 0 && d.isFinite { return d }
        return player.currentTrack?.duration ?? 0
    }

    var body: some View {
        VStack(spacing: 16) {
            ScrubBar(
                progress: audio.progress,
                currentTime: audio.currentTime,
                duration: scrubDuration,
                tint: Color.accentStrong,
                onCommit: { fraction in
                    audio.seek(to: fraction)
                }
            )
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .glassCard(cornerRadius: 28, tint: Color.accentStrong, intensity: 0.08, interactive: true)

            HStack {
                HStack(spacing: 12) {
                    transportButton(
                        systemName: player.isAutoMixActive ? "sparkles" : "wand.and.stars",
                        active: player.isAutoMixActive,
                        size: player.isAutoMixActive ? 18 : 16,
                        bounceTrigger: autoMixCounter
                    ) {
                        autoMixCounter += 1
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        Task { await player.toggleAutoMix() }
                    }

                    transportButton(
                        systemName: "backward.end.fill",
                        size: 21,
                        bounceTrigger: skipPrevCounter
                    ) {
                        skipPrevCounter += 1
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        player.skipPrevious()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 8)

                playPauseButton

                Spacer(minLength: 8)

                HStack(spacing: 12) {
                    transportButton(
                        systemName: "forward.end.fill",
                        size: 21,
                        bounceTrigger: skipNextCounter
                    ) {
                        skipNextCounter += 1
                        #if os(iOS)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        #endif
                        player.skipNext()
                    }

                    transportButton(
                        systemName: player.repeatMode == .track ? "repeat.1" : "repeat",
                        active: player.repeatMode != .off,
                        bounceTrigger: repeatTapCounter
                    ) {
                        repeatTapCounter += 1
                        #if os(iOS)
                        UISelectionFeedbackGenerator().selectionChanged()
                        #endif
                        player.toggleRepeat()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .glassCard(cornerRadius: 34, tint: Color.accentStrong, intensity: 0.09, interactive: true)
        }
        .padding(.bottom, 8)
    }

    private var playPauseButton: some View {
        Button {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: audio.isPlaying ? .medium : .rigid).impactOccurred()
            #endif
            player.togglePlayPause()
        } label: {
            ZStack {
                Circle()
                    .fill(Color.black.opacity(0.34))
                    .blur(radius: 18)
                    .offset(y: 10)

                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "36271d"),
                                Color(hex: "1b1410"),
                                Color(hex: "110c09"),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(hex: "d7ba8d").opacity(audio.isPlaying ? 0.58 : 0.40),
                                .clear,
                            ],
                            center: .topTrailing,
                            startRadius: 4,
                            endRadius: 68
                        )
                    )
                    .blur(radius: 12)
                    .animation(.easeInOut(duration: 0.45), value: audio.isPlaying)

                Circle()
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                .white.opacity(0.24),
                                Color.accentStrong.opacity(0.34),
                                .black.opacity(0.22),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )

                Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 27, weight: .black))
                    .foregroundStyle(Color.textPrimary)
                    .offset(x: audio.isPlaying ? 0 : 2)
                    .contentTransition(.symbolEffect(.replace.downUp))
            }
            .frame(width: 82, height: 82)
            .scaleEffect(audio.isPlaying ? 1.0 : 0.97)
            .animation(.spring(response: 0.32, dampingFraction: 0.7), value: audio.isPlaying)
        }
        .buttonStyle(PressableScale(scale: 0.93))
        .sensoryFeedback(.impact(weight: .light), trigger: audio.isPlaying)
    }

    private func transportButton(
        systemName: String,
        active: Bool = false,
        size: CGFloat = 22,
        bounceTrigger: Int = 0,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: active
                                ? [
                                    Color(hex: "4d3928"),
                                    Color(hex: "231912"),
                                ]
                                : [
                                    Color(hex: "312720").opacity(0.92),
                                    Color(hex: "191412").opacity(0.90),
                                ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Circle()
                    .strokeBorder(
                        LinearGradient(
                            colors: active
                                ? [
                                    Color.accentStrong.opacity(0.28),
                                    .white.opacity(0.18),
                                    .black.opacity(0.20),
                                ]
                                : [
                                    .white.opacity(0.18),
                                    .white.opacity(0.08),
                                    .black.opacity(0.18),
                                ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )

                Image(systemName: systemName)
                    .font(.system(size: size, weight: .semibold))
                    .foregroundStyle(active ? Color.accentStrong : Color.textPrimary)
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: bounceTrigger)
            }
            .frame(width: 46, height: 46)
            .shadow(color: .black.opacity(0.16), radius: 10, y: 4)
        }
        .buttonStyle(PressableScale(scale: 0.90))
    }
}

/// Press-down scale for primary buttons — gives them tactile feel.
struct PressableScale: ButtonStyle {
    var scale: CGFloat = 0.94

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1.0)
            .animation(.spring(response: 0.25, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

// MARK: - LRC Parser

private struct LrcLine: Identifiable {
    let id: Int
    let time: Double
    let text: String
}

private func parseLrc(_ raw: String) -> [LrcLine] {
    var lines: [LrcLine] = []
    let pattern = /\[(\d{1,2}):(\d{2})\.(\d{1,3})\]\s*(.*)/
    for (idx, line) in raw.split(separator: "\n").enumerated() {
        if let match = String(line).firstMatch(of: pattern) {
            let min = Double(match.1) ?? 0
            let sec = Double(match.2) ?? 0
            let ms = Double(match.3) ?? 0
            let msDivisor = match.3.count == 2 ? 100.0 : (match.3.count == 1 ? 10.0 : 1000.0)
            let time = min * 60 + sec + ms / msDivisor
            let text = String(match.4).trimmingCharacters(in: .whitespaces)
            if !text.isEmpty {
                lines.append(LrcLine(id: idx, time: time, text: text))
            }
        }
    }
    return lines.sorted { $0.time < $1.time }
}

// MARK: - Lyrics Sheet (redesigned)

struct LyricsSheet: View {
    let track: Track
    @State private var rawLrc: String?
    @State private var lines: [LrcLine] = []
    @State private var loading = true
    @State private var generating = false
    @State private var activeLine: Int = 0
    @State private var loadError: String?
    @State private var tappedLineId: Int?
    @State private var userScrolledAway = false
    @State private var timerTask: Task<Void, Never>?
    @State private var generateTask: Task<Void, Never>?
    @State private var showManualSearch = false
    @State private var manualArtist = ""
    @State private var manualTitle = ""
    @Environment(\.dismiss) private var dismiss

    private let audio = AudioPlayer.shared
    private let api = APIService.shared

    /// Global constant compensation: LRC times from the server/AI pipeline
    /// consistently run ~0.4s ahead of the audio. Highlight that many seconds
    /// earlier so the active line matches what's actually being sung.
    private let globalLyricsOffset: Double = 0.4

    private var lyricsSourceLabel: String {
        if !lines.isEmpty { return "Synced" }
        if let raw = rawLrc, !raw.isEmpty { return "Plain text" }
        return ""
    }

    var body: some View {
        ZStack {
            // Dark gradient background
            LinearGradient(
                colors: [Color(hex: "1a1510"), Color(hex: "0a0908"), Color(hex: "0d0b09")],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Color.textSecondary)
                            .frame(width: 36, height: 36)
                            .background(Color.white.opacity(0.08), in: Circle())
                    }
                    .buttonStyle(.plain)

                    Spacer()

                    VStack(spacing: 2) {
                        Text(track.title)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Color.textPrimary)
                            .lineLimit(1)
                        Text(track.artist)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .lineLimit(1)
                        if !lyricsSourceLabel.isEmpty {
                            Text(lyricsSourceLabel)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Color.textMuted)
                        }
                    }

                    Spacer()

                    HStack(spacing: 8) {
                        Button {
                            manualArtist = track.artist
                            manualTitle = track.title
                            showManualSearch = true
                        } label: {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(Color.textSecondary)
                                .frame(width: 36, height: 36)
                                .background(Color.white.opacity(0.08), in: Circle())
                        }
                        .buttonStyle(.plain)

                        if rawLrc != nil {
                            Button { retry() } label: {
                                Group {
                                    if generating {
                                        ProgressView()
                                            .tint(Color.textPrimary)
                                            .scaleEffect(0.8)
                                    } else {
                                        Image(systemName: "arrow.clockwise")
                                            .font(.system(size: 14, weight: .bold))
                                            .foregroundStyle(Color.textSecondary)
                                    }
                                }
                                .frame(width: 36, height: 36)
                                .background(Color.white.opacity(0.08), in: Circle())
                            }
                            .buttonStyle(.plain)
                            .disabled(generating)
                            .accessibilityLabel("Re-align lyrics with AI")
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 12)

                // Content
                if loading {
                    Spacer()
                    VStack(spacing: 14) {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .scaleEffect(1.1)
                        Text("Loading lyrics...")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                } else if let loadError {
                    // Error state with retry
                    Spacer()
                    VStack(spacing: 20) {
                        Image(systemName: "wifi.exclamationmark")
                            .font(.system(size: 44))
                            .foregroundStyle(Color.white.opacity(0.15))
                        Text("Failed to load lyrics")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text(loadError)
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
                                Text("Retry")
                            }
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.bgPrimary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 12)
                            .background(Color.textPrimary.opacity(0.9), in: Capsule())
                        }
                    }
                    Spacer()
                } else if !lines.isEmpty {
                    // Synced lyrics with smooth highlight
                    ZStack(alignment: .bottom) {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 6) {
                                    ForEach(lines) { line in
                                        lyricsLineView(line: line)
                                    }
                                }
                                .padding(.horizontal, 24)
                                .padding(.bottom, Layout.playerBottomInset)
                            }
                            .scrollIndicators(.hidden)
                            .onChange(of: activeLine) { _, newLine in
                                if !userScrolledAway {
                                    // `.smooth` gives a gentler macOS scroll that
                                    // doesn't overshoot — easeOut felt jerky on Mac
                                    // where `proxy.scrollTo` lacks the rubber-band
                                    // behaviour iOS provides.
                                    withAnimation(.smooth(duration: 0.55)) {
                                        proxy.scrollTo(newLine, anchor: .center)
                                    }
                                }
                            }
                            .onChange(of: lines.count) { _, newCount in
                                // Right after lyrics load, snap to the active line so the
                                // ScrollView doesn't settle on the bottom-most laid-out row.
                                guard newCount > 0 else { return }
                                DispatchQueue.main.async {
                                    proxy.scrollTo(activeLine, anchor: .center)
                                }
                            }
                            .simultaneousGesture(
                                DragGesture(minimumDistance: 10)
                                    .onChanged { _ in userScrolledAway = true }
                            )
                            .onChange(of: userScrolledAway) { _, scrolled in
                                if scrolled {
                                    // Auto-reset after 4 seconds of no manual scrolling
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                                        userScrolledAway = false
                                    }
                                }
                            }
                        }

                        // "Back to lyrics" pill when user scrolled away
                        if userScrolledAway {
                            Button {
                                userScrolledAway = false
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "arrow.down")
                                        .font(.system(size: 11, weight: .bold))
                                    Text("Back to lyrics")
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
                } else if let rawLrc, !rawLrc.isEmpty {
                    // Plain text lyrics
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
                    // No lyrics
                    Spacer()
                    VStack(spacing: 20) {
                        Image(systemName: "text.quote")
                            .font(.system(size: 44))
                            .foregroundStyle(Color.white.opacity(0.15))
                        Text("No lyrics found")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text("Try generating with AI")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                        Button { generate() } label: {
                            HStack(spacing: 8) {
                                Image(systemName: generating ? "hourglass" : "sparkles")
                                Text(generating ? "Generating..." : "Generate with AI")
                            }
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.bgPrimary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 12)
                            .background(Color.textPrimary.opacity(0.9), in: Capsule())
                        }
                        .disabled(generating)
                    }
                    Spacer()
                }
            }

            // Re-aligning progress banner — overlays visible lyrics while the
            // server runs the forced-alignment pipeline (~15-25s).
            if generating && rawLrc != nil {
                VStack {
                    Spacer()
                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .scaleEffect(0.85)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Re-aligning lyrics with AI")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.textPrimary)
                            Text("Takes ~15-25 seconds")
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
        }
        .animation(.easeInOut(duration: 0.2), value: generating)
        .task { await loadLyrics() }
        .onAppear { startLyricsTimer() }
        .onDisappear { stopLyricsTimer() }
        .alert("Search lyrics manually", isPresented: $showManualSearch) {
            TextField("Artist", text: $manualArtist)
            TextField("Title", text: $manualTitle)
            Button("Search") {
                Task { await manualSearch() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Useful for tracks with features — try \"Flo Milli, SZA, Cardi B\" as artist. Cached result will be replaced.")
        }
    }

    /// Extracted lyric line view — prevents SwiftUI's type-checker from
    /// blowing up on deeply-nested ternary backgrounds on macOS.
    @ViewBuilder
    private func lyricsLineView(line: LrcLine) -> some View {
        let isActive = activeLine == line.id
        let isTapped = tappedLineId == line.id
        let bgColor: Color = isTapped
            ? Color.white.opacity(0.08)
            : (isActive ? Color.white.opacity(0.05) : Color.clear)

        Text(line.text)
            .font(.system(size: 22, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.textPrimary.opacity(isActive ? 1.0 : 0.38))
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7)
            .padding(.horizontal, 6)
            .background(bgColor, in: RoundedRectangle(cornerRadius: 8))
            .id(line.id)
            .animation(.easeOut(duration: 0.22), value: isActive)
            .onTapGesture {
                #if os(iOS)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                #endif
                withAnimation(.easeOut(duration: 0.15)) { tappedLineId = line.id }
                let progress = line.time / max(1, audio.duration)
                audio.seek(to: progress)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    withAnimation { tappedLineId = nil }
                }
            }
    }

    private func manualSearch() async {
        let artist = manualArtist.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = manualTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !artist.isEmpty, !title.isEmpty else { return }
        loading = true
        loadError = nil
        defer { loading = false }
        try? await api.deleteLyrics(trackId: track.id)
        do {
            let response = try await api.getLyrics(trackId: track.id, artist: artist, title: title)
            rawLrc = response.lrc
            lines = parseLrc(response.lrc ?? "")
            updateActiveLine()
        } catch {
            rawLrc = nil
            lines = []
            loadError = error.localizedDescription
        }
    }

    private func startLyricsTimer() {
        timerTask = Task { @MainActor in
            while !Task.isCancelled {
                updateActiveLine()
                // 120 ms keeps highlight within one frame-pair of the audio clock,
                // which hides the stepping that used to look jerky on macOS.
                try? await Task.sleep(for: .milliseconds(120))
            }
        }
    }

    private func stopLyricsTimer() {
        timerTask?.cancel()
        timerTask = nil
        // Also cancel any in-flight lyrics generation poll so it doesn't keep hitting
        // the server after the user dismisses the sheet.
        generateTask?.cancel()
        generateTask = nil
    }

    private func updateActiveLine() {
        let time = audio.currentTime + globalLyricsOffset
        guard time.isFinite else { return }
        var best = lines.first?.id ?? 0
        for line in lines {
            if line.time <= time { best = line.id }
            else { break }
        }
        if activeLine != best { activeLine = best }
    }

    /// User tapped reload. Trigger the server's AI pipeline which runs forced
    /// alignment (LRCLIB/Genius text + whisper word-timestamps) and waits for
    /// the re-aligned LRC before reloading. This is what actually improves
    /// timing vs the stale LRCLIB result we already have cached.
    private func retry() {
        generate()
    }

    private func generate() {
        // Cancel any previous generate task before starting a new one so we don't
        // accumulate zombie pollers when the user re-taps reload mid-flight.
        generateTask?.cancel()
        generating = true
        generateTask = Task { @MainActor in
            defer { generating = false }
            try? await api.deleteLyrics(trackId: track.id)
            if Task.isCancelled { return }
            _ = try? await api.generateLyrics(trackId: track.id)
            // Poll job status until done/failed (generation takes 10-30s)
            for _ in 0..<60 {
                try? await Task.sleep(for: .seconds(2))
                if Task.isCancelled { return }
                let status = try? await api.getLyricsJobStatus(trackId: track.id)
                if status?.status == "done" { break }
                if status?.status == "failed" { break }
                if status?.status == "not_started" { break }
            }
            if Task.isCancelled { return }
            await loadLyrics()
        }
    }

    private func loadLyrics() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let response = try await api.getLyrics(trackId: track.id, artist: track.artist, title: track.title)
            rawLrc = response.lrc
            lines = parseLrc(response.lrc ?? "")
            // Force initial selection to the line matching current playback time,
            // otherwise ScrollView may land on the last laid-out row on first render.
            updateActiveLine()
            if let firstId = lines.first?.id {
                // Prefer the calculated active line, but if nothing matched, pin to the top.
                if !lines.contains(where: { $0.id == activeLine }) {
                    activeLine = firstId
                }
            }
        } catch {
            rawLrc = nil
            lines = []
            loadError = error.localizedDescription
        }
    }
}

// MARK: - Queue View

struct NowPlayingQueueView: View {
    @Environment(\.dismiss) private var dismiss
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    var body: some View {
        NavigationStack {
            ZStack {
                Color.bgPrimary.ignoresSafeArea()

                if player.queue.isEmpty {
                    ContentUnavailableView("Queue Empty", systemImage: "music.note.list")
                } else {
                    ScrollViewReader { proxy in
                        List {
                            ForEach(player.queue.indices, id: \.self) { idx in
                                let track = player.queue[idx]
                                let isCurrent = idx == player.queueIndex
                                HStack(spacing: 12) {
                                    if isCurrent {
                                        Image(systemName: "speaker.wave.2.fill")
                                            .font(.system(size: 12))
                                            .foregroundStyle(Color.accentStrong)
                                            .frame(width: 20)
                                    } else {
                                        Text("\(idx + 1)")
                                            .font(.caption2)
                                            .foregroundStyle(Color.textMuted)
                                            .frame(width: 20)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(track.title)
                                            .font(.system(size: 14, weight: isCurrent ? .bold : .medium))
                                            .foregroundStyle(isCurrent ? Color.accentStrong : Color.textPrimary)
                                            .lineLimit(1)
                                        Text(track.artist)
                                            .font(.caption)
                                            .foregroundStyle(Color.textSecondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    if let dur = track.duration {
                                        Text(fmtTime(dur))
                                            .font(.caption2)
                                            .foregroundStyle(Color.textMuted)
                                    }
                                }
                                .listRowBackground(isCurrent ? Color.white.opacity(0.06) : Color.clear)
                                .id(idx)
                                .onTapGesture {
                                    player.setQueue(player.queue, startAt: idx)
                                }
                            }
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                        .onAppear {
                            proxy.scrollTo(player.queueIndex, anchor: .center)
                        }
                    }
                }
            }
            .navigationTitle("Queue (\(player.queue.count))")
            .navigationBarTitleDisplayModeCompat()
            .toolbar {
                ToolbarItem(placement: .topBarTrailingCompat) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
        }
    }
}
