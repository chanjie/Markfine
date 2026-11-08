import AppKit
import MarkfineCore

struct ClipboardContents {
    static let archiveType = NSPasteboard.PasteboardType("local.markfine.markdown-fragment")
    let values: [NSPasteboard.PasteboardType: Data]
    @MainActor func write(to pasteboard: NSPasteboard) throws {
        let item = NSPasteboardItem()
        for (type, data) in values { guard item.setData(data, forType: type) else { throw ImageStoreFailure.unavailable } }
        pasteboard.clearContents()
        guard pasteboard.writeObjects([item]) else { throw ImageStoreFailure.unavailable }
    }
}
@MainActor
enum RichClipboard {
    static func make(markdown: String, snapshot: [String: Any], options: ExportOptions, image: (String) async throws -> LocalImage) async throws -> ClipboardContents {
        guard markdown.utf8.count <= 8 * 1_048_576, let bindings = snapshot["imageBindings"] as? [[String: String]], bindings.count <= 512 else { throw DocumentExportFailure.tooLarge }
        var originals: [String: LocalImage] = [:], bytes = 0
        for source in Set((snapshot["resources"] as? [String]) ?? []) {
            let value = try await image(source); bytes += value.data.count; guard bytes <= 64 * 1_048_576 else { throw DocumentExportFailure.tooLarge }; originals[source] = value
        }
        var resources: [ClipboardResource] = [], seen = Set<String>()
        for binding in bindings {
            guard let source = binding["source"], let reference = binding["resource"], source.utf8.count <= 8192 else { throw BridgeFailure.malformed }
            if reference.hasPrefix("markfine://app/image/"), let value = originals[reference], seen.insert(source).inserted { resources.append(ClipboardResource(source: source, data: value.data)) }
        }
        let archive = ClipboardArchive(markdown: markdown, images: resources); guard archive.valid else { throw DocumentExportFailure.tooLarge }
        let renderer = DocumentPrintRenderer()
        let rendered = try await renderer.prepare(snapshot: snapshot, options: options, word: true, image: { source in guard let value = originals[source] else { throw ImageStoreFailure.denied }; return value })
        let nodes = try JSONDecoder().decode([ExportNode].self, from: JSONSerialization.data(withJSONObject: rendered["nodes"] ?? []))
        var images: [String: ExportImage] = [:]
        for item in rendered["images"] as? [[String: Any]] ?? [] {
            guard let key = item["key"] as? String, let value = item["data"] as? String, let comma = value.firstIndex(of: ","), let data = Data(base64Encoded: String(value[value.index(after: comma)...])), let width = item["width"] as? Double, let height = item["height"] as? Double else { throw DocumentExportFailure.invalidImage }
            images[key] = ExportImage(data: data, width: width, height: height)
        }
        let attributed = ClipboardPainter(options: options, images: images).render(nodes)
        let range = NSRange(location: 0, length: attributed.length)
        let html = "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font:12pt/1.5 sans-serif;color:#171717}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:5px}img{max-width:100%;height:auto}pre,code{font-family:Menlo,monospace}blockquote{border-left:2px solid #ccc;padding-left:12px}</style></head><body>" + (rendered["html"] as? String ?? "") + "</body></html>"
        var values: [NSPasteboard.PasteboardType: Data] = [.string: Data(markdown.utf8), .html: Data(html.utf8), ClipboardContents.archiveType: try JSONEncoder().encode(archive)]
        values[.rtf] = try attributed.data(from: range, documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        if !images.isEmpty { values[.rtfd] = try attributed.data(from: range, documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]) }
        guard values.values.reduce(0, { $0 + $1.count }) <= 160 * 1_048_576 else { throw DocumentExportFailure.tooLarge }
        return ClipboardContents(values: values)
    }
}
@MainActor
private final class ClipboardPainter {
    let options: ExportOptions; let images: [String: ExportImage]
    init(options: ExportOptions, images: [String: ExportImage]) { self.options = options; self.images = images }
    var base: [NSAttributedString.Key: Any] { [.font: NSFont(name: options.chinese, size: 12) ?? NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor(white: 0.09, alpha: 1)] }
    func render(_ nodes: [ExportNode]) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        for node in nodes { result.append(block(node, attributes: base)) }; return result
    }
    func inline(_ nodes: [ExportNode], attributes: [NSAttributedString.Key: Any]) -> NSMutableAttributedString {
        let result = NSMutableAttributedString(string: "")
        for node in nodes {
            var attrs = attributes
            let font = attrs[.font] as? NSFont ?? NSFont.systemFont(ofSize: 12)
            switch node.tag {
            case "#text": result.append(NSAttributedString(string: node.text ?? "", attributes: attrs)); continue
            case "br": result.append(NSAttributedString(string: "\n", attributes: attrs)); continue
            case "strong", "b": attrs[.font] = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
            case "em", "i": attrs[.font] = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
            case "s", "del": attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case "code": attrs[.font] = NSFont(name: "Menlo", size: font.pointSize)
            case "a": if let href = node.href, let url = URL(string: href), ["http","https"].contains(url.scheme?.lowercased() ?? "") { attrs[.link] = url }
            case "img":
                if let src = node.src, let value = images[src], let image = NSImage(data: value.data) {
                    let requested = node.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? value.width
                    let width = min(requested, 601.7), attachment = NSTextAttachment()
                    attachment.image = image; attachment.bounds = NSRect(x: 0, y: 0, width: width * 0.75, height: value.height / value.width * width * 0.75)
                    result.append(NSAttributedString(attachment: attachment))
                }; continue
            default: break
            }
            result.append(inline(node.children ?? [], attributes: attrs))
        }
        return result
    }
    func block(_ node: ExportNode, attributes: [NSAttributedString.Key: Any], depth: Int = 0) -> NSMutableAttributedString {
        let children = node.children ?? [], result = NSMutableAttributedString(string: "")
        if node.tag == "table" {
            func rows(_ node: ExportNode) -> [ExportNode] { node.tag == "tr" ? [node] : (node.children ?? []).flatMap(rows) }
            let rows = rows(node), columns = max(1, rows.map { ($0.children ?? []).count }.max() ?? 1), table = NSTextTable(); table.numberOfColumns = columns
            for (row, value) in rows.enumerated() { for (column, cell) in (value.children ?? []).enumerated() {
                let block = NSTextTableBlock(table: table, startingRow: row, rowSpan: 1, startingColumn: column, columnSpan: 1)
                block.setContentWidth(100 / CGFloat(columns), type: .percentageValueType); block.setWidth(0.5, type: .absoluteValueType, for: .border); block.setWidth(5, type: .absoluteValueType, for: .padding); block.setBorderColor(.lightGray)
                if cell.tag == "th" { block.backgroundColor = NSColor(white: 0.94, alpha: 1) }
                let style = NSMutableParagraphStyle(); style.textBlocks = [block]; style.paragraphSpacing = 3
                if cell.align == "center" { style.alignment = .center }; if cell.align == "right" { style.alignment = .right }
                var attrs = attributes; attrs[.paragraphStyle] = style
                if cell.tag == "th", let font = attrs[.font] as? NSFont { attrs[.font] = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) }
                let text = inline(cell.children ?? [], attributes: attrs); text.append(NSAttributedString(string: "\n", attributes: attrs)); result.append(text)
            } }; return result
        }
        if node.tag == "ul" || node.tag == "ol" {
            let list = NSTextList(markerFormat: node.tag == "ol" ? .decimal : .disc, options: 0); list.startingItemNumber = node.start ?? 1
            for (index, child) in children.enumerated() {
                let style = NSMutableParagraphStyle(); style.textLists = [list]; style.headIndent = CGFloat((depth + 1) * 18); style.firstLineHeadIndent = CGFloat(depth * 18); style.paragraphSpacing = 5
                var attrs = attributes; attrs[.paragraphStyle] = style
                result.append(NSAttributedString(string: list.marker(forItemNumber: index + list.startingItemNumber) + "\t", attributes: attrs))
                for part in child.children ?? [] {
                    if ["ul","ol"].contains(part.tag) { result.append(block(part, attributes: attributes, depth: depth + 1)) }
                    else if part.tag == "p" { result.append(inline(part.children ?? [], attributes: attrs)) }
                    else { result.append(inline([part], attributes: attrs)) }
                }; result.append(NSAttributedString(string: "\n", attributes: attrs))
            }; return result
        }
        if ["article","div","section","blockquote"].contains(node.tag) { for child in children { result.append(block(child, attributes: attributes, depth: depth)) }; return result }
        var attrs = attributes
        if node.tag.hasPrefix("h"), let level = Int(node.tag.dropFirst()), (1...6).contains(level) { attrs[.font] = NSFont.boldSystemFont(ofSize: [25.0,20,16,14,12,12][level-1]) }
        if node.tag == "pre" { attrs[.font] = NSFont(name: "Menlo", size: 11) }
        let style = NSMutableParagraphStyle(); style.paragraphSpacing = 8; style.lineHeightMultiple = CGFloat(options.lineSpacing); attrs[.paragraphStyle] = style
        result.append(inline(node.tag == "img" ? [node] : children, attributes: attrs)); result.append(NSAttributedString(string: "\n", attributes: attrs)); return result
    }
}
