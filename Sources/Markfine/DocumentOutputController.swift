import AppKit
import MarkfineCore
import PDFKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class DocumentOutputController: NSObject {
    enum Result { case cancelled, exported(URL), printed }
    private(set) var busy = false
    private let settings: ApplicationSettings
    private var savePanel: NSSavePanel?
    private let format = NSPopUpButton()
    private let indent = NSTextField(string: "2")
    private let spacing = NSTextField(string: "1.5")
    private let indentEnabled = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let chinese = NSComboBox(), english = NSComboBox()
    init(settings: ApplicationSettings) { self.settings = settings }
    @discardableResult func perform(window: NSWindow, documentURL: URL?, title: String, printing: Bool, lineHeight: Double? = nil,
                 confirmed: () async -> Void = {}, snapshot: () async throws -> [String: Any], image: (String) async throws -> LocalImage) async throws -> Result {
        guard !busy, window.attachedSheet == nil else { return .cancelled }; busy = true; defer { busy = false; savePanel = nil }
        var options = ExportOptions(chinese: settings.values["fontChinese"] as? String ?? "PingFangSC-Regular", english: settings.values["fontEnglish"] as? String ?? "PingFangSC-Regular")
        options.lineSpacing = lineHeight ?? settings.lineHeight(reading: false)
        var target: URL?
        if !printing {
            let panel = NSSavePanel(); savePanel = panel
            panel.title = settings.text("导出文档", "Export Document"); panel.prompt = settings.text("导出", "Export")
            panel.canCreateDirectories = true; panel.isExtensionHidden = false; panel.allowedContentTypes = [.pdf]
            panel.nameFieldStringValue = (title as NSString).deletingPathExtension + ".pdf"; panel.directoryURL = documentURL?.deletingLastPathComponent()
            panel.accessoryView = controls(options)
            let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in panel.beginSheetModal(for: window) { continuation.resume(returning: $0) } }
            guard response == .OK, let url = panel.url else { return .cancelled }; target = url
            await confirmed()
            options.indent = indentEnabled.state == .on ? Double(indent.stringValue) ?? .nan : 0
            options.lineSpacing = Double(spacing.stringValue) ?? .nan
            guard options.valid else { throw DocumentExportFailure.invalidOptions }
            guard let cn = NSFont(name: chinese.stringValue, size: 12), let en = NSFont(name: english.stringValue, size: 12) else { throw DocumentExportFailure.invalidOptions }
            options.chinese = cn.fontName; options.english = en.fontName
            // Never allow an export to overwrite the source Markdown, even through a manually typed name.
            guard ["pdf", "docx"].contains(url.pathExtension.lowercased()), url.standardizedFileURL.resolvingSymlinksInPath() != documentURL?.standardizedFileURL.resolvingSymlinksInPath() else { throw CocoaError(.fileWriteInvalidFileName) }
        }
        let renderer = DocumentPrintRenderer()
        let result = try await renderer.prepare(snapshot: snapshot(), options: options, word: target?.pathExtension.lowercased() == "docx", image: image)
        if let target, target.pathExtension.lowercased() == "docx" {
            let nodes = try JSONDecoder().decode([ExportNode].self, from: JSONSerialization.data(withJSONObject: result["nodes"] ?? []))
            var images: [String: ExportImage] = [:]
            for item in result["images"] as? [[String: Any]] ?? [] {
                guard let src = item["key"] as? String, let encoded = item["data"] as? String, let comma = encoded.firstIndex(of: ","), let data = Data(base64Encoded: String(encoded[encoded.index(after: comma)...])), let width = item["width"] as? Double, let height = item["height"] as? Double else { throw DocumentExportFailure.invalidImage }
                images[src] = ExportImage(data: data, width: width, height: height)
            }
            let data = try await Task.detached { try WordDocument.data(nodes: nodes, options: options, images: images) }.value
            try data.write(to: target, options: .atomic)
        } else if let target { try await renderer.writePDF(to: target) }
        else { try await renderer.printDocument(window: window) }
        return target.map(Result.exported) ?? .printed
    }
    private func controls(_ options: ExportOptions) -> NSView {
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        stack.widthAnchor.constraint(equalToConstant: 510).isActive = true
        func row(_ label: String, _ controls: [NSView]) { let row = NSStackView(); row.orientation = .horizontal; row.spacing = 10; let title = NSTextField(labelWithString: label); title.widthAnchor.constraint(equalToConstant: 125).isActive = true; row.addArrangedSubview(title); for view in controls { row.addArrangedSubview(view) }; stack.addArrangedSubview(row) }
        format.removeAllItems(); format.addItems(withTitles: ["PDF", "Word (.docx)"]); format.target = self; format.action = #selector(changeFormat)
        row(settings.text("格式", "Format"), [format])
        indentEnabled.title = settings.text("首行缩进", "Indent first line"); indentEnabled.state = .on; indent.stringValue = "2"; indent.widthAnchor.constraint(equalToConstant: 55).isActive = true
        row(settings.text("普通段落", "Body paragraphs"), [indentEnabled, indent, NSTextField(labelWithString: settings.text("字符（0–10）", "characters (0–10)"))])
        spacing.stringValue = String(format: "%g", options.lineSpacing); spacing.widthAnchor.constraint(equalToConstant: 55).isActive = true
        row(settings.text("行间距", "Line spacing"), [spacing, NSTextField(labelWithString: settings.text("倍字号（0.5–5）", "× font size (0.5–5)"))])
        let fonts = NSFontManager.shared.availableFontFamilies.sorted()
        for (label, combo, value) in [(settings.text("中文字体", "Chinese font"), chinese, options.chinese), (settings.text("英文字体", "English font"), english, options.english)] {
            combo.removeAllItems(); combo.addItems(withObjectValues: fonts); combo.stringValue = value; combo.completes = true; combo.numberOfVisibleItems = 10; combo.widthAnchor.constraint(equalToConstant: 285).isActive = true; row(label, [combo])
        }
        let note = NSTextField(wrappingLabelWithString: settings.text("A4 纵向 · 白底 · 正文 12 磅。标题、列表、代码与表格不套用首行缩进。", "A4 portrait · White · 12 pt body. Headings, lists, code and tables are not first-line indented.")); note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor; stack.addArrangedSubview(note)
        return stack
    }
    @objc private func changeFormat() {
        guard let panel = savePanel else { return }; let ext = format.indexOfSelectedItem == 0 ? "pdf" : "docx"
        panel.allowedContentTypes = [UTType(filenameExtension: ext) ?? .data]; panel.nameFieldStringValue = (panel.nameFieldStringValue as NSString).deletingPathExtension + "." + ext
    }
}

