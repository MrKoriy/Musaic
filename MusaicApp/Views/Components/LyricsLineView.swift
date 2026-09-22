import SwiftUI

/// One lyrics line. When the server provides per-word timings the line renders
/// as a karaoke run — words light up (and briefly bold) as they are sung;
/// otherwise it falls back to the plain line text.
struct LyricsLineView: View {
    let lineID: Int
    let text: String
    let isActive: Bool
    let isTapped: Bool
    var words: [LyricsWord] = []
    /// Index of the word being sung right now (only set on the active line).
    var activeWordIndex: Int? = nil
    let onTap: () -> Void

    var body: some View {
        let bgColor: Color = isTapped
            ? Color.white.opacity(0.08)
            : (isActive ? Color.white.opacity(0.05) : Color.clear)

        return Group {
            if words.isEmpty {
                Text(text)
                    .foregroundStyle(Color.textPrimary.opacity(isActive ? 1.0 : 0.38))
            } else {
                Text(karaokeText)
                    .foregroundStyle(Color.textPrimary.opacity(isActive ? 1.0 : 0.38))
            }
        }
        .font(.system(size: 22, weight: .semibold, design: .rounded))
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

    /// Word-by-word attributed run for the karaoke highlight: sung words stay
    /// bright, the current word glows in the accent color, upcoming words sit
    /// dimmed until their turn.
    private var karaokeText: AttributedString {
        var run = AttributedString()
        for (index, word) in words.enumerated() {
            var piece = AttributedString(word.text + " ")
            if isActive, index == activeWordIndex {
                piece.foregroundColor = Color.accentStrong
                piece.font = .system(size: 22, weight: .bold, design: .rounded)
            } else if isActive, let sung = activeWordIndex, index < sung {
                piece.foregroundColor = Color.textPrimary.opacity(0.85)
            } else {
                piece.foregroundColor = Color.textPrimary.opacity(isActive ? 0.55 : 0.38)
            }
            run += piece
        }
        return run
    }
}
