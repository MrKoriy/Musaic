import SwiftUI

private enum StatsPeriod: String, CaseIterable {
    case today, week, month, alltime

    var label: String {
        switch self {
        case .today: return String(localized: "Today")
        case .week: return String(localized: "Week")
        case .month: return String(localized: "Month")
        case .alltime: return String(localized: "All time")
        }
    }

    var apiValue: String {
        switch self {
        case .today: return "today"
        case .week: return "week"
        case .month: return "month"
        case .alltime: return "alltime"
        }
    }

    func listens(from overview: StatsOverview) -> Int {
        switch self {
        case .today: return overview.listens.today
        case .week: return overview.listens.week
        case .month: return overview.listens.month
        case .alltime: return overview.listens.allTime
        }
    }

    func secs(from overview: StatsOverview) -> Int {
        guard let t = overview.listeningTime else { return 0 }
        switch self {
        case .today: return t.todaySecs
        case .week: return t.weekSecs
        case .month: return t.monthSecs
        case .alltime: return t.allTimeSecs
        }
    }
}

struct ProfileStatsSection: View {
    @State private var statsPeriod: StatsPeriod = .month
    @State private var statsOverview: StatsOverview?
    @State private var topTracks: [StatsTopTrack] = []
    @State private var topArtists: [StatsTopArtist] = []
    @State private var statsLoading = false
    @State private var statsError: String?
    @State private var statsUnauthorized = false

    private let api = APIService.shared
    private let settings = SettingsStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Your Stats")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if statsLoading {
                    ProgressView()
                        .tint(Color.textSecondary)
                        .scaleEffect(0.8)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(StatsPeriod.allCases, id: \.self) { period in
                        Button {
                            statsPeriod = period
                            Task { await loadStats() }
                        } label: {
                            Text(period.label)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(statsPeriod == period ? Color.bgPrimary : Color.textSecondary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(
                                    Capsule()
                                        .fill(statsPeriod == period ? Color.textPrimary : Color.white.opacity(0.08))
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
            }

            if let statsError {
                ErrorRetryView(
                    title: statsUnauthorized ? String(localized: "Session expired") : String(localized: "Stats unavailable"),
                    message: statsError,
                    isUnauthorized: statsUnauthorized,
                    onRetry: { Task { await loadStats() } },
                    onSignIn: statsUnauthorized ? { settings.logout() } : nil
                )
                .padding(.horizontal, 18)
            } else if let overview = statsOverview {
                HStack(spacing: 10) {
                    StatCard(
                        value: "\(statsPeriod.listens(from: overview))",
                        label: "Listens",
                        icon: "headphones"
                    )
                    StatCard(
                        value: formatListeningTime(statsPeriod.secs(from: overview)),
                        label: "Time",
                        icon: "clock"
                    )
                    StatCard(
                        value: "\(overview.streak)d",
                        label: "Streak",
                        icon: "flame"
                    )
                }
                .padding(.horizontal, 18)
            } else if !statsLoading {
                HStack(spacing: 10) {
                    StatCard(value: "—", label: "Listens", icon: "headphones")
                    StatCard(value: "—", label: "Time", icon: "clock")
                    StatCard(value: "—", label: "Streak", icon: "flame")
                }
                .padding(.horizontal, 18)
            }

            if !topTracks.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "music.note")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.accentStrong)
                        Text("Top tracks")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                    }

                    ForEach(Array(topTracks.enumerated()), id: \.element.id) { idx, track in
                        HStack(spacing: 12) {
                            Text("\(idx + 1)")
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.textMuted)
                                .frame(width: 18, alignment: .trailing)

                            ArtworkTile(urlString: api.artworkURL(for: track.coverUrl), icon: "music.note")
                                .frame(width: 40, height: 40)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(track.title)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text(track.artist)
                                    .font(.system(size: 12, weight: .regular))
                                    .foregroundStyle(Color.textSecondary)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 0)

                            Text("\(track.playCount) plays")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(16)
                .glassCard(cornerRadius: 24, intensity: 0.10)
                .padding(.horizontal, 18)
            }

            if !topArtists.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "person.2")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.accentStrong)
                        Text("Top artists")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                    }

                    ForEach(Array(topArtists.enumerated()), id: \.element.id) { idx, artist in
                        HStack(spacing: 12) {
                            Text("\(idx + 1)")
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Color.textMuted)
                                .frame(width: 18, alignment: .trailing)

                            ArtworkTile(urlString: api.artworkURL(for: artist.coverUrl), icon: "person")
                                .frame(width: 40, height: 40)
                                .clipShape(Circle())

                            VStack(alignment: .leading, spacing: 2) {
                                Text(artist.artist)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text("\(artist.uniqueTracks) tracks")
                                    .font(.system(size: 12, weight: .regular))
                                    .foregroundStyle(Color.textSecondary)
                            }

                            Spacer(minLength: 0)

                            Text("\(artist.playCount) plays")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(16)
                .glassCard(cornerRadius: 24, intensity: 0.10)
                .padding(.horizontal, 18)
            }
        }
        .task {
            await loadStats()
        }
    }

    private func formatListeningTime(_ secs: Int) -> String {
        if secs < 60 { return "\(secs)s" }
        let mins = secs / 60
        if mins < 60 { return "\(mins)m" }
        let hours = mins / 60
        let remainingMins = mins % 60
        if remainingMins == 0 { return "\(hours)h" }
        return "\(hours)h \(remainingMins)m"
    }

    private func loadStats() async {
        statsLoading = true
        statsError = nil
        statsUnauthorized = false
        defer { statsLoading = false }

        do {
            async let overview = api.getStatsOverview()
            async let tracks = api.getTopTracks(period: statsPeriod.apiValue, limit: 5)
            async let artists = api.getTopArtists(period: statsPeriod.apiValue, limit: 5)
            let (ov, tr, ar) = try await (overview, tracks, artists)
            statsOverview = ov
            topTracks = tr
            topArtists = ar
        } catch {
            statsOverview = nil
            topTracks = []
            topArtists = []
            statsError = error.localizedDescription
            statsUnauthorized = (error as? APIError)?.statusCode == 401
        }
    }
}
