import SwiftUI

struct NowPlayingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var showLyrics = false
    @State private var showQueue = false
    @State private var showSleepTimer = false

    private let player = PlayerStore.shared

    var body: some View {
        if let track = player.currentTrack {
            ZStack {
                NowPlayingBackdrop(track: track)

                GeometryReader { geo in
                    #if os(macOS)
                    // On macOS the sheet is a resizable window; the artwork must
                    // shrink dynamically so transport controls never clip.
                    let screenInset: CGFloat = 24
                    let contentWidth = min(geo.size.width - screenInset * 2, 520)
                    // Cap artwork so all sections (header ~70 + metadata ~120 +
                    // scrub ~70 + transport ~110 + padding ~80 = ~450) fit in any
                    // reasonable window height.
                    let artSide = min(contentWidth - 16, max(220, geo.size.height - 470), 380)
                    let topInset: CGFloat = 18
                    let bottomInset: CGFloat = 18
                    #else
                    let screenInset: CGFloat = 16
                    let contentWidth = min(geo.size.width - screenInset * 2, 360)
                    let artSide = min(contentWidth - 16, geo.size.height * 0.44, 340)
                    let topInset = max(geo.safeAreaInsets.top, 18)
                    let bottomInset = max(geo.safeAreaInsets.bottom, 18)
                    #endif

                    VStack(spacing: 14) {
                        Capsule()
                            .fill(Color.white.opacity(0.35))
                            .frame(width: 42, height: 5)

                        NowPlayingTopBarView(
                            showLyrics: $showLyrics,
                            showQueue: $showQueue,
                            showSleepTimer: $showSleepTimer
                        )

                        #if os(macOS)
                        // Scrollable body so nothing ever clips if the window is
                        // resized smaller than the natural content height.
                        ScrollView(.vertical, showsIndicators: false) {
                            VStack(spacing: 20) {
                                NowPlayingArtworkView(track: track, side: artSide)
                                NowPlayingMetadataSectionView(track: track)
                                NowPlayingTransportDeckView()
                            }
                            .frame(maxWidth: contentWidth)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                        }
                        #else
                        Spacer(minLength: 6)

                        VStack(spacing: 20) {
                            NowPlayingArtworkView(track: track, side: artSide)
                            NowPlayingMetadataSectionView(track: track)
                            NowPlayingTransportDeckView()
                        }
                        .frame(maxWidth: contentWidth)

                        Spacer(minLength: 0)
                        #endif
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.horizontal, screenInset)
                    .padding(.top, topInset + 6)
                    .padding(.bottom, bottomInset)
                }
            }
            .sheet(isPresented: $showLyrics) { LyricsSheet(track: track) }
            .sheet(isPresented: $showQueue) { NowPlayingQueueView() }
            .sheet(isPresented: $showSleepTimer) {
                SleepTimerSheet()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        } else {
            ZStack {
                Color.bgPrimary.ignoresSafeArea()
                Button(String(localized: "Close")) { dismiss() }
                    .foregroundStyle(Color.textPrimary)
            }
        }
    }
}
