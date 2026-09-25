import SwiftUI

struct ImportPlaylistView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var showNowPlaying: Bool

    @State private var url = ""
    @State private var loading = false
    @State private var importResult: ImportResult?
    @State private var error: String?
    @State private var saving = false
    @State private var savedName: String?
    @State private var playlistName = ""

    private let api = APIService.shared

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Import Playlist")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)
                        Text(String(localized: "Paste a link from Yandex Music. Tracks are matched in your library and enabled sources."))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .padding(.horizontal, 18)

                    // URL input
                    HStack(spacing: 12) {
                        Image(systemName: "link")
                            .foregroundStyle(Color.textSecondary)
                        TextField("music.yandex.ru/users/.../playlists/...", text: $url)
                            .textFieldStyle(.plain)
                            .foregroundStyle(Color.textPrimary)
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                        if !url.isEmpty {
                            Button { url = "" } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(Color.textSecondary)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.white.opacity(0.06))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
                    )
                    .padding(.horizontal, 18)

                    // Paste + Search button
                    HStack(spacing: 12) {
                        Button {
                            #if os(iOS)
                            if let clip = UIPasteboard.general.string {
                                url = clip
                            }
                            #elseif os(macOS)
                            if let clip = NSPasteboard.general.string(forType: .string) {
                                url = clip
                            }
                            #endif
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }

                        Button {
                            Task { await importPlaylist() }
                        } label: {
                            HStack(spacing: 8) {
                                if loading {
                                    ProgressView().tint(Color.bgPrimary).scaleEffect(0.8)
                                }
                                Text(loading ? String(localized: "Searching…") : String(localized: "Find Tracks"))
                                    .font(.system(size: 14, weight: .bold))
                            }
                            .foregroundStyle(Color.bgPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.textPrimary.opacity(url.count > 10 ? 0.92 : 0.3), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .disabled(loading || url.count < 10)
                    }
                    .padding(.horizontal, 18)

                    if let error {
                        Text(error)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.red)
                            .padding(.horizontal, 18)
                    }

                    // Results
                    if let result = importResult {
                        resultSection(result)
                    }

                    if let savedName {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text(String(localized: "Saved as \"\(savedName)\""))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                        }
                        .padding(.horizontal, 18)
                    }
                }
                .padding(.top, 12)
                .padding(.bottom, Layout.playerBottomInset)
            }
            .background(AppBackdrop())
            .navigationBarTitleDisplayModeCompat()
            .toolbar {
                ToolbarItem(placement: .topBarTrailingCompat) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
        }
    }

    @ViewBuilder
    private func resultSection(_ result: ImportResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(result.title ?? String(localized: "Imported Playlist"))
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.textPrimary)
                    Text(String(localized: "\(result.matchedCount ?? 0)/\(result.totalTracks ?? 0) tracks found"))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle((result.matchedCount ?? 0) > 0 ? .green : Color.textSecondary)
                }
                Spacer()
                if (result.matchedCount ?? 0) > 0 {
                    Button {
                        Task { await saveAsPlaylist(result) }
                    } label: {
                        HStack(spacing: 6) {
                            if saving {
                                ProgressView().tint(Color.bgPrimary).scaleEffect(0.7)
                            }
                            Text(saving ? String(localized: "Saving…") : String(localized: "Save Playlist"))
                                .font(.system(size: 13, weight: .bold))
                        }
                        .foregroundStyle(Color.bgPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.textPrimary.opacity(0.92), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .disabled(saving)
                }
            }
            .padding(.horizontal, 18)

            LazyVStack(spacing: 8) {
                ForEach(result.identifiedMatches) { item in
                    ImportTrackRow(match: item.match)
                }
            }
        }
    }

    private func importPlaylist() async {
        let link = url.trimmingCharacters(in: .whitespacesAndNewlines)
        loading = true
        error = nil
        importResult = nil
        savedName = nil
        defer { loading = false }

        do {
            let result = try await api.importPlaylist(url: link)
            if let message = result.error {
                error = message
            } else {
                importResult = result
                playlistName = result.title ?? String(localized: "Imported Playlist")
            }
        } catch where error.isCancellation {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saveAsPlaylist(_ result: ImportResult) async {
        let matchedIds = result.matches
            .filter { $0.confidence != "none" }
            .compactMap { $0.match?.id }
        guard !matchedIds.isEmpty else { return }

        saving = true
        defer { saving = false }
        do {
            let response = try await api.saveImportedPlaylist(name: playlistName, trackIds: matchedIds)
            if response.ok == true {
                savedName = playlistName
            } else {
                error = String(localized: "The server didn't save the playlist.")
            }
        } catch where error.isCancellation {
            return
        } catch {
            self.error = String(localized: "Save failed: \(error.localizedDescription)")
        }
    }
}
