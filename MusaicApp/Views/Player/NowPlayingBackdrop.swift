import SwiftUI

/// Static ambient backdrop derived from the current artwork's dominant color.
/// Uses a single, cheap radial gradient — NO animated blur orbs, NO repeatForever
/// animation (those were keeping the GPU at ~full load and heating the device).
/// Falls back to the fallback palette while the image is loading.
struct NowPlayingBackdrop: View {
    let track: Track?

    @State private var palette: ArtworkPalette = .fallback
    @State private var loadedKey: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            // Base vertical gradient: dominant tint → shadow → near-black.
            LinearGradient(
                colors: [
                    palette.dominant.opacity(0.55),
                    palette.shadow.opacity(0.95),
                    Color(red: 0.035, green: 0.03, blue: 0.028)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            // A single static radial glow top-right — gives the "alive" hint
            // without any per-frame GPU work. No `.blur()`, no repeatForever.
            RadialGradient(
                colors: [
                    palette.secondary.opacity(0.32),
                    .clear
                ],
                center: UnitPoint(x: 0.78, y: 0.22),
                startRadius: 20,
                endRadius: 360
            )

            // Soft bottom vignette for legibility.
            LinearGradient(
                colors: [.clear, .black.opacity(0.55)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        // Cross-fade the colour change itself, not the orb positions.
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.9), value: palette.dominant)
        .ignoresSafeArea()
        .task(id: track?.id) {
            await loadPalette()
        }
    }

    private func loadPalette() async {
        guard let urlString = track?.artwork,
              let url = URL(string: urlString) else {
            palette = .fallback
            loadedKey = nil
            return
        }
        let key = url.absoluteString
        if key == loadedKey { return }

        do {
            let result = try await ArtworkPipeline.shared.loadImage(from: url, maxPixelSize: 160)
            let extracted = await ArtworkColorService.shared.palette(for: result.image, cacheKey: key)
            await MainActor.run {
                loadedKey = key
                palette = extracted
            }
        } catch {
            await MainActor.run {
                palette = .fallback
                loadedKey = nil
            }
        }
    }
}

// MARK: - Sleep Timer Sheet

struct SleepTimerSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let player = PlayerStore.shared

    /// Drives the "remaining" countdown display. Re-reads PlayerStore every second.
    @State private var now = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let presets: [(label: String, minutes: Int?)] = [
        (String(localized: "5 minutes"), 5),
        (String(localized: "10 minutes"), 10),
        (String(localized: "15 minutes"), 15),
        (String(localized: "30 minutes"), 30),
        (String(localized: "45 minutes"), 45),
        (String(localized: "1 hour"), 60)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(
                    colors: [Color(hex: "1a1510"), Color(hex: "0a0908")],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        header

                        VStack(spacing: 10) {
                            ForEach(presets, id: \.minutes) { preset in
                                presetRow(label: preset.label, minutes: preset.minutes)
                            }

                            endOfTrackRow
                        }
                        .padding(.horizontal, 18)

                        if player.sleepTimerActive {
                            Button {
                                player.clearSleepTimer()
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "xmark.circle.fill")
                                 Text(String(localized: "Turn off timer"))
                                        .font(.system(size: 14, weight: .bold))
                                }
                                .foregroundStyle(Color.textPrimary)
                                .padding(.horizontal, 22)
                                .padding(.vertical, 13)
                                .background(Color.white.opacity(0.10), in: Capsule())
                                .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                            .padding(.horizontal, 18)
                        }
                    }
                    .padding(.vertical, 14)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayModeCompat()
            .toolbar {
                ToolbarItem(placement: .topBarTrailingCompat) {
                     Button(String(localized: "Done")) { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
        }
        .task {
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(hex: "d7ba8d").opacity(0.55),
                                Color(hex: "5b4430").opacity(0.25),
                                .clear
                            ],
                            center: .center,
                            startRadius: 4,
                            endRadius: 60
                        )
                    )
                if reduceMotion {
                    Image(systemName: "moon.zzz.fill")
                        .font(.system(size: 36, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                } else {
                    Image(systemName: "moon.zzz.fill")
                        .font(.system(size: 36, weight: .semibold))
                        .foregroundStyle(Color.textPrimary)
                        .symbolEffect(.pulse, options: .repeating, value: player.sleepTimerActive)
                }
            }
            .frame(width: 100, height: 100)

             Text(String(localized: "Sleep Timer"))
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)

            Text(statusLine)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .padding(.top, 8)
    }

    private var statusLine: String {
        _ = now // triggers re-render each second
        if player.sleepTimerEndOfTrack {
             return String(localized: "Pause at the end of this track.")
        }
        let remaining = player.sleepTimerRemaining
        if remaining > 0 {
            let mins = Int(remaining) / 60
            let secs = Int(remaining) % 60
             return String(localized: "Playback will fade out in \(mins):\(String(format: "%02d", secs)).")
        }
         return String(localized: "Pick how long you'd like Musaic to keep playing.")
    }

    private func presetRow(label: String, minutes: Int?) -> some View {
        let isActive: Bool = {
            guard let minutes, let deadline = player.sleepTimerDeadline else { return false }
            let remaining = deadline.timeIntervalSinceNow
            let expected = TimeInterval(minutes * 60)
            return abs(remaining - expected) < Double(minutes * 60) && minutes == activeMinutes
        }()

        return Button {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            #endif
            player.setSleepTimer(minutes: minutes)
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentStrong)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .glassCard(cornerRadius: 18, intensity: isActive ? 0.14 : 0.06)
        }
        .buttonStyle(.plain)
    }

    private var endOfTrackRow: some View {
        Button {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            #endif
            player.setSleepTimerEndOfTrack()
        } label: {
            HStack {
                Image(systemName: "music.note")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Color.textPrimary)
                 Text(String(localized: "End of this track"))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if player.sleepTimerEndOfTrack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentStrong)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .glassCard(cornerRadius: 18, intensity: player.sleepTimerEndOfTrack ? 0.14 : 0.06)
        }
        .buttonStyle(.plain)
    }

    /// Rough current-selection tracker; `setSleepTimer` is the source of truth.
    private var activeMinutes: Int? {
        guard let deadline = player.sleepTimerDeadline else { return nil }
        let remaining = max(0, deadline.timeIntervalSinceNow)
        let candidates = presets.compactMap(\.minutes)
        return candidates.min { a, b in
            abs(Double(a * 60) - remaining) < abs(Double(b * 60) - remaining)
        }
    }
}
