import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Classic iPod click-wheel overlay for the Now Playing screen.
///
/// Layout mirrors the 4th-generation iPod: MENU at the top, next/previous on
/// the sides, play/pause at the bottom, select in the center. Dragging around
/// the ring scrubs the track — a full 360° turn seeks 6 seconds, with a
/// haptic tick every 15° like the original wheel.
struct IPodWheelView: View {
    @Binding var isPresented: Bool

    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared

    @State private var wheelRotation: Double = 0
    @State private var lastDragAngle: Double?
    @State private var pendingSeekFraction: Double?
    @State private var lastHapticDetent = 0

    #if os(iOS)
    @State private var haptic = UIImpactFeedbackGenerator(style: .light)
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Degrees of rotation for one second of seek: a full 360° turn scrubs
    /// 6 seconds — the classic-feel ratio of the original click wheel.
    private let degreesPerSecond: Double = 60

    private var ringOuter: CGFloat { 300 }
    private var ringInner: CGFloat { 132 }

    var body: some View {
        VStack(spacing: 22) {
            scrubHint

            ZStack {
                wheelSurface
            }
            .frame(width: ringOuter, height: ringOuter)
        }
        .padding(.vertical, 20)
        .onAppear {
            pendingSeekFraction = audio.duration > 0 ? audio.currentTime / audio.duration : nil
            #if os(iOS)
            haptic.prepare()
            #endif
        }
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
            Button {
                player.togglePlayPause()
            } label: {
                Circle()
                    .fill(Color.white.opacity(0.09))
                    .overlay(
                        Circle().strokeBorder(Color.white.opacity(0.13), lineWidth: 1)
                    )
                    .frame(width: ringInner - 14, height: ringInner - 14)
                    .overlay(
                        VStack(spacing: 4) {
                            Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 30, weight: .medium))
                                .foregroundStyle(Color.textPrimary)
                            Text(audio.isPlaying ? String(localized: "Pause") : String(localized: "Play"))
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Color.textSecondary)
                        }
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Play or pause")))

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

            // MENU — exit the wheel
            Button {
                commitPendingSeek()
                isPresented = false
            } label: {
                Text("MENU")
                    .font(.system(size: 14, weight: .bold))
                    .tracking(1.5)
                    .foregroundStyle(Color.textPrimary.opacity(0.9))
                    .frame(width: 64, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(String(localized: "Close wheel")))
            .position(x: ringOuter / 2, y: ringOuter / 2 - 74)
        }
        .contentShape(Circle())
        .gesture(scrubGesture)
    }

    private var isScrubbing: Bool { lastDragAngle != nil }

    private var scrubHint: some View {
        VStack(spacing: 6) {
            if let fraction = pendingSeekFraction, audio.duration > 0, isScrubbing {
                Text("\(timeString(fraction * audio.duration)) / \(timeString(audio.duration))")
                    .font(.system(size: 26, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.accentStrong)
                    .contentTransition(.numericText())
            } else {
                Text(String(localized: "Spin the wheel to scrub"))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .frame(height: 44)
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

    // MARK: - Scrub gesture

    private var scrubGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                let center = CGPoint(x: ringOuter / 2, y: ringOuter / 2)
                let vector = CGPoint(x: value.location.x - center.x, y: value.location.y - center.y)
                let distance = hypot(vector.x, vector.y)
                // Only the ring area drives the scrub (not the center button).
                guard distance > (ringInner - 14) / 2, distance < ringOuter / 2 else { return }

                let angle = atan2(vector.y, vector.x) * 180 / .pi
                guard let last = lastDragAngle else {
                    lastDragAngle = angle
                    if pendingSeekFraction == nil, audio.duration > 0 {
                        pendingSeekFraction = audio.currentTime / audio.duration
                    }
                    return
                }

                var delta = angle - last
                if delta > 180 { delta -= 360 }
                if delta < -180 { delta += 360 }
                lastDragAngle = angle
                wheelRotation += delta

                guard audio.duration > 0, var fraction = pendingSeekFraction else { return }
                // 60° of rotation = 1 second of seek (a full turn = 6s).
                fraction += (delta / degreesPerSecond) / audio.duration
                fraction = min(max(fraction, 0), 1)
                pendingSeekFraction = fraction

                // Haptic detent every 15° like the original wheel.
                let detent = Int(wheelRotation / 15)
                if detent != lastHapticDetent {
                    lastHapticDetent = detent
                    #if os(iOS)
                    haptic.impactOccurred()
                    #endif
                }
            }
            .onEnded { _ in
                commitPendingSeek()
                lastDragAngle = nil
            }
    }

    private func commitPendingSeek() {
        defer { pendingSeekFraction = audio.duration > 0 ? audio.currentTime / audio.duration : nil }
        guard let fraction = pendingSeekFraction, audio.duration > 0 else { return }
        player.seekTo(fraction)
    }

    private func timeString(_ interval: TimeInterval) -> String {
        let seconds = Int(interval.rounded())
        if seconds >= 3600 {
            return String(format: "%d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

#Preview {
    ZStack {
        Color.bgPrimary.ignoresSafeArea()
        IPodWheelView(isPresented: .constant(true))
    }
}
