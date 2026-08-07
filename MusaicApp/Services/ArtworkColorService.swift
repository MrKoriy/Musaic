import Foundation
import CoreImage
import CoreGraphics
import SwiftUI

struct ArtworkPalette: Sendable {
    let dominant: Color
    let secondary: Color
    let shadow: Color

    static let fallback = ArtworkPalette(
        dominant: Color(red: 0.78, green: 0.69, blue: 0.55),
        secondary: Color(red: 0.32, green: 0.25, blue: 0.19),
        shadow: Color(red: 0.05, green: 0.04, blue: 0.03)
    )
}

actor ArtworkColorService {
    static let shared = ArtworkColorService()

    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private var cache: [String: ArtworkPalette] = [:]
    private var inflight: [String: Task<ArtworkPalette, Never>] = [:]

    func palette(for image: PlatformImage, cacheKey: String) async -> ArtworkPalette {
        if let hit = cache[cacheKey] { return hit }
        if let task = inflight[cacheKey] { return await task.value }

        let task = Task<ArtworkPalette, Never> { [ciContext] in
            await Self.extract(from: image, using: ciContext)
        }
        inflight[cacheKey] = task
        defer { inflight[cacheKey] = nil }

        let palette = await task.value
        cache[cacheKey] = palette
        if cache.count > 128 {
            // Trim oldest half — cheap bounded cache
            let keep = cache.suffix(64)
            cache = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        return palette
    }

    private static func extract(from image: PlatformImage, using context: CIContext) async -> ArtworkPalette {
        guard let cg = image.platformCGImage else { return .fallback }
        let ci = CIImage(cgImage: cg)
        let w = ci.extent.width
        let h = ci.extent.height
        guard w > 0, h > 0 else { return .fallback }

        // Dominant: whole-image average
        let dominant = averageColor(in: ci, rect: ci.extent, context: context)

        // Secondary: top band (often lighter/more saturated)
        let topRect = CGRect(x: 0, y: h * 0.55, width: w, height: h * 0.45)
        let secondaryRaw = averageColor(in: ci, rect: topRect, context: context)
        let secondary = secondaryRaw.boosted(saturation: 1.25, brightness: 1.08)

        // Shadow: darkened dominant, floor applied
        let shadow = dominant.boosted(saturation: 0.8, brightness: 0.18)

        return ArtworkPalette(
            dominant: dominant.asSwiftColor(minBrightness: 0.22, maxBrightness: 0.68),
            secondary: secondary.asSwiftColor(minBrightness: 0.28, maxBrightness: 0.78),
            shadow: shadow.asSwiftColor(minBrightness: 0.04, maxBrightness: 0.14)
        )
    }

    private static func averageColor(in image: CIImage, rect: CGRect, context: CIContext) -> RGB {
        let filter = CIFilter(name: "CIAreaAverage") ?? CIFilter(name: "CIColorClamp")
        let cropped = image.cropped(to: rect)
        let params: [String: Any] = [
            kCIInputImageKey: cropped,
            kCIInputExtentKey: CIVector(cgRect: rect)
        ]
        filter?.setValuesForKeys(params)

        guard let output = filter?.outputImage else { return RGB(r: 0.5, g: 0.4, b: 0.3) }
        var bitmap = [UInt8](repeating: 0, count: 4)
        context.render(
            output,
            toBitmap: &bitmap,
            rowBytes: 4,
            bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
            format: .RGBA8,
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        return RGB(
            r: Double(bitmap[0]) / 255,
            g: Double(bitmap[1]) / 255,
            b: Double(bitmap[2]) / 255
        )
    }
}

private struct RGB {
    var r: Double
    var g: Double
    var b: Double

    func boosted(saturation satMul: Double, brightness briMul: Double) -> RGB {
        var h: Double = 0, s: Double = 0, v: Double = 0
        Self.rgbToHSV(r: r, g: g, b: b, h: &h, s: &s, v: &v)
        s = min(1, s * satMul)
        v = min(1, v * briMul)
        var r2: Double = 0, g2: Double = 0, b2: Double = 0
        Self.hsvToRGB(h: h, s: s, v: v, r: &r2, g: &g2, b: &b2)
        return RGB(r: r2, g: g2, b: b2)
    }

    func asSwiftColor(minBrightness: Double, maxBrightness: Double) -> Color {
        var h: Double = 0, s: Double = 0, v: Double = 0
        Self.rgbToHSV(r: r, g: g, b: b, h: &h, s: &s, v: &v)
        v = min(maxBrightness, max(minBrightness, v))
        s = max(0.12, min(0.85, s))
        var r2: Double = 0, g2: Double = 0, b2: Double = 0
        Self.hsvToRGB(h: h, s: s, v: v, r: &r2, g: &g2, b: &b2)
        return Color(.sRGB, red: r2, green: g2, blue: b2, opacity: 1)
    }

    private static func rgbToHSV(r: Double, g: Double, b: Double, h: inout Double, s: inout Double, v: inout Double) {
        let maxC = max(r, max(g, b))
        let minC = min(r, min(g, b))
        v = maxC
        let d = maxC - minC
        s = maxC == 0 ? 0 : d / maxC
        if d == 0 { h = 0; return }
        if maxC == r { h = (g - b) / d + (g < b ? 6 : 0) }
        else if maxC == g { h = (b - r) / d + 2 }
        else { h = (r - g) / d + 4 }
        h /= 6
    }

    private static func hsvToRGB(h: Double, s: Double, v: Double, r: inout Double, g: inout Double, b: inout Double) {
        let i = floor(h * 6)
        let f = h * 6 - i
        let p = v * (1 - s)
        let q = v * (1 - f * s)
        let t = v * (1 - (1 - f) * s)
        switch Int(i) % 6 {
        case 0: r = v; g = t; b = p
        case 1: r = q; g = v; b = p
        case 2: r = p; g = v; b = t
        case 3: r = p; g = q; b = v
        case 4: r = t; g = p; b = v
        default: r = v; g = p; b = q
        }
    }
}
