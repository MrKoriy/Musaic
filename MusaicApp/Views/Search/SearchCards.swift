import SwiftUI

struct ArtistSearchCard: View {
    let artist: SearchArtist

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Circle()
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        InspectableArtworkView(
                            urlString: APIService.shared.artworkURL(for: artist.coverUrl),
                            debugLabel: "artist: \(artist.artist)",
                            contentMode: .fill,
                            maxPixelSize: 420
                        ) {
                            Image(systemName: "person.fill")
                                .font(.system(size: 28, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                        }
                        .clipShape(Circle())
                    )
                    .frame(width: 86, height: 86)

                Text(sourceBadge(artist.source))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color.textPrimary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.ultraThinMaterial, in: Capsule())
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(artist.artist)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)
                    .frame(minHeight: 34, alignment: .topLeading)

                Text(artist.subtitle?.isEmpty == false ? artist.subtitle! : artist.sourceLabel)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)

                Text("\(artist.trackCount) tracks")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textMuted)
                    .lineLimit(1)
            }
        }
        .frame(width: 150, alignment: .leading)
        .padding(12)
        .glassCard(cornerRadius: 24, intensity: 0.10)
    }
}

private func sourceBadge(_ source: String) -> String {
    switch source {
    case "local": return "LOCAL"
    case "vk": return "VK"
    case "soundcloud": return "SC"
    case "mixed": return "ALL"
    default: return source.uppercased()
    }
}

struct PlaylistSearchCard: View {
    let playlist: ExternalPlaylist
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack {
                    if let url = playlist.coverUrl {
                        InspectableArtworkView(
                            urlString: APIService.shared.artworkURL(for: url),
                            debugLabel: "playlist: \(playlist.title)"
                        ) {
                            Color.white.opacity(0.06)
                        }
                    } else {
                        Color.white.opacity(0.06)
                    }

                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            HStack(spacing: 4) {
                                Image(systemName: "list.bullet")
                                    .font(.system(size: 9, weight: .bold))
                                Text("\(playlist.trackCount)")
                                    .font(.system(size: 10, weight: .bold))
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(6)
                        }
                    }
                }
                .frame(width: 140, height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Text(playlist.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)

                HStack(spacing: 4) {
                    Text(playlist.source.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.textMuted)
                    Text("•")
                        .foregroundStyle(Color.textMuted)
                    Text(playlist.author)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.textSecondary)
                }
                .lineLimit(1)
            }
            .frame(width: 140)
        }
        .buttonStyle(.plain)
    }
}
