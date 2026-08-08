import SwiftUI

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
                    onRetry: retry
                )

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
                    VStack(spacing: 20) {
                        Image(systemName: "wifi.exclamationmark")
                            .font(.system(size: 44))
                            .foregroundStyle(Color.white.opacity(0.15))
                        Text(String(localized: "Failed to load lyrics"))
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
                                Text(String(localized: "Retry"))
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
                    ZStack(alignment: .bottom) {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 6) {
                                    ForEach(lines) { line in
                                        LyricsLineView(
                                            lineID: line.id,
                                            text: line.text,
                                            isActive: activeLine == line.id,
                                            isTapped: tappedLineId == line.id,
                                            onTap: { tapLine(line) }
                                        )
                                    }
                                }
                                .padding(.horizontal, 24)
                                .padding(.bottom, Layout.playerBottomInset)
                            }
                            .scrollIndicators(.hidden)
                            .onChange(of: activeLine) { _, newLine in
                                if !userScrolledAway {
                                    withAnimation(.smooth(duration: 0.55)) {
                                        proxy.scrollTo(newLine, anchor: .center)
                                    }
                                }
                            }
                            .onChange(of: lines.count) { _, newCount in
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
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                                        userScrolledAway = false
                                    }
                                }
                            }
                        }

                        if userScrolledAway {
                            Button {
                                userScrolledAway = false
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
                    Spacer()
                }
            }

            if generating && rawLrc != nil {
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
        }
        .animation(.easeInOut(duration: 0.2), value: generating)
        .task { await loadLyrics() }
        .onAppear { startLyricsTimer() }
        .onDisappear { stopLyricsTimer() }
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

    private func tapLine(_ line: LrcLine) {
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
                try? await Task.sleep(for: .milliseconds(120))
            }
        }
    }

    private func stopLyricsTimer() {
        timerTask?.cancel()
        timerTask = nil
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

    private func retry() {
        generate()
    }

    private func generate() {
        generateTask?.cancel()
        generating = true
        generateTask = Task { @MainActor in
            defer { generating = false }
            try? await api.deleteLyrics(trackId: track.id)
            if Task.isCancelled { return }
            _ = try? await api.generateLyrics(trackId: track.id)
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
            updateActiveLine()
            if let firstId = lines.first?.id {
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
