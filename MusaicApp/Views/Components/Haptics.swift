import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Impact haptics; a no-op on macOS.
@MainActor
enum Haptics {
    enum Style {
        case soft, light, medium, rigid
    }

    static func impact(_ style: Style = .light) {
        #if os(iOS)
        let feedbackStyle: UIImpactFeedbackGenerator.FeedbackStyle
        switch style {
        case .soft: feedbackStyle = .soft
        case .light: feedbackStyle = .light
        case .medium: feedbackStyle = .medium
        case .rigid: feedbackStyle = .rigid
        }
        UIImpactFeedbackGenerator(style: feedbackStyle).impactOccurred()
        #endif
    }
}
