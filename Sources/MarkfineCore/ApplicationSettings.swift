import CoreFoundation
import Foundation

/// Per macOS user, not per document. A caller can supply an isolated suite for local checks.
public final class ApplicationSettings {
    public static let bodyLineHeight = 1.85
    public static let editingLineHeight = 1.4
    public static let defaultPageTheme = "white"
    private let defaults: UserDefaults
    public static let initial: [String: Any] = [
        "shortcutHints": true, "focusMode": true, "lineNumbers": false, "showAllFiles": false, "showWorkspaceRecents": false, "recentLimit": 20,
        "language": "system", "timeZone": "local", "fontChinese": "PingFangSC-Regular", "fontEnglish": "PingFangSC-Regular",
        "appearance": "system", "editTheme": defaultPageTheme, "readTheme": defaultPageTheme, "outlineSide": "left", "filesSide": "left", "outlineWidth": 220.0,
        "leftWidth": 220.0, "rightWidth": 220.0, "editLineSpacing": 1.3, "readLineSpacing": 1.3, "editZoom": 1.0, "readZoom": 1.0
    ]
    private static let exportKeys = ["exportLayout.pdf", "exportLayout.docx", "exportLastFormat"]
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
    public var defaultExportLayout: ExportLayout {
        let preferences = values
        return ExportLayout(spacing: preferences["readLineSpacing"] as? Double ?? 1.3,
                            chinese: preferences["fontChinese"] as? String ?? "PingFangSC-Regular",
                            english: preferences["fontEnglish"] as? String ?? "PingFangSC-Regular")
    }
    public var lastExportFormat: ExportFormat {
        ExportFormat(rawValue: defaults.string(forKey: "exportLastFormat") ?? "") ?? .pdf
    }
    public func exportLayout(for format: ExportFormat) -> ExportLayout? {
        guard let data = defaults.dictionary(forKey: "exportLayout." + format.rawValue),
              let version = data["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let enabled = data["indentEnabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
              let indent = data["indent"] as? NSNumber, CFGetTypeID(indent) != CFBooleanGetTypeID(),
              let spacing = data["spacing"] as? NSNumber, CFGetTypeID(spacing) != CFBooleanGetTypeID(),
              let chinese = data["chinese"] as? String, let english = data["english"] as? String else { return nil }
        let layout = ExportLayout(indentEnabled: enabled.boolValue, indent: indent.doubleValue, spacing: spacing.doubleValue, chinese: chinese, english: english)
        return layout.valid ? layout : nil
    }
    /// Call only after the output file has been written successfully.
    @discardableResult public func recordSuccessfulExport(_ format: ExportFormat, layout: ExportLayout,
                                                           followingPreferences: Bool, baseline: ExportLayout) -> Bool {
        guard layout.valid, baseline.valid else { return false }
        let key = "exportLayout." + format.rawValue
        if followingPreferences && layout == baseline {
            defaults.removeObject(forKey: key)
        } else {
            defaults.set(["version": 1, "indentEnabled": layout.indentEnabled, "indent": layout.indent,
                          "spacing": layout.spacing, "chinese": layout.chinese, "english": layout.english], forKey: key)
        }
        defaults.set(format.rawValue, forKey: "exportLastFormat")
        return true
    }
    public var storedByteCount: Int {
        let values = (Array(Self.initial.keys) + Self.exportKeys).reduce(into: [String: Any]()) { if let value = defaults.object(forKey: $1) { $0[$1] = value } }
        return values.isEmpty ? 0 : (try? JSONSerialization.data(withJSONObject: values).count) ?? 0
    }
    /// Reset this app's preference whitelist only. Never clear recent locations, documents or the whole domain.
    public func reset() { for key in Array(Self.initial.keys) + Self.exportKeys { defaults.removeObject(forKey: key) } }
    public func text(_ chinese: String, _ english: String) -> String { self.english ? english : chinese }
    @discardableResult public func set(_ key: String, _ value: Any) -> Bool {
        guard Self.accepts(key, value) else { return false }; defaults.set(value, forKey: key); return true
    }
    public static func accepts(_ key: String, _ value: Any) -> Bool {
        switch key {
        case "shortcutHints", "focusMode", "lineNumbers", "showAllFiles", "showWorkspaceRecents":
            guard let number = value as? NSNumber else { return false }; return CFGetTypeID(number) == CFBooleanGetTypeID()
        case "language": return ["system", "zh-Hans", "en"].contains(value as? String ?? "")
        case "timeZone": return ["local", "UTC"].contains(value as? String ?? "")
        case "appearance": return ["system", "light", "dark"].contains(value as? String ?? "")
        case "outlineSide", "filesSide": return ["left", "right"].contains(value as? String ?? "")
        case "editTheme", "readTheme": return ["white", "paper", "kraft", "eye"].contains(value as? String ?? "")
        case "fontChinese", "fontEnglish":
            guard let name = value as? String else { return false }
            return !name.isEmpty && name.utf16.count <= 128 && name.rangeOfCharacter(from: .controlCharacters) == nil
        case "recentLimit":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            return number.doubleValue.isFinite && number.doubleValue.rounded() == number.doubleValue && (0...1000).contains(number.intValue)
        case "outlineWidth", "leftWidth", "rightWidth", "editZoom", "readZoom", "editLineSpacing", "readLineSpacing":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let range: ClosedRange<Double> = ["outlineWidth", "leftWidth", "rightWidth"].contains(key) ? 180...360 : key.hasSuffix("LineSpacing") ? 0.75...2.5 : 0.5...2
            return number.doubleValue.isFinite && range.contains(number.doubleValue)
        default: return false
        }
    }
}
