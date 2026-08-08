import SwiftUI

@main
struct MusaicApp: App {
    private let settings = SettingsStore.shared

    var body: some Scene {
        WindowGroup {
            if settings.isLoggedIn {
                ContentView()
                    .preferredColorScheme(settings.theme.colorScheme)
                    #if os(macOS)
                    .frame(minWidth: 900, minHeight: 600)
                    #endif
            } else {
                AuthView()
                    .preferredColorScheme(settings.theme.colorScheme)
            }
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 750)
        .commands { MusaicCommands() }
        #endif
    }
}

#if os(macOS)
/// macOS menu bar commands + global keyboard shortcuts.
/// Space / ←→ are bound on the panel buttons themselves; the shortcuts below
/// fire even when those buttons are off-screen (e.g. during a sheet).
private struct MusaicCommands: Commands {
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    var body: some Commands {
        CommandMenu(String(localized: "Playback")) {
            Button(String(localized: "Play / Pause")) { player.togglePlayPause() }
                .keyboardShortcut(.space, modifiers: [.command])

            Button(String(localized: "Next Track")) { player.skipNext() }
                .keyboardShortcut(.rightArrow, modifiers: [.command])

            Button(String(localized: "Previous Track")) { player.skipPrevious() }
                .keyboardShortcut(.leftArrow, modifiers: [.command])

            Divider()

            Button(String(localized: "Toggle Like")) {
                if let track = player.currentTrack { library.toggleLike(track: track) }
            }
            .keyboardShortcut("l", modifiers: [.command])
            .disabled(player.currentTrack == nil)

            Button(String(localized: "Toggle Shuffle")) { player.toggleShuffle() }
                .keyboardShortcut("s", modifiers: [.command, .shift])

            Button(String(localized: "Toggle Repeat")) { player.toggleRepeat() }
                .keyboardShortcut("r", modifiers: [.command, .shift])

            Divider()

            Menu(String(localized: "Sleep Timer")) {
                if player.sleepTimerActive {
                    Button(String(localized: "Turn Off Timer")) { player.clearSleepTimer() }
                    Divider()
                }
                Button(String(localized: "5 minutes")) { player.setSleepTimer(minutes: 5) }
                Button(String(localized: "10 minutes")) { player.setSleepTimer(minutes: 10) }
                Button(String(localized: "15 minutes")) { player.setSleepTimer(minutes: 15) }
                Button(String(localized: "30 minutes")) { player.setSleepTimer(minutes: 30) }
                Button(String(localized: "45 minutes")) { player.setSleepTimer(minutes: 45) }
                Button(String(localized: "1 hour")) { player.setSleepTimer(minutes: 60) }
                Divider()
                Button(String(localized: "End of current track")) { player.setSleepTimerEndOfTrack() }
                    .disabled(player.currentTrack == nil)
            }
        }
    }
}
#endif

private enum RootTab: Int, CaseIterable {
    case home
    case search
    case library
    case profile

    var title: String {
        switch self {
        case .home: return String(localized: "Home")
        case .search: return String(localized: "Search")
        case .library: return String(localized: "Library")
        case .profile: return String(localized: "Settings")
        }
    }

    var icon: String {
        switch self {
        case .home: return "house"
        case .search: return "magnifyingglass"
        case .library: return "square.stack.3d.up"
        case .profile: return "gearshape"
        }
    }

    init?(debugValue: String) {
        switch debugValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "home":
            self = .home
        case "search":
            self = .search
        case "library":
            self = .library
        case "profile", "settings":
            self = .profile
        default:
            return nil
        }
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab: RootTab = .home
    @State private var showNowPlaying = false

    private let player = PlayerStore.shared
    private let settings = SettingsStore.shared
    private let libraryStore = LibraryStore.shared

    #if os(macOS)
    @State private var showLyricsMac = false
    @State private var showQueueMac = false
    @State private var skipNextCounterMac = 0
    @State private var skipPrevCounterMac = 0
    @State private var shuffleTapCounterMac = 0
    @State private var repeatTapCounterMac = 0
    @State private var sleepMenuOpen = false
    #endif

