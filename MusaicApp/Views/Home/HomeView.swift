import SwiftUI

struct HomeView: View {
    @Binding var showNowPlaying: Bool
    @State private var tracks: [Track] = []
    @State private var dailyMix: [Track] = []
    @State private var dailyMixName = String(localized: "Daily Mix")
    @State private var recommendationsRequestId: String?
    @State private var dailyMixRequestId: String?
    /// Recommendations list state; independent of the Daily Mix so switching
    /// moods never falls through to the empty state while loading.
    @State private var feedLoading = true
    @State private var homeError: String?
    @State private var homeUnauthorized = false
    @State private var dailyMixError: String?
    @State private var dailyMixUnauthorized = false
    @State private var selectedMood: String?
    @State private var feedTask: Task<Void, Never>?
    @State private var feedGeneration = 0
    /// Mood of the tracks currently on screen (nil = "For You").
    @State private var displayedFeedMood: String?
    @State private var lastLoadedAt: Date?
    @State private var myVibeFilters = MyVibeFilters.default
    @State private var startingMyVibe = false
    @State private var vibeIconAppeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared
    private let settings = SettingsStore.shared

    /// Tab switches reuse loaded content; it is refetched only after this long.
    private static let staleAfter: TimeInterval = 5 * 60
    private let moods = ["Energise", "Feel good", "Relax", "Workout", "Sad", "Party", "Focus", "Romance", "Sleep"]

    private var currentTrackId: String? { player.currentTrack?.id }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    jumpBackInSection

                    heroSection

                    if let dailyMixError {
                        ErrorRetryView(
                            title: dailyMixUnauthorized ? String(localized: "Session expired") : String(localized: "Daily Mix unavailable"),
                            message: dailyMixError,
                            isUnauthorized: dailyMixUnauthorized,
                            onRetry: { Task { await loadDailyMix(refresh: true) } },
                            onSignIn: dailyMixUnauthorized ? { settings.logout() } : nil
                        )
                        .padding(.horizontal, 18)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        LiquidSectionHeader(title: String(localized: "Moods"), subtitle: String(localized: "Pick a lane and let the mix shift with it."))
                            .padding(.horizontal, 18)

                        ChipSelector(
                            options: moods,
                            label: { $0 },
                            isSelected: { selectedMood == $0 },
                            onSelect: selectMood,
                            style: .mood
                        )
                    }

                    if !dailyMix.isEmpty {
                        dailyMixSection
                    }

