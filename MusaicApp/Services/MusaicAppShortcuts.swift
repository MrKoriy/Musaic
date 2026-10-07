import AppIntents

struct StartMusaicWaveIntent: AppIntent {
    static let title: LocalizedStringResource = "Start My Vibe"
    static let description = IntentDescription("Start your personal music station from favorites.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard SettingsStore.shared.isLoggedIn else {
            return .result(dialog: "Sign in to Musaic to start your station.")
        }
        await LibraryStore.shared.ensureSynced()
        let tracks = LibraryStore.shared.likedTracks
        guard !tracks.isEmpty else {
            return .result(dialog: "Add favorite tracks in Musaic to build your station.")
        }
        await PlayerStore.shared.startMyVibe(from: tracks)
        return .result(dialog: "Starting your personal station in Musaic.")
    }
}
struct MusaicAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartMusaicWaveIntent(),
            phrases: ["Play my wave in \(.applicationName)", "Start my station in \(.applicationName)"],
            shortTitle: "My Vibe", systemImageName: "dot.radiowaves.up.forward")
    }
}
