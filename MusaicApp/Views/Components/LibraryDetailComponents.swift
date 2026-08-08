import SwiftUI

struct ArtistDetailBanner: View {
    let artworkURL: String?
    let artistName: String
    let albumCount: Int
    let trackCount: Int

    var body: some View {
        ZStack(alignment: .bottom) {
            GeometryReader { geo in
                InspectableArtworkView(
                    urlString: artworkURL,
                    debugLabel: "artist-banner",
                    contentMode: .fill,
                    maxPixelSize: 800
                ) {
                    Rectangle().fill(Color.white.opacity(0.08))
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .blur(radius: 24)
                .overlay(
                    LinearGradient(
                        colors: [Color.black.opacity(0.3), Color.black.opacity(0.7)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }
            .frame(height: 240)
            .clipped()

            VStack(spacing: 8) {
                Circle()
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 90, height: 90)
                    .overlay(
                        InspectableArtworkView(
                            urlString: artworkURL,
                            debugLabel: "artist-avatar",
                            contentMode: .fill,
                            maxPixelSize: 300
                        ) {
                            Image(systemName: "person.fill")
                                .font(.system(size: 34))
                                .foregroundStyle(Color.textPrimary)
                        }
                        .clipShape(Circle())
                    )

                Text(artistName)
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                    .multilineTextAlignment(.center)
                    .shadow(color: .black.opacity(0.5), radius: 4, y: 2)

                Text("\(albumCount) albums • \(trackCount) tracks")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.75))
            }
            .padding(.bottom, 20)
        }
        .frame(height: 240)
    }
}