/// An isolated, static output page: only embedded images and installed local fonts; no document scripts.
@MainActor
final class DocumentPrintRenderer: NSObject, WKNavigationDelegate {
    private var view: WKWebView!
    private var loaded: CheckedContinuation<Void, Error>?
    private var printed: CheckedContinuation<Void, Error>?
    private var watchdog: Task<Void, Never>?
    private var pageBreaks: [Double] = []
    private var printablePDF: PDFDocument?
    func prepare(snapshot: [String: Any], options: ExportOptions, word: Bool, image: (String) async throws -> LocalImage) async throws -> [String: Any] {
        guard options.valid, let html = snapshot["html"] as? String, html.utf8.count <= 32 * 1024 * 1024,
              let references = snapshot["resources"] as? [String], references.count <= 512, references.allSatisfy({ $0.utf16.count <= 8192 }) else { throw DocumentExportFailure.tooLarge }
        var resourceImages: [String: String] = [:], inputBytes = 0, outputBytes = 0, pixels = 0.0
        for reference in Set(references) {
            let local = try await image(reference); inputBytes += local.data.count
            guard inputBytes <= 64 * 1024 * 1024 else { throw DocumentExportFailure.tooLarge }
            let raster = try await Task.detached { try ExportRaster.png(local.data) }.value
            outputBytes += raster.data.count; pixels += raster.width * raster.height
            guard outputBytes <= 96 * 1024 * 1024, pixels <= 32_000_000 else { throw DocumentExportFailure.tooLarge }
            resourceImages[reference] = "data:image/png;base64," + raster.data.base64EncodedString()
        }
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = false
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 601.7, height: 900), configuration: config); view.navigationDelegate = self
        let quote: (String) -> String = { value in value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "<", with: "\\3c ").replacingOccurrences(of: ">", with: "\\3e ") }
        let unit = "pt"
        let faces = [("OutputLatin", options.english, "U+0000-024F,U+1E00-1EFF"), ("OutputCJK", options.chinese, "U+0250-1DFF,U+2000-10FFFF"), ("Markfine Latin", options.english, "U+0000-024F,U+1E00-1EFF"), ("Markfine CJK", options.chinese, "U+0250-1DFF,U+2000-10FFFF")].map { family, name, range in
            let bold = NSFont(name: name, size: 12).map { NSFontManager.shared.convert($0, toHaveTrait: .boldFontMask).fontName } ?? name
            return "@font-face{font-family:\"\(family)\";src:local(\"\(quote(name))\");font-weight:400;unicode-range:\(range)}@font-face{font-family:\"\(family)\";src:local(\"\(quote(bold))\");font-weight:700;unicode-range:\(range)}"
        }.joined()
        let paginationCSS = "article{display:flow-root}"
        let page = """
        <!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
        <style>\(faces)
        *{box-sizing:border-box;font-synthesis:style}html,body{margin:0;padding:0;background:white;color:#171717}body{font:12\(unit)/\(options.lineSpacing) OutputLatin,OutputCJK,sans-serif;overflow-wrap:anywhere}p{text-indent:\(options.indent)em;margin:0 0 9\(unit)}li p,td p,th p{ text-indent:0 }h1,h2,h3,h4,h5,h6{line-height:1.3;break-after:avoid;margin:14\(unit) 0 8\(unit)}h1{font-size:20\(unit)}h2{font-size:16\(unit)}h3{font-size:14\(unit)}h4,h5,h6{font-size:12\(unit)}pre,code{font-family:Menlo,monospace}pre{font-size:10\(unit);white-space:pre-wrap;background:#f3f3f3;padding:9\(unit);text-indent:0}blockquote{border-left:2\(unit) solid #ccc;margin-left:0;padding-left:12\(unit)}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11\(unit)}th,td{border:.5\(unit) solid #ccc;padding:5\(unit);vertical-align:top}th{background:#eee}thead{display:table-header-group}img,svg{max-width:100%;height:auto;max-height:675\(unit);object-fit:contain;break-inside:avoid}a{color:#315c80}hr{border:0;border-top:.5\(unit) solid #ccc}ul,ol{padding-left:24\(unit)}.diagram{margin:8\(unit) 0} .image-placeholder{font-size:10\(unit);color:#666}\(paginationCSS)</style></head><body><div id="page-clip"><article></article></div></body></html>
        """
        try await withCheckedThrowingContinuation { continuation in
            loaded = continuation
            watchdog = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                self.loaded?.resume(throwing: CocoaError(.fileReadUnknown)); self.loaded = nil; self.view.stopLoading()
            }
            view.loadHTMLString(page, baseURL: nil)
        }
        let result = try await view.callAsyncJavaScript(Self.snapshotScript, arguments: ["html": html, "resourceImages": resourceImages, "word": word], in: nil, contentWorld: .page) as? [String: Any] ?? [:]
        pageBreaks = result["breaks"] as? [Double] ?? []
        return result
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { watchdog?.cancel(); loaded?.resume(); loaded = nil }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { watchdog?.cancel(); loaded?.resume(throwing: error); loaded = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { self.webView(webView, didFail: navigation, withError: error) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy { navigationAction.navigationType == .other && navigationAction.request.url?.scheme == "about" ? .allow : .cancel }
    private func printInfo() -> NSPrintInfo {
        let info = NSPrintInfo(); info.paperSize = NSSize(width: 595.28, height: 841.89); info.orientation = .portrait
        info.topMargin = 72; info.bottomMargin = 72; info.leftMargin = 72; info.rightMargin = 72
        info.horizontalPagination = .fit; info.verticalPagination = .automatic; info.isHorizontallyCentered = false; info.isVerticallyCentered = false
        return info
    }
    private func pdfData() async throws -> Data {
        guard (2...1001).contains(pageBreaks.count), pageBreaks.first == 0 else { throw DocumentExportFailure.pagination("Invalid page boundaries: \(pageBreaks.count)") }
        let output = NSMutableData(); var media = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
        guard let consumer = CGDataConsumer(data: output), let context = CGContext(consumer: consumer, mediaBox: &media, nil) else { throw CocoaError(.fileWriteUnknown) }
        var capturedBytes = 0
        for index in 1..<pageBreaks.count {
            let start = pageBreaks[index - 1], height = pageBreaks[index] - start
            guard start.isFinite, height.isFinite, height > 0, height <= 930.53 else { throw DocumentExportFailure.pagination("Invalid page height: \(height)") }
            let config = WKPDFConfiguration(); config.rect = CGRect(x: 0, y: start, width: 601.7067, height: height)
            let data = try await view.pdf(configuration: config); capturedBytes += data.count
            guard capturedBytes <= 128 * 1024 * 1024 else { throw DocumentExportFailure.tooLarge }
            guard let provider = CGDataProvider(data: data as CFData), let source = CGPDFDocument(provider), source.numberOfPages == 1, let page = source.page(at: 1) else { throw DocumentExportFailure.pagination("WebKit did not return one bounded PDF region") }
            let bounds = page.getBoxRect(.mediaBox)
            guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0, bounds.width <= 603.71, bounds.height <= height + 2 else { throw DocumentExportFailure.pagination("Unexpected WebKit region size \(bounds.width) × \(bounds.height), requested \(height)") }
            let scale = min(451.28 / bounds.width, 697.89 / bounds.height)
            context.beginPDFPage(nil); context.saveGState()
            context.translateBy(x: 72, y: media.height - 72 - bounds.height * scale); context.scaleBy(x: scale, y: scale)
            context.translateBy(x: -bounds.minX, y: -bounds.minY); context.drawPDFPage(page)
            context.restoreGState(); context.endPDFPage()
            guard output.length <= 200 * 1024 * 1024 else { throw DocumentExportFailure.tooLarge }
        }
        context.closePDF()
        guard output.length <= 200 * 1024 * 1024 else { throw DocumentExportFailure.tooLarge }; return output as Data
    }
    func writePDF(to url: URL) async throws {
        let data = try await pdfData(); try data.write(to: url, options: .atomic)
    }
    func printDocument(window: NSWindow) async throws {
        printablePDF = PDFDocument(data: try await pdfData())
        guard let operation = printablePDF?.printOperation(for: printInfo(), scalingMode: .pageScaleDownToFit, autoRotate: true) else { throw CocoaError(.fileReadUnknown) }
        operation.showsPrintPanel = true; operation.showsProgressPanel = false
        try await withCheckedThrowingContinuation { continuation in
            printed = continuation; operation.runModal(for: window, delegate: self, didRun: #selector(printFinished(_:success:context:)), contextInfo: nil)
        }
    }
    @objc private func printFinished(_ operation: NSPrintOperation, success: Bool, context: UnsafeMutableRawPointer?) {
        printed?.resume(); printed = nil; printablePDF = nil
    }
    private static let snapshotScript = """
    const article = document.querySelector('article');
    const template = document.createElement('template'); template.innerHTML = html;
    if (template.content.querySelectorAll('img,svg image').length > 512) throw Error('Too many image references');
    for (const node of template.content.querySelectorAll('img,svg image')) {
      const attribute = node.tagName.toLowerCase() === 'img' ? 'src' : node.hasAttribute('href') ? 'href' : 'xlink:href';
      const source = node.getAttribute(attribute) || '';
      if (Object.hasOwn(resourceImages,source)) node.setAttribute(attribute, resourceImages[source]);
      else if (!source.startsWith('data:image/') && !source.startsWith('#')) throw Error('Image outside export permissions');
    }
    article.append(template.content);
    await document.fonts.ready;
    for (const node of article.querySelectorAll('svg image')) { const image = new Image(); image.src = node.getAttribute('href') || node.getAttribute('xlink:href'); await image.decode(); }
    await Promise.all([...article.querySelectorAll('img')].map(image => image.decode()));
    if (!word) {
      const origin = article.getBoundingClientRect().top, height = Math.max(1,article.getBoundingClientRect().height);
      if (height > 930520) throw Error('Document exceeds 1000 output pages');
      const pageHeight = 930.52, intervals = [];
      const walker = document.createTreeWalker(article,NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.height > 0 && rect.height < pageHeight) intervals.push([rect.top-origin,rect.bottom-origin]);
        if (intervals.length > 200000) throw Error('Document layout exceeds output budget');
      }
      for (const element of article.querySelectorAll('img,svg,tr,h1,h2,h3,h4,h5,h6')) {
        const rect = element.getBoundingClientRect();
        let bottom = rect.bottom;
        if (/^H[1-6]$/.test(element.tagName) && element.nextElementSibling) bottom = Math.min(bottom + 32,element.nextElementSibling.getBoundingClientRect().bottom);
        if (bottom - rect.top < pageHeight) intervals.push([rect.top-origin,bottom-origin]);
      }
      intervals.sort((a,b)=>a[0]-b[0]);
      const breaks = [0];
      while (breaks.at(-1) < height) {
        const start = breaks.at(-1); let end = Math.min(start + pageHeight,height);
        for (let retry=0;retry<1000;retry++) { const cuts = intervals.filter(rect=>rect[0] < end-.01 && rect[1] > end+.01); if (!cuts.length) break; const next = Math.min(...cuts.map(rect=>rect[0])); if (next <= start + 1) break; end=next; }
        if (end <= start || breaks.length > 1000) throw Error('Cannot paginate document safely');
        breaks.push(end);
      }
      return {nodes:[],images:[],breaks};
    }
    let pixels = 0, bytes = 0, rasterPixels = 0;
    const budget = (width,height,length) => { pixels += width * height; bytes += length; if (pixels > 32000000 || bytes > 134217728) throw Error('Export images exceed the output budget'); };
    const raster = async image => {
      await image.decode();
      const scale = Math.min(2,2400/Math.max(image.naturalWidth,image.naturalHeight));
      const width = Math.ceil(image.naturalWidth * scale), height = Math.ceil(image.naturalHeight * scale);
      if (!width || !height || width * height + rasterPixels > 32000000) throw Error('Image is invalid or too large');
      rasterPixels += width * height;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(image,0,0,width,height);
      return { src: canvas.toDataURL('image/png'), width, height };
    };
    for (const svg of [...article.querySelectorAll('svg')]) {
      const box = svg.viewBox.baseVal; const width = Math.max(1,Math.ceil(box.width || svg.getBoundingClientRect().width)); const height = Math.max(1,Math.ceil(box.height || svg.getBoundingClientRect().height));
      svg.setAttribute('width',width); svg.setAttribute('height',height); svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
      const image = new Image(); image.alt = svg.getAttribute('aria-label') || 'Mermaid';
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      const output = await raster(image); image.src = output.src; image.width = width; image.height = height; svg.replaceWith(image);
    }
    const images = [], keys = new Map();
    for (const image of article.querySelectorAll('img')) {
      if (keys.has(image.src)) continue;
      await image.decode(); budget(image.naturalWidth,image.naturalHeight,image.src.length);
      const key = 'image-' + (images.length + 1); keys.set(image.src,key);
      images.push({key,data:image.src,width:image.naturalWidth,height:image.naturalHeight});
    }
    await Promise.all([...article.querySelectorAll('img')].map(image => image.decode()));
    const convert = node => {
      if (node.nodeType === Node.TEXT_NODE) return { tag:'#text', text:node.parentElement.closest('pre') ? node.textContent : node.textContent.replace(/[\\t\\r\\n ]+/g,' ') };
      if (!(node instanceof Element)) return null;
      if (node.tagName === 'INPUT') return { tag:'#text', text:node.checked ? '☑ ' : '☐ ' };
      const value = { tag:node.tagName.toLowerCase(), children:[...node.childNodes].map(convert).filter(Boolean) };
      if (value.tag === 'img') { value.src = keys.get(node.src); value.text = node.alt; }
      if (value.tag === 'a') value.href = node.getAttribute('href');
      if (value.tag === 'ol') value.start = Number(node.getAttribute('start') || 1);
      if (node.style.textAlign) value.align = node.style.textAlign;
      return value;
    };
    return {nodes:[...article.childNodes].map(convert).filter(Boolean),images};
    """
}
