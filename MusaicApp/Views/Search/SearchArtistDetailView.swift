import SwiftUI

/// Artist page opened from search; shares `ArtistProfileScreen` with library artists.
struct SearchArtistDetailView: View {
    let artist: SearchArtist
    @Binding var showNowPlaying: Bool

    var body: some View {
        ArtistProfileScreen(subject: .search(artist), showNowPlaying: $showNowPlaying)
    }
}

struct ArtistSourceWarning: View {
    let errors: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(String(localized: "Some sources did not respond"), systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textPrimary)

            Text(errors.keys.sorted(by: { artistSourceRank($0) < artistSourceRank($1) }).map(artistSourceDisplayName).joined(separator: ", "))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassCard(cornerRadius: 20, intensity: 0.08)
    }
}
