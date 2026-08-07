import SwiftUI

struct HomeView: View {
    @Binding var showNowPlaying: Bool
    @State private var tracks: [Track] = []
    @State private var dailyMix: [Track] = []
    @State private var dailyMixName = "Morning Mix"
    @State private var recommendationsRequestId: String?
    @State private var dailyMixRequestId: String?
    @State private var loading = true
    @State private var selectedMood: String?
    @State private var myVibeFilters = MyVibeFilters.default
    @State private var startingMyVibe = false
    @State private var currentTrackId: String?
    /// Hero wave-icon entrance + slow glow drift (parallax) behind it.
    @State private var vibeIconAppeared = false
    @State private var vibeGlowDrift = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let api = APIService.shared
    private let player = PlayerStore.shared
    private let library = LibraryStore.shared

    private let moods = ["Energise", "Feel good", "Relax", "Workout", "Sad", "Party", "Focus", "Romance", "Sleep"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    jumpBackInSection

                    heroSection

                    VStack(alignment: .leading, spacing: 12) {
                        LiquidSectionHeader(title: "Moods", subtitle: "Pick a lane and let the mix shift with it.")
                            .padding(.horizontal, 18)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(moods, id: \.self) { mood in
                                    Button {
                                        loadMood(mood)
                                    } label: {
                                        Text(mood)
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(selectedMood == mood ? Color.bgPrimary : Color.textPrimary)
                                            .padding(.horizontal, 16)
                                            .padding(.vertical, 10)
                                            .background(
                                                Capsule()
                                                    .fill(selectedMood == mood ? Color.textPrimary.opacity(0.92) : Color.white.opacity(0.07))
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 18)
                        }
                    }

                    if !dailyMix.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .bottom) {
                                LiquidSectionHeader(title: dailyMixName, subtitle: "Rebuilt from recent listening and favorites.")
                                Spacer(minLength: 12)
                                Button {
                                    Task { await loadDailyMix(refresh: true) }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: "arrow.counterclockwise")
                                            .font(.system(size: 12, weight: .bold))
                                        Text("Reload")
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
                                let visibleDailyMix = Array(dailyMix.prefix(8))
                                ForEach(Array(visibleDailyMix.enumerated()), id: \.element.id) { idx, track in
                                    TrackRow(
                                        track: track,
                                        index: idx + 1,
                                        isCurrent: currentTrackId == track.id,
                                        isLiked: library.isLiked(track.id),
                                        onTap: {
                                            if player.setQueue(
                                                dailyMix,
                                                startAt: idx,
                                                surface: "daily_mix",
                                                requestId: dailyMixRequestId
                                            ) {
                                                showNowPlaying = true
                                            }
                                        },
                                        onLike: { library.toggleLike(track: track) },
                                        onAddToQueue: { player.addToQueue(track) }
                                    )
                                }
                            }
                        }
                    }

                    recommendationsSection
                }
                .padding(.top, 12)
                .padding(.bottom, Layout.playerBottomInset)
            }
            .scrollIndicators(.hidden)
            .background(AppBackdrop())
            .refreshable { await loadData() }
            .task { await loadData() }
            .onAppear { currentTrackId = player.currentTrack?.id }
            .onChange(of: player.currentTrack?.id) { _, newId in currentTrackId = newId }
            .navigationBarHiddenCompat(true)
        }
    }

    @ViewBuilder
    private var jumpBackInSection: some View {
        let likedTracks = Array(library.likedTracks.prefix(10))
        if !likedTracks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Jump Back In")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 18)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(Array(likedTracks.enumerated()), id: \.element.id) { idx, track in
                            Button {
                                if player.setQueue(library.likedTracks, startAt: idx) {
                                    showNowPlaying = true
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    InspectableArtworkView(
                                        urlString: track.artwork,
                                        debugLabel: "\(track.source.rawValue): \(track.artist) - \(track.title)",
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
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 18)
                }
            }
        }
    }

    private var heroSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(greeting)
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.textPrimary)
                    Text(selectedMood == nil ? "Your infinite wave from liked tracks and quick filters." : "Recommendations shifted to \(selectedMood!.lowercased()) mood.")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                }
                Spacer(minLength: 12)
                LiquidIconButton(systemName: "arrow.clockwise") {
                    selectedMood = nil
                    Task { await loadData() }
                }
            }

            myVibeHeroCard

            HStack(spacing: 12) {
                statCard(title: "Queue", value: "\(player.queue.count)", icon: "music.note.list")
                statCard(title: "Liked", value: "\(library.likedTrackIds.count)", icon: "heart.fill")
                statCard(title: player.isMyVibeActive ? "Vibe" : "Mix", value: player.isMyVibeActive ? (player.currentMyVibeFilters?.character.title ?? myVibeFilters.character.title) : (dailyMix.isEmpty ? "--" : "\(dailyMix.count)"), icon: player.isMyVibeActive ? "dot.radiowaves.up.forward" : "wand.and.stars")
            }
        }
        .padding(.horizontal, 18)
    }

    private var myVibeHeroCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Text("My Vibe")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)

                        Text(player.isMyVibeActive ? "LIVE" : "WAVE")
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

                ZStack {
                    // Parallax glow layer drifting slowly behind the wave icon
                    Circle()
                        .fill(Color(hex: "f0d6a6").opacity(0.45))
                        .frame(width: 66, height: 66)
                        .blur(radius: 16)
                        .offset(x: vibeGlowDrift ? 7 : -7, y: vibeGlowDrift ? -6 : 6)
                        .scaleEffect(vibeGlowDrift ? 1.14 : 0.92)

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
                .onAppear {
                    guard !reduceMotion else {
                        vibeIconAppeared = true
                        return
                    }
                    withAnimation(.spring(response: 0.55, dampingFraction: 0.72)) {
                        vibeIconAppeared = true
                    }
                    withAnimation(.easeInOut(duration: 4.4).repeatForever(autoreverses: true).delay(0.5)) {
                        vibeGlowDrift = true
                    }
                }
            }

            HStack(spacing: 10) {
                Button {
                    Task { await startMyVibe() }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: startingMyVibe ? "hourglass" : "play.fill")
                            .font(.system(size: 13, weight: .black))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(player.isMyVibeActive ? "Перезапустить волну" : "Запустить волну")
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                            Text(player.isMyVibeActive && player.currentMyVibeFilters == myVibeFilters ? "Станция уже идёт с этими фильтрами" : "Бесконечная станция по избранному")
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
                    Button("Сбросить") {
                        withAnimation(.easeInOut(duration: 0.25)) {
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
                    title: "Язык",
                    selection: $myVibeFilters.language,
                    options: MyVibeFilters.Language.allCases
                ) { $0.title }

                vibeFilterRow(
                    title: "Характер",
                    selection: $myVibeFilters.character,
                    options: MyVibeFilters.Character.allCases
                ) { $0.title }

                vibeFilterRow(
                    title: "Настроение",
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

                Circle()
                    .fill(Color(hex: "f0d6a6").opacity(0.18))
                    .frame(width: 200, height: 200)
                    .blur(radius: 30)
                    .offset(x: 110, y: -90)

                Circle()
                    .fill(Color.white.opacity(0.08))
                    .frame(width: 170, height: 170)
                    .blur(radius: 36)
                    .offset(x: -110, y: 90)
            }
        )
        .glassCard(cornerRadius: 34, tint: Color.accentStrong, intensity: 0.14)
    }

    private var mixHeroCard: some View {
        Button {
            guard !dailyMix.isEmpty else { return }
            if player.setQueue(
                dailyMix,
                startAt: 0,
                surface: "daily_mix",
                requestId: dailyMixRequestId
            ) {
                showNowPlaying = true
            }
        } label: {
            HStack(spacing: 16) {
                AnimatedMixCover(artworks: dailyMix.prefix(4).compactMap(\.artwork))

                VStack(alignment: .leading, spacing: 8) {
                    Text(dailyMixName)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.textPrimary)
                    Text(dailyMix.prefix(3).map(\.artist).joined(separator: " • "))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                        .lineLimit(2)
                    Text("Play curated blend")
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
        if loading && tracks.isEmpty && dailyMix.isEmpty {
            VStack(spacing: 14) {
                ProgressView()
                    .tint(Color.textPrimary)
                Text("Blending your feed")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else if !tracks.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                LiquidSectionHeader(
                    title: selectedMood ?? "For You",
                    subtitle: selectedMood == nil ? "Recommendations pulled from your library and history." : "Mood-weighted picks."
                )
                .padding(.horizontal, 18)

                LazyVStack(spacing: 10) {
                    let visibleTracks = Array(tracks.prefix(12))
                    ForEach(Array(visibleTracks.enumerated()), id: \.element.id) { idx, track in
                        TrackRow(
                            track: track,
                            index: idx + 1,
                            isCurrent: currentTrackId == track.id,
                            isLiked: library.isLiked(track.id),
                            onTap: {
                                if player.setQueue(
                                    tracks,
                                    startAt: idx,
                                    surface: selectedMood == nil ? "home" : "mood",
                                    requestId: recommendationsRequestId
                                ) {
                                    showNowPlaying = true
                                }
                            },
                            onLike: { library.toggleLike(track: track) },
                            onAddToQueue: { player.addToQueue(track) }
                        )
                    }
                }
            }
        } else {
            ContentUnavailableView("Nothing Yet", systemImage: "music.note.house", description: Text("Connect to your server and scan some music to populate the home feed."))
                .padding(.top, 80)
        }
    }

    private func statCard(title: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 22, tint: Color.white, intensity: 0.08)
    }

    private var myVibeLead: String {
        if startingMyVibe {
            return "Собираю первую пачку треков с учётом языка, знакомости и настроения."
        }
        if player.isMyVibeActive, player.currentMyVibeFilters == myVibeFilters {
            return "Эта волна уже играет. Можно быстро перезапустить её с теми же фильтрами."
        }
        return "Главная волна от избранного. Фильтры можно сочетать между собой, как в Моей волне."
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
                            withAnimation(.easeInOut(duration: 0.22)) {
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
                    }
                }
                .padding(.vertical, 1)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        if h < 12 { return "Good morning" }
        if h < 17 { return "Good afternoon" }
        return "Good evening"
    }

    private func loadData() async {
        loading = true
        async let recoTask: Void = loadRecommendations()
        async let dailyTask: Void = loadDailyMix()
        _ = await (recoTask, dailyTask)
        loading = false
    }

    private func loadRecommendations() async {
        // Try up to 2 times with a short delay
        for attempt in 0..<2 {
            do {
                let response = try await api.getHomeRecommendations()
                recommendationsRequestId = response.requestId
                tracks = response.tracks.map(api.toAppTrack)
                return
            } catch {
                if attempt == 0 {
                    try? await Task.sleep(for: .milliseconds(800))
                }
            }
        }
        // Final fallback: try local tracks
        if let st = try? await api.getTracks(source: "local", limit: 30) {
            recommendationsRequestId = nil
            tracks = st.map(api.toAppTrack)
        }
    }

    private func loadDailyMix(refresh: Bool = false) async {
        do {
            let mix = try await api.getDailyMix(refresh: refresh)
            dailyMixName = mix.name
            dailyMixRequestId = mix.requestId
            dailyMix = mix.tracks.map(api.toAppTrack)
        } catch {}
    }

    private func loadMood(_ mood: String) {
        selectedMood = mood
        recommendationsRequestId = nil
        tracks = []
        Task {
            do {
                let response = try await api.getMoodTracks(mood: mood, limit: 20)
                recommendationsRequestId = response.requestId
                tracks = response.tracks.map(api.toAppTrack)
            } catch {
                tracks = []
            }
        }
    }

    @MainActor
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

