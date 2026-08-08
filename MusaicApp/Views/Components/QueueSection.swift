import SwiftUI

struct QueueSection: View {
    private let player = PlayerStore.shared

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
                ScrollViewReader { proxy in
                    List {
                        ForEach(player.queue.indices, id: \.self) { idx in
                            let track = player.queue[idx]
                            QueueTrackRow(
                                track: track,
                                index: idx,
                                isCurrent: idx == player.queueIndex,
                                onTap: { player.setQueue(player.queue, startAt: idx) }
                            )
                            .listRowBackground(idx == player.queueIndex ? Color.white.opacity(0.06) : Color.clear)
                            .id(idx)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .onAppear {
                        proxy.scrollTo(player.queueIndex, anchor: .center)
                    }
                }
            }
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
                    ToolbarItem(placement: .topBarTrailingCompat) {
                        Button(String(localized: "Done")) { dismiss() }
                            .foregroundStyle(Color.textPrimary)
                    }
                }
        }
    }
}
