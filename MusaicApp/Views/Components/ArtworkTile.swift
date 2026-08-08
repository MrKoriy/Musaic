import SwiftUI

struct ArtworkTile: View {
    let urlString: String?
    let icon: String

    var body: some View {
        GeometryReader { geo in
            InspectableArtworkView(
                urlString: urlString,
                debugLabel: icon,
                maxPixelSize: 900
            ) {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(Image(systemName: icon).font(.system(size: 28)).foregroundStyle(Color.textSecondary))
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
