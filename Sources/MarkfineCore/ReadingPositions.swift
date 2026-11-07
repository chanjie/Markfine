import CryptoKit
import Foundation

public struct ReadingPosition: Codable, Equatable, Sendable {
    public let mode: String
    public let line: Int
    public let fraction: Double
    public init(mode: String, line: Int, fraction: Double = 0) {
        self.mode = mode; self.line = line; self.fraction = fraction
    }
    public var valid: Bool { ["edit", "read"].contains(mode) && line > 0 && line <= 10_000_000 && fraction.isFinite && (0...1).contains(fraction) }
}

/// Only navigation metadata, never Markdown or attachments. Identity is the absolute, standardized path.
public final class ReadingPositions {
    public static let storageKey = "readingPositions.v1"
    private let defaults: UserDefaults
    private struct Entry: Codable { let position: ReadingPosition; let date: Double }
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private func key(_ url: URL) -> String { SHA256.hash(data: Data(url.standardizedFileURL.path.utf8)).map { String(format: "%02x", $0) }.joined() }
    private var entries: [String: Entry] { defaults.data(forKey: Self.storageKey).flatMap { try? JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:] }
    public func position(for url: URL) -> ReadingPosition? {
        guard url.isFileURL, let value = entries[key(url)]?.position, value.valid else { return nil }; return value
    }
    public func note(_ position: ReadingPosition, for url: URL) {
        guard url.isFileURL, position.valid else { return }
        var values = entries; values[key(url)] = Entry(position: position, date: Date().timeIntervalSince1970)
        if values.count > 500 { for item in values.sorted(by: { $0.value.date > $1.value.date }).dropFirst(500) { values[item.key] = nil } }
        if let data = try? JSONEncoder().encode(values) { defaults.set(data, forKey: Self.storageKey) }
    }
    public func clear() { defaults.removeObject(forKey: Self.storageKey) }
    public var byteCount: Int { defaults.data(forKey: Self.storageKey)?.count ?? 0 }
}
