import Foundation

public final class RecentLocations {
    private let defaults: UserDefaults
    private let key = "recentLocations"
    private let entriesKey = "recentLocationEntries"
    private struct Entry { let url: URL; let folderOnly: Bool }
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private var limit: Int {
        let value = defaults.object(forKey: "recentLimit") ?? 20
        return ApplicationSettings.accepts("recentLimit", value) ? (value as? NSNumber)?.intValue ?? 20 : 20
    }
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
        entries.prefix(limit).filter { includeWorkspaceFiles || !$0.folderOnly }.map(\.url)
    }
    private func store(_ values: [Entry]) {
        defaults.set(values.map { ["url": $0.url.absoluteString, "folderOnly": $0.folderOnly] }, forKey: entriesKey)
        defaults.removeObject(forKey: key)
    }
    /// Called when the preference changes and at startup, including legacy two-category data.
    public func enforceLimit() {
        let old = entries
        if old.count > limit { store(Array(old.prefix(limit))) }
    }
    public func remove(_ urls: [URL]) {
        let paths = Set(urls.filter(\.isFileURL).map { $0.standardizedFileURL.path })
        guard !paths.isEmpty else { return }
        store(entries.filter { !paths.contains($0.url.path) })
    }
    public func note(_ url: URL, fromWorkspace: Bool = false) {
        guard limit > 0, url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else { return }
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        let old = entries
        // A direct open remains visible when the same document is later clicked in the tree.
        let folderOnly = fromWorkspace && old.first(where: { $0.url.path == canonical.path })?.folderOnly != false
        let values = [Entry(url: canonical, folderOnly: folderOnly)] + old.filter { $0.url.path != canonical.path }
        store(Array(values.prefix(limit)))
    }
    public func clear() { defaults.removeObject(forKey: key); defaults.removeObject(forKey: entriesKey) }
    public var byteCount: Int {
        [key, entriesKey].reduce(0) { result, key in
            guard let value = defaults.object(forKey: key) else { return result }
            return result + ((try? JSONSerialization.data(withJSONObject: value).count) ?? 0)
        }
    }
}
