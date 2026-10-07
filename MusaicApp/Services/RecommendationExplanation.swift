import Foundation

extension Track {
    var recommendationReasonSummary: String {
        let labels = (recommendationReasons ?? []).compactMap { reason -> String? in
            switch reason {
            case "positive_track_history": return String(localized: "Positive listening history for this track.")
            case "positive_artist_history": return String(localized: "Positive listening history for this artist.")
            case "shared_tags": return String(localized: "Musical tags shared with your station seeds.")
            case "mood_match": return String(localized: "Matches the selected mood.")
            case "seed_artist": return String(localized: "Related to an artist used to build this station.")
            case "similar_listeners": return String(localized: "Similar listening preferences.")
            default: return nil
            }
        }
        return labels.joined(separator: "\n")
    }
}
