import Foundation
import MarkfineCore
import WebKit

@MainActor
final class EditorScheme: NSObject, WKURLSchemeHandler {
    static let page = URL(string: "markfine://app/index.html")!
    private let resources: EditorResources
    private let images: ImageStore
    private let diagnostic: ((Error) -> Void)?
    private var requests: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(resources: EditorResources, images: ImageStore, diagnostic: ((Error) -> Void)? = nil) { self.resources = resources; self.images = images; self.diagnostic = diagnostic }

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
            default:
                let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
                guard parts.count >= 4, parts[0].isEmpty, parts[1] == "image", UUID(uuidString: String(parts[2])) != nil else { throw ImageStoreFailure.denied }
                let image = try await images.read(documentID: String(parts[2]), relativePath: parts.dropFirst(3).joined(separator: "/"))
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
