import SwiftUI

/// A pill-shaped scrub bar inspired by Apple Music's iOS 17+ player.
/// - Grows from `restHeight` to `activeHeight` when the user touches it
/// - Time labels rise and scale while scrubbing
/// - Haptic feedback per second + boundary thumps
struct ScrubBar: View {
    let progress: Double            // 0...1
    let currentTime: TimeInterval
    let duration: TimeInterval
    var tint: Color = .white
    /// Called when the user releases, with the final 0...1 fraction.
    let onCommit: (Double) -> Void

    @State private var dragProgress: Double = 0
    @State private var isDragging = false
    @State private var lastHapticSecond: Int = -1

    private let restHeight: CGFloat = 5
    private let activeHeight: CGFloat = 11

    private var displayProgress: Double {
        let p = isDragging ? dragProgress : progress
        return p.isFinite ? max(0, min(1, p)) : 0
    }

    private var displayTime: TimeInterval {
        if isDragging { return dragProgress * max(0, duration) }
        return currentTime.isFinite ? max(0, currentTime) : 0
    }

    private var remainingTime: TimeInterval {
        max(0, duration - displayTime)
    }

    private var height: CGFloat {
        isDragging ? activeHeight : restHeight
    }

    var body: some View {
        VStack(spacing: 10) {
            GeometryReader { geo in
                let width = geo.size.width
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.14))
                        .frame(height: height)

                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [
                                    tint.opacity(0.88),
                                    Color.textPrimary.opacity(0.95)
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(0, width * displayProgress), height: height)
                }
                .frame(height: activeHeight, alignment: .center)
                .contentShape(Rectangle().inset(by: -10))
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if !isDragging {
                                isDragging = true
                                #if os(iOS)
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                #endif
                            }
                            let x = max(0, min(width, value.location.x))
                            let newProgress = width > 0 ? Double(x / width) : 0
                            dragProgress = newProgress

                            // Per-second haptic tick while scrubbing
                            let s = Int(newProgress * max(0, duration))
                            if s != lastHapticSecond {
                                lastHapticSecond = s
                                #if os(iOS)
                                UISelectionFeedbackGenerator().selectionChanged()
                                #endif
                            }
                        }
                        .onEnded { _ in
                            #if os(iOS)
                            // Boundary feedback
                            if dragProgress <= 0.001 || dragProgress >= 0.999 {
                                UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                            } else {
                                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            }
                            #endif
                            onCommit(dragProgress)
                            // Keep dragging=true briefly so the bar holds height during seek
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(350))
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                                    isDragging = false
                                }
                            }
                        }
                )
                .animation(.spring(response: 0.28, dampingFraction: 0.82), value: height)
            }
            .frame(height: activeHeight)

            HStack {
                Text(fmtTime(displayTime))
                    .font(.system(size: isDragging ? 13 : 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(isDragging ? Color.textPrimary : Color.textSecondary)
                    .scaleEffect(isDragging ? 1.08 : 1.0, anchor: .leading)

                Spacer()

                Text("-\(fmtTime(remainingTime))")
                    .font(.system(size: isDragging ? 13 : 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(isDragging ? Color.textPrimary : Color.textSecondary)
                    .scaleEffect(isDragging ? 1.08 : 1.0, anchor: .trailing)
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.85), value: isDragging)
        }
    }

    private func fmtTime(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "0:00" }
        let s = Int(max(0, seconds))
        return "\(s / 60):\(String(format: "%02d", s % 60))"
    }
}
