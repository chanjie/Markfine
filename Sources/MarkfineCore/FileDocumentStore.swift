import Darwin
import Foundation

public struct FileIdentity: Equatable, Sendable {
    public let device: UInt64
    public let inode: UInt64

    init(_ info: stat) {
        device = UInt64(truncatingIfNeeded: info.st_dev)
        inode = UInt64(info.st_ino)
    }
}

public struct FileDocumentMetadata: Equatable, Sendable {
    public let id: String
    public let title: String
    public let url: URL?
    public let identity: FileIdentity?
    public let saveUnconfirmed: Bool
    public let encoding: String
    public var isMarkdown: Bool { TextDocument.isMarkdown(url) }
    public var language: String { isMarkdown ? "" : TextDocument.language(url) }
}

public struct FileDocumentLoad: Sendable {
    public let document: FileDocumentMetadata
    /// nil means activate the existing editor; never reload its live content/history.
    public let markdown: String?
}

public struct FileSaveRequest: Sendable {
    public let documentID: String
    public let requestID: String
    public let revision: Int
    public let snapshot: String

    public init(documentID: String, requestID: String, revision: Int, snapshot: String) {
        self.documentID = documentID
        self.requestID = requestID
        self.revision = revision
        self.snapshot = snapshot
    }
}

/// Native-only input from a successful system save panel; not a Web bridge payload.
public struct FirstSaveTarget: Sendable {
    public let url: URL
    public let replacementConfirmed: Bool
    fileprivate let observation: FirstTargetObservation?

    public init(url: URL, replacementConfirmed: Bool) {
        self.url = url
        self.replacementConfirmed = replacementConfirmed
        observation = nil
    }
    fileprivate init(url: URL, replacementConfirmed: Bool, observation: FirstTargetObservation) {
        self.url = url; self.replacementConfirmed = replacementConfirmed; self.observation = observation
    }
}

fileprivate struct FirstTargetObservation: Sendable {
    let stamp: DiskStamp?
    let parent: FileIdentity
}

public enum FileStoreFailure: Error, Equatable, CustomStringConvertible {
    case unknownDocument, invalidRequest, duplicateRequest, staleRevision
    case targetRequired, replacementConfirmationRequired, targetAlreadyOpen, saveAsNotSupported
    case invalidURL, notRegularFile, invalidUTF8, notText, tooLarge, externalChange, commitUnconfirmed
    case posix(operation: String, code: Int32)

    public var description: String {
        switch self {
        case .unknownDocument: return "文档会话已失效"
        case .invalidRequest: return "保存请求无效"
        case .duplicateRequest: return "拒绝重复保存请求"
        case .staleRevision: return "拒绝旧版本保存请求"
        case .targetRequired: return "首次保存需要用户选择目标"
        case .replacementConfirmationRequired: return "替换已有文件需要系统确认"
        case .targetAlreadyOpen: return "目标已在另一文档中打开，不能覆盖"
        case .saveAsNotSupported: return "当前版本不提供另存为"
        case .invalidURL: return "无效文件位置"
        case .notRegularFile: return "只能打开或保存普通文件"
        case .invalidUTF8: return "无法无损识别文档的 Unicode 编码，原始字节未改变"
        case .notText: return "文件不是可识别的纯文本，未读取为可编辑文档"
        case .tooLarge: return "文件超过 16 MiB 的文本编辑上限，未截断或修改内容"
        case .externalChange: return "原文件已被外部更改、删除或移走；已停止保存并保留编辑"
        case .commitUnconfirmed: return "保存可能已提交但结果未确认；保留编辑，不自动重试或关闭"
        case .posix(let operation, let code): return "文件操作失败（\(operation)，\(code)）"
        }
    }
}

