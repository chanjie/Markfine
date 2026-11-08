import Foundation
import MarkfineCore
import WebKit

@MainActor
final class EditorScheme: NSObject, WKURLSchemeHandler {
    static let page = URL(string: "markfine://app/index.html")!
    private let resources: EditorResources
    private let images: ImageStore
    private let diagnostic: ((Error) -> Void)?
    private let remoteImage: ((String, String) async throws -> LocalImage)?
    private var requests: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(resources: EditorResources, images: ImageStore, diagnostic: ((Error) -> Void)? = nil, remoteImage: ((String, String) async throws -> LocalImage)? = nil) { self.resources = resources; self.images = images; self.diagnostic = diagnostic; self.remoteImage = remoteImage }

    static func remoteSource(_ address: String, documentID: String) -> String? {
        guard let url = URL(string: address), url.scheme == "markfine", url.host == "app", url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.pathComponents.count == 4, url.pathComponents[1] == "remote-image", url.pathComponents[2] == documentID else { return nil }
        let value = url.pathComponents[3]; guard value.count <= 12_000, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
        let encoded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded) else { return nil }; return String(data: data, encoding: .utf8)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        requests[key] = Task { @MainActor in
        do {
            guard let url = urlSchemeTask.request.url, url.scheme == "markfine", url.host == "app",
                  url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
                  urlSchemeTask.request.httpMethod == "GET" else { throw ResourceFailure.invalid("resource request") }
            let data: Data
            let mime: String
            switch url.path {
            case "/index.html": data = try resources.data("index.html"); mime = "text/html"
            case "/style.css": data = try resources.data("style.css"); mime = "text/css"
            case "/paper-texture.png": data = try resources.data("paper-texture.png"); mime = "image/png"
            case "/kraft-texture.png": data = try resources.data("kraft-texture.png"); mime = "image/png"
            default:
                let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
                guard parts.count >= 4, parts[0].isEmpty, UUID(uuidString: String(parts[2])) != nil else { throw ImageStoreFailure.denied }
                let image: LocalImage
                if parts[1] == "image" { image = try await images.read(documentID: String(parts[2]), relativePath: parts.dropFirst(3).joined(separator: "/")) }
                else if parts[1] == "remote-image", parts.count == 4, let remoteImage {
                    let value = String(parts[3]); guard value.count <= 12_000, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw ImageStoreFailure.denied }
                    let encoded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
                    guard let data = Data(base64Encoded: encoded), let source = String(data: data, encoding: .utf8) else { throw ImageStoreFailure.denied }
                    image = try await remoteImage(String(parts[2]), source)
                } else { throw ImageStoreFailure.denied }
                data = image.data; mime = image.mime
            }
            // app.js and capabilities are only injected in the isolated world, never served to page scripts.
            guard !Task.isCancelled, requests[key] != nil else { return }
            urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch { if !Task.isCancelled, requests[key] != nil { diagnostic?(error); urlSchemeTask.didFailWithError(error) } }
        requests[key] = nil
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) { requests.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel() }
}
