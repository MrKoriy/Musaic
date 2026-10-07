import SwiftUI

private struct MusaicScaledFont: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 14
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design, relativeTo: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: relativeTo)
        self.weight = weight
        self.design = design
    }
    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}
private struct MusaicBounce<Value: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let value: Value
    func body(content: Content) -> some View {
        if reduceMotion { content } else { content.symbolEffect(.bounce, value: value) }
    }
}
extension View {
    func musaicFont(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default,
                    relativeTo: Font.TextStyle = .body) -> some View {
        modifier(MusaicScaledFont(size: size, weight: weight, design: design, relativeTo: relativeTo))
    }
    func musaicBounce<Value: Equatable>(value: Value) -> some View {
        modifier(MusaicBounce(value: value))
    }
}

/// Large accessibility text gets a scrollable player instead of overflowing
/// the fixed artwork/transport budget used at ordinary text sizes.
struct AdaptivePlayerContainer<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            ScrollView(.vertical) { content }
        } else { content }
    }
}
