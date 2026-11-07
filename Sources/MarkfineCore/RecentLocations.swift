import Foundation

public final class RecentLocations {
    private let defaults: UserDefaults
    private let key = "recentLocations"
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var urls: [URL] {
        var seen = Set<String>()
        return (defaults.stringArray(forKey: key) ?? []).compactMap { value in
            guard let url = URL(string: value), url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
                  seen.insert(url.standardizedFileURL.path).inserted else { return nil }
            return url.standardizedFileURL
        }.prefix(20).map { $0 }
    }
    public func note(_ url: URL) {
        guard url.isFileURL else { return }
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        defaults.set(([canonical] + urls.filter { $0.path != canonical.path }).prefix(20).map(\.absoluteString), forKey: key)
    }
    public func clear() { defaults.removeObject(forKey: key) }
    public var byteCount: Int { guard let values = defaults.stringArray(forKey: key), !values.isEmpty else { return 0 }; return (try? JSONSerialization.data(withJSONObject: values).count) ?? 0 }
}
