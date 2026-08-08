import SwiftUI

struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String
    var actionTitle: String?
    var action: (() -> Void)?

    init(
        title: String,
        message: String,
        systemImage: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(Color.textPrimary)

            Text(title)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .multilineTextAlignment(.center)

            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let action, let actionTitle {
                Button(actionTitle, action: action)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Color.bgPrimary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(Color.textPrimary.opacity(0.92), in: Capsule())
                    .accessibilityHint(Text(String(localized: "Opens the related action")))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .glassCard(cornerRadius: 28, intensity: 0.08)
    }
}