                    recommendationsSection
                }
                .padding(.top, 12)
                .padding(.bottom, Layout.playerBottomInset)
            }
            .scrollIndicators(.hidden)
            .background(AppBackdrop())
            .refreshable { await loadData() }
            .task { await refreshIfStale() }
            .navigationBarHiddenCompat(true)
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var jumpBackInSection: some View {
        let likedTracks = Array(library.likedTracks.prefix(10))
        if !likedTracks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(String(localized: "Jump Back In"))
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 18)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(likedTracks.listItems) { item in
                            Button {
                                if player.setQueue(library.likedTracks, startAt: item.index) {
                                    showNowPlaying = true
                                }
                            } label: {
                                jumpBackInCard(item.track)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("\(item.track.title), \(item.track.artist)"))
                        }
                    }
                    .padding(.horizontal, 18)
                }
            }
        }
    }

    private func jumpBackInCard(_ track: Track) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            InspectableArtworkView(
                urlString: track.artwork,
                debugLabel: "jump-back-in",
                maxPixelSize: 256
            ) {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        Image(systemName: "music.note")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    )
            }
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: Color.black.opacity(0.35), radius: 8, y: 4)

            Text(track.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
                .lineLimit(1)
                .frame(width: 88, alignment: .leading)

            Text(track.artist)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(1)
                .frame(width: 88, alignment: .leading)
        }
    }

    private var heroSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(greeting)
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.textPrimary)
                    Text(heroSubtitle)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                }
                Spacer(minLength: 12)
                LiquidIconButton(systemName: "arrow.clockwise", accessibilityLabel: String(localized: "Reload")) {
                    selectedMood = nil
                    Task { await loadData() }
                }
            }

            myVibeHeroCard

            if let intro = player.djIntroMessage, player.isDjIntroVisible {
                djIntroBanner(intro)
            }

            HStack(spacing: 12) {
                StatCard(value: "\(player.queue.count)", label: String(localized: "Queue"), icon: "music.note.list")
                StatCard(value: "\(library.likedTrackIds.count)", label: String(localized: "Liked"), icon: "heart.fill")
                StatCard(
                    value: mixStatValue,
                    label: player.isMyVibeActive ? String(localized: "Vibe") : String(localized: "Mix"),
                    icon: player.isMyVibeActive ? "dot.radiowaves.up.forward" : "wand.and.stars"
                )
            }
        }
        .padding(.horizontal, 18)
    }

    private var heroSubtitle: String {
        if let selectedMood {
            return String(localized: "Recommendations shifted to \(selectedMood.lowercased()) mood.")
        }
        return String(localized: "Your infinite wave from liked tracks and quick filters.")
    }

    private var mixStatValue: String {
        if player.isMyVibeActive {
            return player.currentMyVibeFilters?.character.title ?? myVibeFilters.character.title
        }
        return dailyMix.isEmpty ? "--" : "\(dailyMix.count)"
    }

    /// AI DJ line: appears right after the wave starts, auto-hides after ~7s.
    private func djIntroBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "dot.radiowaves.forward")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Color.accentStrong)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .glassCard(cornerRadius: 18, intensity: 0.12)
        .transition(.opacity.combined(with: .move(edge: .top)))
        .task {
            guard (try? await Task.sleep(for: .seconds(7.5))) != nil else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.4)) {
                player.djIntroMessage = nil
            }
        }
    }

    private var myVibeHeroCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Text(String(localized: "My Vibe"))
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)

                        Text(player.isMyVibeActive ? String(localized: "LIVE") : String(localized: "WAVE"))
                            .font(.system(size: 11, weight: .black))
                            .foregroundStyle(player.isMyVibeActive ? Color.bgPrimary : Color.textPrimary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                Capsule()
                                    .fill(player.isMyVibeActive ? Color.textPrimary.opacity(0.92) : Color.white.opacity(0.10))
                            )
                    }

                    Text(myVibeLead)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(myVibeFilters.summary)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.textPrimary.opacity(0.90))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.08), in: Capsule())
                }

                Spacer(minLength: 12)

                vibeOrb
            }

            HStack(spacing: 10) {
                Button {
                    Task { await startMyVibe() }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: startingMyVibe ? "hourglass" : "play.fill")
                            .font(.system(size: 13, weight: .black))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(player.isMyVibeActive ? String(localized: "Restart My Vibe") : String(localized: "Start My Vibe"))
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                            Text(isCurrentVibe ? String(localized: "Already playing with these filters") : String(localized: "An endless station built from your favorites"))
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Color.bgPrimary.opacity(0.70))
                        }
                        Spacer(minLength: 8)
                        if startingMyVibe {
                            ProgressView()
                                .tint(Color.bgPrimary)
                                .scaleEffect(0.85)
                        }
                    }
                    .foregroundStyle(Color.bgPrimary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(Color.textPrimary.opacity(0.94), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(startingMyVibe)

                if !myVibeFilters.isDefault {
                    Button(String(localized: "Reset")) {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                            myVibeFilters = .default
                        }
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .glassCard(cornerRadius: 24, tint: Color.white, intensity: 0.08)
                    .buttonStyle(.plain)
                }
            }

            VStack(alignment: .leading, spacing: 12) {
                vibeFilterRow(
                    title: String(localized: "Language"),
                    selection: $myVibeFilters.language,
                    options: MyVibeFilters.Language.allCases
                ) { $0.title }

                vibeFilterRow(
                    title: String(localized: "Character"),
                    selection: $myVibeFilters.character,
                    options: MyVibeFilters.Character.allCases
                ) { $0.title }

                vibeFilterRow(
                    title: String(localized: "Mood"),
                    selection: $myVibeFilters.mood,
                    options: MyVibeFilters.Mood.allCases
                ) { $0.title }

                Text(myVibeFilters.character.subtitle)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .padding(22)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(hex: "4d3f30").opacity(0.88),
                                Color(hex: "2d241d").opacity(0.86),
                                Color(hex: "171311").opacity(0.94),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                // Static radial glows instead of large live blurs.
                RadialGradient(
                    colors: [Color(hex: "f0d6a6").opacity(0.16), .clear],
                    center: .topTrailing,
                    startRadius: 10,
                    endRadius: 200
                )
                RadialGradient(
                    colors: [Color.white.opacity(0.06), .clear],
                    center: .bottomLeading,
                    startRadius: 10,
                    endRadius: 180
                )
            }
            .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
        )
        .glassCard(cornerRadius: 34, tint: Color.accentStrong, intensity: 0.14)
    }

    /// Wave icon with a one-time entrance; no looping motion (see the heat
    /// note in NowPlayingBackdrop).
    private var vibeOrb: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(hex: "f0d6a6").opacity(0.95),
                            Color(hex: "c28a46").opacity(0.38),
                            .clear
                        ],
                        center: .center,
                        startRadius: 8,
                        endRadius: 54
                    )
                )
            Circle()
                .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                .padding(8)
            Image(systemName: startingMyVibe ? "waveform.path.ecg" : "dot.radiowaves.up.forward")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(Color.bgPrimary)
        }
        .frame(width: 88, height: 88)
        .scaleEffect(vibeIconAppeared ? 1 : 0.8)
        .opacity(vibeIconAppeared ? 1 : 0)
        .accessibilityHidden(true)
        .onAppear {
            guard !vibeIconAppeared else { return }
            if reduceMotion {
                vibeIconAppeared = true
            } else {
                withAnimation(.spring(response: 0.55, dampingFraction: 0.72)) {
                    vibeIconAppeared = true
                }
            }
        }
    }

    private var dailyMixSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom) {
                LiquidSectionHeader(title: dailyMixName, subtitle: String(localized: "Rebuilt from recent listening and favorites."))
                Spacer(minLength: 12)
                Button {
                    Task { await loadDailyMix(refresh: true) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 12, weight: .bold))
                        Text(String(localized: "Reload"))
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.10), in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 18)

            mixHeroCard
                .padding(.horizontal, 18)

            LazyVStack(spacing: 10) {
                ForEach(Array(dailyMix.prefix(8)).listItems) { item in
                    TrackRow(
                        track: item.track,
                        index: item.index + 1,
                        isCurrent: currentTrackId == item.track.id,
                        isLiked: library.isLiked(item.track.id),
                        onTap: { playDailyMix(from: item.index) },
                        onLike: { library.toggleLike(track: item.track) },
                        onAddToQueue: { player.addToQueue(item.track) }
                    )
                }
            }
        }
    }

    private var mixHeroCard: some View {
        Button {
            playDailyMix(from: 0)
        } label: {
            HStack(spacing: 16) {
                MixCover(artworks: dailyMix.prefix(4).compactMap(\.artwork))

                VStack(alignment: .leading, spacing: 8) {
                    Text(dailyMixName)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.textPrimary)
                    Text(dailyMix.prefix(3).map(\.artist).joined(separator: " • "))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .lineLimit(2)
                    Text(String(localized: "Play curated blend"))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.textPrimary.opacity(0.85))
                }

                Spacer()
            }
            .padding(18)
            .glassCard(cornerRadius: 28, tint: Color.white, intensity: 0.12)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var recommendationsSection: some View {
        if feedLoading && tracks.isEmpty {
            VStack(spacing: 14) {
                ProgressView()
                    .tint(Color.textPrimary)
                Text(String(localized: "Blending your feed"))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else if let homeError {
            ErrorRetryView(
                title: homeUnauthorized ? String(localized: "Session expired") : String(localized: "Home unavailable"),
                message: homeError,
                isUnauthorized: homeUnauthorized,
                onRetry: { reloadFeed() },
                onSignIn: homeUnauthorized ? { settings.logout() } : nil
            )
            .padding(.horizontal, 18)
            .padding(.top, 80)
        } else if !tracks.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                LiquidSectionHeader(
                    title: selectedMood ?? String(localized: "For You"),
                    subtitle: selectedMood == nil
                        ? String(localized: "Recommendations pulled from your library and history.")
                        : String(localized: "Mood-weighted picks.")
                )
                .padding(.horizontal, 18)

                LazyVStack(spacing: 10) {
                    ForEach(Array(tracks.prefix(12)).listItems) { item in
                        TrackRow(
                            track: item.track,
                            index: item.index + 1,
                            isCurrent: currentTrackId == item.track.id,
                            isLiked: library.isLiked(item.track.id),
                            onTap: {
                                if player.setQueue(
                                    tracks,
                                    startAt: item.index,
                                    surface: selectedMood == nil ? "home" : "mood",
                                    requestId: recommendationsRequestId
                                ) {
                                    showNowPlaying = true
                                }
                            },
                            onLike: { library.toggleLike(track: item.track) },
                            onAddToQueue: { player.addToQueue(item.track) }
                        )
                    }
                }
            }
        } else {
            EmptyStateView(
                title: String(localized: "Nothing Yet"),
                message: String(localized: "Connect to your server and scan some music to populate the home feed."),
                systemImage: "music.note.house",
                actionTitle: String(localized: "Retry"),
                action: { reloadFeed() }
            )
            .padding(.top, 80)
        }
    }

    private var isCurrentVibe: Bool {
        player.isMyVibeActive && player.currentMyVibeFilters == myVibeFilters
    }

    private var myVibeLead: String {
        if startingMyVibe {
            return String(localized: "Gathering the first batch of tracks for your language, familiarity and mood.")
        }
        if isCurrentVibe {
            return String(localized: "This wave is already playing. You can restart it with the same filters.")
        }
        return String(localized: "The main wave from your favorites. Filters can be combined freely.")
    }

    private func vibeFilterRow<Option: Identifiable & Hashable>(
        title: String,
        selection: Binding<Option>,
        options: [Option],
        label: @escaping (Option) -> String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.textSecondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(options, id: \.id) { option in
                        let isSelected = selection.wrappedValue == option
                        Button {
                            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) {
                                selection.wrappedValue = option
                            }
                        } label: {
                            Text(label(option))
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(isSelected ? Color.bgPrimary : Color.textPrimary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .background(
                                    Capsule()
                                        .fill(isSelected ? Color.textPrimary.opacity(0.94) : Color.white.opacity(0.08))
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(isSelected ? .isSelected : [])
                    }
                }
                .padding(.vertical, 1)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        if hour < 12 { return String(localized: "Good morning") }
        if hour < 17 { return String(localized: "Good afternoon") }
        return String(localized: "Good evening")
    }

    // MARK: - Loading

    private func refreshIfStale() async {
        if let lastLoadedAt, Date().timeIntervalSince(lastLoadedAt) < Self.staleAfter {
            return
        }
        await loadData()
    }

    private func loadData() async {
        async let feed: Void = loadFeed()
        async let mix: Void = loadDailyMix()
        _ = await (feed, mix)
        // A tab switch mid-load cancels it; don't mark the screen as fresh then.
        if !Task.isCancelled { lastLoadedAt = Date() }
    }

    private func reloadFeed() {
        Task { await loadFeed() }
    }

    private func selectMood(_ mood: String) {
        // Tapping the active mood returns to "For You".
        selectedMood = selectedMood == mood ? nil : mood
        reloadFeed()
    }

    /// Latest request wins: a newer mood/refresh cancels the previous load
    /// and stale responses are dropped by generation.
    private func loadFeed() async {
        feedTask?.cancel()
        feedGeneration += 1
        let generation = feedGeneration
        let mood = selectedMood
        // A different mood replaces the list; a plain refresh keeps it visible.
        if mood != displayedFeedMood {
            tracks = []
            recommendationsRequestId = nil
        }
        homeError = nil
        homeUnauthorized = false
        feedLoading = true

        let task = Task {
            let outcome = await fetchFeed(mood: mood)
            guard !Task.isCancelled, generation == feedGeneration else { return }
            switch outcome {
            case .success(let response):
                tracks = response.tracks
                recommendationsRequestId = response.requestId
                displayedFeedMood = mood
            case .failure(let error):
                // Keep a still-valid list after a failed refresh.
                if tracks.isEmpty || mood != displayedFeedMood {
                    tracks = []
                    homeError = error.localizedDescription
                    homeUnauthorized = error.isUnauthorized
                }
            }
            feedLoading = false
        }
        feedTask = task
        await task.value
    }

    private struct FeedResponse {
        let tracks: [Track]
        let requestId: String?
    }

    private func fetchFeed(mood: String?) async -> Result<FeedResponse, Error> {
        do {
            if let mood {
                let response = try await api.getMoodTracks(mood: mood, limit: 20)
                return .success(FeedResponse(tracks: response.tracks.map(api.toAppTrack), requestId: response.requestId))
            }
            let response = try await api.getHomeRecommendations()
            return .success(FeedResponse(tracks: response.tracks.map(api.toAppTrack), requestId: response.requestId))
        } catch where mood == nil && !error.isCancellation && !error.isUnauthorized {
            // Recommendations down: fall back to the local library.
            if let local = try? await api.getTracks(source: "local", limit: 30), !local.isEmpty {
                return .success(FeedResponse(tracks: local.map(api.toAppTrack), requestId: nil))
            }
            return .failure(error)
        } catch {
            return .failure(error)
        }
    }

    private func loadDailyMix(refresh: Bool = false) async {
        dailyMixError = nil
        dailyMixUnauthorized = false
        do {
            let mix = try await api.getDailyMix(refresh: refresh)
            dailyMixName = mix.name
            dailyMixRequestId = mix.requestId
            dailyMix = mix.tracks.map(api.toAppTrack)
        } catch where error.isCancellation {
            return
        } catch {
            dailyMix = []
            dailyMixError = error.localizedDescription
            dailyMixUnauthorized = error.isUnauthorized
        }
    }

    private func playDailyMix(from index: Int) {
        guard !dailyMix.isEmpty else { return }
        if player.setQueue(dailyMix, startAt: index, surface: "daily_mix", requestId: dailyMixRequestId) {
            showNowPlaying = true
        }
    }

    private func startMyVibe() async {
        startingMyVibe = true
        defer { startingMyVibe = false }

        await library.hydrateLikedTracksIfNeeded()
        let likedSeeds = library.displayedLikedTracks
        let fallbackSeeds = !dailyMix.isEmpty ? dailyMix : tracks
        let seeds = likedSeeds.isEmpty ? fallbackSeeds : likedSeeds
        guard !seeds.isEmpty else { return }
        let shouldOpenNowPlaying = player.currentTrack == nil

        await player.startMyVibe(
            from: Array(seeds.prefix(24)),
            filters: myVibeFilters,
            knownTrackIds: library.likedTrackIds
        )
        if shouldOpenNowPlaying, player.currentTrack != nil {
            showNowPlaying = true
        }
    }
}

