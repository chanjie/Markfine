import Foundation
import Darwin

public enum WorkspaceFailure: Error { case unavailable, denied, stale }
public struct WorkspaceEntry: Codable, Sendable {
    public let id: String
    public let name: String
    public let directory: Bool
    public let markdown: Bool
}
public struct WorkspaceSnapshot: Codable, Sendable {
    public let generation: String
    public let root: WorkspaceEntry
}
/// Only native user-chosen roots enter this registry. Web commands use opaque IDs, never filesystem paths.
public actor WorkspaceStore {
    private var root: URL?
    private var generation = UUID().uuidString
    private var entries: [String: URL] = [:]
    private var identifiers: [String: String] = [:]
    private var rootFD: Int32 = -1
    public init() {}
    deinit { if rootFD >= 0 { Darwin.close(rootFD) } }
    public static func isMarkdown(_ url: URL) -> Bool { ["md", "markdown"].contains(url.pathExtension.lowercased()) }
    public func open(_ url: URL) throws -> WorkspaceSnapshot {
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        guard canonical.isFileURL, try canonical.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw WorkspaceFailure.unavailable }
        let fd = Darwin.open(canonical.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw WorkspaceFailure.denied }
        if rootFD >= 0 { Darwin.close(rootFD) }; rootFD = fd
        root = canonical; generation = UUID().uuidString; entries.removeAll(); identifiers.removeAll()
        return WorkspaceSnapshot(generation: generation, root: item(canonical, directory: true))
    }
    private func item(_ url: URL, directory: Bool) -> WorkspaceEntry {
        let id = identifiers[url.path] ?? UUID().uuidString
        identifiers[url.path] = id; entries[id] = url
        return WorkspaceEntry(id: id, name: url.lastPathComponent, directory: directory, markdown: !directory && Self.isMarkdown(url))
    }
    private func checked(_ id: String, generation: String) throws -> URL {
        guard generation == self.generation, let root, let url = entries[id] else { throw WorkspaceFailure.stale }
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        guard canonical.path == root.path || canonical.path.hasPrefix(root.path == "/" ? "/" : root.path + "/") else { throw WorkspaceFailure.denied }
        return canonical
    }
    private func directoryFD(_ url: URL) throws -> Int32 {
        guard let root, rootFD >= 0 else { throw WorkspaceFailure.stale }
        var pinned = stat(), current = stat()
        guard fstat(rootFD, &pinned) == 0, lstat(root.path, &current) == 0, pinned.st_dev == current.st_dev, pinned.st_ino == current.st_ino else { throw WorkspaceFailure.stale }
        guard url.path == root.path || url.path.hasPrefix(root.path == "/" ? "/" : root.path + "/") else { throw WorkspaceFailure.denied }
        let relative = url.path == root.path ? "" : String(url.path.dropFirst(root.path == "/" ? 1 : root.path.count + 1))
        // dup/fcntl would share the directory read cursor and make a second enumeration appear empty.
        var fd = openat(rootFD, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); guard fd >= 0 else { throw WorkspaceFailure.denied }
        for component in relative.split(separator: "/") {
            let next = openat(fd, String(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            Darwin.close(fd); guard next >= 0 else { throw WorkspaceFailure.denied }; fd = next
        }
        return fd
    }
    public func children(_ id: String, generation: String, showAll: Bool) throws -> [WorkspaceEntry] {
        let url = try checked(id, generation: generation)
        let fd = try directoryFD(url)
        guard let stream = fdopendir(fd) else { Darwin.close(fd); throw WorkspaceFailure.denied }; defer { closedir(stream) }
        var result: [WorkspaceEntry] = []
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) } }
            if name == "." || name == ".." || !showAll && name.hasPrefix(".") { continue }
            var info = stat(); guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
            let child = url.appendingPathComponent(name)
            let package = ["app", "bundle", "framework", "photoslibrary"].contains(child.pathExtension.lowercased())
            let directory = info.st_mode & S_IFMT == S_IFDIR && !package
            if directory || showAll || Self.isMarkdown(child) { result.append(item(child, directory: directory)) }
        }
        return result.sorted { a, b in a.directory != b.directory ? a.directory : a.name.localizedStandardCompare(b.name) == .orderedAscending }
    }
    public func file(_ id: String, generation: String) throws -> URL {
        let url = try checked(id, generation: generation)
        let fd = try directoryFD(url.deletingLastPathComponent()); defer { Darwin.close(fd) }
        var info = stat(); guard fstatat(fd, url.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFREG else { throw WorkspaceFailure.denied }
        return url
    }
    /// Re-check after document I/O, so a root/ancestor replacement cannot swap the selected object.
    public func verifyFile(_ id: String, generation: String, identity: FileIdentity) throws {
        let url = try checked(id, generation: generation), fd = try directoryFD(url.deletingLastPathComponent()); defer { Darwin.close(fd) }
        var info = stat()
        guard fstatat(fd, url.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFREG,
              UInt64(truncatingIfNeeded: info.st_dev) == identity.device, UInt64(info.st_ino) == identity.inode else { throw WorkspaceFailure.stale }
    }
}