/// I/O lives on this actor, not the AppKit main actor. It retains disk baselines, not live editor text.
/// Callers must validate bridge session/capability and serialize each document's UI/save requests.
public actor FileDocumentStore {
    private struct Record {
        let id: String
        var url: URL?
        var baseline: DiskStamp?
        var latestRevision = 0
        var unconfirmed = false
        var encoding = TextFileEncoding.utf8

        var metadata: FileDocumentMetadata {
            FileDocumentMetadata(id: id, title: url?.lastPathComponent ?? "未命名", url: url,
                                 identity: baseline?.file, saveUnconfirmed: unconfirmed, encoding: encoding.name)
        }
    }
    private var records: [String: Record] = [:]
    private var seenRequests: Set<String> = []
    public init() {}

    public func create() -> FileDocumentLoad {
        let record = Record(id: UUID().uuidString)
        records[record.id] = record
        return FileDocumentLoad(document: record.metadata, markdown: "")
    }

    public func metadata(_ id: String) throws -> FileDocumentMetadata {
        guard let record = records[id] else { throw FileStoreFailure.unknownDocument }
        return record.metadata
    }

    public func validateFirstTarget(_ id: String, target: FirstSaveTarget) throws -> URL {
        try prepareFirstTarget(id, target: target).url
    }

    public func prepareFirstTarget(_ id: String, target: FirstSaveTarget) throws -> FirstSaveTarget {
        guard let record = records[id], record.url == nil else { throw FileStoreFailure.saveAsNotSupported }
        let url = try Self.canonical(target.url)
        guard !records.values.contains(where: { $0.id != id && $0.url == url }) else { throw FileStoreFailure.targetAlreadyOpen }
        try Self.preflightRegular(url, allowMissing: true)
        let directory = try PinnedDirectory(url.deletingLastPathComponent())
        let file = try ReadFile(directory: directory, name: url.lastPathComponent, allowMissing: true)
        if let file {
            guard target.replacementConfirmed else { throw FileStoreFailure.replacementConfirmationRequired }
            guard !records.values.contains(where: { $0.id != id && $0.baseline?.file == file.stamp.file }) else { throw FileStoreFailure.targetAlreadyOpen }
        }
        return FirstSaveTarget(url: url, replacementConfirmed: target.replacementConfirmed,
                               observation: FirstTargetObservation(stamp: file?.stamp, parent: directory.identity))
    }

    public func open(_ selectedURL: URL, expectedIdentity: FileIdentity? = nil) throws -> FileDocumentLoad {
        let url = try Self.canonical(selectedURL)
        // An externally replaced/missing path still belongs to its open editor. Never reload it.
        if let existing = records.values.first(where: { $0.url == url }) {
            return FileDocumentLoad(document: existing.metadata, markdown: nil)
        }
        // NSFileCoordinator itself performs a blocking open before its accessor. Reject special
        // files BEFORE coordination; O_NONBLOCK only inside the accessor is too late for FIFOs.
        try Self.preflightRegular(url, allowMissing: false)
        let loaded: (DiskStamp, String, TextFileEncoding) = try Self.coordinatedRead(url) { coordinated in
            guard coordinated == url else { throw FileStoreFailure.externalChange }
            let directory = try PinnedDirectory(url.deletingLastPathComponent())
            guard let file = try ReadFile(directory: directory, name: url.lastPathComponent, allowMissing: false, expectedIdentity: expectedIdentity) else {
                throw FileStoreFailure.externalChange
            }
            let (markdown, encoding) = try TextFileEncoding.decode(file.data)
            try directory.verifyLocation()
            return (file.stamp, markdown, encoding)
        }
        if let existing = records.values.first(where: { $0.baseline?.file == loaded.0.file }) {
            return FileDocumentLoad(document: existing.metadata, markdown: nil)
        }
        let record = Record(id: UUID().uuidString, url: url, baseline: loaded.0, encoding: loaded.2)
        records[record.id] = record
        return FileDocumentLoad(document: record.metadata, markdown: loaded.1)
    }

    public func save(_ request: FileSaveRequest, firstTarget: FirstSaveTarget? = nil) throws -> FileDocumentMetadata {
        guard var record = records[request.documentID] else { throw FileStoreFailure.unknownDocument }
        guard UUID(uuidString: request.requestID) != nil, request.revision >= 0, request.revision <= 9_007_199_254_740_991 else {
            throw FileStoreFailure.invalidRequest
        }
        guard !record.unconfirmed else { throw FileStoreFailure.commitUnconfirmed }
        guard !seenRequests.contains(request.requestID) else { throw FileStoreFailure.duplicateRequest }
        guard request.revision >= record.latestRevision else { throw FileStoreFailure.staleRevision }
        seenRequests.insert(request.requestID)
        record.latestRevision = request.revision
        records[record.id] = record
        let url: URL
        if let existing = record.url {
            guard firstTarget == nil else { throw FileStoreFailure.saveAsNotSupported }
            url = existing
        } else {
            guard let firstTarget else { throw FileStoreFailure.targetRequired }
            url = try Self.canonical(firstTarget.url)
        }
        guard !records.values.contains(where: { $0.id != record.id && $0.url == url }) else {
            throw FileStoreFailure.targetAlreadyOpen
        }
        do {
            try Self.preflightRegular(url, allowMissing: record.url == nil)
            let stamp: DiskStamp = try Self.coordinatedWrite(url) { coordinated in
                guard coordinated == url else { throw FileStoreFailure.externalChange }
                let directory = try PinnedDirectory(url.deletingLastPathComponent())
                let original: ReadFile?
                do { original = try ReadFile(directory: directory, name: url.lastPathComponent, allowMissing: true) }
                catch {
                    if record.url != nil { throw FileStoreFailure.externalChange }
                    throw error
                }
                if record.url != nil {
                    guard let original, original.stamp == record.baseline else { throw FileStoreFailure.externalChange }
                } else {
                    if let observation = firstTarget?.observation {
                        guard observation.parent == directory.identity, original?.stamp == observation.stamp else { throw FileStoreFailure.externalChange }
                    }
                    if original != nil && firstTarget?.replacementConfirmed != true { throw FileStoreFailure.replacementConfirmationRequired }
                }
                if let original, self.records.values.contains(where: { $0.id != record.id && $0.baseline?.file == original.stamp.file }) {
                    throw FileStoreFailure.targetAlreadyOpen
                }
                return try self.write(record.encoding.encode(request.snapshot), to: url, directory: directory, original: original)
            }
            record.url = url
            record.baseline = stamp
            records[record.id] = record
            return record.metadata
        } catch FileStoreFailure.commitUnconfirmed {
            // A post-rename failure is never mislabeled as "nothing was written".
            record.url = url
            record.unconfirmed = true
            records[record.id] = record
            throw FileStoreFailure.commitUnconfirmed
        } catch FileStoreFailure.posix(_, let code) where record.url != nil && [ENOENT, ELOOP, ENOTDIR].contains(code) {
            throw FileStoreFailure.externalChange
        } catch FileStoreFailure.notRegularFile where record.url != nil {
            throw FileStoreFailure.externalChange
        } catch let error as NSError where record.url != nil && error.domain == NSCocoaErrorDomain &&
            [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
            throw FileStoreFailure.externalChange
        }
    }

    public func closeDocument(_ id: String) throws {
        guard let record = records[id] else { throw FileStoreFailure.unknownDocument }
        guard !record.unconfirmed else { throw FileStoreFailure.commitUnconfirmed }
        // The host must first finish the Web dirty/close handshake; there is no implicit disk save here.
        records.removeValue(forKey: id)
    }

    public func closeDocuments(_ ids: [String]) throws {
        for id in ids {
            guard let record = records[id] else { throw FileStoreFailure.unknownDocument }
            guard !record.unconfirmed else { throw FileStoreFailure.commitUnconfirmed }
        }
        for id in ids { records.removeValue(forKey: id) }
    }

    private func write(_ data: Data, to url: URL, directory: PinnedDirectory, original: ReadFile?) throws -> DiskStamp {
        if original != nil, faccessat(directory.fd.value, url.lastPathComponent, W_OK, 0) != 0 {
            throw FileStoreFailure.posix(operation: "writable", code: errno)
        }
        let name = ".markfine-save-" + UUID().uuidString
        let raw = openat(directory.fd.value, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard raw >= 0 else { throw Self.io("create temporary") }
        let temporary = OwnedFD(raw)
        var exists = true
        defer { if exists { _ = unlinkat(directory.fd.value, name, 0) } }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(temporary.value, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Self.io("write") }
                offset += count
            }
        }
        if let original {
            guard fcopyfile(original.fd.value, temporary.value, nil, copyfile_flags_t(COPYFILE_METADATA)) == 0 else {
                throw Self.io("copy metadata")
            }
            guard futimes(temporary.value, nil) == 0 else { throw Self.io("update timestamps") }
        }
        guard fsync(temporary.value) == 0 else { throw Self.io("sync temporary") }
        let current = try ReadFile(directory: directory, name: url.lastPathComponent, allowMissing: true)
        guard current?.stamp == original?.stamp else { throw FileStoreFailure.externalChange }
        try directory.verifyLocation()
        let result: Int32
        if original == nil {
            result = renameatx_np(directory.fd.value, name, directory.fd.value, url.lastPathComponent, UInt32(RENAME_EXCL))
        } else {
            // NSFileCoordinator + final baseline check; not CAS against non-cooperating external writers.
            result = renameat(directory.fd.value, name, directory.fd.value, url.lastPathComponent)
        }
        guard result == 0 else {
            if errno == EEXIST || errno == ENOENT { throw FileStoreFailure.externalChange }
            throw Self.io("atomic commit")
        }
        exists = false
        do {
            guard fsync(directory.fd.value) == 0 else { throw Self.io("sync directory") }
            var info = stat()
            guard fstat(temporary.value, &info) == 0 else { throw Self.io("stat committed") }
            return DiskStamp(info: info, parent: directory.identity, data: data)
        } catch { throw FileStoreFailure.commitUnconfirmed }
    }

    private static func canonical(_ selected: URL) throws -> URL {
        guard selected.isFileURL, selected.host == nil || selected.host == "" || selected.host == "localhost",
              selected.user == nil, selected.password == nil, selected.query == nil, selected.fragment == nil, !selected.path.contains("\0"),
              !selected.lastPathComponent.isEmpty else { throw FileStoreFailure.invalidURL }
        var url = selected.standardizedFileURL.resolvingSymlinksInPath()
        if (try? url.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile) == true {
            url = try URL(resolvingAliasFileAt: url, options: [.withoutUI, .withoutMounting]).standardizedFileURL.resolvingSymlinksInPath()
        }
        return url
    }

    private static func preflightRegular(_ url: URL, allowMissing: Bool) throws {
        var info = stat()
        if lstat(url.path, &info) != 0 {
            if errno == ENOENT && allowMissing { return }
            throw io("preflight")
        }
        guard info.st_mode & S_IFMT == S_IFREG else { throw FileStoreFailure.notRegularFile }
        // Rechecked with descriptor-relative O_NOFOLLOW/O_NONBLOCK inside the coordinated accessor.
    }

    private static func coordinatedRead<T>(_ url: URL, _ operation: (URL) throws -> T) throws -> T {
        var error: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &error) { coordinated in
            result = Result { try operation(coordinated) }
        }
        if let result { return try result.get() }
        throw error ?? NSError(domain: NSCocoaErrorDomain, code: NSFileReadUnknownError)
    }

    private static func coordinatedWrite<T>(_ url: URL, _ operation: (URL) throws -> T) throws -> T {
        var error: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forReplacing, error: &error) { coordinated in
            result = Result { try operation(coordinated) }
        }
        if let result { return try result.get() }
        throw error ?? NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError)
    }

    fileprivate static func io(_ operation: String) -> FileStoreFailure { .posix(operation: operation, code: errno) }
}

