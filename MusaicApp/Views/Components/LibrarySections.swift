import SwiftUI

struct LibraryHeaderView: View {
    let selectedTab: String
    let likedCount: Int
    let albumCount: Int
    let playlistCount: Int
    let onImport: () -> Void
    let onNewPlaylist: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                LiquidSectionHeader(
                    title: String(localized: "Your Library"),
                    subtitle: String(localized: "Albums, artists, playlists and the tracks you keep around.")
                )
                Spacer(minLength: 12)
                if selectedTab == "Playlists" {
                    HStack(spacing: 8) {
                        LiquidIconButton(systemName: "square.and.arrow.down", accessibilityLabel: String(localized: "Import Playlist"), action: onImport)
                        LiquidIconButton(systemName: "plus", accessibilityLabel: String(localized: "New Playlist"), action: onNewPlaylist)
                    }
                }
            }

            HStack(spacing: 12) {
                libraryStat(title: String(localized: "Liked"), value: "\(likedCount)")
                libraryStat(title: String(localized: "Albums"), value: "\(albumCount)")
                libraryStat(title: String(localized: "Playlists"), value: "\(playlistCount)")
            }
        }
        .padding(.horizontal, 18)
    }

    private func libraryStat(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 22, tint: Color.accentStrong, intensity: 0.10)
    }
}

struct LibraryPlaylistSection: View {
    let playlists: [ServerPlaylist]
    let loading: Bool
    let loadError: String?
    let loadUnauthorized: Bool
    @Binding var showNowPlaying: Bool
    @Binding var showNewPlaylist: Bool
    @Binding var newPlaylistName: String
    let onCreatePlaylist: () -> Void
    let onRetry: () -> Void
    let onSignIn: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Button {
                showNewPlaylist = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color.textPrimary)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle()
                                .fill(Color.clear)
                                .liquidProminentSurface(cornerRadius: 18, accent: Color(hex: "d9b17b"))
                        )
                    VStack(alignment: .leading, spacing: 4) {
                        Text("New Playlist")
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text("Create a fresh playlist and start filling it right away.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                }
                .padding(14)
                .glassCard(cornerRadius: 24, intensity: 0.10)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 18)

            if loading && playlists.isEmpty {
                ProgressView()
                    .tint(Color.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 34)
            } else if let loadError {
                ErrorRetryView(
                    title: loadUnauthorized ? String(localized: "Session expired") : String(localized: "Library unavailable"),
                    message: loadError,
                    isUnauthorized: loadUnauthorized,
                    onRetry: onRetry,
                    onSignIn: loadUnauthorized ? onSignIn : nil
                )
                .padding(.horizontal, 18)
                .padding(.top, 18)
            } else if playlists.isEmpty {
                EmptyStateView(
                    title: String(localized: "No playlists yet"),
                    message: String(localized: "Create one and give it a custom cover from Photos or Files."),
                    systemImage: "music.note.list"
                )
                .padding(.horizontal, 18)
                .padding(.top, 24)
            } else {
                LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 14) {
                    ForEach(playlists, id: \.id) { playlist in
                        NavigationLink {
                            PlaylistDetailView(playlistId: playlist.id, initialPlaylist: playlist, showNowPlaying: $showNowPlaying)
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                PlaylistArtworkView(coverURL: APIService.shared.artworkURL(for: playlist.coverUrl))
                                    .aspectRatio(1, contentMode: .fit)

                                Text(playlist.name)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.textPrimary)
                                    .lineLimit(1)
                                Text("\(playlist.trackCount) tracks")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(Color.textSecondary)
                            }
                            .padding(12)
                            .glassCard(cornerRadius: 26, intensity: 0.10)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
            }
        }
        .alert("New Playlist", isPresented: $showNewPlaylist) {
            TextField("Playlist name", text: $newPlaylistName)
            Button("Create", action: onCreatePlaylist)
            Button("Cancel", role: .cancel) {}
        }
    }
}
