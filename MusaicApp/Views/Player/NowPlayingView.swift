import SwiftUI

struct NowPlayingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var showLyrics = false
    @State private var showQueue = false
    @State private var showSleepTimer = false
    @State private var showIPodWheel = false

    private let player = PlayerStore.shared
    private let audio = AudioPlayer.shared
    private let videoStore = VideoStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let track = player.currentTrack {
            ZStack {
                NowPlayingBackdrop(track: track)

                #if os(macOS)
                macPlayerLayout(track: track)
                #else
                iosPlayerLayout(track: track)
                #endif
            }
            .sheet(isPresented: $showLyrics) {
                // Force a fresh lyrics state when the current queue item changes.
                LyricsSheet(track: track).id(track.id)
            }
            .sheet(isPresented: $showQueue) { NowPlayingQueueView() }
            .sheet(isPresented: $showSleepTimer) {
                SleepTimerSheet()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showIPodWheel) {
                ZStack {
                    Color.bgPrimary.ignoresSafeArea()
                    IPodWheelView(isPresented: $showIPodWheel)
                }
                .presentationDetents([.height(560)])
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

    // MARK: - macOS layout (native desktop player — no scrolling)

    #if os(macOS)
    private func macPlayerLayout(track: Track) -> some View {
        GeometryReader { geo in
            // Everything fits without scrolling: header 44 + artwork (adaptive)
            // + metadata ~120 + scrub ~70 + transport ~96 + paddings ~50.
            // The video slot reuses the artwork's vertical budget at 16:9.
            let screenInset: CGFloat = 22
            let contentWidth = min(geo.size.width - screenInset * 2, 460)
            let artSide = min(contentWidth, max(170, geo.size.height - 400), 290)
            let videoHeight = min(contentWidth * 9 / 16, max(170, geo.size.height - 400), 290)

            AdaptivePlayerContainer {
            VStack(spacing: 0) {
                macTopBar

                Spacer(minLength: 8)

                ZStack {
                    NowPlayingArtworkView(track: track, side: artSide)
                    if videoStore.videoModeEnabled, let videoPlayer = audio.activeVideoPlayer {
                        MacVideoPlayerSurface(player: videoPlayer, height: videoHeight)
                            .transition(.opacity)
                    }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: audio.activeVideoPlayer != nil)
                .frame(maxHeight: .infinity)

                NowPlayingMetadataSectionView(track: track)
                    .padding(.top, 16)
                    .frame(maxWidth: contentWidth)

                NowPlayingTransportDeckView()
                    .padding(.top, 10)
                    .frame(maxWidth: contentWidth)
            }
            .frame(maxWidth: contentWidth)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.horizontal, screenInset)
            .padding(.top, 14)
            .padding(.bottom, 16)
            }
        }
    }

    private var macTopBar: some View {
        HStack(spacing: 10) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .musaicFont(size: 12, weight: .bold)
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(Color.white.opacity(0.07), in: Circle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "Close player"))
            .accessibilityLabel(Text(String(localized: "Close player")))

            Spacer()

            if videoStore.currentVideo != nil {
                Button {
                    videoStore.toggleVideoMode()
                } label: {
                    Image(systemName: videoStore.videoModeEnabled ? "tv.fill" : "tv")
                        .musaicFont(size: 12, weight: .semibold)
                        .foregroundStyle(videoStore.videoModeEnabled ? Color.accentStrong : Color.textSecondary)
                        .frame(width: 30, height: 30)
                        .background(Color.white.opacity(0.07), in: Circle())
                }
                .buttonStyle(.plain)
                .help(videoStore.videoModeEnabled ? String(localized: "Show artwork") : String(localized: "Show video"))
                .accessibilityLabel(Text(videoStore.videoModeEnabled ? String(localized: "Show artwork") : String(localized: "Show video")))
            }

            Button {
                showSleepTimer = true
            } label: {
                Image(systemName: player.sleepTimerActive ? "moon.zzz.fill" : "moon")
                    .musaicFont(size: 12, weight: .semibold)
                    .foregroundStyle(player.sleepTimerActive ? Color.accentStrong : Color.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(Color.white.opacity(0.07), in: Circle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "Sleep timer"))
            .accessibilityLabel(Text(String(localized: "Sleep timer")))

            Button {
                showLyrics = true
            } label: {
                Image(systemName: "quote.bubble")
                    .musaicFont(size: 12, weight: .semibold)
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(Color.white.opacity(0.07), in: Circle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "Show lyrics"))
            .accessibilityLabel(Text(String(localized: "Show lyrics")))

            Button {
                showQueue = true
            } label: {
                Image(systemName: "list.bullet")
                    .musaicFont(size: 12, weight: .semibold)
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 30, height: 30)
                    .background(Color.white.opacity(0.07), in: Circle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "Show queue"))
            .accessibilityLabel(Text(String(localized: "Show queue")))
        }
    }
    #endif

    // MARK: - iOS layout (unchanged phone player)

    #if os(iOS)
    private func iosPlayerLayout(track: Track) -> some View {
        GeometryReader { geo in
            let screenInset: CGFloat = 16
            let contentWidth = min(geo.size.width - screenInset * 2, 360)
            let artSide = min(contentWidth - 16, geo.size.height * 0.44, 340)
            let topInset = max(geo.safeAreaInsets.top, 18)
            let bottomInset = max(geo.safeAreaInsets.bottom, 18)

            AdaptivePlayerContainer {
            VStack(spacing: 14) {
                Capsule()
                    .fill(Color.white.opacity(0.35))
                    .frame(width: 42, height: 5)

                NowPlayingTopBarView(
                    showLyrics: $showLyrics,
                    showQueue: $showQueue,
                    showSleepTimer: $showSleepTimer,
                    showIPodWheel: $showIPodWheel
                )

                Spacer(minLength: 6)

                VStack(spacing: 20) {
                    NowPlayingArtworkView(track: track, side: artSide)
                    NowPlayingMetadataSectionView(track: track)
                    NowPlayingTransportDeckView()
                }
                .frame(maxWidth: contentWidth)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.horizontal, screenInset)
            .padding(.top, topInset + 6)
            .padding(.bottom, bottomInset)
            }
        }
    }
    #endif
}
