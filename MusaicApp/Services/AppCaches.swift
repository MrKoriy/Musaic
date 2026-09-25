import Foundation

/// The app's own caches (HTTP responses, artwork, palettes) — never the whole
/// Caches folder, which other subsystems use while the app runs.
@MainActor
enum AppCaches {
    static func usageBytes() async -> Int {
        let artwork = await ArtworkPipeline.shared.diskUsageBytes()
        return APIService.shared.urlCache.currentDiskUsage + URLCache.shared.currentDiskUsage + artwork
    }

    static func clearAll() async {
        APIService.shared.clearSessionCaches()
        URLCache.shared.removeAllCachedResponses()
        await ArtworkPipeline.shared.clearCaches()
        await ArtworkColorService.shared.clear()
    }

    static func formatted(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