    var body: some View {
        Group {
            if shouldShowSourceOnboarding {
                sourceOnboarding
            } else {
                #if os(macOS)
                macOSLayout
                #else
                iOSLayout
                #endif
            }
        }
        .task {
            await LibraryStore.shared.ensureSynced(force: true)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await LibraryStore.shared.ensureSynced(force: true)
            }
        }
    }

    private var shouldShowSourceOnboarding: Bool {
        let libraryIsEmpty = libraryStore.likedTrackIds.isEmpty && libraryStore.likedTracks.isEmpty
        return libraryIsEmpty && !settings.onboardingComplete
    }

    private var sourceOnboarding: some View {
        OnboardingView(
            sourceYandex: Binding(
                get: { settings.sourceYandex },
                set: { settings.sourceYandex = $0 }
            ),
            sourceYoutube: Binding(
                get: { settings.sourceYoutube },
                set: { settings.sourceYoutube = $0 }
            ),
            sourceSoundcloud: Binding(
                get: { settings.sourceSoundcloud },
                set: { settings.sourceSoundcloud = $0 }
            ),
            sourceVK: Binding(
                get: { settings.sourceVK },
                set: { settings.sourceVK = $0 }
            ),
            yandexConnected: settings.yandexAuthenticated,
            vkConnected: settings.vkAuthenticated,
            onComplete: {
                settings.onboardingComplete = true
            },
            onOpenSettings: {
                settings.onboardingComplete = true
                selectedTab = .profile
            }
        )
    }

    #if os(macOS)
    private let library = LibraryStore.shared
    private let audio = AudioPlayer.shared

    private var macOSLayout: some View {
        ZStack {
            AppBackdrop()

            HStack(spacing: 0) {
                // ── Left Sidebar ──
                macSidebar
                    .frame(width: 220)

                Rectangle().fill(Color.white.opacity(0.06)).frame(width: 1)

                // ── Main Content ──
                ZStack {
                    screen(for: selectedTab)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // ── Right Panel (Now Playing + Queue) ──
                if player.currentTrack != nil {
                    Rectangle().fill(Color.white.opacity(0.06)).frame(width: 1)

                    macNowPlayingPanel
                        .frame(width: 300)
                }
            }
        }
        .sheet(isPresented: $showNowPlaying) {
            NowPlayingView()
                .frame(minWidth: 560, idealWidth: 640, minHeight: 820, idealHeight: 880)
        }
    }

    // MARK: - macOS Sidebar

    private var macSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Logo
            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [Color(hex: "f0d09d"), Color(hex: "7f5f43")],
                                center: .center, startRadius: 4, endRadius: 22
                            )
                        )
                    Image(systemName: "waveform")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Color.bgPrimary)
                }
                .frame(width: 36, height: 36)

                Text("Musaic")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
            }
            .padding(.horizontal, 18)
            .padding(.top, 20)
            .padding(.bottom, 24)

            // Nav items
            VStack(spacing: 4) {
                ForEach(RootTab.allCases, id: \.rawValue) { tab in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { selectedTab = tab }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 14, weight: .medium))
                                .frame(width: 20)
                            Text(tab.title)
                                .font(.system(size: 14, weight: selectedTab == tab ? .semibold : .medium))
                            Spacer()
                            if selectedTab == tab {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(Color.textMuted)
                            }
                        }
                        .foregroundStyle(selectedTab == tab ? Color.textPrimary : Color.textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(selectedTab == tab ? Color.white.opacity(0.08) : Color.clear)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)

            // Session metrics
            VStack(alignment: .leading, spacing: 10) {
                Text(String(localized: "Session"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
                    .padding(.leading, 4)

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    macMetricTile(value: "\(player.queue.count)", label: String(localized: "Queue"), icon: "music.note.list")
                    macMetricTile(value: "\(library.likedTrackIds.count)", label: String(localized: "Liked"), icon: "heart.fill")
                    macMetricTile(value: "3", label: String(localized: "Sources"), icon: "dot.radiowaves.left.and.right")
                    macMetricTile(value: "\(DownloadManager.shared.downloadCount)", label: String(localized: "Offline"), icon: "arrow.down.circle.fill")
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 24)

            // Open full player
            if player.currentTrack != nil {
                Button { showNowPlaying = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.up.right.circle.fill")
                            .font(.system(size: 14, weight: .semibold))
                        Text(String(localized: "Open full player"))
                            .font(.system(size: 13, weight: .semibold))
                        Spacer()
                    }
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.white.opacity(0.06))
                    )
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.top, 14)
            }

            Spacer()

            // User info
            VStack(alignment: .leading, spacing: 8) {
                Text(settings.authDisplayName.isEmpty ? settings.authUsername : settings.authDisplayName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)

                Text(String(localized: "Local • VK • SoundCloud"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textSecondary)

                HStack(spacing: 6) {
                    macSourceBadge("VK", active: settings.sourceVK)
                    macSourceBadge("SC", active: settings.sourceSoundcloud)
                    macSourceBadge("LOCAL", active: true)
                }
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
                    )
            )
            .padding(.horizontal, 14)
            .padding(.bottom, 18)
        }
        .background(Color.white.opacity(0.02))
    }

    // MARK: - macOS Now Playing Panel

    private var macNowPlayingPanel: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 16) {
                    // Header with action buttons (lyrics, sleep popover, expand)
                    macNowPlayingHeader

                    if let track = player.currentTrack {
                        let liked = library.isLiked(track.id)

                        // Artwork
                        ArtworkTile(urlString: track.artwork, icon: "music.note")
                            .frame(width: 180, height: 180)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .shadow(color: .black.opacity(0.3), radius: 16, y: 8)

                        // Track info
                        VStack(spacing: 6) {
                            Text(track.title)
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundStyle(Color.textPrimary)
                                .lineLimit(2)
                                .multilineTextAlignment(.center)
                                .contentTransition(.opacity)
                                .animation(.easeOut(duration: 0.28), value: track.id)

                            Text(track.artist)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color.textSecondary)
                                .lineLimit(1)
                                .contentTransition(.opacity)
                                .animation(.easeOut(duration: 0.28), value: track.id)

                            HStack(spacing: 8) {
                                Text(track.source.displayTag)
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(Color.textPrimary)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(Color.white.opacity(0.08), in: Capsule())

                                Button {
                                    library.toggleLike(track: track)
                                } label: {
                                    Image(systemName: liked ? "heart.fill" : "heart")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(liked ? Color.accentStrong : Color.textPrimary)
                                        .frame(width: 30, height: 30)
                                        .background(Color.white.opacity(0.08), in: Circle())
                                        .contentTransition(.symbolEffect(.replace.downUp))
                                        .symbolEffect(.bounce.up.byLayer, value: liked)
                                }
                                .buttonStyle(PressableScale(scale: 0.90))
                                 .help(liked ? String(localized: "Unlike") : String(localized: "Like"))
                                 .accessibilityLabel(Text(liked ? String(localized: "Unlike") : String(localized: "Like")))
                            }
                            .padding(.top, 4)
                        }
                        .padding(.horizontal, 18)

                        // Seek bar — interactive ScrubBar (same as iOS full player)
                        ScrubBar(
                            progress: audio.progress,
                            currentTime: audio.currentTime,
                            duration: audio.duration > 0 ? audio.duration : (track.duration ?? 0),
                            tint: Color.accentStrong,
                            onCommit: { fraction in audio.seek(to: fraction) }
                        )
                        .padding(.horizontal, 18)

                        // Transport controls
                        HStack(spacing: 12) {
                            Button {
                                shuffleTapCounterMac &+= 1
                                player.toggleShuffle()
                            } label: {
                                macTransportGlyph(
                                    systemName: "shuffle",
                                    size: 15,
                                    active: player.isShuffled,
                                    bounceTrigger: shuffleTapCounterMac
                                )
                            }
                            .buttonStyle(PressableScale(scale: 0.88))
                             .help(String(localized: "Toggle Shuffle"))
                             .accessibilityLabel(Text(String(localized: "Toggle Shuffle")))

                            Button {
                                skipPrevCounterMac &+= 1
                                player.skipPrevious()
                            } label: {
                                macTransportGlyph(systemName: "backward.fill", size: 18, bounceTrigger: skipPrevCounterMac)
                            }
                            .buttonStyle(PressableScale(scale: 0.88))
                            .keyboardShortcut(.leftArrow, modifiers: [])
                             .help(String(localized: "Previous Track"))
                             .accessibilityLabel(Text(String(localized: "Previous Track")))

                            Button { player.togglePlayPause() } label: {
                                Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                                    .font(.system(size: 24, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .frame(width: 56, height: 56)
                                    .background(Circle().fill(Color.white.opacity(0.11)))
                                    .contentTransition(.symbolEffect(.replace.downUp))
                            }
                            .buttonStyle(PressableScale(scale: 0.92))
                            .keyboardShortcut(.space, modifiers: [])
                             .help(audio.isPlaying ? String(localized: "Pause") : String(localized: "Play"))
                             .accessibilityLabel(Text(audio.isPlaying ? String(localized: "Pause") : String(localized: "Play")))

                            Button {
                                skipNextCounterMac &+= 1
                                player.skipNext()
                            } label: {
                                macTransportGlyph(systemName: "forward.fill", size: 18, bounceTrigger: skipNextCounterMac)
                            }
                            .buttonStyle(PressableScale(scale: 0.88))
                            .keyboardShortcut(.rightArrow, modifiers: [])
                             .help(String(localized: "Next Track"))
                             .accessibilityLabel(Text(String(localized: "Next Track")))

                            Button {
                                repeatTapCounterMac &+= 1
                                player.toggleRepeat()
                            } label: {
                                macTransportGlyph(
                                    systemName: player.repeatMode == .track ? "repeat.1" : "repeat",
                                    size: 15,
                                    active: player.repeatMode != .off,
                                    bounceTrigger: repeatTapCounterMac
                                )
                            }
                            .buttonStyle(PressableScale(scale: 0.88))
                             .help(String(localized: "Toggle Repeat"))
                             .accessibilityLabel(Text(String(localized: "Toggle Repeat")))
                        }
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 4)

                        // Queue section
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                 Text(String(localized: "Queue"))
                                    .font(.system(size: 16, weight: .bold, design: .rounded))
                                    .foregroundStyle(Color.textPrimary)
                                Spacer()
                                 Text(String(localized: "\(player.queue.count) up next"))
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Color.textSecondary)
                            }

                            ForEach(Array(player.queue.prefix(8).enumerated()), id: \.element.id) { idx, track in
                                Button {
                                    player.selectQueueTrack(at: idx)
                                } label: {
                                    HStack(spacing: 10) {
                                        Text("\(idx + 2)")
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundStyle(Color.textMuted)
                                            .frame(width: 18)

                                        ArtworkTile(urlString: track.artwork, icon: "music.note")
                                            .frame(width: 40, height: 40)
                                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(track.title)
                                                .font(.system(size: 13, weight: .medium))
                                                .foregroundStyle(Color.textPrimary)
                                                .lineLimit(1)
                                            Text(track.artist)
                                                .font(.system(size: 11, weight: .medium))
                                                .foregroundStyle(Color.textSecondary)
                                                .lineLimit(1)
                                        }

                                        Spacer()

                                        if let dur = track.duration {
                                            Text(formatDuration(dur))
                                                .font(.system(size: 11, weight: .medium))
                                                .foregroundStyle(Color.textMuted)
                                        }
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(
                                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                                            .fill(Color.white.opacity(0.04))
                                    )
                                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 12)
                    }
                }
                .padding(.bottom, 20)
            }
        }
        .background(Color.white.opacity(0.02))
        .sheet(isPresented: $showLyricsMac) {
            if let track = player.currentTrack {
                LyricsSheet(track: track)
                    .frame(minWidth: 520, minHeight: 620)
            }
        }
    }

    private var macNowPlayingHeader: some View {
        HStack(spacing: 8) {
             Text(String(localized: "Now Playing"))
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Spacer()

            // Sleep timer as a native macOS Menu (popover-style)
            Menu {
                macSleepMenuContent
            } label: {
                Image(systemName: player.sleepTimerActive ? "moon.zzz.fill" : "moon")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(player.sleepTimerActive ? Color.accentStrong : Color.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(Color.white.opacity(0.08), in: Circle())
                    .contentTransition(.symbolEffect(.replace))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
             .help(String(localized: "Sleep timer"))
             .accessibilityLabel(Text(String(localized: "Sleep timer")))

            Button { showLyricsMac = true } label: {
                Image(systemName: "quote.bubble")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(Color.white.opacity(0.08), in: Circle())
            }
            .buttonStyle(PressableScale(scale: 0.90))
            .disabled(player.currentTrack == nil)
             .help(String(localized: "Show lyrics"))
             .accessibilityLabel(Text(String(localized: "Show lyrics")))

             Button(String(localized: "Expand")) { showNowPlaying = true }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.white.opacity(0.10))
                )
                .buttonStyle(.plain)
                 .help(String(localized: "Open full player"))
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
    }

    /// Sleep-timer menu content — macOS native popover-style Menu items.
    @ViewBuilder
    private var macSleepMenuContent: some View {
        if player.sleepTimerActive {
             Button(String(localized: "Turn off timer"), systemImage: "xmark.circle.fill") {
                player.clearSleepTimer()
            }
            Divider()
        }
         Section(String(localized: "Pause after")) {
             Button(String(localized: "5 minutes")) { player.setSleepTimer(minutes: 5) }
             Button(String(localized: "10 minutes")) { player.setSleepTimer(minutes: 10) }
             Button(String(localized: "15 minutes")) { player.setSleepTimer(minutes: 15) }
             Button(String(localized: "30 minutes")) { player.setSleepTimer(minutes: 30) }
             Button(String(localized: "45 minutes")) { player.setSleepTimer(minutes: 45) }
             Button(String(localized: "1 hour")) { player.setSleepTimer(minutes: 60) }
        }
        Divider()
         Button(String(localized: "End of current track")) { player.setSleepTimerEndOfTrack() }
            .disabled(player.currentTrack == nil)
    }

    // MARK: - Sidebar Helpers

    private func macMetricTile(value: String, label: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.textSecondary)
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
                )
        )
    }

    private func macSourceBadge(_ label: String, active: Bool) -> some View {
        Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(active ? Color.textPrimary : Color.textMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(active ? Color.white.opacity(0.08) : Color.white.opacity(0.03))
            )
    }

    private func macTransportGlyph(
        systemName: String,
        size: CGFloat,
        active: Bool = false,
        bounceTrigger: Int = 0
    ) -> some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(active ? Color.accentStrong : Color.textPrimary)
            .frame(width: 42, height: 42)
            .background(Color.white.opacity(active ? 0.12 : 0.07), in: Circle())
            .contentTransition(.symbolEffect(.replace))
            .symbolEffect(.bounce, value: bounceTrigger)
    }
    #endif

    #if os(iOS)
    private var iOSLayout: some View {
        GeometryReader { geo in
            let bottomSafe = geo.safeAreaInsets.bottom
            // Tab bar height (~49pt) + safe area (home indicator ~34pt)
            let miniPlayerBottomInset = bottomSafe + 8

            ZStack(alignment: .bottom) {
                AppBackdrop()

                rootTabs

                if player.currentTrack != nil {
                    MiniPlayerView(showNowPlaying: $showNowPlaying)
                        .padding(.horizontal, 16)
                        .padding(.bottom, miniPlayerBottomInset)
                        .safeAreaPadding(.bottom, 0)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .zIndex(1)
                }
            }
            .task {
                #if DEBUG
                if let debugTab = ProcessInfo.processInfo.environment["MUSAIC_DEBUG_TAB"],
                   let tab = RootTab(debugValue: debugTab) {
                    selectedTab = tab
                }
                if ProcessInfo.processInfo.environment["MUSAIC_DEBUG_NOW_PLAYING"] == "1" {
                    let shouldAutoPlay = ProcessInfo.processInfo.environment["MUSAIC_DEBUG_AUTOPLAY"] != "0"
                    let shouldOpenNowPlaying = ProcessInfo.processInfo.environment["MUSAIC_DEBUG_SHOW_NOW_PLAYING"] != "0"
                    player.seedDebugNowPlayingIfNeeded(autoplay: shouldAutoPlay)
                    if shouldOpenNowPlaying {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                            showNowPlaying = true
                        }
                    }
                }
                #endif
            }
        }
        .sheet(isPresented: $showNowPlaying) {
            NowPlayingView()
                .presentationDetents([.large])
                .presentationDragIndicator(.hidden)
                .presentationCornerRadius(32)
                .presentationBackground(.clear)
                .interactiveDismissDisabled(false)
        }
    }

    @ViewBuilder
    private var rootTabs: some View {
        // Keep the TabView identity stable while the mini-player appears.
        sharedTabs
    }
    #endif

    private var sharedTabs: some View {
        TabView(selection: $selectedTab) {
            ForEach(RootTab.allCases, id: \.rawValue) { tab in
                screen(for: tab)
                    .tag(tab)
                    .tabItem {
                        Label(tab.title, systemImage: tab.icon)
                    }
            }
        }
        .tint(Color.textPrimary)
        .toolbarColorSchemeCompat()
    }

    @ViewBuilder
    private func screen(for tab: RootTab) -> some View {
        switch tab {
        case .home:
            HomeView(showNowPlaying: $showNowPlaying)
        case .search:
            SearchView(showNowPlaying: $showNowPlaying)
        case .library:
            LibraryView(showNowPlaying: $showNowPlaying)
        case .profile:
            ProfileView()
        }
    }
}

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 6: (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default: (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255, opacity: Double(a) / 255)
    }

    static let accent = Color(hex: "e6d8c3")
    static let accentStrong = Color(hex: "cdb69a")
    static let textPrimary = Color(hex: "fbf7f1")
    static let textSecondary = Color(hex: "c9bfb4")
    static let textMuted = Color(hex: "9b9187")
    static let bgPrimary = Color(hex: "090807")
    static let bgSecondary = Color(hex: "151210")
    static let bgTertiary = Color(hex: "2a241f")
}

enum Layout {
    /// Bottom padding to keep content above MiniPlayer + tab bar
    static let playerBottomInset: CGFloat = 120
}
