import CryptoKit
import Foundation

public struct BuildInfo: Codable, Equatable {
    public let version: String
    public let build: Int
    public let stage: String
    public let inputID: String
}

public enum ResourceFailure: Error, CustomStringConvertible {
    case invalid(String)
    public var description: String {
        switch self { case .invalid(let name): return "内置资源缺失或校验失败：\(name)" }
    }
}

public struct EditorResources {
    public let root: URL
    public let info: BuildInfo

    private struct Manifest: Decodable {
        let format: Int
        let inputID: String
        let files: [String: String]
    }

    public static func locate(bundle: Bundle = .main, executable: URL) throws -> EditorResources {
        let root: URL
        if bundle.bundleURL.pathExtension == "app" {
            guard let resources = bundle.resourceURL else { throw ResourceFailure.invalid("Resources") }
            root = resources.appendingPathComponent("Editor", isDirectory: true)
        } else {
            root = executable.deletingLastPathComponent().appendingPathComponent("Editor", isDirectory: true)
        }
        // Deliberately no Bundle.module, #filePath, working-directory or source-tree fallback.
        return try EditorResources(root: root)
    }

    public init(root: URL) throws {
        guard root.isFileURL, root.host == nil || root.host == "" || root.host == "localhost" else { throw ResourceFailure.invalid("local resource root required") }
        self.root = root
        let manifestURL = root.appendingPathComponent("manifest.json")
        let manifest = try JSONDecoder().decode(Manifest.self, from: Self.readRegular(manifestURL))
        let required: Set<String> = ["index.html", "style.css", "app.js", "build-info.json", "ThirdPartyNotices.txt", "dependencies.json"]
        guard manifest.format == 1, Self.isDigest(manifest.inputID),
              required.isSubset(of: Set(manifest.files.keys)), manifest.files.count <= 32 else {
            throw ResourceFailure.invalid("manifest")
        }
        for (name, digest) in manifest.files {
            guard Self.isFilename(name), Self.isDigest(digest) else { throw ResourceFailure.invalid(name) }
            let data = try Self.readRegular(root.appendingPathComponent(name))
            guard Self.sha256(data) == digest else { throw ResourceFailure.invalid(name) }
        }
        let actual = try Set(FileManager.default.contentsOfDirectory(atPath: root.path))
        guard actual == Set(manifest.files.keys).union(["manifest.json"]) else {
            throw ResourceFailure.invalid("unexpected files")
        }
        info = try JSONDecoder().decode(BuildInfo.self, from: Self.readRegular(root.appendingPathComponent("build-info.json")))
        guard info.inputID == manifest.inputID, info.build > 0, ["development", "mvp-candidate"].contains(info.stage) else { throw ResourceFailure.invalid("build-info") }
    }

    public func data(_ name: String) throws -> Data {
        guard ["index.html", "style.css", "app.js", "mermaid-runtime.js", "paper-texture.png", "kraft-texture.png"].contains(name) else { throw ResourceFailure.invalid(name) }
        return try Self.readRegular(root.appendingPathComponent(name))
    }

    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isFilename(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && name.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95].contains($0)
        }
    }

    private static func isDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func readRegular(_ url: URL) throws -> Data {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { throw ResourceFailure.invalid("local resource URL required") }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 32 * 1_048_576 else {
            throw ResourceFailure.invalid(url.lastPathComponent)
        }
        return try Data(contentsOf: url)
    }
}