// MARK: - Mix Cover

/// Daily Mix cover: a 2x2 collage of the mix's artworks (or a warm gradient
/// when there is none) with a glass play badge. Deliberately static.
private struct MixCover: View {
    let artworks: [String]
    var size: CGFloat = 92

    private var cornerRadius: CGFloat { size * 0.28 }

    /// Padded to exactly 4 tiles by repeating what's available.
    private var tiles: [String] {
        guard !artworks.isEmpty else { return [] }
        return (0..<4).map { artworks[$0 % artworks.count] }
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(hex: "4d3f30"), Color(hex: "241c15")],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            if tiles.isEmpty {
                RadialGradient(
                    colors: [Color(hex: "f0d6a6").opacity(0.45), Color(hex: "c28a46").opacity(0.2), .clear],
                    center: .topLeading,
                    startRadius: 4,
                    endRadius: size
                )
                Image(systemName: "waveform")
                    .font(.system(size: size * 0.30, weight: .semibold))
                    .foregroundStyle(Color.textPrimary.opacity(0.85))
            } else {
                collage
            }

            // Contrast veil so the play badge reads on any artwork.
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.black.opacity(0.22))

            Image(systemName: "play.fill")
                .font(.system(size: size * 0.24, weight: .bold))
                .foregroundStyle(Color.textPrimary)
                .frame(width: size * 0.52, height: size * 0.52)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(
                    AngularGradient(
                        colors: [
                            Color(hex: "f0d6a6").opacity(0.75),
                            Color.white.opacity(0.10),
                            Color(hex: "c28a46").opacity(0.55),
                            Color.white.opacity(0.08),
                            Color(hex: "f0d6a6").opacity(0.75),
                        ],
                        center: .center
                    ),
                    lineWidth: 1.4
                )
        )
        .shadow(color: Color(hex: "c28a46").opacity(0.30), radius: 14, y: 6)
        .accessibilityHidden(true)
    }

    private var collage: some View {
        let columns = [GridItem(.flexible(), spacing: 0), GridItem(.flexible(), spacing: 0)]
        return LazyVGrid(columns: columns, spacing: 0) {
            ForEach(Array(tiles.enumerated()), id: \.offset) { _, url in
                InspectableArtworkView(urlString: url, debugLabel: "mix-cover", maxPixelSize: 128) {
                    Rectangle()
                        .fill(Color.white.opacity(0.06))
                }
                .aspectRatio(1, contentMode: .fill)
                .clipped()
            }
        }
    }
}
