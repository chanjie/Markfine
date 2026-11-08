import Foundation

public struct ClipboardResource: Codable, Sendable {
    public let source: String
    public let data: Data
    public init(source: String, data: Data) { self.source = source; self.data = data }
}
/// Self-contained image bytes, never paths that grant the receiving process file access.
public struct ClipboardArchive: Codable, Sendable {
    public let format: Int
    public let markdown: String
    public let images: [ClipboardResource]
    public init(markdown: String, images: [ClipboardResource]) { self.format = 1; self.markdown = markdown; self.images = images }
    public var valid: Bool {
        format == 1 && markdown.utf8.count <= 8 * 1_048_576 && images.count <= 512 && Set(images.map(\.source)).count == images.count &&
        images.allSatisfy { !$0.source.isEmpty && $0.source.utf8.count <= 8192 && !$0.data.isEmpty && $0.data.count <= 64 * 1_048_576 } && images.reduce(0, { $0 + $1.data.count }) <= 64 * 1_048_576
    }
    public static func decode(_ data: Data) throws -> ClipboardArchive {
        guard data.count <= 96 * 1_048_576, let value = try? JSONDecoder().decode(Self.self, from: data), value.valid else { throw ImageStoreFailure.unsupported }; return value
    }
}
