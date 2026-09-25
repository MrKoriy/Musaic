import SwiftUI

/// Server address input shared by sign-in and Settings.
struct ServerAddressField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "server.rack")
                .foregroundStyle(Color.textSecondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            TextField(String(localized: "Server address"), text: $text, prompt: Text(verbatim: "192.168.1.10:3001"))
                .textFieldStyle(.plain)
                .foregroundStyle(Color.textPrimary)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textContentType(.URL)
                #endif
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .glassCard(cornerRadius: 18, intensity: 0.08)
    }
}
