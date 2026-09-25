import SwiftUI

/// The "Play All" + "Shuffle" pair shown above track lists.
struct PlayShuffleButtons: View {
    let tracks: [Track]
    var surface = "organic"
    /// Called after playback started (typically opens Now Playing).
    let onStarted: () -> Void

    private let player = PlayerStore.shared

    var body: some View {
        HStack(spacing: 12) {
            Button {
                start(tracks)
            } label: {
                Label(String(localized: "Play All"), systemImage: "play.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 13)
                    .background(
                        Capsule()
                            .fill(Color.clear)
                            .liquidProminentSurface(cornerRadius: 999, accent: Color(hex: "d9b17b"))
                    )
            }
            .buttonStyle(.plain)

            Button {
                start(tracks.shuffled())
            } label: {
                Label(String(localized: "Shuffle"), systemImage: "shuffle")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 13)
                    .glassCard(cornerRadius: 22, intensity: 0.08)
            }
            .buttonStyle(.plain)
        }
        .disabled(tracks.isEmpty)
        .opacity(tracks.isEmpty ? 0.45 : 1)
    }

    private func start(_ queue: [Track]) {
        guard !queue.isEmpty else { return }
        if player.setQueue(queue, startAt: 0, surface: surface) { onStarted() }
    }
}
