import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct ClipboardInput: Sendable {
    public let png: Data?
    public let jpeg: Data?
    public let tiff: Data?
    public let text: String?
    public let fileURL: URL?
    public init(png: Data? = nil, jpeg: Data? = nil, tiff: Data? = nil, text: String? = nil, fileURL: URL? = nil) {
        self.png = png; self.jpeg = jpeg; self.tiff = tiff; self.text = text; self.fileURL = fileURL
    }
}
public struct ImagePasteResult: Sendable {
    public let reference: String?
    public let text: String?
    public init(reference: String?, text: String?) { self.reference = reference; self.text = text }
}
public struct LocalImage: Sendable { public let data: Data; public let mime: String }
public enum ImageStoreFailure: Error, CustomStringConvertible {
    case denied, unsupported, invalidImage, assetsUnavailable, unavailable, temporaryLimit
    public var description: String {
        switch self {
        case .denied: return "图片路径超出当前文档权限或存在不安全路径"
        case .unsupported: return "剪贴板没有可用的 PNG、JPEG、TIFF 图片或纯文本"
        case .invalidImage: return "图片数据无效或过大，未改变正文"
        case .assetsUnavailable: return "资源目录被占用或不可写；正文未改变，图片暂存已保留"
        case .unavailable: return "无法读取或写入本地图片，正文与暂存均保留"
        case .temporaryLimit: return "图片暂存已达上限，请关闭暂不使用的文档后重试"
        }
    }
}

/// The lock is held for the whole session, including while the editor is idle.
private final class ImageFD: @unchecked Sendable {
    let value: Int32
    init(_ value: Int32) { self.value = value }
    deinit { Darwin.close(value) }
}