// MARK: - Animated Mix Cover

/// Living cover for the Daily Mix hero card: a 2x2 collage of the mix's track
/// artworks with a slow "breathing" drift, a rotating light sheen and a pulsing
/// glass play button. Falls back to drifting warm aurora blobs when the mix
/// has no artwork. All motion is disabled with Reduce Motion enabled.
private struct AnimatedMixCover: View {
    let artworks: [String]
    var size: CGFloat = 92

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false
    @State private var sheen = false

    private var cornerRadius: CGFloat { size * 0.28 }

    /// Padded to exactly 4 tiles by repeating what's available.
    private var tiles: [String] {
        guard !artworks.isEmpty else { return [] }
        return (0..<4).map { artworks[$0 % artworks.count] }
    }

    var body: some View {
        ZStack {
            // Warm dark base
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(hex: "4d3f30"), Color(hex: "241c15")],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            if tiles.isEmpty {
                auroraFallback
            } else {
                collage
            }

            // Contrast veil so the play button reads on any artwork
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.black.opacity(0.22))

            // Rotating light sheen sweeping across the cover
            if !reduceMotion {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(
                        AngularGradient(
                            colors: [
                                .clear,
                                Color(hex: "f0d6a6").opacity(0.20),
                                .clear,
                                Color.white.opacity(0.10),
                                .clear,
                            ],
                            center: .center
                        )
                    )
                    .rotationEffect(sheen ? .degrees(360) : .degrees(0))
            }

