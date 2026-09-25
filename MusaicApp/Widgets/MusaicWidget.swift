import AppIntents
import WidgetKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct NowPlayingEntry: TimelineEntry {
    let date: Date
    let snapshot: NowPlayingSnapshot?
    /// Downsampled JPEG written by the app into the App Group container.
    let artwork: Data?
}

struct NowPlayingProvider: TimelineProvider {
    func placeholder(in context: Context) -> NowPlayingEntry {
        NowPlayingEntry(date: Date(), snapshot: nil, artwork: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
        completion(Self.currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
        // The app reloads the timeline on every track / state change; this is
        // only a safety net.
        let next = Date().addingTimeInterval(30 * 60)
        completion(Timeline(entries: [Self.currentEntry()], policy: .after(next)))
    }

    private static func currentEntry() -> NowPlayingEntry {
        let snapshot = NowPlayingShared.load()
        let artwork = snapshot.flatMap { NowPlayingShared.loadArtworkData(for: $0.trackId) }
        return NowPlayingEntry(date: Date(), snapshot: snapshot, artwork: artwork)
    }
}

struct NowPlayingWidgetView: View {
    let entry: NowPlayingEntry
    @Environment(\.widgetFamily) private var family

    private static let textPrimary = Color(hex: "fbf7f1")
    private static let accent = Color(hex: "cdb69a")

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                if family == .systemSmall {
                    smallLayout(snapshot)
                } else {
                    mediumLayout(snapshot)
                }
            } else {
                emptyLayout
            }
        }
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [Color(hex: "1a1410"), Color(hex: "0d0b09")],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        }
    }

    private func smallLayout(_ snapshot: NowPlayingSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                WidgetArtwork(data: entry.artwork, size: 52, cornerRadius: 11)
                Spacer(minLength: 4)
                controlButton(
                    command: "toggle",
                    systemName: snapshot.isPlaying ? "pause.fill" : "play.fill",
                    label: snapshot.isPlaying ? String(localized: "Pause") : String(localized: "Play")
                )
            }
            Spacer(minLength: 0)
            titles(snapshot)
            progress(snapshot)
        }
    }

    private func mediumLayout(_ snapshot: NowPlayingSnapshot) -> some View {
        HStack(spacing: 12) {
            WidgetArtwork(data: entry.artwork, size: 64, cornerRadius: 13)
            VStack(alignment: .leading, spacing: 6) {
                titles(snapshot)
                progress(snapshot)
                HStack(spacing: 22) {
                    controlButton(command: "previous", systemName: "backward.fill", label: String(localized: "Previous track"))
                    controlButton(
                        command: "toggle",
                        systemName: snapshot.isPlaying ? "pause.fill" : "play.fill",
                        label: snapshot.isPlaying ? String(localized: "Pause") : String(localized: "Play")
                    )
                    controlButton(command: "next", systemName: "forward.fill", label: String(localized: "Next track"))
                }
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func titles(_ snapshot: NowPlayingSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(snapshot.title)
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundStyle(Self.textPrimary)
                .lineLimit(1)
            Text(snapshot.artist)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private func progress(_ snapshot: NowPlayingSnapshot) -> some View {
        // Timer-driven while playing: the system animates it without reloads.
        if let interval = snapshot.playbackInterval {
            ProgressView(timerInterval: interval, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                .progressViewStyle(.linear)
                .tint(Self.accent)
        } else {
            ProgressView(value: snapshot.progressFraction)
                .progressViewStyle(.linear)
                .tint(Self.accent)
        }
    }

    private var emptyLayout: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "waveform.circle")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Self.accent)
            Text("Nothing playing")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(Self.textPrimary)
            Text("Open Musaic to start a track.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    /// Interactive control. `MusaicPlaybackIntent` runs in the app process
    /// (AudioPlaybackIntent), so it drives the player directly.
    private func controlButton(command: String, systemName: String, label: String) -> some View {
        Button(intent: MusaicPlaybackIntent(command: command)) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Self.textPrimary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

/// Artwork read from the App Group file (remote images never load in widgets).
struct WidgetArtwork: View {
    let data: Data?
    var size: CGFloat? = nil
    var cornerRadius: CGFloat = 12

    var body: some View {
        Group {
            #if canImport(UIKit)
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
            #else
            placeholder
            #endif
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private var placeholder: some View {
        Color.white.opacity(0.08)
            .overlay {
                Image(systemName: "music.note")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
    }
}

struct MusaicWidget: Widget {
    let kind = NowPlayingShared.widgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NowPlayingProvider()) { entry in
            NowPlayingWidgetView(entry: entry)
        }
        .configurationDisplayName("Now Playing")
        .description("Shows the currently playing track in Musaic.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct MusaicWidgetBundle: WidgetBundle {
    var body: some Widget {
        MusaicWidget()
        #if os(iOS)
        MusaicLiveActivityWidget()
        #endif
    }
}

extension Color {
    init(hex: String) {
        let cleaned = hex.replacingOccurrences(of: "#", with: "")
        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
