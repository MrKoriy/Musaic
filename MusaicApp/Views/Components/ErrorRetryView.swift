import SwiftUI

struct ErrorRetryView: View {
    let title: String
    let message: String
    let isUnauthorized: Bool
    let onRetry: () -> Void
    var onSignIn: (() -> Void)?

    init(
        title: String = String(localized: "Something went wrong"),
        message: String,
        isUnauthorized: Bool = false,
        onRetry: @escaping () -> Void,
        onSignIn: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.isUnauthorized = isUnauthorized
        self.onRetry = onRetry
        self.onSignIn = onSignIn
    }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: isUnauthorized ? "person.crop.circle.badge.exclamationmark" : "wifi.exclamationmark")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(Color.accentStrong)

            Text(title)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .multilineTextAlignment(.center)

            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                Button {
                    onRetry()
                } label: {
                    Label(String(localized: "Retry"), systemImage: "arrow.clockwise")
                }
                .buttonStyle(StateActionButtonStyle(prominent: true))

                if isUnauthorized, let onSignIn {
                    Button(String(localized: "Sign In Again"), action: onSignIn)
                        .buttonStyle(StateActionButtonStyle(prominent: false))
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .glassCard(cornerRadius: 28, tint: Color.accentStrong, intensity: 0.08)
    }
}

struct StateActionButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(prominent ? Color.bgPrimary : Color.textPrimary)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background(
                prominent
                    ? AnyShapeStyle(Color.textPrimary.opacity(configuration.isPressed ? 0.72 : 0.92))
                    : AnyShapeStyle(Color.white.opacity(configuration.isPressed ? 0.14 : 0.08)),
                in: Capsule()
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}
