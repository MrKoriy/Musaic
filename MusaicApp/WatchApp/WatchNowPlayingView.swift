import SwiftUI
import WatchKit

/// watchOS remote for the Musaic iOS app. The phone owns playback; the watch
/// mirrors its state and sends commands. The Digital Crown adjusts volume or
/// scrubs (tap the mode chip to switch).
struct WatchNowPlayingView: View {
    @ObservedObject private var link = WatchPhoneLink.shared

    private enum CrownMode {
        case volume
        case scrub
    }

    @State private var crownMode: CrownMode = .volume
    @State private var crownValue: Double = 1
    /// Scrub target while the crown is turning (nil when idle).
    @State private var pendingScrub: Double?
    @State private var crownIdleTask: Task<Void, Never>?
    @State private var lastVolumeSentAt = Date.distantPast

    private static let accent = Color(red: 0.80, green: 0.71, blue: 0.60)

    var body: some View {
        Group {
            if let snapshot = link.snapshot {
                nowPlaying(snapshot)
            } else {
                emptyState
            }
        }
        .onAppear { resetCrownValue() }
        .onReceive(link.$volume) { _ in
            if crownMode == .volume, crownIdleTask == nil { resetCrownValue() }
        }
    }

    private func nowPlaying(_ snapshot: NowPlayingSnapshot) -> some View {
        VStack(spacing: 5) {
            HStack(spacing: 8) {
                artwork(snapshot)
                    .frame(width: 36, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(snapshot.title)
                        .font(.system(size: 14, weight: .bold))
                        .lineLimit(1)
                    Text(snapshot.artist)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let line = link.lyricLine {
                Text(line)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Self.accent)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .transition(.opacity)
                    .id(line)
            }

            progressBar(isPlaying: snapshot.isPlaying)

            HStack(spacing: 18) {
                controlButton("backward.end.fill", label: String(localized: "Previous track")) {
                    link.send(command: "previous")
                }
                controlButton(snapshot.isPlaying ? "pause.fill" : "play.fill", size: 24, label: snapshot.isPlaying ? String(localized: "Pause") : String(localized: "Play")) {
                    WKInterfaceDevice.current().play(.click)
                    link.send(command: snapshot.isPlaying ? "pause" : "play")
                }
                controlButton("forward.end.fill", label: String(localized: "Next track")) {
                    link.send(command: "next")
                }
            }

            HStack(spacing: 10) {
                Button {
                    link.send(command: "like")
                } label: {
                    Image(systemName: link.liked ? "heart.fill" : "heart")
                        .foregroundStyle(link.liked ? Self.accent : Color.primary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(link.liked ? "Remove from favorites" : "Add to favorites"))

                Button(action: toggleCrownMode) {
                    HStack(spacing: 4) {
                        Image(systemName: crownMode == .volume ? "speaker.wave.2.fill" : "digitalcrown.horizontal.arrow.clockwise")
                        Text(crownModeLabel)
                            .monospacedDigit()
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(pendingScrub == nil ? Color.secondary : Self.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(crownMode == .volume ? "Crown controls volume" : "Crown scrubs the track"))
            }
        }
        .padding(.horizontal, 4)
        .focusable()
        .digitalCrownRotation(
            crownBinding,
            from: 0,
            through: 1,
            by: crownMode == .volume ? 0.02 : 0.005,
            sensitivity: .low,
            isContinuous: false,
            isHapticFeedbackEnabled: true
        )
        .animation(.easeInOut(duration: 0.25), value: link.lyricLine)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.system(size: 26))
                .foregroundStyle(.secondary)
            Text("Nothing playing")
                .font(.system(size: 14, weight: .semibold))
            Text(link.isReachable ? "Start a track in Musaic on your iPhone." : "Open Musaic on your iPhone.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Refresh") { link.send(command: "sync") }
                .font(.system(size: 13, weight: .semibold))
        }
        .padding()
    }

    // MARK: - Progress

    private func progressBar(isPlaying: Bool) -> some View {
        // Interpolates between phone corrections; only ticks while playing.
        TimelineView(.animation(minimumInterval: 1, paused: !isPlaying)) { context in
            let duration = link.duration
            let position = pendingScrub.map { $0 * duration } ?? link.estimatedPosition(at: context.date)
            VStack(spacing: 2) {
                ProgressView(value: duration > 0 ? min(max(position / duration, 0), 1) : 0)
                    .progressViewStyle(.linear)
                    .tint(Self.accent)
                HStack {
                    Text(timeString(position))
                    Spacer()
                    Text(duration > 0 ? "-" + timeString(max(0, duration - position)) : "--:--")
                }
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(pendingScrub == nil ? Color.secondary : Self.accent)
            }
        }
    }

    // MARK: - Crown

    private var crownModeLabel: String {
        switch crownMode {
        case .volume:
            return "\(Int((link.volume * 100).rounded()))%"
        case .scrub:
            return pendingScrub.map { timeString($0 * link.duration) } ?? String(localized: "Scrub")
        }
    }

    private var crownBinding: Binding<Double> {
        Binding(
            get: { crownValue },
            set: { newValue in
                guard abs(newValue - crownValue) > 0.0001 else { return }
                crownValue = newValue
                crownDidChange(newValue)
            }
        )
    }

    private func toggleCrownMode() {
        WKInterfaceDevice.current().play(.click)
        crownIdleTask?.cancel()
        crownIdleTask = nil
        pendingScrub = nil
        crownMode = crownMode == .volume ? .scrub : .volume
        resetCrownValue()
    }

    private func resetCrownValue() {
        switch crownMode {
        case .volume:
            crownValue = link.volume
        case .scrub:
            crownValue = link.duration > 0 ? min(max(link.estimatedPosition() / link.duration, 0), 1) : 0
        }
    }

    private func crownDidChange(_ value: Double) {
        switch crownMode {
        case .volume:
            // Throttled live updates plus a final value when the crown rests.
            let now = Date()
            if now.timeIntervalSince(lastVolumeSentAt) > 0.15 {
                lastVolumeSentAt = now
                link.send(command: "volume", value: value)
            }
            scheduleCrownIdle { link.send(command: "volume", value: value) }
        case .scrub:
            guard link.duration > 0 else { return }
            pendingScrub = value
            scheduleCrownIdle {
                link.send(command: "seek", value: value)
                pendingScrub = nil
            }
        }
    }

    private func scheduleCrownIdle(_ action: @escaping @MainActor () -> Void) {
        crownIdleTask?.cancel()
        crownIdleTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            crownIdleTask = nil
            action()
        }
    }

    // MARK: - Pieces

    private func controlButton(_ systemName: String, size: CGFloat = 17, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size, weight: .bold))
                .frame(minWidth: 30, minHeight: 30)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }

    @ViewBuilder
    private func artwork(_ snapshot: NowPlayingSnapshot) -> some View {
        if let data = link.artworkData, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else if let url = snapshot.artworkURL.flatMap(URL.init(string:)) {
            // Needs an ATS exception on the watch for plain-HTTP artwork.
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.white.opacity(0.08)
            }
        } else {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.white.opacity(0.08))
                .overlay {
                    Image(systemName: "music.note")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
        }
    }

    private func timeString(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "0:00" }
        let total = Int(max(0, seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
