import Foundation

/// File contents are data, never a program or a resource-loading document.
public enum TextDocument {
    public static let maximumBytes = 16 * 1_048_576
    public static func isMarkdown(_ url: URL?) -> Bool { url == nil || ["md", "markdown"].contains(url!.pathExtension.lowercased()) }
    public static func language(_ url: URL?) -> String {
        guard let url else { return "" }
        let groups: [(String, [String])] = [
            ("javascript", ["js", "jsx", "mjs", "cjs"]), ("typescript", ["ts", "tsx", "mts", "cts"]),
            ("python", ["py", "pyw"]), ("bash", ["sh", "bash", "zsh", "command"]), ("swift", ["swift"]),
            ("go", ["go"]), ("rust", ["rs"]), ("java", ["java"]), ("cpp", ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"]),
            ("csharp", ["cs"]), ("json", ["json", "jsonc", "ipynb"]), ("yaml", ["yaml", "yml"]),
            ("xml", ["html", "htm", "xml", "svg", "xhtml", "plist", "vue", "svelte"]), ("css", ["css"]),
            ("sql", ["sql"]), ("ruby", ["rb", "rake", "gemspec"]), ("powershell", ["ps1", "psm1", "psd1"])
        ]
        if let language = groups.first(where: { $0.1.contains(url.pathExtension.lowercased()) })?.0 { return language }
        switch url.lastPathComponent.lowercased() {
        case ".bashrc", ".bash_profile", ".zshrc", ".zprofile": return "bash"
        case "gemfile", "rakefile": return "ruby"
        default: return ""
        }
    }
    /// Routing hint only. Every file is still decoded and checked before becoming editable.
    public static func isKnownText(_ url: URL) -> Bool {
        isMarkdown(url) || !language(url).isEmpty || ["txt", "text", "log", "csv", "tsv", "toml", "ini", "cfg", "conf", "config", "env", "properties", "gitignore", "gitattributes", "editorconfig", "applescript", "pl", "fish"].contains(url.pathExtension.lowercased()) || url.pathExtension.isEmpty
    }
}

/// Explicit Unicode encodings only: a missing/ambiguous encoding is never guessed lossily.
public struct TextFileEncoding: Equatable, Sendable {
    private let encoding: UInt
    private let bom: Data
    public let name: String
    public static let utf8 = TextFileEncoding(encoding: String.Encoding.utf8.rawValue, bom: Data(), name: "UTF-8")

    public static func decode(_ data: Data) throws -> (String, TextFileEncoding) {
        guard data.count <= TextDocument.maximumBytes else { throw FileStoreFailure.tooLarge }
        let choices: [(bytes: [UInt8], encoding: String.Encoding, name: String)] = [
            ([0xff, 0xfe, 0, 0], .utf32LittleEndian, "UTF-32 LE"), ([0, 0, 0xfe, 0xff], .utf32BigEndian, "UTF-32 BE"),
            ([0xef, 0xbb, 0xbf], .utf8, "UTF-8 BOM"), ([0xff, 0xfe], .utf16LittleEndian, "UTF-16 LE"), ([0xfe, 0xff], .utf16BigEndian, "UTF-16 BE")
        ]
        let match = choices.first { data.starts(with: $0.bytes) }
        let format = match.map { TextFileEncoding(encoding: $0.encoding.rawValue, bom: Data($0.bytes), name: $0.name) } ?? .utf8
        let body = Data(data.dropFirst(format.bom.count))
        guard let text = String(data: body, encoding: String.Encoding(rawValue: format.encoding)),
              text.data(using: String.Encoding(rawValue: format.encoding), allowLossyConversion: false) == body else { throw FileStoreFailure.invalidUTF8 }
        // Reject binary/control payloads even when their bytes happen to be valid UTF-8.
        guard !text.unicodeScalars.contains(where: { value in
            value.value < 0x20 && ![9, 10, 12, 13, 27].contains(value.value) || value.value == 0x7f
        }), !text.hasPrefix("%PDF-"), !text.hasPrefix("GIF87a"), !text.hasPrefix("GIF89a") else { throw FileStoreFailure.notText }
        return (text, format)
    }

    public func encode(_ text: String) throws -> Data {
        guard let data = text.data(using: String.Encoding(rawValue: encoding), allowLossyConversion: false) else { throw FileStoreFailure.invalidUTF8 }
        guard data.count <= TextDocument.maximumBytes - bom.count else { throw FileStoreFailure.tooLarge }
        return bom + data
    }
}
