import AppKit
import Darwin
import MarkfineCore
import UniformTypeIdentifiers
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let resources: EditorResources
    private let sessionID = UUID().uuidString
    private let capability = UUID().uuidString + UUID().uuidString
    private let world = WKContentWorld.world(name: "Markfine.TrustedEditor")
    private let store = FileDocumentStore()
    private var images: ImageStore!
    private var gate: BridgeGate { BridgeGate(sessionID: sessionID, capability: capability, documentIDs: Set(documents.keys)) }
    private var documents: [String: FileDocumentMetadata] = [:]
    private var states: [String: (revision: Int, dirty: Bool, pending: Bool)] = [:]
    private var saving: Set<String> = []
    private var opening = 0
    private var pendingURLs: [URL] = []
    private var webView: WKWebView!
    private var window: NSWindow?
    private var ready = false
    private var initialLoadFinished = false
    private var mermaidLoaded = false
    private var closeApproved = false
    private var closeRequest: (id: String, terminating: Bool)?
    private var pasteTask: (id: String, documentID: String, task: Task<Void, Never>)?
    private var activeDocumentID: String?
    private var webFailed = false
    private var ruleRoot: URL?

    init(resources: EditorResources) { self.resources = resources }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in do { try await start() } catch { fail("startupFailure", error) } }
    }

    private func start() async throws {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Markfine", isDirectory: true)
        images = try ImageStore(root: base.appendingPathComponent("Staging", isDirectory: true), sessionID: sessionID)
        await images.cleanStaleSessions()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(EditorScheme(resources: resources, images: images), forURLScheme: "markfine")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(self, contentWorld: world, name: "markfine")
        let context: [String: Any] = ["protocolVersion": 1, "sessionID": sessionID, "capability": capability]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: context), as: UTF8.self)
        configuration.userContentController.addUserScript(WKUserScript(
            source: "globalThis.__markfineBootstrap = \(json);\n" + String(decoding: try resources.data("app.js"), as: UTF8.self),
            injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 760), configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        configureWindow(); configureMenu()
        let cache = FileManager.default.temporaryDirectory.appendingPathComponent("Markfine-rules-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        ruleRoot = cache
        let rules = """
        [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}}]
        """
        let list: WKContentRuleList = try await withCheckedThrowingContinuation { continuation in
            WKContentRuleListStore(url: cache).compileContentRuleList(forIdentifier: "MarkfineNoNetwork", encodedContentRuleList: rules) { list, error in
                if let list { continuation.resume(returning: list) }
                else { continuation.resume(throwing: error ?? ImageStoreFailure.unavailable) }
            }
        }
        webView.configuration.userContentController.add(list)
        webView.load(URLRequest(url: EditorScheme.page))
        window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    private func configureWindow() {
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Markfine"
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false; window.contentView = webView; window.delegate = self; window.center()
        self.window = window
    }

    private func configureMenu() {
        let main = NSMenu()
        func menu(_ name: String) -> NSMenu {
            let item = NSMenuItem(); let menu = NSMenu(title: name); item.submenu = menu; main.addItem(item); return menu
        }
        let app = menu("Markfine")
        app.addItem(withTitle: "关于 Markfine", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "隐藏 Markfine", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "退出 Markfine", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = menu("文件")
        add("新建", key: "n", action: "new", to: file)
        add("新建标签页", key: "t", action: "new", to: file)
        add("打开…", key: "o", action: "open", to: file)
        file.addItem(.separator()); add("保存", key: "s", action: "save", to: file)
        file.addItem(.separator()); add("关闭标签页", key: "w", action: "close", to: file)
        add("关闭窗口", key: "w", modifiers: [.command, .shift], action: "closeWindow", to: file)
        let edit = menu("编辑")
        add("撤销", key: "z", action: "undo", to: edit)
        add("重做", key: "z", modifiers: [.command, .shift], action: "redo", to: edit)
        edit.addItem(.separator())
        for (title, selector, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        add("粘贴", key: "v", action: "paste", to: edit)
        edit.addItem(.separator())
        add("查找", key: "f", action: "find", to: edit)
        add("显示替换", key: "f", modifiers: [.command, .option], action: "replace", to: edit)
        add("下一个匹配", key: "g", action: "findNext", to: edit)
        add("上一个匹配", key: "g", modifiers: [.command, .shift], action: "findPrevious", to: edit)
        let format = menu("格式")
        for level in 1...6 { add("标题 \(level)", key: String(level), action: "heading\(level)", to: format) }
        add("普通段落", key: "0", action: "heading0", to: format)
        format.addItem(.separator())
        for (title, key, modifiers, action) in [
            ("加粗", "b", NSEvent.ModifierFlags.command, "bold"), ("斜体", "i", .command, "italic"),
            ("行内代码", "k", [.command, .option], "inlineCode"), ("删除线", "`", [.control, .shift], "strike"),
            ("链接", "k", .command, "link"), ("图片引用", "i", [.command, .control], "image"),
            ("代码块", "c", [.command, .option], "codeBlock"), ("引用块", "q", [.command, .option], "quote"),
            ("有序列表", "o", [.command, .option], "ordered"), ("无序列表", "u", [.command, .option], "unordered"),
            ("任务列表", "x", [.command, .option], "task"), ("表格", "t", [.command, .option], "table"),
            ("增加缩进", "]", .command, "indent"), ("减少缩进", "[", .command, "outdent")
        ] { add(title, key: key, modifiers: modifiers, action: action, to: format) }
        let windows = menu("窗口")
        windows.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        add("下一标签页", key: "\t", modifiers: .control, action: "nextTab", to: windows)
        add("上一标签页", key: "\t", modifiers: [.control, .shift], action: "previousTab", to: windows)
        NSApp.mainMenu = main; NSApp.windowsMenu = windows
    }

    private func add(_ title: String, key: String, modifiers: NSEvent.ModifierFlags = .command, action: String, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: #selector(menuCommand(_:)), keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers; item.target = self; item.representedObject = action; menu.addItem(item)
    }
    @objc private func menuCommand(_ item: NSMenuItem) {
        guard let action = item.representedObject as? String else { return }
        if action == "closeWindow" { window?.performClose(nil) }
        else {
            Task { @MainActor in
                do {
                    let handled = try await deliver(["kind": "hostCommand", "action": action]) as? Bool == true
                    if !handled && ["paste", "undo", "redo"].contains(action) { NSApp.sendAction(Selector(action + ":"), to: nil, from: self) }
                } catch { fail("hostDeliveryFailure", error) }
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if !initialLoadFinished { pendingURLs += urls; return }
        for url in urls { Task { @MainActor in await openDocument(url) } }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.deminiaturize(nil); window?.makeKeyAndOrderFront(nil) }; return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func initializeEditor() async throws {
        let info = try JSONSerialization.jsonObject(with: JSONEncoder().encode(resources.info))
        _ = try await deliver(["kind": "initialize", "build": info])
        let urls = pendingURLs; pendingURLs.removeAll()
        if urls.isEmpty { await createDocument() } else { for url in urls { await openDocument(url) } }
        initialLoadFinished = true
        let late = pendingURLs; pendingURLs.removeAll()
        for url in late { await openDocument(url) }
        _ = try await deliver(["kind": "initialReady"])
    }

    private func register(_ loaded: FileDocumentLoad) async throws {
        let metadata = loaded.document
        documents[metadata.id] = metadata
        try await images.register(metadata.id, url: metadata.url)
        if let markdown = loaded.markdown {
            states[metadata.id] = (0, false, false)
            _ = try await deliver(["kind": "load", "documentID": metadata.id, "title": metadata.title, "path": metadata.url?.path ?? "", "markdown": markdown])
        } else { _ = try await deliver(["kind": "activate", "documentID": metadata.id]) }
    }
    private func createDocument() async {
        guard closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        do { try await register(store.create()) } catch { fail("newDocumentFailure", error) }
    }
    private func openDocument(_ url: URL) async {
        guard closeRequest == nil else { notice("请先完成当前关闭操作"); return }
        opening += 1; defer { opening -= 1 }
        do { try await register(store.open(url)) } catch { notice("无法打开文档：\(error)") }
    }
    private func chooseOpen() async {
        guard let window, closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText, .plainText]
        panel.allowsOtherFileTypes = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = true
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        if response == .OK { for url in panel.urls { await openDocument(url) } }
    }
    private func chooseSave(_ metadata: FileDocumentMetadata) async -> URL? {
        guard let window else { return nil }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = "未命名.md"; panel.canCreateDirectories = true; panel.isExtensionHidden = false
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        return response == .OK ? panel.url : nil // NSSavePanel performs its standard replacement confirmation.
    }

    private func save(_ command: [String: Any]) async {
        let id = command["documentID"] as! String, requestID = command["requestID"] as! String, revision = command["revision"] as! Int
        var receipt: [String: Any] = ["kind": "saveReceipt", "documentID": id, "requestID": requestID, "revision": revision, "outcome": "failure"]
        guard let metadata = documents[id], !saving.contains(id), pasteTask?.documentID != id else {
            receipt["error"] = "该文档有未完成的文件/图片操作"; emit(receipt); return
        }
        saving.insert(id); defer { saving.remove(id) }
        do {
            let firstTarget: FirstSaveTarget?
            let targetURL: URL
            if let url = metadata.url { firstTarget = nil; targetURL = url }
            else {
                guard let url = await chooseSave(metadata) else { receipt["outcome"] = "cancelled"; emit(receipt); return }
                let target = FirstSaveTarget(url: url, replacementConfirmed: true)
                let prepared = try await store.prepareFirstTarget(id, target: target)
                targetURL = prepared.url; firstTarget = prepared
            }
            let snapshot = command["snapshot"] as! String
            let references: [String]
            if snapshot.contains("markfine-staging/") {
                references = try await evaluate("return globalThis.markfine.stagedReferences(snapshot)", arguments: ["snapshot": snapshot]) as? [String] ?? []
            } else { references = [] }
            let migration = try await images.migrate(id, to: targetURL, references: references)
            let normalized: String
            if migration.isEmpty { normalized = snapshot }
            else {
                guard let result = try await evaluate("return globalThis.markfine.prepareSnapshot(snapshot, mapping)", arguments: ["snapshot": snapshot, "mapping": migration]) as? String else { throw BridgeFailure.malformed }
                normalized = result
            }
            let request = FileSaveRequest(documentID: id, requestID: requestID, revision: revision, snapshot: normalized)
            let saved = try await store.save(request, firstTarget: firstTarget)
            documents[id] = saved
            receipt["outcome"] = "success"; receipt["title"] = saved.title; receipt["path"] = saved.url?.path ?? ""; receipt["migration"] = migration
            if let url = saved.url {
                do { try await images.setURL(id, url: url) }
                catch { receipt["error"] = "正文已保存，但图片预览上下文未更新：\(error)" }
            }
            updateWindowTitle()
        } catch {
            receipt["error"] = String(describing: error)
            if let failure = error as? FileStoreFailure {
                if failure == .externalChange || failure == .targetAlreadyOpen { receipt["outcome"] = "conflict" }
                if failure == .commitUnconfirmed { receipt["outcome"] = "unconfirmed" }
            }
        }
        // Clear native slot before delivering a receipt that can enqueue the next real snapshot.
        saving.remove(id)
        emit(receipt)
    }

    private func startPaste(_ command: [String: Any]) {
        let id = command["documentID"] as! String, requestID = command["requestID"] as! String
        guard pasteTask == nil, !saving.contains(id), closeRequest == nil else {
            emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": "请先等待当前保存或图片任务完成"]); return
        }
        let input: ClipboardInput
        let pasteboard = NSPasteboard.general // Read only in response to a user-initiated paste.
        let changeCount = pasteboard.changeCount
        input = ClipboardInput(png: pasteboard.data(forType: .png), jpeg: pasteboard.data(forType: NSPasteboard.PasteboardType("public.jpeg")),
                               tiff: pasteboard.data(forType: .tiff), text: pasteboard.string(forType: .string))
        guard pasteboard.changeCount == changeCount else {
            emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": "读取期间剪贴板已变化，请重新粘贴"]); return
        }
        let task = Task { @MainActor in
            var receipt: [String: Any] = ["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure"]
            do {
                let result = try await self.images.paste(input, documentID: id)
                try Task.checkCancellation()
                receipt["outcome"] = "success"
                if let reference = result.reference { receipt["reference"] = reference }
                if let text = result.text { receipt["text"] = text }
            } catch is CancellationError { receipt["outcome"] = "cancelled" }
            catch { receipt["error"] = String(describing: error) }
            guard self.pasteTask?.id == requestID else { return }
            self.pasteTask = nil
            self.emit(receipt)
        }
        pasteTask = (requestID, id, task)
    }

    private func closeDocument(_ command: [String: Any]) async {
        let id = command["documentID"] as! String, request = command["requestID"] as! String, revision = command["revision"] as! Int
        var approved = false
        if !saving.contains(id), pasteTask?.documentID != id, states[id]?.revision == revision, states[id]?.pending == false {
            do { try await store.closeDocument(id); await images.closeDocument(id); documents[id] = nil; states[id] = nil; approved = true }
            catch { notice(String(describing: error)) }
        }
        emit(["kind": "closeReceipt", "documentID": id, "requestID": request, "permitted": approved])
    }
    private func requestCloseAll(terminating: Bool) {
        guard ready, opening == 0, saving.isEmpty, pasteTask == nil else { notice("请先等待保存或图片任务完成，或取消图片任务，再关闭/退出"); return }
        if let current = closeRequest { if terminating { closeRequest = (current.id, true) }; return }
        let request = UUID().uuidString; closeRequest = (request, terminating)
        emit(["kind": "hostCommand", "action": "closeAll", "requestID": request])
    }
    private func finishCloseAll(_ command: [String: Any]) async {
        guard let request = closeRequest, request.id == command["requestID"] as? String else { return }
        let items = command["documents"] as! [[String: Any]]
        let ids = items.compactMap { $0["documentID"] as? String }
        var permitted = command["permitted"] as? Bool == true && saving.isEmpty && pasteTask == nil && opening == 0 &&
            Set(ids) == Set(documents.keys) && ids.count == documents.count && items.allSatisfy { states[$0["documentID"] as! String]?.revision == $0["revision"] as? Int && states[$0["documentID"] as! String]?.pending == false }
        if permitted {
            do {
                try await store.closeDocuments(ids)
                await images.finish(); documents.removeAll(); states.removeAll()
            } catch { permitted = false; notice(String(describing: error)) }
        }
        let terminating = closeRequest?.terminating ?? request.terminating
        closeRequest = nil
        if permitted { closeApproved = true }
        emit(["kind": "closeAllReceipt", "requestID": request.id, "permitted": permitted])
        if terminating { NSApp.reply(toApplicationShouldTerminate: permitted) }
        else if permitted { window?.close(); NSApp.terminate(nil) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeApproved { return true }; requestCloseAll(terminating: false); return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closeApproved || (!ready && documents.isEmpty && opening == 0) { return .terminateNow }
        guard opening == 0, saving.isEmpty, pasteTask == nil else { notice("请先等待保存或图片任务完成，或取消图片任务"); return .terminateCancel }
        requestCloseAll(terminating: true)
        return closeRequest == nil ? .terminateCancel : .terminateLater
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame, message.frameInfo.request.url == EditorScheme.page, message.world == world else {
            fail("rejectedTransport", nil); return
        }
        do {
            let command = try gate.decode(message.body)
            switch command["kind"] as? String {
            case "ready":
                guard !ready else { throw BridgeFailure.malformed }; ready = true
                Task { @MainActor in do { try await initializeEditor() } catch { fail("initializeFailure", error) } }
            case "new": Task { @MainActor in await createDocument() }
            case "open": Task { @MainActor in await chooseOpen() }
            case "save": Task { @MainActor in await save(command) }
            case "state":
                let id = command["documentID"] as! String, revision = command["revision"] as! Int
                guard revision >= (states[id]?.revision ?? 0) else { throw BridgeFailure.malformed }
                states[id] = (revision, command["dirty"] as! Bool, command["pending"] as! Bool)
                updateWindowTitle()
            case "activeDocument": activeDocumentID = command["documentID"] as? String; updateWindowTitle()
            case "closeDocument": Task { @MainActor in await closeDocument(command) }
            case "closeAllResult": Task { @MainActor in await finishCloseAll(command) }
            case "paste": startPaste(command)
            case "cancelPaste":
                if pasteTask?.id == command["requestID"] as? String && pasteTask?.documentID == command["documentID"] as? String { pasteTask?.task.cancel() }
            case "loadMermaid":
                if mermaidLoaded { emit(["kind": "mermaidReady"]); return }
                mermaidLoaded = true
                let script = String(decoding: try resources.data("mermaid-runtime.js"), as: UTF8.self)
                webView.evaluateJavaScript(script, in: nil, in: world) { [weak self] result in
                    Task { @MainActor in
                        switch result {
                        case .success: self?.emit(["kind": "mermaidReady"])
                        case .failure(let error): self?.emit(["kind": "mermaidFailed", "error": String(describing: error)])
                        }
                    }
                }
            default: throw BridgeFailure.malformed
            }
        } catch { fail("rejectedBridgeMessage", error) }
    }

    private func notice(_ text: String) { emit(["kind": "notice", "text": text]) }
    private func updateWindowTitle() {
        let metadata = activeDocumentID.flatMap { documents[$0] }
        window?.title = metadata.map { $0.title + " — Markfine" } ?? "Markfine"
        window?.representedURL = metadata?.url
        window?.isDocumentEdited = activeDocumentID.flatMap { states[$0]?.dirty } ?? false
    }
    private func emit(_ fields: [String: Any]) {
        Task { @MainActor in do { _ = try await deliver(fields) } catch { fail("hostDeliveryFailure", error) } }
    }
    private func deliver(_ fields: [String: Any]) async throws -> Any {
        var payload = fields; payload["protocolVersion"] = 1; payload["sessionID"] = sessionID
        return try await evaluate("return globalThis.markfine.receive(message)", arguments: ["message": payload])
    }
    private func evaluate(_ body: String, arguments: [String: Any], contentWorld: WKContentWorld? = nil) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: contentWorld ?? world) { continuation.resume(with: $0) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.request.url == EditorScheme.page, navigationAction.targetFrame?.isMainFrame == true, navigationAction.navigationType == .other, !ready { return .allow }
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
           ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil { NSWorkspace.shared.open(url) }
        return .cancel
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { fail("navigationFailure", error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("webProcessTerminated", nil) }
    private func fail(_ event: String, _ error: Error?) {
        log(event, ["error": error.map(String.init(describing:)) ?? "operation failed"])
        if event == "webProcessTerminated" || event == "hostDeliveryFailure" { webFailed = true }
        if ready && !webFailed { notice("操作未完成，当前编辑请勿关闭：\(error.map(String.init(describing:)) ?? event)") }
        else if let window, window.attachedSheet == nil {
            let alert = NSAlert(); alert.messageText = "编辑器发生异常"; alert.informativeText = "磁盘文件没有因此被覆盖。尚未保存的内容无法保证恢复，请不要继续覆盖原文件。\n\(event)"
            alert.beginSheetModal(for: window)
        }
    }
    private func log(_ event: String, _ fields: [String: Any]) {
        var object = fields; object["event"] = event
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        print(String(decoding: data, as: UTF8.self)); fflush(stdout)
    }
}