private final class OwnedFD {
    let value: Int32
    init(_ value: Int32) { self.value = value }
    deinit { Darwin.close(value) }
}

fileprivate struct DiskStamp: Equatable, Sendable {
    let file: FileIdentity
    let parent: FileIdentity
    let size: Int64
    let modifiedSeconds: Int64
    let modifiedNanos: Int64
    let changedSeconds: Int64
    let changedNanos: Int64
    let mode: UInt16
    let digest: String

    init(info: stat, parent: FileIdentity, data: Data) {
        file = FileIdentity(info)
        self.parent = parent
        size = Int64(info.st_size)
        modifiedSeconds = Int64(info.st_mtimespec.tv_sec)
        modifiedNanos = Int64(info.st_mtimespec.tv_nsec)
        changedSeconds = Int64(info.st_ctimespec.tv_sec)
        changedNanos = Int64(info.st_ctimespec.tv_nsec)
        mode = UInt16(info.st_mode)
        digest = EditorResources.sha256(data)
    }
}

private struct PinnedDirectory {
    let url: URL
    let fd: OwnedFD
    let identity: FileIdentity

    init(_ url: URL) throws {
        self.url = url
        let raw = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard raw >= 0 else { throw FileDocumentStore.io("open directory") }
        fd = OwnedFD(raw)
        var info = stat()
        guard fstat(raw, &info) == 0 else { throw FileDocumentStore.io("stat directory") }
        identity = FileIdentity(info)
    }

