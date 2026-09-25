import SwiftUI

/// Small glass metric tile (Home, Library header, Profile stats, macOS sidebar).
struct StatCard: View {
    let value: String
    let label: String
    var icon: String? = nil
    var compact = false
    var tint: Color = .white

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: compact ? 12 : 14, weight: .semibold))
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityHidden(true)
            }
            Text(value)
                .font(.system(size: compact ? 20 : 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.system(size: compact ? 11 : 12, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(compact ? 10 : 14)
        .glassCard(cornerRadius: compact ? 14 : 20, tint: tint, intensity: 0.08)
        .accessibilityElement(children: .combine)
    }
}
