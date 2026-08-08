import SwiftUI

struct LiquidSectionHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)
            Text(subtitle)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
        }
    }
}