public actor ImageStore {
    private struct Document {
        var url: URL?
        var staged: Set<String> = []
        var destination: URL?
        var migrated: [String: String] = [:]
        var bytes = 0
    }
    private let root: URL
    private let session: URL
    private let sessionID: String
    private let lock: ImageFD
    private var documents: [String: Document] = [:]
    private var stagedBytes = 0
    private func checkSpace(_ count: Int, documentID: String) throws {
        guard count <= 512 * 1_048_576 - stagedBytes, count <= 256 * 1_048_576 - (documents[documentID]?.bytes ?? 0) else { throw ImageStoreFailure.temporaryLimit }
    }

    public init(root: URL, sessionID: String = UUID().uuidString) throws {
        guard UUID(uuidString: sessionID) != nil else { throw ImageStoreFailure.denied }
        self.root = root.standardizedFileURL
        self.sessionID = sessionID
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(root.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw ImageStoreFailure.denied }
        session = root.appendingPathComponent(sessionID, isDirectory: true)
        guard mkdir(session.path, 0o700) == 0 else { throw ImageStoreFailure.unavailable }
        let raw = Darwin.open(session.appendingPathComponent("session.lock").path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard raw >= 0 else { throw ImageStoreFailure.unavailable }
        lock = ImageFD(raw)
        guard flock(raw, LOCK_EX | LOCK_NB) == 0 else { throw ImageStoreFailure.unavailable }
        let marker: [String: Any] = ["format": 1, "sessionID": sessionID]
        try JSONSerialization.data(withJSONObject: marker).write(to: session.appendingPathComponent("owner.json"), options: .withoutOverwriting)
    }

    public func register(_ id: String, url: URL?) throws {
        guard UUID(uuidString: id) != nil else { throw ImageStoreFailure.denied }
        if documents[id] == nil {
            let folder = session.appendingPathComponent(id, isDirectory: true)
            guard mkdir(folder.path, 0o700) == 0 else { throw ImageStoreFailure.unavailable }
            documents[id] = Document(url: url)
        } else { documents[id]?.url = url }
    }

    public func setURL(_ id: String, url: URL) throws {
        guard documents[id] != nil else { throw ImageStoreFailure.denied }
        documents[id]?.url = url
    }

    /// Materialize one explicitly copied local file off the UI actor, before
    /// staging or uploading. Retries then use the same immutable bytes.
    public func prepareClipboardInput(_ input: ClipboardInput) throws -> ClipboardInput {
        guard let url = input.fileURL else { return input }
        try Task.checkCancellation()
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
              url.query == nil, url.fragment == nil else { throw ImageStoreFailure.denied }
        let raw = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard raw >= 0 else { throw ImageStoreFailure.unavailable }
        let file = ImageFD(raw)
        var info = stat()
        guard fstat(file.value, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0, info.st_size <= 64 * 1_048_576 else { throw ImageStoreFailure.invalidImage }
        var data = Data(count: Int(info.st_size))
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                try Task.checkCancellation()
                let count = Darwin.read(file.value, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw ImageStoreFailure.unavailable }
                offset += count
            }
        }
        var after = stat()
        guard fstat(file.value, &after) == 0, after.st_dev == info.st_dev, after.st_ino == info.st_ino,
              after.st_size == info.st_size, after.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec,
              after.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec else { throw ImageStoreFailure.unavailable }
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String? else {
            if let text = input.text, !text.isEmpty { return ClipboardInput(text: text) }
            throw ImageStoreFailure.unsupported
        }
        switch type {
        case UTType.png.identifier: return ClipboardInput(png: data)
        case UTType.jpeg.identifier: return ClipboardInput(jpeg: data)
        case UTType.tiff.identifier: return ClipboardInput(tiff: data)
        default:
            if let text = input.text, !text.isEmpty { return ClipboardInput(text: text) }
            throw ImageStoreFailure.unsupported
        }
    }

    public func paste(_ input: ClipboardInput, documentID: String) throws -> ImagePasteResult {
        let result = try stage(input, documentID: documentID)
        guard let reference = result.reference else { return result }
        if let url = documents[documentID]?.url {
            return ImagePasteResult(reference: try copyAsset(String(reference.dropFirst("markfine-staging/".count)), documentID: documentID, target: url), text: nil)
        }
        return result
    }

    public func stage(_ input: ClipboardInput, documentID: String) throws -> ImagePasteResult {
        guard documents[documentID] != nil else { throw ImageStoreFailure.denied }
        try Task.checkCancellation()
        let input = try prepareClipboardInput(input)
        guard let image = try Self.encode(input) else {
            guard let text = input.text, !text.isEmpty else { throw ImageStoreFailure.unsupported }
            return ImagePasteResult(reference: nil, text: text)
        }
        let name = "image-" + UUID().uuidString.lowercased() + "." + image.extensionName
        try checkSpace(image.data.count, documentID: documentID)
        let folder = session.appendingPathComponent(documentID, isDirectory: true)
        try Self.exclusiveWrite(image.data, directory: folder, name: name)
        documents[documentID]?.staged.insert(name)
        documents[documentID]?.bytes += image.data.count; stagedBytes += image.data.count
        try Task.checkCancellation()
        return ImagePasteResult(reference: "markfine-staging/" + name, text: nil)
    }

    public func contains(_ id: String) -> Bool { documents[id] != nil }
    public func importImage(_ data: Data, documentID: String, local: Bool = true) throws -> String {
        guard documents[documentID] != nil else { throw ImageStoreFailure.denied }
        try Task.checkCancellation(); let image = try Self.validatedImage(data)
        let ext = ["image/png":"png", "image/jpeg":"jpg", "image/gif":"gif", "image/webp":"webp", "image/tiff":"tiff", "image/heic":"heic"][image.mime]!
        let name = "image-" + UUID().uuidString.lowercased() + "." + ext
        try checkSpace(data.count, documentID: documentID)
        try Self.exclusiveWrite(data, directory: session.appendingPathComponent(documentID, isDirectory: true), name: name)
        documents[documentID]?.staged.insert(name)
        documents[documentID]?.bytes += data.count; stagedBytes += data.count
        if local, let url = documents[documentID]?.url { return try copyAsset(name, documentID: documentID, target: url) }
        return "markfine-staging/" + name
    }
    public static func validatedImage(_ data: Data) throws -> LocalImage {
        guard !data.isEmpty, data.count <= 64 * 1_048_576,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?, let p = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = p[kCGImagePropertyPixelWidth] as? Int, let height = p[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 32_768, height <= 32_768, width * height <= 100_000_000 else { throw ImageStoreFailure.invalidImage }
        let types = [UTType.png.identifier: "image/png", UTType.jpeg.identifier: "image/jpeg", UTType.gif.identifier: "image/gif", UTType.webP.identifier: "image/webp", UTType.tiff.identifier: "image/tiff", UTType.heic.identifier: "image/heic"]
        guard let mime = types[type] else { throw ImageStoreFailure.invalidImage }; return LocalImage(data: data, mime: mime)
    }

    public func migrate(_ id: String, to target: URL, references: [String]? = nil) throws -> [String: String] {
        guard let document = documents[id] else { throw ImageStoreFailure.denied }
        var mapping: [String: String] = [:]
        let required = references.map { Set($0.compactMap { $0.hasPrefix("markfine-staging/") ? String($0.dropFirst("markfine-staging/".count)) : nil }) } ?? document.staged
        for name in document.staged.intersection(required).sorted() {
            try Task.checkCancellation()
            mapping["markfine-staging/" + name] = try copyAsset(name, documentID: id, target: target)
        }
        return mapping
    }

    private func copyAsset(_ name: String, documentID: String, target: URL) throws -> String {
        guard var document = documents[documentID], document.staged.contains(name) else { throw ImageStoreFailure.denied }
        let directory = target.deletingPathExtension().appendingPathExtension("assets")
        if document.destination == directory, let existing = document.migrated[name],
           FileManager.default.fileExists(atPath: target.deletingLastPathComponent().appendingPathComponent(existing.removingPercentEncoding ?? existing).path) {
            return existing
        }
        if document.destination != directory { document.destination = directory; document.migrated = [:] }
        let parent = try Self.openDirectory(target.deletingLastPathComponent())
        if mkdirat(parent.value, directory.lastPathComponent, 0o700) != 0 && errno != EEXIST { throw ImageStoreFailure.assetsUnavailable }
        let raw = openat(parent.value, directory.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard raw >= 0 else { throw ImageStoreFailure.assetsUnavailable }
        let assets = ImageFD(raw)
        let image = try Self.readData(root: session.appendingPathComponent(documentID, isDirectory: true), relative: name)
        var filename = name
        var success = false
        for _ in 0..<8 {
            do { try Self.writeAt(image, directory: assets.value, name: filename); success = true; break }
            catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(EEXIST) {
                filename = "image-" + UUID().uuidString.lowercased() + "." + (name as NSString).pathExtension
            }
        }
        guard success else { throw ImageStoreFailure.assetsUnavailable }
        let relative = [directory.lastPathComponent, filename].map(Self.escapeComponent).joined(separator: "/")
        document.migrated[name] = relative
        documents[documentID] = document
        return relative
    }

    public func read(documentID: String, relativePath: String) throws -> LocalImage {
        guard let document = documents[documentID] else { throw ImageStoreFailure.denied }
        let path = try Self.checkedPath(relativePath)
        let data: Data
        if path.hasPrefix("markfine-staging/"), document.staged.contains(String(path.dropFirst("markfine-staging/".count))) {
            data = try Self.readData(root: session.appendingPathComponent(documentID, isDirectory: true), relative: String(path.dropFirst("markfine-staging/".count)))
        } else {
            guard let url = document.url else { throw ImageStoreFailure.denied }
            let root = url.deletingLastPathComponent().resolvingSymlinksInPath()
            let resolved = root.appendingPathComponent(path).resolvingSymlinksInPath()
            let rootParts = root.pathComponents, parts = resolved.pathComponents
            guard parts.count > rootParts.count, Array(parts.prefix(rootParts.count)) == rootParts else { throw ImageStoreFailure.denied }
            data = try Self.readData(root: root, relative: parts.dropFirst(rootParts.count).joined(separator: "/"))
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String? else { throw ImageStoreFailure.invalidImage }
        let allowed: [String: String] = [UTType.png.identifier: "image/png", UTType.jpeg.identifier: "image/jpeg", UTType.tiff.identifier: "image/tiff",
                                         UTType.gif.identifier: "image/gif", UTType.webP.identifier: "image/webp", UTType.heic.identifier: "image/heic"]
        guard let mime = allowed[type] else { throw ImageStoreFailure.denied }
        return LocalImage(data: data, mime: mime)
    }

    public func closeDocument(_ id: String) {
        guard let document = documents.removeValue(forKey: id) else { return }
        // Only the exact private UUID directory owned by this live session, never .assets.
        do { try Self.removeDocument(session: session, id: id); stagedBytes = max(0, stagedBytes - document.bytes) } catch { /* Keep failed cleanup charged to this session's quota. */ }
    }

    public func finish() {
        for id in Array(documents.keys) { closeDocument(id) }
        try? Self.removeSession(session, expectedID: sessionID, ownLock: lock.value)
    }

    public func cleanStaleSessions() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
        for name in names where name != sessionID && UUID(uuidString: name) != nil {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            guard let directory = try? Self.openDirectory(folder) else { continue }
            let raw = openat(directory.value, "session.lock", O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard raw >= 0 else { continue }
            let candidate = ImageFD(raw)
            guard flock(candidate.value, LOCK_EX | LOCK_NB) == 0 else { continue } // Live or unconfirmable sessions are preserved.
            try? Self.removeSession(folder, expectedID: name, ownLock: candidate.value)
        }
    }

    public static func encode(_ input: ClipboardInput) throws -> (data: Data, extensionName: String)? {
        for (data, expected, ext) in [(input.png, UTType.png.identifier, "png"), (input.jpeg, UTType.jpeg.identifier, "jpg"), (input.tiff, UTType.tiff.identifier, "png")] {
            guard let data, !data.isEmpty, data.count <= 64 * 1_048_576,
                  let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  CGImageSourceGetType(source) as String? == expected,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 32_768, height <= 32_768, width * height <= 100_000_000,
                  let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { continue }
            if expected != UTType.tiff.identifier { return (data, ext) }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { continue }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { continue }
            return (output as Data, "png")
        }
        return nil
    }

    private static func checkedPath(_ value: String) throws -> String {
        guard !value.isEmpty, value.utf8.count < 8_192, !value.contains("%"), !value.contains(":"), !value.contains("\\"),
              !value.contains("\0"), !value.contains("?"), !value.contains("#"),
              value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw ImageStoreFailure.denied }
        return value
    }
    private static func escapeComponent(_ text: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return text.unicodeScalars.map { scalar in
            if scalar.value >= 128 && !CharacterSet.whitespacesAndNewlines.contains(scalar) && !CharacterSet.controlCharacters.contains(scalar) {
                return String(scalar)
            }
            return String(scalar).addingPercentEncoding(withAllowedCharacters: allowed)!
        }.joined()
    }
    private static func openDirectory(_ url: URL) throws -> ImageFD {
        let real = url.standardizedFileURL // Resource callers resolve allowed links first; managed staging never follows links.
        var directory = ImageFD(Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
        guard directory.value >= 0 else { throw ImageStoreFailure.unavailable }
        var components = Array(real.pathComponents.dropFirst())
        // Foundation shortens /private/var to /var after resolving a file URL. Expand
        // only macOS's root-owned fixed aliases, never arbitrary document/staging links.
        if let first = components.first, ["var", "tmp", "etc"].contains(first) {
            var info = stat(), bytes = [CChar](repeating: 0, count: 256)
            if fstatat(directory.value, first, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFLNK, info.st_uid == 0 {
                let count = readlinkat(directory.value, first, &bytes, bytes.count - 1)
                guard count > 0, count < bytes.count else { throw ImageStoreFailure.denied }
                let target = String(cString: bytes)
                guard target == "private/" + first || target == "/private/" + first else { throw ImageStoreFailure.denied }
                components.insert("private", at: 0)
            }
        }
        for component in components {
            let child = openat(directory.value, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard child >= 0 else { throw ImageStoreFailure.denied }
            directory = ImageFD(child)
        }
        return directory
    }
    private static func readData(root: URL, relative: String) throws -> Data {
        let parts = try checkedPath(relative).split(separator: "/").map(String.init)
        var directory = try openDirectory(root)
        for component in parts.dropLast() {
            let next = openat(directory.value, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw ImageStoreFailure.denied }
            directory = ImageFD(next)
        }
        let raw = openat(directory.value, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard raw >= 0 else { throw ImageStoreFailure.unavailable }
        let file = ImageFD(raw)
        var info = stat()
        guard fstat(file.value, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= 64 * 1_048_576 else { throw ImageStoreFailure.denied }
        var data = Data(count: Int(info.st_size))
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.read(file.value, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw ImageStoreFailure.unavailable }
                offset += count
            }
        }
        return data
    }
    private static func exclusiveWrite(_ data: Data, directory: URL, name: String) throws {
        let folder = try openDirectory(directory)
        try writeAt(data, directory: folder.value, name: name)
    }
    private static func writeAt(_ data: Data, directory: Int32, name: String) throws {
        let raw = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard raw >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let file = ImageFD(raw)
        var complete = false
        defer { if !complete { _ = unlinkat(directory, name, 0) } }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                try Task.checkCancellation()
                let count = Darwin.write(file.value, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw ImageStoreFailure.unavailable }
                offset += count
            }
        }
        guard fsync(file.value) == 0 else { throw ImageStoreFailure.unavailable }
        complete = true
    }
    private static func removeDocument(session: URL, id: String) throws {
        guard UUID(uuidString: id) != nil else { throw ImageStoreFailure.denied }
        let folder = session.appendingPathComponent(id, isDirectory: true)
        let directory = try openDirectory(folder)
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        guard names.allSatisfy({ $0.range(of: "^image-[a-fA-F0-9-]+\\.(png|jpg|gif|webp|tiff|heic)$", options: .regularExpression) != nil }) else { throw ImageStoreFailure.denied }
        for name in names { guard unlinkat(directory.value, name, 0) == 0 else { throw ImageStoreFailure.unavailable } }
        let parent = try openDirectory(session)
        guard unlinkat(parent.value, id, AT_REMOVEDIR) == 0 else { throw ImageStoreFailure.unavailable }
    }
    private static func removeSession(_ folder: URL, expectedID: String, ownLock: Int32) throws {
        guard flock(ownLock, LOCK_EX | LOCK_NB) == 0, UUID(uuidString: expectedID) != nil,
              let marker = try JSONSerialization.jsonObject(with: readData(root: folder, relative: "owner.json")) as? [String: Any],
              marker["format"] as? Int == 1, marker["sessionID"] as? String == expectedID else { throw ImageStoreFailure.denied }
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        guard names.allSatisfy({ ["session.lock", "owner.json"].contains($0) || UUID(uuidString: $0) != nil }) else { throw ImageStoreFailure.denied }
        for id in names where UUID(uuidString: id) != nil { try removeDocument(session: folder, id: id) }
        let directory = try openDirectory(folder)
        _ = unlinkat(directory.value, "owner.json", 0); _ = unlinkat(directory.value, "session.lock", 0)
        let parent = try openDirectory(folder.deletingLastPathComponent())
        guard unlinkat(parent.value, expectedID, AT_REMOVEDIR) == 0 else { throw ImageStoreFailure.unavailable }
    }
}