            // Glass play button
            Image(systemName: "play.fill")
                .font(.system(size: size * 0.24, weight: .bold))
                .foregroundStyle(Color.textPrimary)
                .frame(width: size * 0.52, height: size * 0.52)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
                .scaleEffect(breathe ? 1.06 : 0.96)
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
                .rotationEffect(sheen ? .degrees(-360) : .degrees(0))
        )
        .shadow(color: Color(hex: "c28a46").opacity(0.30), radius: 14, y: 6)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 16).repeatForever(autoreverses: false)) {
                sheen = true
            }
            withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) {
                breathe = true
            }
        }
    }

    private var collage: some View {
        let columns = [GridItem(.flexible(), spacing: 0), GridItem(.flexible(), spacing: 0)]
        return LazyVGrid(columns: columns, spacing: 0) {
            ForEach(Array(tiles.enumerated()), id: \.offset) { _, url in
                InspectableArtworkView(
                    urlString: url,
                    debugLabel: "mix-cover",
                    maxPixelSize: 128
                ) {
                    RoundedRectangle(cornerRadius: 0)
                        .fill(Color.white.opacity(0.06))
                        .overlay(
                            Image(systemName: "music.note")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textSecondary)
                        )
                }
                .aspectRatio(1, contentMode: .fill)
                .clipped()
            }
        }
        // Slow "breathing" drift — clipped by the rounded rect on the parent.
        .scaleEffect(breathe ? 1.12 : 1.0)
    }

    private var auroraFallback: some View {
        ZStack {
            Circle()
                .fill(Color(hex: "f0d6a6").opacity(0.45))
                .frame(width: size * 0.7, height: size * 0.7)
                .blur(radius: 14)
                .offset(
                    x: breathe ? size * 0.16 : -size * 0.16,
                    y: breathe ? -size * 0.12 : size * 0.12
                )

            Circle()
                .fill(Color(hex: "c28a46").opacity(0.40))
                .frame(width: size * 0.55, height: size * 0.55)
                .blur(radius: 12)
                .offset(
                    x: breathe ? -size * 0.18 : size * 0.14,
                    y: breathe ? size * 0.14 : -size * 0.16
                )

            Image(systemName: "waveform")
                .font(.system(size: size * 0.30, weight: .semibold))
                .foregroundStyle(Color.textPrimary.opacity(0.85))
        }
    }
}
