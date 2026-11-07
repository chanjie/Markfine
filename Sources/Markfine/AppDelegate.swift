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
    private let workspace = WorkspaceStore()
    private let locationOpenQueue = LocationOpenQueue()
    private let recent = RecentLocations()
    private var recentMenu: NSMenu?
    private var latestWorkspaceRequest: String?
    private var unsupportedFiles: [String: URL] = [:]
    private var images: ImageStore!
    private var gate: BridgeGate { BridgeGate(sessionID: sessionID, capability: capability, documentIDs: Set(documents.keys).union(unsupportedFiles.keys)) }
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
    private let settings = ApplicationSettings()
    private lazy var preferencesController = PreferencesController(settings: settings)
    private var preferences: [String: Any] { settings.values }
    private var readingEnabled = false
    private func l(_ text: String) -> String {
        guard settings.english else { return text }
        if text.hasPrefix("文件操作失败") { return text.replacingOccurrences(of: "文件操作失败", with: "File operation failed").replacingOccurrences(of: "（", with: " (").replacingOccurrences(of: "，", with: ", ").replacingOccurrences(of: "）", with: ")") }
        return nativeEnglish[text] ?? text
    }

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
        webView.allowsMagnification = false
        webView.addGestureRecognizer(NSMagnificationGestureRecognizer(target: self, action: #selector(magnifyContent(_:))))
        configureWindow(); configureMenu(); updateBackground()
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
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0.141, green: 0.169, blue: 0.153, alpha: 1) : NSColor(srgbRed: 0.984, green: 0.988, blue: 0.980, alpha: 1)
        }
        webView.underPageBackgroundColor = window.backgroundColor
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false; window.contentView = webView; window.delegate = self; window.center()
        if !pendingURLs.isEmpty, let screen = window.screen ?? NSScreen.main { window.setFrame(screen.visibleFrame, display: false) }
        self.window = window
    }

    private func configureMenu() {
        let main = NSMenu()
        func menu(_ name: String) -> NSMenu {
            let item = NSMenuItem(); let menu = NSMenu(title: l(name)); item.submenu = menu; main.addItem(item); return menu
        }
        let app = menu("Markfine")
        app.addItem(withTitle: l("关于 Markfine"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        add("首选项…", key: ",", action: "preferences", to: app)
        app.addItem(.separator())
        app.addItem(withTitle: l("隐藏 Markfine"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: l("退出 Markfine"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = menu("文件")
        add("新建", key: "n", action: "new", to: file)
        add("新建标签页", key: "t", action: "new", to: file)
        add("打开…", key: "o", action: "open", to: file)
        let recentItem = NSMenuItem(title: settings.text("打开最近", "Open Recent"), action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(); recentItem.submenu = recentMenu; file.addItem(recentItem); self.recentMenu = recentMenu; updateRecentMenu()
        file.addItem(.separator()); add("保存", key: "s", action: "save", to: file)
        file.addItem(.separator()); add("关闭标签页", key: "w", action: "close", to: file)
        add("关闭窗口", key: "w", modifiers: [.command, .shift], action: "closeWindow", to: file)
        let edit = menu("编辑")
        add("撤销", key: "z", action: "undo", to: edit)
        add("重做", key: "z", modifiers: [.command, .shift], action: "redo", to: edit)
        edit.addItem(.separator())
        for (title, selector, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: l(title), action: Selector(selector), keyEquivalent: key)
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
        let view = menu("显示")
        add("显示／隐藏目录", key: "l", modifiers: [.command, .shift], action: "toggleOutline", to: view)
        add("阅读／编辑模式", key: "r", modifiers: [.command, .shift], action: "toggleReading", to: view)
        add("源码模式", key: "/", action: "toggleSource", to: view)
        add("显示／隐藏行号", key: "n", modifiers: [.command, .shift], action: "toggleLineNumbers", to: view)
        view.addItem(.separator())
        add("放大内容", key: "=", action: "zoomIn", to: view)
        add("放大内容", key: "+", action: "zoomIn", to: view)
        view.items.last?.isHidden = true; view.items.last?.allowsKeyEquivalentWhenHidden = true
        add("缩小内容", key: "-", action: "zoomOut", to: view)
        add("恢复实际大小", key: "0", modifiers: [.command, .option], action: "zoomReset", to: view)
        let windows = menu("窗口")
        windows.addItem(withTitle: l("最小化"), action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        add("下一标签页", key: "\t", modifiers: .control, action: "nextTab", to: windows)
        add("上一标签页", key: "\t", modifiers: [.control, .shift], action: "previousTab", to: windows)
        let help = menu("帮助"); add("快捷键说明", key: "?", action: "help", to: help); NSApp.helpMenu = help
        NSApp.mainMenu = main; NSApp.windowsMenu = windows
    }

    private func add(_ title: String, key: String, modifiers: NSEvent.ModifierFlags = .command, action: String, to menu: NSMenu) {
        let item = NSMenuItem(title: l(title), action: #selector(menuCommand(_:)), keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers; item.target = self; item.representedObject = action; menu.addItem(item)
    }
    @objc private func menuCommand(_ item: NSMenuItem) {
        if let url = item.representedObject as? URL { Task { @MainActor in await openLocation(url) }; return }
        guard let action = item.representedObject as? String else { return }
        if (action == "close" || action == "closeWindow"), preferencesController.closeIfKey() { return }
        if action == "clearRecent" { recent.clear(); updateRecentMenu(); return }
        if action == "preferences" { showPreferences() }
        else if action == "closeWindow" { window?.performClose(nil) }
        else {
            Task { @MainActor in
                do {
                    let handled = try await deliver(["kind": "hostCommand", "action": action]) as? Bool == true
                    if !handled && ["paste", "undo", "redo"].contains(action) { NSApp.sendAction(Selector(action + ":"), to: nil, from: self) }
                } catch { fail("hostDeliveryFailure", error) }
            }
        }
    }

    private func showPreferences() {
        preferencesController.onChange = { [weak self] in self?.preferencesChanged() }; preferencesController.show()
    }
    private func preferencesChanged() {
        emit(["kind": "preferences", "preferences": preferences]); configureMenu(); updateWindowTitle(); updateBackground()
    }
    @objc private func magnifyContent(_ gesture: NSMagnificationGestureRecognizer) {
        guard window != nil else { return }
        let factor = max(0.8, min(1.2, 1 + gesture.magnification)); gesture.magnification = 0
        emit(["kind": "hostCommand", "action": "zoom", "factor": factor])
    }
    private func setReadingMode(_ enabled: Bool) {
        readingEnabled = enabled
        guard let window else { return }
        if enabled { window.styleMask.insert(.fullSizeContentView) } else { window.styleMask.remove(.fullSizeContentView) }
        window.titleVisibility = enabled ? .hidden : .visible
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(button)?.isHidden = enabled }
        updateBackground()
    }
    private func updateBackground() {
        let theme = preferences[readingEnabled ? "readTheme" : "editTheme"] as? String ?? "paper"
        let color: NSColor = theme == "kraft" ? NSColor(srgbRed: 0.945, green: 0.886, blue: 0.776, alpha: 1) :
            theme == "eye" ? NSColor(srgbRed: 0.898, green: 0.933, blue: 0.890, alpha: 1) : NSColor(srgbRed: 0.984, green: 0.980, blue: 0.969, alpha: 1)
        window?.backgroundColor = color; webView.underPageBackgroundColor = color
    }
    private func openLink(_ command: [String: Any]) {
        guard let id = command["documentID"] as? String, let metadata = documents[id], let href = command["href"] as? String else { return }
        do {
            let target = try ExternalLink.destination(href, documentURL: metadata.url)
            if target.isFileURL {
                let values = try target.resourceValues(forKeys: [.isRegularFileKey, .isPackageKey, .contentTypeKey])
                guard values.isRegularFile == true, values.isPackage != true, values.contentType?.conforms(to: .executable) != true else { throw ExternalLinkFailure.executable }
            }
            if !NSWorkspace.shared.open(target) { throw ExternalLinkFailure.unavailable }
        } catch { notice(settings.text("无法打开链接：文件不存在、路径无效或目标不安全。", "Cannot open link: the file is missing, the path is invalid, or the destination is unsafe.")) }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if !initialLoadFinished { pendingURLs += urls; if let screen = window?.screen ?? NSScreen.main { window?.setFrame(screen.visibleFrame, display: false) }; return }
        for url in urls { Task { @MainActor in await openLocation(url) } }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.deminiaturize(nil); window?.makeKeyAndOrderFront(nil) }; return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func initializeEditor() async throws {
        let info = try JSONSerialization.jsonObject(with: JSONEncoder().encode(resources.info))
        _ = try await deliver(["kind": "initialize", "build": info, "preferences": preferences])
        let urls = pendingURLs; pendingURLs.removeAll()
        for url in urls { await openLocation(url) }
        initialLoadFinished = true
        let late = pendingURLs; pendingURLs.removeAll()
        for url in late { await openLocation(url) }
        _ = try await deliver(["kind": "initialReady"])
    }

    private func register(_ loaded: FileDocumentLoad, preview: Bool = false, openRequestID: String = "") async throws {
        let metadata = loaded.document
        documents[metadata.id] = metadata
        try await images.register(metadata.id, url: metadata.url)
        if let markdown = loaded.markdown {
            states[metadata.id] = (0, false, false)
            _ = try await deliver(["kind": "load", "documentID": metadata.id, "title": metadata.title, "path": metadata.url?.path ?? "", "markdown": markdown, "preview": preview, "openRequestID": openRequestID])
        } else { _ = try await deliver(["kind": "activate", "documentID": metadata.id, "pin": !preview, "openRequestID": openRequestID]) }
    }
    private func createDocument() async {
        guard closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        do { try await register(store.create()) } catch { fail("newDocumentFailure", error) }
    }
    private func openDocument(_ url: URL) async {
        guard closeRequest == nil else { notice(settings.text("请先完成当前关闭操作", "Finish the current close operation first")); return }
        opening += 1; defer { opening -= 1 }
        do { try await register(store.open(url)) } catch { notice(settings.text("无法打开文档：", "Cannot open document: ") + l(String(describing: error))) }
    }
    private func updateRecentMenu() {
        guard let menu = recentMenu else { return }; menu.removeAllItems()
        for url in recent.urls {
            let item = NSMenuItem(title: url.lastPathComponent + " — " + url.deletingLastPathComponent().lastPathComponent, action: #selector(menuCommand(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = url; item.toolTip = url.path; menu.addItem(item)
        }
        if menu.items.isEmpty { let item = NSMenuItem(title: settings.text("暂无最近记录", "No recent locations"), action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item) }
        menu.addItem(.separator()); add(settings.text("清空最近记录", "Clear Recent"), key: "", action: "clearRecent", to: menu)
    }
    private func openLocation(_ url: URL, preview: Bool = false, requestID: String = "", workspaceEntry: (id: String, generation: String)? = nil) async {
        guard closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        await locationOpenQueue.perform { await self.performOpenLocation(url, preview: preview, requestID: requestID, workspaceEntry: workspaceEntry) }
    }
    private func performOpenLocation(_ url: URL, preview: Bool, requestID: String, workspaceEntry: (id: String, generation: String)?) async {
        guard closeRequest == nil else { return }
        do {
            if !requestID.isEmpty && latestWorkspaceRequest != requestID { return }
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isPackageKey])
            if values.isDirectory == true && values.isPackage != true {
                latestWorkspaceRequest = nil
                let snapshot = try await workspace.open(url)
                let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
                recent.note(url); updateRecentMenu(); _ = try await deliver(["kind": "workspace", "workspace": value]); return
            }
            guard values.isRegularFile == true else { throw WorkspaceFailure.unavailable }
            if WorkspaceStore.isMarkdown(url) {
                let loaded = try await store.open(url)
                if let entry = workspaceEntry, loaded.markdown != nil {
                    do {
                        guard let identity = loaded.document.identity else { throw WorkspaceFailure.stale }
                        try await workspace.verifyFile(entry.id, generation: entry.generation, identity: identity)
                    } catch { if loaded.markdown != nil { try? await store.closeDocument(loaded.document.id) }; throw error }
                }
                if !requestID.isEmpty && (latestWorkspaceRequest != requestID || loaded.document.url?.path != url.standardizedFileURL.path) {
                    if loaded.markdown != nil { try? await store.closeDocument(loaded.document.id) }; return
                }
                try await register(loaded, preview: preview, openRequestID: requestID)
            } else {
                let existing = unsupportedFiles.first { $0.value.standardizedFileURL == url.standardizedFileURL }?.key
                let id = existing ?? UUID().uuidString; unsupportedFiles[id] = url; states[id] = (0, false, false)
                if existing != nil { _ = try await deliver(["kind": "activate", "documentID": id, "openRequestID": requestID]) }
                else { _ = try await deliver(["kind": "load", "documentID": id, "title": url.lastPathComponent, "path": url.path, "markdown": "", "unsupported": true, "preview": true, "openRequestID": requestID]) }
            }
            recent.note(url); updateRecentMenu()
        } catch {
            if !requestID.isEmpty && latestWorkspaceRequest != requestID { return }
            if !requestID.isEmpty { emit(["kind": "openFailed", "openRequestID": requestID]) }
            notice(settings.text("无法打开文件或文件夹：", "Cannot open file or folder: ") + l(String(describing: error)))
        }
    }
    private func workspaceChildren(_ command: [String: Any]) async {
        do {
            let entries = try await workspace.children(command["folderID"] as! String, generation: command["generation"] as! String, showAll: command["showAll"] as! Bool)
            let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entries))
            emit(["kind": "workspaceChildren", "folderID": command["folderID"]!, "generation": command["generation"]!, "requestID": command["requestID"]!, "entries": value])
        } catch { emit(["kind": "workspaceChildren", "folderID": command["folderID"]!, "generation": command["generation"]!, "requestID": command["requestID"]!, "entries": [], "error": settings.text("目录不可用或已改变", "Folder unavailable or changed")]) }
    }
    private func openWorkspaceEntry(_ command: [String: Any]) async {
        let request = command["requestID"] as! String
        do {
            let url = try await workspace.file(command["entryID"] as! String, generation: command["generation"] as! String)
            if latestWorkspaceRequest == request { await openLocation(url, preview: true, requestID: request, workspaceEntry: (command["entryID"] as! String, command["generation"] as! String)) }
        } catch { if latestWorkspaceRequest == request { emit(["kind": "openFailed", "openRequestID": request]); notice(settings.text("文件不存在、无权限或链接越界", "File missing, inaccessible or outside the chosen folder")) } }
    }
    private func chooseOpen() async {
        guard let window, closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText, .plainText]
        panel.allowsOtherFileTypes = true; panel.canChooseDirectories = true; panel.canChooseFiles = true; panel.allowsMultipleSelection = true
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        if response == .OK { for url in panel.urls { await openLocation(url) } }
    }
    private func chooseSave(_ metadata: FileDocumentMetadata) async -> URL? {
        guard let window else { return nil }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = l("未命名.md"); panel.canCreateDirectories = true; panel.isExtensionHidden = false
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        return response == .OK ? panel.url : nil // NSSavePanel performs its standard replacement confirmation.
    }

    private func save(_ command: [String: Any]) async {
        let id = command["documentID"] as! String, requestID = command["requestID"] as! String, revision = command["revision"] as! Int
        var receipt: [String: Any] = ["kind": "saveReceipt", "documentID": id, "requestID": requestID, "revision": revision, "outcome": "failure"]
        guard let metadata = documents[id], !saving.contains(id), pasteTask?.documentID != id else {
            receipt["error"] = settings.text("该文档有未完成的文件/图片操作", "This document has an unfinished file or image operation"); emit(receipt); return
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
            receipt["savedAt"] = Date().timeIntervalSince1970 * 1000
            if let url = saved.url {
                do { try await images.setURL(id, url: url) }
                catch { receipt["error"] = settings.text("正文已保存，但图片预览上下文未更新：", "Document saved, but the image preview context could not be updated: ") + l(String(describing: error)) }
            }
            updateWindowTitle()
        } catch {
            receipt["error"] = l(String(describing: error))
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
            emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": settings.text("请先等待当前保存或图片任务完成", "Wait for the current save or image operation to finish")]); return
        }
        let input: ClipboardInput
        let pasteboard = NSPasteboard.general // Read only in response to a user-initiated paste.
        let changeCount = pasteboard.changeCount
        input = ClipboardInput(png: pasteboard.data(forType: .png), jpeg: pasteboard.data(forType: NSPasteboard.PasteboardType("public.jpeg")),
                               tiff: pasteboard.data(forType: .tiff), text: pasteboard.string(forType: .string))
        guard pasteboard.changeCount == changeCount else {
            emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": settings.text("读取期间剪贴板已变化，请重新粘贴", "The clipboard changed while reading. Please paste again")]); return
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
            catch { receipt["error"] = self.l(String(describing: error)) }
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
            do { if unsupportedFiles[id] != nil { unsupportedFiles[id] = nil } else { try await store.closeDocument(id); await images.closeDocument(id) }; documents[id] = nil; states[id] = nil; approved = true }
            catch { notice(l(String(describing: error))) }
        }
        emit(["kind": "closeReceipt", "documentID": id, "requestID": request, "permitted": approved])
    }
    private func requestCloseAll(terminating: Bool) {
        guard ready, opening == 0, saving.isEmpty, pasteTask == nil else { notice(settings.text("请先等待保存或图片任务完成，或取消图片任务，再关闭/退出", "Wait for saving or image processing, or cancel the image operation before closing / quitting")); return }
        if let current = closeRequest { if terminating { closeRequest = (current.id, true) }; return }
        let request = UUID().uuidString; closeRequest = (request, terminating)
        emit(["kind": "hostCommand", "action": "closeAll", "requestID": request])
    }
    private func finishCloseAll(_ command: [String: Any]) async {
        guard let request = closeRequest, request.id == command["requestID"] as? String else { return }
        let items = command["documents"] as! [[String: Any]]
        let ids = items.compactMap { $0["documentID"] as? String }
        var permitted = command["permitted"] as? Bool == true && saving.isEmpty && pasteTask == nil && opening == 0 &&
            Set(ids) == Set(documents.keys).union(unsupportedFiles.keys) && ids.count == documents.count + unsupportedFiles.count && items.allSatisfy { states[$0["documentID"] as! String]?.revision == $0["revision"] as? Int && states[$0["documentID"] as! String]?.pending == false }
        if permitted {
            do {
                try await store.closeDocuments(ids.filter { documents[$0] != nil })
                await images.finish(); documents.removeAll(); unsupportedFiles.removeAll(); states.removeAll()
            } catch { permitted = false; notice(l(String(describing: error))) }
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
        guard opening == 0, saving.isEmpty, pasteTask == nil else { notice(settings.text("请先等待保存或图片任务完成，或取消图片任务", "Wait for saving or image processing, or cancel the image operation")); return .terminateCancel }
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
            case "closeEmptyWindow": if documents.isEmpty && unsupportedFiles.isEmpty && initialLoadFinished { requestCloseAll(terminating: false) }
            case "workspaceChildren": Task { @MainActor in await workspaceChildren(command) }
            case "openWorkspaceEntry":
                latestWorkspaceRequest = command["requestID"] as? String
                Task { @MainActor in await openWorkspaceEntry(command) }
            case "openUnsupported":
                if let url = unsupportedFiles[command["documentID"] as! String] {
                    do {
                        let target = try ExternalLink.destination(url.absoluteString, documentURL: nil)
                        let values = try target.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey])
                        guard values.isRegularFile == true, values.contentType?.conforms(to: .executable) != true else { throw ExternalLinkFailure.executable }
                        if !NSWorkspace.shared.open(target) { throw ExternalLinkFailure.unavailable }
                    } catch { notice(settings.text("无法安全地打开此文件", "This file cannot be opened safely")) }
                }
            case "readingMode": setReadingMode(command["enabled"] as! Bool)
            case "openLink": openLink(command)
            case "setPreference":
                let key = command["key"] as! String
                if settings.set(key, command["value"]!) {
                    if key == "language" { configureMenu(); updateWindowTitle() }
                    // The editor already applied its own validated change. Do not echo an older zoom snapshot over a live gesture.
                    updateBackground(); if !["editZoom", "readZoom", "outlineWidth"].contains(key) { preferencesController.refresh() }
                }
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
        let unsupported = activeDocumentID.flatMap { unsupportedFiles[$0] }
        window?.title = metadata.map { ($0.url == nil ? l("未命名") : $0.title) + " — Markfine" } ?? unsupported.map { $0.lastPathComponent + " — Markfine" } ?? "Markfine"
        window?.representedURL = metadata?.url ?? unsupported
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
        return .cancel
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { fail("navigationFailure", error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("webProcessTerminated", nil) }
    private func fail(_ event: String, _ error: Error?) {
        log(event, ["error": error.map(String.init(describing:)) ?? "operation failed"])
        if event == "webProcessTerminated" || event == "hostDeliveryFailure" { webFailed = true }
        if ready && !webFailed { notice(settings.text("操作未完成，当前编辑请勿关闭：", "Operation incomplete. Keep your current document open: ") + (error.map(String.init(describing:)) ?? event)) }
        else if let window, window.attachedSheet == nil {
            let alert = NSAlert(); alert.messageText = settings.text("编辑器发生异常", "Editor error"); alert.informativeText = settings.text("磁盘文件没有因此被覆盖。尚未保存的内容无法保证恢复，请不要继续覆盖原文件。", "Disk files have not been overwritten. Unsaved changes may not be recoverable. Do not overwrite the original file.") + "\n" + event
            alert.beginSheetModal(for: window)
        }
    }
    private func log(_ event: String, _ fields: [String: Any]) {
        var object = fields; object["event"] = event
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        print(String(decoding: data, as: UTF8.self)); fflush(stdout)
    }
}
