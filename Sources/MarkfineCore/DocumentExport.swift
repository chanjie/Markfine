import Foundation
import ImageIO

public struct ExportNode: Codable, Sendable {
    public var tag: String
    public var text: String?
    public var children: [ExportNode]?
    public var src: String?
    public var href: String?
    public var align: String?
    public var start: Int?
    public var width: Double?
    public init(tag: String, text: String? = nil, children: [ExportNode]? = nil, src: String? = nil) {
        self.tag = tag; self.text = text; self.children = children; self.src = src
    }
}
public struct ExportOptions: Sendable {
    public var indent: Double = 2
    public var lineSpacing: Double = 1.5
    public var chinese: String
    public var english: String
    public init(chinese: String, english: String) { self.chinese = chinese; self.english = english }
    public var valid: Bool { indent.isFinite && (0...10).contains(indent) && lineSpacing.isFinite && (0.5...5).contains(lineSpacing) }
}
public struct ExportImage: Sendable {
    public let data: Data
    public let width: Double
    public let height: Double
    public init(data: Data, width: Double, height: Double) { self.data = data; self.width = width; self.height = height }
}
public enum DocumentExportFailure: Error { case invalidOptions, invalidImage, tooLarge, pagination(String) }

public enum ExportRaster {
    /// Inspect dimensions before decoding, then bound the raster used by a paged output document.
    public static func png(_ data: Data) throws -> ExportImage {
        guard data.count <= 64 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0, width.doubleValue * height.doubleValue <= 100_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400] as CFDictionary) else { throw DocumentExportFailure.invalidImage }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil) else { throw DocumentExportFailure.invalidImage }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), output.length <= 24 * 1024 * 1024 else { throw DocumentExportFailure.tooLarge }
        return ExportImage(data: output as Data, width: Double(image.width), height: Double(image.height))
    }
}

private func xml(_ value: String) -> String {
    String(value.unicodeScalars.filter { $0.value == 9 || $0.value == 10 || $0.value == 13 || ($0.value >= 32 && $0.value != 0xFFFE && $0.value != 0xFFFF) })
        .replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&apos;")
}

