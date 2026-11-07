import Foundation

public enum ExternalLinkFailure: Error { case invalid, unsavedRelativePath, unavailable, executable }
public enum ExternalLink {
    /// Resolve only on an explicit user gesture. This never reads or opens the destination itself.
    public static func destination(_ href: String, documentURL: URL?) throws -> URL {
        guard !href.isEmpty, href.utf16.count <= 8192, !href.hasPrefix("//"), !href.contains("\\"),
              let decoded = href.removingPercentEncoding,
              decoded.rangeOfCharacter(from: .controlCharacters) == nil else { throw ExternalLinkFailure.invalid }
        let candidate = URL(string: href)
        if let url = candidate, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) {
            guard url.host?.isEmpty == false, url.user == nil, url.password == nil else { throw ExternalLinkFailure.invalid }; return url
        }
        let url: URL
        if let scheme = candidate?.scheme {
            guard scheme.lowercased() == "file", let candidate, candidate.host == nil || candidate.host == "" || candidate.host == "localhost",
                  candidate.user == nil, candidate.password == nil else { throw ExternalLinkFailure.invalid }
            url = candidate
        } else if href.hasPrefix("/") { url = URL(fileURLWithPath: decoded) }
        else {
            guard let documentURL else { throw ExternalLinkFailure.unsavedRelativePath }
            guard let relative = URL(string: href, relativeTo: documentURL.deletingLastPathComponent().appendingPathComponent("", isDirectory: true)) else { throw ExternalLinkFailure.invalid }
            url = relative.absoluteURL
        }
        guard url.isFileURL, !url.path.isEmpty else { throw ExternalLinkFailure.invalid }
        let target = url.standardizedFileURL.resolvingSymlinksInPath()
        let blocked: Set<String> = ["app", "command", "sh", "bash", "zsh", "fish", "scpt", "applescript", "workflow", "py", "pl", "rb", "js", "jar", "pkg", "dmg", "terminal", "webloc", "url"]
        guard !blocked.contains(target.pathExtension.lowercased()) else { throw ExternalLinkFailure.executable }
        return target
    }
}