    func verifyLocation() throws {
        let current = try PinnedDirectory(url)
        guard current.identity == identity else { throw FileStoreFailure.externalChange }
    }
}

private struct ReadFile {
    let fd: OwnedFD
    let data: Data
    let stamp: DiskStamp

    init?(directory: PinnedDirectory, name: String, allowMissing: Bool, expectedIdentity: FileIdentity? = nil) throws {
        let raw = openat(directory.fd.value, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if raw < 0 && errno == ENOENT && allowMissing { return nil }
        guard raw >= 0 else { throw FileDocumentStore.io("open file") }
        fd = OwnedFD(raw)
        var before = stat()
        guard fstat(raw, &before) == 0 else { throw FileDocumentStore.io("stat file") }
        guard before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0 else { throw FileStoreFailure.notRegularFile }
        if let expectedIdentity, FileIdentity(before) != expectedIdentity { throw FileStoreFailure.externalChange }
        guard before.st_size <= TextDocument.maximumBytes else { throw FileStoreFailure.tooLarge }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 65_536)
        while true {
            // Stop at the original size + one byte; an external append loop must not grow this read forever.
            let remaining = min(65_536, Int(before.st_size) - data.count + 1)
            let count = bytes.withUnsafeMutableBytes { Darwin.read(raw, $0.baseAddress!, remaining) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw FileDocumentStore.io("read") }
            if count == 0 { break }
            data.append(contentsOf: bytes.prefix(count))
            guard data.count <= before.st_size else { throw FileStoreFailure.externalChange }
        }
        var after = stat()
        guard fstat(raw, &after) == 0 else { throw FileDocumentStore.io("stat after read") }
        let initial = DiskStamp(info: before, parent: directory.identity, data: data)
        let final = DiskStamp(info: after, parent: directory.identity, data: data)
        guard initial == final, Int64(data.count) == after.st_size else { throw FileStoreFailure.externalChange }
        self.data = data
        stamp = final
    }
}
