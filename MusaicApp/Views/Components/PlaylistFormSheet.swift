import SwiftUI

struct PlaylistPickerView: View {
    let track: Track
    @State private var playlists: [ServerPlaylist] = []
    @State private var loading = true
    @State private var newName = ""
    @State private var showNew = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if loading {
                        ProgressView()
                            .tint(Color.textPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 30)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(playlists, id: \.id) { playlist in
                                Button {
                                    Task {
                                        try? await APIService.shared.addToPlaylist(playlistId: playlist.id, trackId: track.id)
                                        dismiss()
                                    }
                                } label: {
                                    HStack(spacing: 12) {
                                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .fill(Color.white.opacity(0.08))
                                            .frame(width: 52, height: 52)
                                            .overlay(Image(systemName: "music.note.list").foregroundStyle(Color.textPrimary))

                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(playlist.name)
                                                .font(.system(size: 15, weight: .semibold))
                                                .foregroundStyle(Color.textPrimary)
                                            Text("\(playlist.trackCount) tracks")
                                                .font(.system(size: 12, weight: .medium))
                                                .foregroundStyle(Color.textSecondary)
                                        }

                                        Spacer()
                                    }
                                    .padding(14)
                                    .glassCard(cornerRadius: 22, intensity: 0.10)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if showNew {
                        VStack(spacing: 12) {
                            TextField("Playlist name", text: $newName)
                                .textFieldStyle(.plain)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .glassCard(cornerRadius: 20, intensity: 0.08)

                            Button("Create and add track") {
                                Task {
                                    let id = try? await APIService.shared.createPlaylist(name: newName)
                                    if let id {
                                        try? await APIService.shared.addToPlaylist(playlistId: id, trackId: track.id)
                                    }
                                    dismiss()
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background {
                                RoundedRectangle(cornerRadius: 20, style: .continuous)
                                    .fill(Color.clear)
                                    .opacity(newName.isEmpty ? 0.55 : 1)
                                    .liquidProminentSurface(cornerRadius: 20, accent: Color(hex: "d9b17b"))
                            }
                            .foregroundStyle(newName.isEmpty ? Color.textSecondary : Color.textPrimary)
                            .disabled(newName.isEmpty)
                        }
                    } else {
                        Button {
                            showNew = true
                        } label: {
                            Label("New Playlist", systemImage: "plus")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .glassCard(cornerRadius: 20, intensity: 0.08)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(18)
                .padding(.bottom, 24)
            }
            .background(AppBackdrop())
            .navigationTitle("Add to Playlist")
            .navigationBarTitleDisplayModeCompat()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Color.textPrimary)
                }
            }
            .task {
                playlists = (try? await APIService.shared.getPlaylists()) ?? []
                loading = false
            }
        }
        .presentationDetents([.medium, .large])
    }
}
