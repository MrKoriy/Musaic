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
                        Text("Paste a link from Yandex Music. Tracks will be matched on SoundCloud and VK.")
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
                                Text(loading ? "Searching..." : "Find Tracks")
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
                            Text("Saved as \"\(savedName)\"")
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
                    Text(result.title ?? "Imported Playlist")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.textPrimary)
                    Text("\(result.matchedCount ?? 0)/\(result.totalTracks ?? 0) tracks found")
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
                            Text(saving ? "Saving..." : "Save Playlist")
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
                ForEach(result.matches.indices, id: \.self) { idx in
                    let match = result.matches[idx]
                    ImportTrackRow(match: match)
                }
            }
        }
    }

    @MainActor
    private func importPlaylist() async {
        loading = true
        error = nil
        importResult = nil
        savedName = nil
        defer { loading = false }

        do {
            struct Body: Codable { let url: String }
            guard let urlObj = URL(string: "\(api.serverURL)/api/import/playlist") else {
                self.error = "Invalid server URL"
                return
            }
            var request = URLRequest(url: urlObj)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = SettingsStore.shared.authToken {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try? JSONEncoder().encode(Body(url: url))
            request.timeoutInterval = 300

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                self.error = "No response"
                return
            }

            let result = try JSONDecoder().decode(ImportResult.self, from: data)
            if let errMsg = result.error {
                self.error = errMsg
            } else {
                importResult = result
                playlistName = result.title ?? "Imported Playlist"
            }
        } catch {
            self.error = "Failed: \(error.localizedDescription)"
        }
    }

    @MainActor
    private func saveAsPlaylist(_ result: ImportResult) async {
        saving = true
        defer { saving = false }

        let matchedIds = result.matches
            .filter { $0.confidence != "none" }
            .compactMap { $0.match?.id }

        guard !matchedIds.isEmpty else { return }

        do {
            struct SaveBody: Codable { let name: String; let trackIds: [String] }
            guard let urlObj = URL(string: "\(api.serverURL)/api/import/save") else {
                self.error = "Invalid server URL"
                return
            }
            var request = URLRequest(url: urlObj)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = SettingsStore.shared.authToken {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try? JSONEncoder().encode(SaveBody(name: playlistName, trackIds: matchedIds))

            let (data, _) = try await URLSession.shared.data(for: request)
            let resp = try JSONDecoder().decode(SaveResponse.self, from: data)
            if resp.ok == true {
                savedName = playlistName
            }
        } catch {
            self.error = "Save failed: \(error.localizedDescription)"
        }
    }
}

// MARK: - Response Models

struct ImportResult: Codable {
    let source: String?
    let title: String?
    let totalTracks: Int?
    let matchedCount: Int?
    let matches: [ImportMatch]
    let error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        totalTracks = try c.decodeIfPresent(Int.self, forKey: .totalTracks)
        matchedCount = try c.decodeIfPresent(Int.self, forKey: .matchedCount)
        matches = (try? c.decode([ImportMatch].self, forKey: .matches)) ?? []
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    enum CodingKeys: String, CodingKey {
        case source, title, totalTracks, matchedCount, matches, error
    }
}

struct ImportMatch: Codable {
    let title: String
    let artist: String
    let album: String?
    let durationSec: Int?
    let confidence: String
    let match: ImportMatchTrack?
    let matchSource: String?
}

struct ImportMatchTrack: Codable {
    let id: String
    let title: String
    let artist: String
    let source: String?

    enum CodingKeys: String, CodingKey {
        case id, title, artist, source
    }
}

struct SaveResponse: Codable {
    let ok: Bool?
    let id: String?
    let trackCount: Int?
}