/// A small, standards-based OOXML writer; no office installation, subprocess or runtime dependency.
public enum WordDocument {
    public static func data(nodes: [ExportNode], options: ExportOptions, images: [String: ExportImage] = [:]) throws -> Data {
        guard options.valid else { throw DocumentExportFailure.invalidOptions }
        return try Writer(options: options, images: images).build(nodes)
    }
    private final class Writer {
        let options: ExportOptions
        let images: [String: ExportImage]
        var files: [(String, Data)] = []
        var relationships: [String] = []
        var numbering: [String] = []
        var abstractNumbering: [String] = []
        var imageIDs: [String: (String, Int)] = [:]
        var drawingID = 0
        init(options: ExportOptions, images: [String: ExportImage]) { self.options = options; self.images = images }
        func relation(_ type: String, _ target: String, external: Bool = false) -> String {
            let id = "rId\(relationships.count + 1)"
            relationships.append("<Relationship Id=\"\(id)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/\(type)\" Target=\"\(xml(target))\"\(external ? " TargetMode=\"External\"" : "")/>")
            return id
        }
        func add(_ path: String, _ text: String) { files.append((path, Data(("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" + text).utf8))) }
        var fonts: String { "<w:rFonts w:ascii=\"\(xml(options.english))\" w:hAnsi=\"\(xml(options.english))\" w:eastAsia=\"\(xml(options.chinese))\"/>" }
        func build(_ nodes: [ExportNode]) throws -> Data {
            let body = nodes.map { block($0) }.joined()
            _ = relation("styles", "styles.xml"); _ = relation("numbering", "numbering.xml")
            add("word/document.xml", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>\(body)<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>")
            let headings = (1...6).map { level in "<w:style w:type=\"paragraph\" w:styleId=\"Heading\(level)\"><w:name w:val=\"heading \(level)\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/><w:outlineLvl w:val=\"\(level - 1)\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"\([40,32,28,26,24,24][level - 1])\"/></w:rPr></w:style>" }.joined()
            add("word/styles.xml", "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:docDefaults><w:rPrDefault><w:rPr>\(fonts)<w:sz w:val=\"24\"/><w:lang w:val=\"en-US\" w:eastAsia=\"zh-CN\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"\(Int((options.lineSpacing * 240).rounded()))\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style>\(headings)</w:styles>")
            add("word/numbering.xml", "<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\(abstractNumbering.joined())\(numbering.joined())</w:numbering>")
            add("word/_rels/document.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\(relationships.joined())</Relationships>")
            add("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>")
            add("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/></Types>")
            return try StoredZIP.pack(files)
        }
        func paragraph(_ content: String, properties: String = "", normal: Bool = false) -> String {
            let indent = normal && options.indent > 0 ? "<w:ind w:firstLine=\"\(Int(options.indent * 240))\" w:firstLineChars=\"\(Int(options.indent * 100))\"/>" : ""
            return "<w:p><w:pPr>\(properties)\(indent)</w:pPr>\(content)</w:p>"
        }
        func block(_ node: ExportNode, depth: Int = 0, numbered: Int? = nil) -> String {
            let children = node.children ?? []
            let listProperty = numbered.map { "<w:numPr><w:ilvl w:val=\"\(min(depth, 8))\"/><w:numId w:val=\"\($0)\"/></w:numPr>" } ?? ""
            switch node.tag {
            case "h1", "h2", "h3", "h4", "h5", "h6": return paragraph(inlines(children), properties: "<w:pStyle w:val=\"Heading\(node.tag.suffix(1))\"/>")
            case "p": return paragraph(inlines(children), properties: listProperty, normal: numbered == nil)
            case "pre":
                let text = flatten(node)
                return text.split(separator: "\n", omittingEmptySubsequences: false).map { paragraph(run(String($0), properties: "<w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\" w:eastAsia=\"\(xml(options.chinese))\"/><w:sz w:val=\"20\"/>"), properties: "<w:shd w:val=\"clear\" w:fill=\"F3F3F3\"/>") }.joined()
            case "blockquote": return children.map { block($0, depth: depth) }.joined()
            case "ul", "ol":
                let id = numbering.count + 1, ordered = node.tag == "ol", start = max(1, min(node.start ?? 1, 999_999))
                let levels = (0...8).map { level in "<w:lvl w:ilvl=\"\(level)\"><w:start w:val=\"\(start)\"/><w:numFmt w:val=\"\(ordered ? "decimal" : "bullet")\"/><w:lvlText w:val=\"\(ordered ? "%\(level + 1)." : "•")\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:tabs><w:tab w:val=\"num\" w:pos=\"\(720 * (level + 1))\"/></w:tabs><w:ind w:left=\"\(720 * (level + 1))\" w:hanging=\"360\"/></w:pPr></w:lvl>" }.joined()
                abstractNumbering.append("<w:abstractNum w:abstractNumId=\"\(id)\"><w:multiLevelType w:val=\"multilevel\"/>\(levels)</w:abstractNum>")
                numbering.append("<w:num w:numId=\"\(id)\"><w:abstractNumId w:val=\"\(id)\"/></w:num>")
                return children.map { child in
                    var first = true; var result = ""; var inline: [ExportNode] = []
                    func flush() { if !inline.isEmpty { result += paragraph(inlines(inline), properties: first ? "<w:numPr><w:ilvl w:val=\"\(min(depth,8))\"/><w:numId w:val=\"\(id)\"/></w:numPr>" : ""); first = false; inline = [] } }
                    for part in child.children ?? [] {
                        if part.tag == "ul" || part.tag == "ol" { flush(); result += block(part, depth: depth + 1) }
                        else if part.tag == "p" { flush(); result += block(part, depth: depth, numbered: first ? id : nil); first = false }
                        else if ["table", "pre", "blockquote"].contains(part.tag) { flush(); result += block(part, depth: depth) }
                        else { inline.append(part) }
                    }
                    flush(); return result
                }.joined()
            case "table":
                let rows = descendants(node, tag: "tr"), count = max(1, rows.map { ($0.children ?? []).filter { ["td", "th"].contains($0.tag) }.count }.max() ?? 1)
                let widths = (0..<count).map { $0 == count - 1 ? 9026 - (9026 / count) * (count - 1) : 9026 / count }
                let grid = widths.map { "<w:gridCol w:w=\"\($0)\"/>" }.joined()
                let body = rows.map { row in
                    let cells = (row.children ?? []).filter { ["td", "th"].contains($0.tag) }
                    return "<w:tr>\(cells.contains { $0.tag == "th" } ? "<w:trPr><w:tblHeader/></w:trPr>" : "")" + cells.enumerated().map { index, cell in
                        let width = widths[min(index, widths.count - 1)]
                        return "<w:tc><w:tcPr><w:tcW w:w=\"\(width)\" w:type=\"dxa\"/>\(cell.tag == "th" ? "<w:shd w:val=\"clear\" w:fill=\"EEEEEE\"/>" : "")</w:tcPr>\(paragraph(inlines(cell.children ?? [], properties: cell.tag == "th" ? "<w:b/>" : ""), properties: ["left", "center", "right"].contains(cell.align ?? "") ? "<w:jc w:val=\"\(cell.align!)\"/>" : ""))</w:tc>"
                    }.joined() + "</w:tr>"
                }.joined()
                let borders = ["top","left","bottom","right","insideH","insideV"].map { "<w:\($0) w:val=\"single\" w:sz=\"4\" w:color=\"CCCCCC\"/>" }.joined()
                return "<w:tbl><w:tblPr><w:tblW w:w=\"9026\" w:type=\"dxa\"/><w:tblBorders>\(borders)</w:tblBorders><w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:top w:w=\"80\" w:type=\"dxa\"/><w:left w:w=\"120\" w:type=\"dxa\"/><w:bottom w:w=\"80\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr><w:tblGrid>\(grid)</w:tblGrid>\(body)</w:tbl>\(paragraph(""))"
            case "hr": return paragraph("", properties: "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"CCCCCC\"/></w:pBdr>")
            case "img": return paragraph(image(node))
            case "#text": return (node.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : paragraph(run(node.text ?? ""))
            default: return children.map { block($0, depth: depth) }.joined()
            }
        }
        func flatten(_ node: ExportNode) -> String { node.text ?? (node.children ?? []).map(flatten).joined() }
        func descendants(_ node: ExportNode, tag: String) -> [ExportNode] { node.tag == tag ? [node] : (node.children ?? []).flatMap { descendants($0, tag: tag) } }
        func run(_ text: String, properties: String = "") -> String {
            let content = text.split(separator: "\n", omittingEmptySubsequences: false).map { part in part.split(separator: "\t", omittingEmptySubsequences: false).map { "<w:t xml:space=\"preserve\">\(xml(String($0)))</w:t>" }.joined(separator: "<w:tab/>") }.joined(separator: "<w:br/>")
            return "<w:r><w:rPr>\(properties)</w:rPr>\(content)</w:r>"
        }
        func inlines(_ nodes: [ExportNode], properties: String = "") -> String { nodes.map { node in
            switch node.tag {
            case "#text": return run(node.text ?? "", properties: properties)
            case "br": return "<w:r><w:br/></w:r>"
            case "img": return image(node)
            case "strong", "b": return inlines(node.children ?? [], properties: properties + "<w:b/>")
            case "em", "i": return inlines(node.children ?? [], properties: properties + "<w:i/>")
            case "s", "del": return inlines(node.children ?? [], properties: properties + "<w:strike/>")
            case "code": return inlines(node.children ?? [], properties: properties + "<w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\" w:eastAsia=\"\(xml(options.chinese))\"/>")
            case "a":
                if let href = node.href, let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { return "<w:hyperlink r:id=\"\(relation("hyperlink", href, external: true))\">\(inlines(node.children ?? [], properties: properties + "<w:color w:val=\"315C80\"/><w:u w:val=\"single\"/>"))</w:hyperlink>" }
                return inlines(node.children ?? [], properties: properties)
            default: return inlines(node.children ?? [], properties: properties)
            }
        }.joined() }
        func image(_ node: ExportNode) -> String {
            guard let src = node.src, let image = images[src], image.width > 0, image.height > 0, image.width.isFinite, image.height.isFinite else { return run(node.text ?? "[Image unavailable]") }
            let identity: (String, Int)
            if let existing = imageIDs[src] { identity = existing }
            else { let number = imageIDs.count + 1; files.append(("word/media/image\(number).png", image.data)); identity = (relation("image", "media/image\(number).png"), number); imageIDs[src] = identity }
            let requested = node.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? image.width
            let ratio = requested / image.width, scale = min(ratio, 601.7 / image.width, 900 / image.height), width = Int(image.width * scale * 9525), height = Int(image.height * scale * 9525)
            drawingID += 1
            return "<w:r><w:drawing><wp:inline><wp:extent cx=\"\(width)\" cy=\"\(height)\"/><wp:docPr id=\"\(drawingID)\" name=\"Image \(drawingID)\" descr=\"\(xml(node.text ?? "Image"))\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"0\" name=\"image\(identity.1).png\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"\(identity.0)\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"\(width)\" cy=\"\(height)\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
        }
    }
}

private enum StoredZIP {
    static func pack(_ files: [(String, Data)]) throws -> Data {
        var output = Data(), directory = Data()
        func append(_ value: UInt32, bytes: Int, to data: inout Data) { for shift in 0..<bytes { data.append(UInt8(truncatingIfNeeded: value >> (shift * 8))) } }
        func crc(_ data: Data) -> UInt32 { var value: UInt32 = 0xFFFFFFFF; for byte in data { value ^= UInt32(byte); for _ in 0..<8 { value = value & 1 == 1 ? (value >> 1) ^ 0xEDB88320 : value >> 1 } }; return value ^ 0xFFFFFFFF }
        guard files.count < 65535 else { throw DocumentExportFailure.tooLarge }
        for (name, data) in files {
            guard data.count < Int(UInt32.max), output.count < Int(UInt32.max) else { throw DocumentExportFailure.tooLarge }
            let filename = Data(name.utf8), checksum = crc(data), offset = UInt32(output.count)
            append(0x04034B50, bytes: 4, to: &output)
            for (value, size) in [(20,2),(0x800,2),(0,2),(0,2),(33,2),(checksum,4),(UInt32(data.count),4),(UInt32(data.count),4),(UInt32(filename.count),2),(0,2)] as [(UInt32,Int)] { append(value, bytes: size, to: &output) }
            output.append(filename); output.append(data)
            append(0x02014B50, bytes: 4, to: &directory)
            for (value, size) in [(20,2),(20,2),(0x800,2),(0,2),(0,2),(33,2),(checksum,4),(UInt32(data.count),4),(UInt32(data.count),4),(UInt32(filename.count),2),(0,2),(0,2),(0,2),(0,2),(0,4),(offset,4)] as [(UInt32,Int)] { append(value, bytes: size, to: &directory) }
            directory.append(filename)
        }
        guard output.count + directory.count < Int(UInt32.max) else { throw DocumentExportFailure.tooLarge }
        let offset = UInt32(output.count); output.append(directory); append(0x06054B50, bytes: 4, to: &output)
        for (value, size) in [(0,2),(0,2),(UInt32(files.count),2),(UInt32(files.count),2),(UInt32(directory.count),4),(offset,4),(0,2)] as [(UInt32,Int)] { append(value, bytes: size, to: &output) }
        return output
    }
}
