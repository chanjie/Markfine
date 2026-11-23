import AppKit
import MarkfineCore

/// A native window background only. No title-bar views, hit testing or event routing changes.
@MainActor
final class WindowPaper {
    private var patterns: [String: NSColor] = [:]

    func solidBackground(theme: String) -> NSColor {
        adaptiveBackground(light: lightBackground(theme: theme))
    }

    func background(theme: String, resources: EditorResources) -> NSColor {
        let light = lightBackground(theme: theme)
        guard theme == "paper" || theme == "kraft" else { return adaptiveBackground(light: light) }
        let name = "\(theme)-texture.png"
        if let cached = patterns[name] { return adaptiveBackground(light: cached) }
        if let data = try? resources.data(name), let image = NSImage(data: data) {
            image.size = NSSize(width: 512, height: 512) // Same point size as the Web paper; Retina retains its 2× pixels.
            let color = NSColor(patternImage: image); patterns[name] = color
            return adaptiveBackground(light: color)
        }
        return adaptiveBackground(light: light)
    }

    private func lightBackground(theme: String) -> NSColor {
        switch theme {
        case "paper": return NSColor(srgbRed: 0.969, green: 0.953, blue: 0.906, alpha: 1)
        case "kraft": return NSColor(srgbRed: 0.878, green: 0.788, blue: 0.631, alpha: 1)
        case "eye": return NSColor(srgbRed: 0.898, green: 0.933, blue: 0.890, alpha: 1)
        default: return NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
        }
    }

    private func adaptiveBackground(light: NSColor) -> NSColor {
        return NSColor(name: nil) { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua { return NSColor(srgbRed: 0.102, green: 0.118, blue: 0.110, alpha: 1) }
            return light
        }
    }
}
