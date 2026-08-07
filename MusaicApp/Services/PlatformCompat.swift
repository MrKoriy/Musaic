import SwiftUI

#if os(iOS)
import UIKit
public typealias PlatformImage = UIImage
#elseif os(macOS)
import AppKit
public typealias PlatformImage = NSImage
#endif

// MARK: - Cross-platform image helpers

extension PlatformImage {
    /// Create a PlatformImage from raw data
    static func platformImage(from data: Data) -> PlatformImage? {
        #if os(iOS)
        return UIImage(data: data)
        #elseif os(macOS)
        return NSImage(data: data)
        #endif
    }

    /// Create a PlatformImage from a CGImage
    static func platformImage(cgImage: CGImage) -> PlatformImage {
        #if os(iOS)
        return UIImage(cgImage: cgImage)
        #elseif os(macOS)
        let size = NSSize(width: cgImage.width, height: cgImage.height)
        return NSImage(cgImage: cgImage, size: size)
        #endif
    }

    /// Image dimensions (points)
    var platformSize: CGSize {
        #if os(iOS)
        return size
        #elseif os(macOS)
        return size
        #endif
    }

    /// Scale factor
    var platformScale: CGFloat {
        #if os(iOS)
        return scale
        #elseif os(macOS)
        guard let rep = representations.first else { return 1.0 }
        let pixelWidth = CGFloat(rep.pixelsWide)
        return pixelWidth > 0 ? pixelWidth / size.width : 1.0
        #endif
    }

    /// Underlying CGImage (for color extraction, thumbnailing)
    var platformCGImage: CGImage? {
        #if os(iOS)
        return cgImage
        #elseif os(macOS)
        var proposedRect = CGRect(origin: .zero, size: size)
        return cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
        #endif
    }

    /// JPEG data representation
    func platformJPEGData(compressionQuality: CGFloat) -> Data? {
        #if os(iOS)
        return jpegData(compressionQuality: compressionQuality)
        #elseif os(macOS)
        guard let tiffData = tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData) else { return nil }
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: compressionQuality])
        #endif
    }
}

// MARK: - Cross-platform image resizing

func resizedImage(_ image: PlatformImage, to targetSize: CGSize) -> PlatformImage {
    #if os(iOS)
    let renderer = UIGraphicsImageRenderer(size: targetSize)
    return renderer.image { _ in
        image.draw(in: CGRect(origin: .zero, size: targetSize))
    }
    #elseif os(macOS)
    let newImage = NSImage(size: targetSize)
    newImage.lockFocus()
    image.draw(in: NSRect(origin: .zero, size: targetSize),
               from: NSRect(origin: .zero, size: image.size),
               operation: .sourceOver,
               fraction: 1.0)
    newImage.unlockFocus()
    return newImage
    #endif
}

// MARK: - SwiftUI Image from PlatformImage

extension Image {
    init(platformImage: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: platformImage)
        #elseif os(macOS)
        self.init(nsImage: platformImage)
        #endif
    }
}

// MARK: - iOS-only view modifier wrappers

extension View {
    /// navigationBarHidden — iOS only, no-op on macOS
    @ViewBuilder
    func navigationBarHiddenCompat(_ hidden: Bool) -> some View {
        #if os(iOS)
        self.navigationBarHidden(hidden)
        #else
        self
        #endif
    }

    /// navigationBarTitleDisplayMode — iOS only, no-op on macOS
    @ViewBuilder
    func navigationBarTitleDisplayModeCompat(_ mode: Any? = nil) -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// toolbarColorScheme for tabBar — iOS only
    @ViewBuilder
    func toolbarColorSchemeCompat() -> some View {
        #if os(iOS)
        self.toolbarColorScheme(.dark, for: .tabBar)
        #else
        self
        #endif
    }
}

// MARK: - Cross-platform toolbar placement

extension ToolbarItemPlacement {
    /// .topBarTrailing on iOS, .automatic on macOS
    static var topBarTrailingCompat: ToolbarItemPlacement {
        #if os(iOS)
        return .topBarTrailing
        #else
        return .automatic
        #endif
    }
}
