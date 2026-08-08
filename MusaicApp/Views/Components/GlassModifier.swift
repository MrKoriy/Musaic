import SwiftUI

// MARK: - Liquid Glass Modifier

private struct LiquidEdgeHighlight: View {
    let cornerRadius: CGFloat
    let tint: Color

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(
                LinearGradient(
                    colors: [
                        .white.opacity(0.22),
                        tint.opacity(0.18),
                        .white.opacity(0.04),
                        .black.opacity(0.18),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                lineWidth: 1
            )
    }
}

struct GlassBackground: ViewModifier {
    var cornerRadius: CGFloat = 24
    var tint: Color = .white
    var intensity: Double = 0.08
    var interactive: Bool = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        if #available(iOS 26.0, macOS 26.0, *) {
            let glass = Glass.regular
                .tint(tint.opacity(min(0.12, max(0.02, intensity))))
                .interactive(interactive)

            content
                .background {
                    shape
                        .fill(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.03),
                                    tint.opacity(intensity * 0.34),
                                    .black.opacity(0.14),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .overlay {
                            shape
                                .fill(
                                    RadialGradient(
                                        colors: [
                                            tint.opacity(intensity * 0.7),
                                            .clear,
                                        ],
                                        center: .topTrailing,
                                        startRadius: 4,
                                        endRadius: 120
                                    )
                                )
                                .blur(radius: 16)
                        }
                }
                .glassEffect(glass, in: shape)
                .overlay {
                    LiquidEdgeHighlight(cornerRadius: cornerRadius, tint: tint)
                }
                .shadow(color: .black.opacity(0.24), radius: 28, y: 18)
        } else {
            content
                .background(
                    ZStack {
                        shape
                            .fill(
                                LinearGradient(
                                    colors: [
                                        tint.opacity(intensity + 0.04),
                                        .white.opacity(0.06),
                                        .black.opacity(0.12),
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    }
                )
                .overlay(
                    LiquidEdgeHighlight(cornerRadius: cornerRadius, tint: tint)
                )
                .shadow(color: .black.opacity(0.18), radius: 16, y: 10)
        }
    }
}

struct ClearGlassBackground: ViewModifier {
    var cornerRadius: CGFloat = 24

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.clear, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            content
                .background(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.thinMaterial)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(.white.opacity(0.12), lineWidth: 1)
                )
        }
    }
}

struct LiquidProminentSurface: ViewModifier {
    var cornerRadius: CGFloat = 24
    var accent: Color = Color.accentStrong

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        content
            .background {
                ZStack {
                    shape
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color(hex: "33251b"),
                                    Color(hex: "1d1510"),
                                    Color(hex: "130e0b"),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )

                    shape
                        .fill(
                            RadialGradient(
                                colors: [
                                    accent.opacity(0.40),
                                    .clear,
                                ],
                                center: .topTrailing,
                                startRadius: 8,
                                endRadius: 150
                            )
                        )
                        .blur(radius: 18)

                    shape
                        .fill(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.20),
                                    .white.opacity(0.05),
                                    .clear,
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .blendMode(.screen)
                }
            }
            .overlay {
                LiquidEdgeHighlight(cornerRadius: cornerRadius, tint: accent)
            }
            .shadow(color: .black.opacity(0.30), radius: 26, y: 18)
    }
}

struct LiquidChipSurface: ViewModifier {
    var selected: Bool
    var cornerRadius: CGFloat = 999
    var accent: Color = Color(hex: "d9b17b")

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

        content
            .background(
                // Flat symmetric fill — no asymmetric gradient, nothing that looks like a drop shadow.
                shape.fill(selected
                    ? Color(hex: "3e2e1f").opacity(0.95)
                    : Color.white.opacity(0.055))
            )
            .overlay(
                shape.strokeBorder(
                    selected ? Color.white.opacity(0.18) : Color.white.opacity(0.10),
                    lineWidth: 0.8
                )
            )
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = 24, tint: Color = .white, intensity: Double = 0.16, interactive: Bool = false) -> some View {
        modifier(GlassBackground(cornerRadius: cornerRadius, tint: tint, intensity: intensity, interactive: interactive))
    }

    func clearGlass(cornerRadius: CGFloat = 24) -> some View {
        modifier(ClearGlassBackground(cornerRadius: cornerRadius))
    }

    func liquidProminentSurface(cornerRadius: CGFloat = 24, accent: Color = Color.accentStrong) -> some View {
        modifier(LiquidProminentSurface(cornerRadius: cornerRadius, accent: accent))
    }

    func liquidChipSurface(selected: Bool, cornerRadius: CGFloat = 999, accent: Color = Color(hex: "d9b17b")) -> some View {
        modifier(LiquidChipSurface(selected: selected, cornerRadius: cornerRadius, accent: accent))
    }

    @ViewBuilder
    func liquidButtonStyle(prominent: Bool = false) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            if prominent {
                buttonStyle(.glassProminent)
            } else {
                buttonStyle(.glass)
            }
        } else {
            buttonStyle(.plain)
        }
    }
}

// MARK: - Glass Card View

struct GlassCard<Content: View>: View {
    var cornerRadius: CGFloat = 24
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .glassCard(cornerRadius: cornerRadius)
    }
}

struct LiquidGlassGroup<Content: View>: View {
    var spacing: CGFloat? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content()
            }
        } else {
            content()
        }
    }
}

struct AppBackdrop: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(hex: "2b211b"),
                    Color(hex: "14110f"),
                    Color(hex: "090807"),
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            // Warm glow — replaced a 320pt blurred Circle with a plain RadialGradient.
            // Visually identical, but no per-frame Gaussian blur = far less GPU load.
            RadialGradient(
                colors: [Color(hex: "c89c68").opacity(0.14), .clear],
                center: UnitPoint(x: 0.8, y: 0.1),
                startRadius: 40,
                endRadius: 260
            )

            RadialGradient(
                colors: [Color.white.opacity(0.05), .clear],
                center: UnitPoint(x: 0.1, y: 0.05),
                startRadius: 30,
                endRadius: 230
            )

            LinearGradient(
                colors: [
                    .clear,
                    .black.opacity(0.28),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
    }
}

struct LiquidIconButton: View {
    let systemName: String
    var size: CGFloat = 44
    var accessibilityLabel: String? = nil
    var action: () -> Void

    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            Button(action: action) {
                Image(systemName: systemName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .frame(width: size, height: size)
            }
            .buttonBorderShape(.circle)
            .buttonStyle(.glass(.regular.interactive()))
            .accessibilityLabel(Text(accessibilityLabel ?? systemName))
        } else {
            Button(action: action) {
                Image(systemName: systemName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                    .frame(width: size, height: size)
                    .glassCard(cornerRadius: size / 2, intensity: 0.12)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(accessibilityLabel ?? systemName))
        }
    }
}
