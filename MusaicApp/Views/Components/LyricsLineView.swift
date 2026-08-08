import SwiftUI

struct LyricsLineView: View {
    let lineID: Int
    let text: String
    let isActive: Bool
    let isTapped: Bool
    let onTap: () -> Void

    var body: some View {
        let bgColor: Color = isTapped
            ? Color.white.opacity(0.08)
            : (isActive ? Color.white.opacity(0.05) : Color.clear)

        return Text(text)
            .font(.system(size: 22, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.textPrimary.opacity(isActive ? 1.0 : 0.38))
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7)
            .padding(.horizontal, 6)
            .background(bgColor, in: RoundedRectangle(cornerRadius: 8))
            .id(lineID)
            .animation(.easeOut(duration: 0.22), value: isActive)
            .onTapGesture(perform: onTap)
    }
}
