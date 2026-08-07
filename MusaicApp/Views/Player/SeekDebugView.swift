import SwiftUI
import AVFoundation

/// Debug overlay showing all seek-related state in real time
struct SeekDebugView: View {
    let audio = AudioPlayer.shared
    let player = PlayerStore.shared

    @State private var seekTestResult = ""
    @State private var seekableRanges = ""
    @State private var loadedRanges = ""
    @State private var playerItemStatus = ""
    @State private var ticker = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("SEEK DEBUG").font(.headline).foregroundStyle(.yellow)

                Group {
                    row("audio.progress", "\(String(format: "%.4f", audio.progress))")
                    row("audio.currentTime", "\(String(format: "%.2f", audio.currentTime))s")
                    row("audio.duration", "\(String(format: "%.2f", audio.duration))s")
                    row("audio.isPlaying", "\(audio.isPlaying)")
                    row("audio.isBuffering", "\(audio.isBuffering)")
                    row("track.duration", "\(player.currentTrack?.duration ?? 0)s")
                }

                Divider().background(.gray)

                Text("AVPlayer Internal").font(.subheadline).foregroundStyle(.orange)
                row("seekableRanges", seekableRanges)
                row("loadedRanges", loadedRanges)
                row("itemStatus", playerItemStatus)

                Divider().background(.gray)

                Text("Seek Tests").font(.subheadline).foregroundStyle(.green)

                HStack(spacing: 8) {
                    seekButton("Seek 10s", seconds: 10)
                    seekButton("Seek 30s", seconds: 30)
                    seekButton("Seek 60s", seconds: 60)
                }

                HStack(spacing: 8) {
                    seekButton("Seek 0.5", fraction: 0.5)
                    seekButton("Seek 0.25", fraction: 0.25)
                    seekButton("Seek 0.75", fraction: 0.75)
                }

                Button("Direct AVPlayer.seek(10s)") {
                    directSeekTest(seconds: 10)
                }
                .buttonStyle(.borderedProminent)

                Button("Direct AVPlayer.seek(30s)") {
                    directSeekTest(seconds: 30)
                }
                .buttonStyle(.borderedProminent)

                Text(seekTestResult)
                    .font(.caption.monospaced())
                    .foregroundStyle(.cyan)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding()
        }
        .background(Color.black.opacity(0.85))
        .onReceive(Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()) { _ in
            ticker += 1
            updateInternals()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption.monospaced()).foregroundStyle(.gray).frame(width: 140, alignment: .leading)
            Text(value).font(.caption.monospaced()).foregroundStyle(.white)
        }
    }

    private func seekButton(_ title: String, seconds: Double? = nil, fraction: Double? = nil) -> some View {
        Button(title) {
            if let seconds {
                let frac = seconds / max(audio.duration, 1)
                doSeekTest(fraction: frac, label: "\(seconds)s")
            } else if let fraction {
                doSeekTest(fraction: fraction, label: "\(fraction)")
            }
        }
        .font(.caption)
        .buttonStyle(.bordered)
    }

    private func doSeekTest(fraction: Double, label: String) {
        let before = audio.currentTime
        seekTestResult = "Seeking to \(label)..."
        audio.seek(to: fraction)

        // Check after 2s
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            let after = audio.currentTime
            seekTestResult = """
            seek(\(label)):
              before: \(String(format: "%.2f", before))s
              after:  \(String(format: "%.2f", after))s
              moved:  \(String(format: "%.2f", after - before))s
              expected: \(String(format: "%.2f", fraction * audio.duration))s
            """
        }
    }

    private func directSeekTest(seconds: Double) {
        seekTestResult = "Direct seek to \(seconds)s..."

        // Access AVPlayer directly through reflection or the exposed method
        let target = CMTime(seconds: seconds, preferredTimescale: 600)

        // We need to access the internal player — add a test method
        audio.debugSeek(to: target) { finished, actualTime in
            DispatchQueue.main.async {
                seekTestResult = """
                DIRECT seek to \(seconds)s:
                  finished: \(finished)
                  actualTime after: \(String(format: "%.2f", actualTime))s
                  audio.currentTime: \(String(format: "%.2f", audio.currentTime))s
                """
            }
        }
    }

    private func updateInternals() {
        // These would need a debug accessor on AudioPlayer
        audio.debugGetRanges { seekable, loaded, status in
            Task { @MainActor in
                seekableRanges = seekable
                loadedRanges = loaded
                playerItemStatus = status
            }
        }
    }
}
