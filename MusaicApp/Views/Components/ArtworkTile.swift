import SwiftUI

/// Artwork sized to its frame: requests are decoded at display size × screen
/// scale (bucketed), not a fixed large size.
struct ArtworkTile: View {
    let urlString: String?
    let icon: String

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { geo in
            let side = max(geo.size.width, geo.size.height)
            InspectableArtworkView(
                urlString: urlString,
                debugLabel: icon,
                maxPixelSize: side > 0 ? ArtworkPipeline.bucketedPixelSize(for: side, scale: displayScale) : 0
            ) {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        Image(systemName: icon)
                            .font(.system(size: min(28, max(side * 0.3, 12))))
                            .foregroundStyle(Color.textSecondary)
                    )
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct PlaylistArtworkView: View {
    let coverURL: String?

    var body: some View {
        ArtworkTile(urlString: coverURL, icon: "music.note.list")
    }
}
