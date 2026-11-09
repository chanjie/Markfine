import AppKit
import MarkfineCore

/// A native window background only. No title-bar views, hit testing or event routing changes.
@MainActor
final class WindowPaper {
    private var patterns: [String: NSColor] = [:]

    func background(theme: String, resources: EditorResources) -> NSColor {
        let solid = theme == "kraft" ? NSColor(srgbRed: 0.878, green: 0.788, blue: 0.631, alpha: 1) : theme == "eye" ? NSColor(srgbRed: 0.898, green: 0.933, blue: 0.890, alpha: 1) : NSColor(srgbRed: 0.969, green: 0.953, blue: 0.906, alpha: 1)
        let name = theme == "eye" ? nil : theme == "kraft" ? "kraft-texture.png" : "paper-texture.png"
        var pattern: NSColor?
        if let name {
            if let cached = patterns[name] { pattern = cached }
            else if let data = try? resources.data(name), let image = NSImage(data: data) {
                image.size = NSSize(width: 512, height: 512) // Same point size as the Web paper; Retina retains its 2× pixels.
                let color = NSColor(patternImage: image); patterns[name] = color; pattern = color
            }
        }
        let light = pattern ?? solid
        return NSColor(name: nil) { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua { return NSColor(srgbRed: 0.102, green: 0.118, blue: 0.110, alpha: 1) }
            return light
        }
    }
}
