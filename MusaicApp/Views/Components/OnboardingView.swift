import SwiftUI

struct OnboardingView: View {
    @Binding var sourceYandex: Bool
    @Binding var sourceYoutube: Bool
    @Binding var sourceSoundcloud: Bool
    @Binding var sourceVK: Bool

    let yandexConnected: Bool
    let vkConnected: Bool
    let onComplete: () -> Void
    let onOpenSettings: () -> Void

    private var enabledSourceCount: Int {
        [sourceYandex, sourceYoutube, sourceSoundcloud, sourceVK].filter { $0 }.count
    }

    var body: some View {
        ZStack {
            AppBackdrop()

            ScrollView {
                VStack(spacing: 22) {
                    VStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(Color(hex: "f0d09d").opacity(0.32))
                                .frame(width: 92, height: 92)
                                .blur(radius: 18)

                            Circle()
                                .fill(
                                    RadialGradient(
                                        colors: [Color(hex: "f0d09d"), Color(hex: "7f5f43")],
                                        center: .center,
                                        startRadius: 4,
                                        endRadius: 44
                                    )
                                )
                                .frame(width: 70, height: 70)

                            Image(systemName: "waveform")
                                .font(.system(size: 28, weight: .bold))
                                .foregroundStyle(Color.bgPrimary)
                        }
                        Text(String(localized: "Welcome to Musaic"))
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)

                        Text(String(localized: "Your library is empty. Choose the sources Musaic should search and recommend from."))
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 26)
                    .padding(.top, 44)

                    VStack(alignment: .leading, spacing: 14) {
                        Text(String(localized: "Music Sources"))
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.textPrimary)

                        sourceRow(
                            title: String(localized: "Local Library"),
                            subtitle: String(localized: "Always available on this server"),
                            icon: "externaldrive.fill",
                            isOn: .constant(true),
                            status: String(localized: "Ready")
                        )

                        sourceRow(
                            title: String(localized: "Yandex Music"),
                            subtitle: yandexConnected
                                ? String(localized: "Account connected")
                                : String(localized: "Connect later in Settings"),
                            icon: "y.square.fill",
                            isOn: $sourceYandex,
                            status: yandexConnected ? String(localized: "Connected") : String(localized: "Not connected")
                        )

                        sourceRow(
                            title: String(localized: "YouTube Music"),
                            subtitle: String(localized: "Search and recommendations"),
                            icon: "play.rectangle.fill",
                            isOn: $sourceYoutube,
                            status: String(localized: "Enabled")
                        )

                        sourceRow(
                            title: String(localized: "SoundCloud"),
                            subtitle: String(localized: "Search and recommendations"),
                            icon: "cloud.fill",
                            isOn: $sourceSoundcloud,
                            status: String(localized: "Optional")
                        )

                        sourceRow(
                            title: String(localized: "VK liked tracks"),
                            subtitle: vkConnected
                                ? String(localized: "Account connected")
                                : String(localized: "Connect later in Settings"),
                            icon: "person.2.fill",
                            isOn: $sourceVK,
                            status: vkConnected ? String(localized: "Connected") : String(localized: "Not connected")
                        )
                    }
                    .padding(18)
                    .glassCard(cornerRadius: 28, tint: Color.accentStrong, intensity: 0.10)
                    .padding(.horizontal, 18)

                    Text(
                        enabledSourceCount == 0
                            ? String(localized: "You can enable sources later in Settings.")
                            : String(localized: "You can change these choices any time in Settings.")
                    )
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 30)

                    VStack(spacing: 10) {
                        Button(String(localized: "Start Listening"), action: onComplete)
                            .buttonStyle(StateActionButtonStyle(prominent: true))
                            .frame(maxWidth: .infinity)

                        Button(String(localized: "Open Settings to Connect"), action: onOpenSettings)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.textSecondary)
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 32)
                }
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func sourceRow(
        title: String,
        subtitle: String,
        icon: String,
        isOn: Binding<Bool>,
        status: String
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
                .frame(width: 34, height: 34)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text(subtitle)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 5) {
                Text(status)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
                Toggle("", isOn: isOn)
                    .labelsHidden()
                    .tint(Color.accentStrong)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(status))
    }
}
