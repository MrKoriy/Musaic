import WidgetKit
import SwiftUI

struct NowPlayingEntry: TimelineEntry {
    let date: Date
    let snapshot: NowPlayingSnapshot?
}

struct NowPlayingProvider: TimelineProvider {
    func placeholder(in context: Context) -> NowPlayingEntry {
        NowPlayingEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
        completion(NowPlayingEntry(date: Date(), snapshot: NowPlayingShared.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
        let snapshot = NowPlayingShared.load()
        let entry = NowPlayingEntry(date: Date(), snapshot: snapshot)
        // Refresh every 5 minutes; the app also nudges the widget on playback change.
        let next = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

struct NowPlayingWidgetView: View {
    let entry: NowPlayingEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let snapshot = entry.snapshot {
            HStack(spacing: 12) {
                artwork(snapshot.artworkURL)
                VStack(alignment: .leading, spacing: 3) {
                    Text(snapshot.title)
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Text(snapshot.artist)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Image(systemName: snapshot.isPlaying ? "waveform" : "pause.fill")
                            .font(.system(size: 9, weight: .semibold))
                        Text(snapshot.isPlaying ? "Playing" : "Paused")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .containerBackground(for: .widget) {
                LinearGradient(
                    colors: [Color(hex: "1a1410"), Color(hex: "0d0b09")],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: "waveform.circle")
                    .font(.system(size: 28, weight: .semibold))
                Text("Nothing playing")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                Text("Open Musaic to start a track.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .containerBackground(for: .widget) {
                LinearGradient(
                    colors: [Color(hex: "1a1410"), Color(hex: "0d0b09")],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            }
        }
    }

    @ViewBuilder
    private func artwork(_ url: String?) -> some View {
        if let url, let u = URL(string: url) {
            AsyncImage(url: u) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.white.opacity(0.08)
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.08))
                .frame(width: 56, height: 56)
                .overlay {
                    Image(systemName: "music.note")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
        }
    }
}

struct MusaicWidget: Widget {
    let kind = "MusaicNowPlaying"

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
