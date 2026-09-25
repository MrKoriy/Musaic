import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Classic iPod click-wheel overlay for the Now Playing screen.
///
/// Layout mirrors the 4th-generation iPod: MENU at the top, next/previous on
/// the sides, play/pause at the bottom, select in the center. MENU cycles the
/// wheel's mode like the original: scrub → volume → shuffle/repeat. A haptic
/// detent fires every 15° of rotation.
struct IPodWheelView: View {
    @Binding var isPresented: Bool

    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    private enum WheelMode: CaseIterable {
        case scrub, volume, playbackModes

        var next: WheelMode {
            switch self {
            case .scrub: return .volume
            case .volume: return .playbackModes
            case .playbackModes: return .scrub
            }
        }

        var title: String {
            switch self {
            case .scrub: return String(localized: "Scrub")
            case .volume: return String(localized: "Volume")
            case .playbackModes: return String(localized: "Shuffle & Repeat")
            }
        }
    }

    private enum ModeOption: CaseIterable {
        case shuffle, repeatMode
    }

    @State private var mode: WheelMode = .scrub
    @State private var wheelRotation: Double = 0
    @State private var lastDragAngle: Double?
    /// Scrub target during a drag; seeded from the live position when the
    /// drag starts and committed when it ends.
    @State private var scrubFraction: Double?
    @State private var detentAccumulator: Double = 0
    @State private var optionAccumulator: Double = 0
    @State private var highlightedOption: ModeOption = .shuffle
    @State private var modeChangeCount = 0

    #if os(iOS)
    @State private var haptic = UIImpactFeedbackGenerator(style: .light)
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Base scrub ratio: 60° of rotation = 1 s (a slow full turn = 6 s, the
    /// classic feel). Faster spins accelerate up to 5×.
    private let degreesPerSecond: Double = 60
    /// Volume: a full turn sweeps the whole range.
    private let degreesPerFullVolume: Double = 360
    private let detentDegrees: Double = 15
    private let optionStepDegrees: Double = 45

    private var ringOuter: CGFloat { 300 }
    private var ringInner: CGFloat { 132 }

    var body: some View {
        VStack(spacing: 18) {
            header

            ZStack {
                wheelSurface
            }
            .frame(width: ringOuter, height: ringOuter)
        }
        .padding(.vertical, 20)
        .sensoryFeedback(.selection, trigger: modeChangeCount)
        .onAppear {
            #if os(iOS)
            haptic.prepare()
            #endif
        }
        .accessibilityAction(named: Text(String(localized: "Next wheel mode"))) { cycleMode() }
        .accessibilityAction(named: Text(String(localized: "Close wheel"))) { close() }
    }

    // MARK: - Header (mode + readout)

    private var header: some View {
        VStack(spacing: 6) {
            HStack {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.textSecondary)
                        .frame(width: 32, height: 32)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(String(localized: "Close wheel")))

                Spacer()

                Text(mode.title.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .tracking(2)
                    .foregroundStyle(Color.accentStrong)
                    .contentTransition(.opacity)

                Spacer()

                Color.clear.frame(width: 32, height: 32)
            }
            .padding(.horizontal, 24)

            readout
                .frame(height: 48)
        }
    }

