import CoreFoundation
import Foundation

/// Per macOS user, not per document. A caller can supply an isolated suite for local checks.
public final class ApplicationSettings {
    public static let bodyLineHeight = 1.85
    public static let editingLineHeight = 1.4
    private let defaults: UserDefaults
    public static let initial: [String: Any] = [
        "shortcutHints": true, "focusMode": true, "lineNumbers": false, "showAllFiles": false,
        "language": "system", "timeZone": "local", "fontChinese": "PingFangSC-Regular", "fontEnglish": "PingFangSC-Regular",
        "appearance": "system", "editTheme": "paper", "readTheme": "paper", "outlineSide": "left", "filesSide": "left", "outlineWidth": 220.0,
        "leftWidth": 220.0, "rightWidth": 220.0, "editLineSpacing": 1.3, "readLineSpacing": 1.3, "editZoom": 1.0, "readZoom": 1.0
    ]
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var values: [String: Any] {
        var result = Self.initial
        for key in result.keys { if let value = defaults.object(forKey: key), Self.accepts(key, value) { result[key] = value } }
        for key in ["leftWidth", "rightWidth"] where defaults.object(forKey: key) == nil { result[key] = result["outlineWidth"] }
        let language = result["language"] as! String
        result["locale"] = language == "system" ? (Locale.preferredLanguages.first?.hasPrefix("zh") == true ? "zh-Hans" : "en") : language
        return result
    }
    public var english: Bool { values["locale"] as? String == "en" }
    public func lineHeight(reading: Bool, source: Bool = false) -> Double { (reading || source ? Self.bodyLineHeight : Self.editingLineHeight) * (values[reading ? "readLineSpacing" : "editLineSpacing"] as? Double ?? 1.3) }
    public var storedByteCount: Int {
        let values = Self.initial.keys.reduce(into: [String: Any]()) { if let value = defaults.object(forKey: $1) { $0[$1] = value } }
        return values.isEmpty ? 0 : (try? JSONSerialization.data(withJSONObject: values).count) ?? 0
    }
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
        case "appearance": return ["system", "light", "dark"].contains(value as? String ?? "")
        case "outlineSide", "filesSide": return ["left", "right"].contains(value as? String ?? "")
        case "editTheme", "readTheme": return ["paper", "kraft", "eye"].contains(value as? String ?? "")
        case "fontChinese", "fontEnglish":
            guard let name = value as? String else { return false }
            return !name.isEmpty && name.utf16.count <= 128 && name.rangeOfCharacter(from: .controlCharacters) == nil
        case "outlineWidth", "leftWidth", "rightWidth", "editZoom", "readZoom", "editLineSpacing", "readLineSpacing":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let range: ClosedRange<Double> = ["outlineWidth", "leftWidth", "rightWidth"].contains(key) ? 180...360 : key.hasSuffix("LineSpacing") ? 0.75...2.5 : 0.5...2
            return number.doubleValue.isFinite && range.contains(number.doubleValue)
        default: return false
        }
    }
}
