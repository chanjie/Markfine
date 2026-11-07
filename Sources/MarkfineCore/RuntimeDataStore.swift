import Darwin
import Foundation

/// This namespace must never contain documents, staging images or exported documents.
/// Descriptor-relative traversal refuses symlinks and never enumerates Application Support / Staging.
public final class RuntimeDataStore {
    public enum Category: String, CaseIterable { case logs = "Logs", temporary = "Temporary", cache = "Cache" }
    private let root: Int32
    private let managementLock: Int32
    private var sessionLock: Int32 = -1
    public let url: URL
    public init(url: URL) throws {
        self.url = url
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        root = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw CocoaError(.fileReadNoPermission) }
        managementLock = openat(root, ".management.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard managementLock >= 0 else { close(root); throw CocoaError(.fileWriteNoPermission) }
        for category in Category.allCases { if mkdirat(root, category.rawValue, 0o700) != 0 && errno != EEXIST { throw CocoaError(.fileWriteUnknown) } }
    }
    deinit { if sessionLock >= 0 { close(sessionLock) }; close(managementLock); close(root) }
    public func startSession() throws -> URL {
        guard sessionLock < 0, flock(managementLock, LOCK_EX) == 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { flock(managementLock, LOCK_UN) }
        let temporary = openat(root, Category.temporary.rawValue, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard temporary >= 0 else { throw CocoaError(.fileWriteNoPermission) }; defer { close(temporary) }
        let name = UUID().uuidString
        guard mkdirat(temporary, name, 0o700) == 0 else { throw CocoaError(.fileWriteUnknown) }
        let directory = openat(temporary, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw CocoaError(.fileWriteNoPermission) }; defer { close(directory) }
        let lock = openat(directory, "session.lock", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw CocoaError(.fileWriteUnknown) }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { close(lock); throw CocoaError(.fileWriteUnknown) }
        sessionLock = lock
        return url.appendingPathComponent(Category.temporary.rawValue).appendingPathComponent(name)
    }
    public func bytes(_ category: Category) -> Int64 { walk(root, name: category.rawValue, remove: false, protected: [], sessionChildren: category == .temporary) }
    /// Open per write, under the cleanup lock: clearing Logs works even while the app is running.
    /// Five bounded files, no symlink following, no user-controlled file names.
    @discardableResult public func record(_ event: DiagnosticEvent, version: String, session: String, limit: Int = 2 * 1024 * 1024) -> Bool {
        guard let data = event.data(version: version, session: session), data.count <= 4096,
              flock(managementLock, LOCK_EX) == 0 else { return false }
        defer { flock(managementLock, LOCK_UN) }
        let directory = openat(root, "Logs", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { return false }; defer { close(directory) }
        var info = stat()
        if fstatat(directory, "errors.jsonl", &info, AT_SYMLINK_NOFOLLOW) == 0 {
            guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1 else { return false }
            if info.st_size + Int64(data.count) > max(4096, limit) {
                _ = unlinkat(directory, "errors.4.jsonl", 0)
                for index in stride(from: 3, through: 1, by: -1) { _ = renameat(directory, "errors.\(index).jsonl", directory, "errors.\(index + 1).jsonl") }
                guard renameat(directory, "errors.jsonl", directory, "errors.1.jsonl") == 0 else { return false }
            }
        }
        let fd = openat(directory, "errors.jsonl", O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard fd >= 0 else { return false }; defer { close(fd) }
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1 else { return false }
        return data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < data.count {
                let count = write(fd, buffer.baseAddress!.advanced(by: offset), data.count - offset)
                if count < 0 && errno == EINTR { continue }; if count <= 0 { return false }; offset += count
            }
            return true
        }
    }
    @discardableResult public func clear(_ category: Category, protecting names: Set<String> = []) -> Int64 {
        guard flock(managementLock, LOCK_EX) == 0 else { return 0 }; defer { flock(managementLock, LOCK_UN) }
        return walk(root, name: category.rawValue, remove: true, protected: names, sessionChildren: category == .temporary)
    }
    private func walk(_ parent: Int32, name: String, remove: Bool, protected: Set<String>, sessionChildren: Bool = false, requireSession: Bool = false, removeDirectory: Bool = false) -> Int64 {
        if protected.contains(name) { return 0 }
        var info = stat()
        guard fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_uid == getuid() else { return 0 }
        if info.st_mode & S_IFMT == S_IFREG {
            if remove, unlinkat(parent, name, 0) != 0 { return 0 }; return Int64(info.st_size)
        }
        guard info.st_mode & S_IFMT == S_IFDIR else { return 0 }
        let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return 0 }; defer { close(fd) }
        var opened = stat(); guard fstat(fd, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else { return 0 }
        let lock = remove && requireSession ? openat(fd, "session.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC) : -1
        defer { if lock >= 0 { close(lock) } }
        if remove && requireSession { guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { return 0 } }
        // A fresh open description is essential: dup() would share directory enumeration offsets.
        let cursor = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard cursor >= 0, let directory = fdopendir(cursor) else { if cursor >= 0 { close(cursor) }; return 0 }
        defer { closedir(directory) }
        var bytes: Int64 = 0
        while let entry = readdir(directory) {
            let child = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
            if child == "." || child == ".." { continue }
            bytes += walk(fd, name: child, remove: remove, protected: protected, requireSession: sessionChildren, removeDirectory: true)
        }
        if remove && removeDirectory { _ = unlinkat(parent, name, AT_REMOVEDIR) }
        return bytes
    }
}