    @ViewBuilder
    private var readout: some View {
        switch mode {
        case .scrub:
            if let fraction = scrubFraction, audio.duration > 0 {
                Text("\(timeString(fraction * audio.duration)) / \(timeString(audio.duration))")
                    .font(.system(size: 26, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.accentStrong)
                    .contentTransition(.numericText())
            } else {
                // Separate view: only it follows the live position.
                WheelLiveTime()
            }
        case .volume:
            VStack(spacing: 6) {
                Text("\(Int((player.volume * 100).rounded()))%")
                    .font(.system(size: 26, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.accentStrong)
                    .contentTransition(.numericText())
                ProgressView(value: Double(player.volume))
                    .progressViewStyle(.linear)
                    .tint(Color.accentStrong)
                    .frame(width: 160)
            }
        case .playbackModes:
            HStack(spacing: 10) {
                optionChip(
                    title: player.isShuffled ? String(localized: "Shuffle On") : String(localized: "Shuffle Off"),
                    systemImage: "shuffle",
                    highlighted: highlightedOption == .shuffle
                )
                optionChip(
                    title: repeatTitle,
                    systemImage: player.repeatMode == .track ? "repeat.1" : "repeat",
                    highlighted: highlightedOption == .repeatMode
                )
            }
        }
    }

    private var repeatTitle: String {
        switch player.repeatMode {
        case .off: return String(localized: "Repeat Off")
        case .queue: return String(localized: "Repeat All")
        case .track: return String(localized: "Repeat One")
        }
    }

    private func optionChip(title: String, systemImage: String, highlighted: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
            Text(title)
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(highlighted ? Color.bgPrimary : Color.textPrimary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            Capsule().fill(highlighted ? Color.accentStrong : Color.white.opacity(0.08))
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: highlighted)
    }

    // MARK: - Wheel

    private var wheelSurface: some View {
        ZStack {
            // Ring
            Circle()
                .fill(Color.white.opacity(0.05))
            Circle()
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
            Circle()
                .trim(from: 0.94, to: 1.0)
                .stroke(Color.accentStrong.opacity(0.55), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: ringOuter - 10, height: ringOuter - 10)
                .rotationEffect(.degrees(reduceMotion ? 0 : wheelRotation))

            // Center select button
            Button(action: selectPressed) {
                Circle()
                    .fill(Color.white.opacity(0.09))
                    .overlay(
                        Circle().strokeBorder(Color.white.opacity(0.13), lineWidth: 1)
                    )
                    .frame(width: ringInner - 14, height: ringInner - 14)
                    .overlay(centerLabel)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(mode == .playbackModes ? String(localized: "Select") : String(localized: "Play or pause")))

            // Edge zones (MENU / prev / next / play-pause)
            edgeButton(
                systemName: "forward.fill",
                label: String(localized: "Next track"),
                action: { player.skipNext() }
            )
            .position(x: ringOuter / 2 + 74, y: ringOuter / 2)

            edgeButton(
                systemName: "backward.fill",
                label: String(localized: "Previous track"),
                action: { player.skipPrevious() }
            )
            .position(x: ringOuter / 2 - 74, y: ringOuter / 2)

            Button {
                player.togglePlayPause()
            } label: {
                Image(systemName: "playpause")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color.textPrimary.opacity(0.9))
                    .frame(width: 64, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Play or pause")))
            .position(x: ringOuter / 2, y: ringOuter / 2 + 74)

            // MENU — cycles the wheel mode, like the original.
            Button(action: cycleMode) {
                Text("MENU")
                    .font(.system(size: 14, weight: .bold))
                    .tracking(1.5)
                    .foregroundStyle(Color.textPrimary.opacity(0.9))
                    .frame(width: 64, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Menu")))
            .accessibilityHint(Text(String(localized: "Switches between scrub, volume and shuffle/repeat")))
            .position(x: ringOuter / 2, y: ringOuter / 2 - 74)
        }
        .contentShape(Circle())
        .gesture(wheelGesture)
    }

    @ViewBuilder
    private var centerLabel: some View {
        VStack(spacing: 4) {
            if mode == .playbackModes {
                Image(systemName: "checkmark")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Color.textPrimary)
                Text(String(localized: "Select"))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.textSecondary)
            } else {
                Image(systemName: player.isPlaybackIntended ? "pause.fill" : "play.fill")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(Color.textPrimary)
                Text(player.isPlaybackIntended ? String(localized: "Pause") : String(localized: "Play"))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }

    private func edgeButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color.textPrimary.opacity(0.9))
                .frame(width: 64, height: 64)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    // MARK: - Actions

    private func cycleMode() {
        commitScrubIfNeeded()
        lastDragAngle = nil
        detentAccumulator = 0
        optionAccumulator = 0
        if reduceMotion {
            mode = mode.next
        } else {
            withAnimation(.easeOut(duration: 0.2)) { mode = mode.next }
        }
        modeChangeCount += 1
    }

    private func selectPressed() {
        guard mode == .playbackModes else {
            player.togglePlayPause()
            return
        }
        switch highlightedOption {
        case .shuffle: player.toggleShuffle()
        case .repeatMode: player.toggleRepeat()
        }
        modeChangeCount += 1
    }

    private func close() {
        commitScrubIfNeeded()
        isPresented = false
    }

    // MARK: - Wheel gesture

    private var wheelGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                let center = CGPoint(x: ringOuter / 2, y: ringOuter / 2)
                let vector = CGPoint(x: value.location.x - center.x, y: value.location.y - center.y)
                let distance = hypot(vector.x, vector.y)
                // Only the ring area drives the wheel (not the center button).
                guard distance > (ringInner - 14) / 2, distance < ringOuter / 2 else { return }

                let angle = atan2(vector.y, vector.x) * 180 / .pi
                guard let last = lastDragAngle else {
                    lastDragAngle = angle
                    if mode == .scrub {
                        // Always start from where playback is right now.
                        scrubFraction = liveFraction
                    }
                    return
                }

                var delta = angle - last
                if delta > 180 { delta -= 360 }
                if delta < -180 { delta += 360 }
                lastDragAngle = angle
                wheelRotation += delta
                tickDetents(delta)

                switch mode {
                case .scrub:
                    let duration = audio.duration
                    guard duration > 0, let fraction = scrubFraction ?? liveFraction else { return }
                    let acceleration = 1 + min(4, abs(delta) / 6)
                    let seconds = delta / degreesPerSecond * acceleration
                    scrubFraction = min(max(fraction + seconds / duration, 0), 1)
                case .volume:
                    player.setVolume(player.volume + Float(delta / degreesPerFullVolume))
                case .playbackModes:
                    optionAccumulator += delta
                    if abs(optionAccumulator) >= optionStepDegrees {
                        optionAccumulator = 0
                        highlightedOption = highlightedOption == .shuffle ? .repeatMode : .shuffle
                        modeChangeCount += 1
                    }
                }
            }
            .onEnded { _ in
                commitScrubIfNeeded()
                lastDragAngle = nil
                detentAccumulator = 0
            }
    }

    /// Current position as a 0...1 fraction, read live (never cached).
    private var liveFraction: Double? {
        let duration = audio.duration > 0 ? audio.duration : (player.currentTrack?.duration ?? 0)
        guard duration > 0 else { return nil }
        return min(max(audio.livePlaybackTime() / duration, 0), 1)
    }

    private func tickDetents(_ delta: Double) {
        detentAccumulator += delta
        guard abs(detentAccumulator) >= detentDegrees else { return }
        detentAccumulator = detentAccumulator.truncatingRemainder(dividingBy: detentDegrees)
        #if os(iOS)
        haptic.impactOccurred()
        haptic.prepare()
        #endif
    }

    private func commitScrubIfNeeded() {
        guard let fraction = scrubFraction else { return }
        scrubFraction = nil
        player.seekTo(fraction)
    }

    private func timeString(_ interval: TimeInterval) -> String {
        let seconds = Int(max(0, interval).rounded())
        if seconds >= 3600 {
            return String(format: "%d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

/// Live elapsed / total readout, isolated so position ticks don't redraw the
/// whole wheel.
private struct WheelLiveTime: View {
    private let audio = AudioPlayer.shared

    var body: some View {
        VStack(spacing: 2) {
            Text(audio.duration > 0 ? "\(format(audio.currentTime)) / \(format(audio.duration))" : "--:--")
                .font(.system(size: 20, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.textPrimary.opacity(0.85))
            Text(String(localized: "Spin the wheel to scrub"))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
        }
    }

    private func format(_ interval: TimeInterval) -> String {
        let seconds = Int(max(0, interval))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

#Preview {
    ZStack {
        Color.bgPrimary.ignoresSafeArea()
        IPodWheelView(isPresented: .constant(true))
    }
}
