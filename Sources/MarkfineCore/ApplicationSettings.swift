import CoreFoundation
import Foundation

/// Per macOS user, not per document. A caller can supply an isolated suite for local checks.
public final class ApplicationSettings {
    private let defaults: UserDefaults
    public static let initial: [String: Any] = [
        "shortcutHints": true, "focusMode": true, "lineNumbers": false, "showAllFiles": false,
        "language": "system", "timeZone": "local", "fontChinese": "PingFangSC-Regular", "fontEnglish": "PingFangSC-Regular",
        "editTheme": "paper", "readTheme": "paper", "outlineSide": "left", "outlineWidth": 220.0, "editZoom": 1.0, "readZoom": 1.0
    ]
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var values: [String: Any] {
        var result = Self.initial
        for key in result.keys { if let value = defaults.object(forKey: key), Self.accepts(key, value) { result[key] = value } }
        let language = result["language"] as! String
        result["locale"] = language == "system" ? (Locale.preferredLanguages.first?.hasPrefix("zh") == true ? "zh-Hans" : "en") : language
        return result
    }
    public var english: Bool { values["locale"] as? String == "en" }
    /// Reset this app's preference whitelist only. Never clear recent locations, documents or the whole domain.
    public func reset() { for key in Self.initial.keys { defaults.removeObject(forKey: key) } }
    public func text(_ chinese: String, _ english: String) -> String { self.english ? english : chinese }
    @discardableResult public func set(_ key: String, _ value: Any) -> Bool {
        guard Self.accepts(key, value) else { return false }; defaults.set(value, forKey: key); return true
    }
    public static func accepts(_ key: String, _ value: Any) -> Bool {
        switch key {
        case "shortcutHints", "focusMode", "lineNumbers", "showAllFiles":
            guard let number = value as? NSNumber else { return false }; return CFGetTypeID(number) == CFBooleanGetTypeID()
        case "language": return ["system", "zh-Hans", "en"].contains(value as? String ?? "")
        case "timeZone": return ["local", "UTC"].contains(value as? String ?? "")
        case "outlineSide": return ["left", "right"].contains(value as? String ?? "")
        case "editTheme", "readTheme": return ["paper", "kraft", "eye"].contains(value as? String ?? "")
        case "fontChinese", "fontEnglish":
            guard let name = value as? String else { return false }
            return !name.isEmpty && name.utf16.count <= 128 && name.rangeOfCharacter(from: .controlCharacters) == nil
        case "outlineWidth", "editZoom", "readZoom":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let range: ClosedRange<Double> = key == "outlineWidth" ? 180...360 : 0.5...2
            return number.doubleValue.isFinite && range.contains(number.doubleValue)
        default: return false
        }
    }
}
