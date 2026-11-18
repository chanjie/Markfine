import Darwin
import Foundation
import ImageIO
import JavaScriptCore
import QuickLookUI
import UniformTypeIdentifiers

private enum PreviewFailure: Error { case unavailable, invalidText, tooLarge, renderFailed }

/// Quick Look grants access to the selected document, not its parent. Attempt only
/// document-local, non-symlink images and retain an inert placeholder on denial.
private final class PreviewImages {
    private let parent: URL
    private var bytes = 0
    init(document: URL) { parent = document.deletingLastPathComponent() }
    func read(_ source: String) -> String? {
        guard source.utf16.count <= 8192, let path = source.removingPercentEncoding,
              path.rangeOfCharacter(from: CharacterSet(charactersIn: "\\:%?#").union(.controlCharacters)) == nil else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              ["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "heic"].contains((parts.last! as NSString).pathExtension.lowercased()) else { return nil }
        var fd = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { Darwin.close(fd) }
        for part in parts.dropLast() {
            let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { return nil }
            Darwin.close(fd); fd = next
        }
        let image = openat(fd, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard image >= 0 else { return nil }
        defer { Darwin.close(image) }
        guard let data = try? Self.readRegular(image, maximum: min(16 * 1_048_576, 32 * 1_048_576 - bytes)),
              let imageSource = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(imageSource) as String?,
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0, width.doubleValue * height.doubleValue <= 100_000_000,
              let mime = UTType(type)?.preferredMIMEType, ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime) else { return nil }
        bytes += data.count
        return "data:\(mime);base64," + data.base64EncodedString()
    }
    static func readRegular(_ fd: Int32, maximum: Int) throws -> Data {
        var before = stat()
        guard maximum > 0, fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_size >= 0, before.st_size <= maximum else { throw PreviewFailure.tooLarge }
        var data = Data(count: Int(before.st_size))
        try data.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw PreviewFailure.unavailable }
                offset += count
            }
        }
        var after = stat()
        guard fstat(fd, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw PreviewFailure.unavailable }
        return data
    }
}

private enum PreviewPage {
    static func decode(_ data: Data) throws -> String {
        let formats: [([UInt8], String.Encoding)] = [
            ([0xff, 0xfe, 0, 0], .utf32LittleEndian), ([0, 0, 0xfe, 0xff], .utf32BigEndian),
            ([0xef, 0xbb, 0xbf], .utf8), ([0xff, 0xfe], .utf16LittleEndian), ([0xfe, 0xff], .utf16BigEndian)
        ]
        let choice = formats.first { data.starts(with: $0.0) }
        let body = Data(data.dropFirst(choice?.0.count ?? 0)), encoding = choice?.1 ?? .utf8
        guard let text = String(data: body, encoding: encoding), text.data(using: encoding, allowLossyConversion: false) == body,
              !text.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 12, 13, 27].contains($0.value) || $0.value == 127 }) else { throw PreviewFailure.invalidText }
        return text
    }
    static func make(url: URL) throws -> Data {
        guard url.isFileURL, ["md", "markdown"].contains(url.pathExtension.lowercased()),
              let scriptURL = Bundle.main.url(forResource: "quicklook-render", withExtension: "js") else { throw PreviewFailure.unavailable }
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw PreviewFailure.unavailable }
        defer { Darwin.close(fd) }
        let source = try decode(PreviewImages.readRegular(fd, maximum: 16 * 1_048_576))
        let script = try String(contentsOf: scriptURL, encoding: .utf8)
        guard let context = JSContext() else { throw PreviewFailure.renderFailed }
        let images = PreviewImages(document: url)
        let load: @convention(block) (String) -> String? = { images.read($0) }
        context.setObject(load, forKeyedSubscript: "markfineQuickLookImage" as NSString)
        context.evaluateScript(script)
        let english = !(Locale.preferredLanguages.first?.hasPrefix("zh") ?? false)
        guard context.exception == nil, let render = context.objectForKeyedSubscript("markfineQuickLookRender"),
              !render.isUndefined, let html = render.call(withArguments: [source, english])?.toString(),
              context.exception == nil, html.utf8.count <= 48 * 1_048_576 else { throw PreviewFailure.renderFailed }
        let page = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
        <style>
        :root{color-scheme:light dark}body{margin:0;background:#f7f3e7;color:#303b34;font:16px/1.75 -apple-system,BlinkMacSystemFont,sans-serif;overflow-wrap:anywhere}article{max-width:780px;margin:0 auto;padding:36px 42px 80px}h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.3em 0 .5em}p{margin:.65em 0}a{color:#466c55}blockquote{border-left:3px solid #c3c6b9;margin-left:0;padding-left:18px;color:#68746a}pre{overflow:auto;padding:14px;background:#ece7db;border-radius:6px}code{font:0.9em Menlo,monospace;background:#e8e2d5;border-radius:3px}pre code{background:none}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}th,td{border:1px solid #d0d0c4;padding:7px 12px}th{background:#eae5d8}img{max-width:100%;height:auto}.image-placeholder,.diagram-source small{color:#727b72;font-size:13px}input{pointer-events:none}hr{border:0;border-top:1px solid #d0d0c4}
        @media(prefers-color-scheme:dark){body{background:#1a1e1b;color:#e2e8e0}pre,code,th{background:#303831}blockquote,.image-placeholder,.diagram-source small{color:#a4b3a7}th,td{border-color:#59665b}a{color:#a4d3af}}
        </style></head><body><article>\(html)</article></body></html>
        """
        return Data(page.utf8)
    }
}

final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        let url = request.fileURL
        let page = try PreviewPage.make(url: url)
        return QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: 860, height: 880)) { reply in
            reply.title = url.lastPathComponent; reply.stringEncoding = .utf8; return page
        }
    }
}
