import SwiftUI

struct QueueSection: View {
    private let player = PlayerStore.shared

    /// One queue row. The id stays stable while other rows move; repeated
    /// tracks get an occurrence suffix so duplicates never collide.
    private struct Entry: Identifiable {
        let id: String
        let index: Int
        let track: Track
    }

    private var entries: [Entry] {
        var occurrences: [String: Int] = [:]
        return player.queue.enumerated().map { index, track in
            let occurrence = occurrences[track.id, default: 0]
            occurrences[track.id] = occurrence + 1
            let id = occurrence == 0 ? track.id : "\(track.id)#\(occurrence)"
            return Entry(id: id, index: index, track: track)
        }
    }

    var body: some View {
        ZStack {
            Color.bgPrimary.ignoresSafeArea()

            if player.queue.isEmpty {
                EmptyStateView(
                    title: String(localized: "Queue Empty"),
                    message: String(localized: "Add tracks to the queue to see what plays next."),
                    systemImage: "music.note.list"
                )
            } else {
                let entries = self.entries
                let currentIndex = player.queueIndex
                ScrollViewReader { proxy in
                    List {
                        ForEach(entries) { entry in
                            QueueTrackRow(
                                track: entry.track,
                                index: entry.index,
                                isCurrent: entry.index == currentIndex,
                                onTap: { player.selectQueueTrack(at: entry.index) }
                            )
                            .listRowBackground(entry.index == currentIndex ? Color.white.opacity(0.06) : Color.clear)
                            .contextMenu { contextMenu(for: entry, currentIndex: currentIndex) }
                            .id(entry.id)
                        }
                        .onDelete { offsets in
                            player.removeFromQueue(atOffsets: offsets)
                        }
                        .onMove { source, destination in
                            player.moveQueue(fromOffsets: source, toOffset: destination)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .onAppear {
                        if let current = entries.first(where: { $0.index == currentIndex }) {
                            proxy.scrollTo(current.id, anchor: .center)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func contextMenu(for entry: Entry, currentIndex: Int) -> some View {
        if entry.index != currentIndex {
            Button {
                player.selectQueueTrack(at: entry.index)
            } label: {
                Label(String(localized: "Play Now"), systemImage: "play.fill")
            }
        }
        if entry.index > currentIndex + 1 {
            Button {
                player.moveQueue(fromOffsets: IndexSet(integer: entry.index), toOffset: currentIndex + 1)
            } label: {
                Label(String(localized: "Play Next"), systemImage: "text.line.first.and.arrowtriangle.forward")
            }
        }
        Button(role: .destructive) {
            player.removeFromQueue(at: entry.index)
        } label: {
            Label(String(localized: "Remove from Queue"), systemImage: "trash")
        }
    }
}

struct NowPlayingQueueView: View {
    @Environment(\.dismiss) private var dismiss
    private let player = PlayerStore.shared

    var body: some View {
        NavigationStack {
            QueueSection()
                .navigationTitle(String(localized: "Queue (\(player.queue.count))"))
                .navigationBarTitleDisplayModeCompat()
                .toolbar {
                    #if os(iOS)
                    ToolbarItem(placement: .topBarLeading) {
                        // Shows drag handles / delete buttons for the rows.
                        EditButton()
                            .foregroundStyle(Color.textPrimary)
                    }
                    #endif
                    ToolbarItem(placement: .topBarTrailingCompat) {
                        Button(String(localized: "Done")) { dismiss() }
                            .foregroundStyle(Color.textPrimary)
                    }
                }
        }
    }
}
