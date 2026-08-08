import SwiftUI

enum ChipSelectorStyle: Equatable {
    case liquid
    case mood
}

struct ChipSelector<Option: Hashable>: View {
    let options: [Option]
    let label: (Option) -> String
    let isSelected: (Option) -> Bool
    let onSelect: (Option) -> Void
    var style: ChipSelectorStyle = .liquid

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(options, id: \.self) { option in
                    Button {
                        onSelect(option)
                    } label: {
                        chipLabel(for: option)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
        }
    }

    @ViewBuilder
    private func chipLabel(for option: Option) -> some View {
        let selected = isSelected(option)
        if style == .mood {
            Text(label(option))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(selected ? Color.bgPrimary : Color.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(
                    Capsule()
                        .fill(selected ? Color.textPrimary.opacity(0.92) : Color.white.opacity(0.07))
                )
        } else {
            Text(label(option))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .liquidChipSurface(selected: selected)
        }
    }
}
