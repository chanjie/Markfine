import Foundation

public final class RecentLocations {
    private let defaults: UserDefaults
    private let key = "recentLocations"
    private let entriesKey = "recentLocationEntries"
    private struct Entry { let url: URL; let folderOnly: Bool }
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private var entries: [Entry] {
        var seen = Set<String>()
        let stored = defaults.array(forKey: entriesKey) as? [[String: Any]] ?? (defaults.stringArray(forKey: key) ?? []).map { ["url": $0, "folderOnly": false] }
        return stored.compactMap { item in
            guard let value = item["url"] as? String else { return nil }
            guard let url = URL(string: value), url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
                   seen.insert(url.standardizedFileURL.path).inserted else { return nil }
            return Entry(url: url.standardizedFileURL, folderOnly: item["folderOnly"] as? Bool == true)
        }
    }
    public var urls: [URL] { visibleURLs(includeWorkspaceFiles: false) }
    public func visibleURLs(includeWorkspaceFiles: Bool) -> [URL] {
        entries.filter { includeWorkspaceFiles || !$0.folderOnly }.prefix(20).map(\.url)
    }
    public func note(_ url: URL, fromWorkspace: Bool = false) {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { return }
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        let old = entries
        // A direct open remains visible when the same document is later clicked in the tree.
        let folderOnly = fromWorkspace && old.first(where: { $0.url.path == canonical.path })?.folderOnly != false
        let values = [Entry(url: canonical, folderOnly: folderOnly)] + old.filter { $0.url.path != canonical.path }
        // Hidden tree traffic must not evict the user's last twenty direct locations.
        var direct = 0, folder = 0
        let retained = values.filter { value in
            if value.folderOnly { folder += 1; return folder <= 20 }
            direct += 1; return direct <= 20
        }
        defaults.set(retained.map { ["url": $0.url.absoluteString, "folderOnly": $0.folderOnly] }, forKey: entriesKey)
        defaults.removeObject(forKey: key)
    }
    public func clear() { defaults.removeObject(forKey: key); defaults.removeObject(forKey: entriesKey) }
    public var byteCount: Int {
        [key, entriesKey].reduce(0) { result, key in
            guard let value = defaults.object(forKey: key) else { return result }
            return result + ((try? JSONSerialization.data(withJSONObject: value).count) ?? 0)
        }
    }
}
