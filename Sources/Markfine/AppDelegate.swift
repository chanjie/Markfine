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
    private let positions = ReadingPositions()
    private var pendingPositions: [String: ReadingPosition] = [:]
    private var recentIDs: [String: URL] = [:]
    private var runtime: RuntimeDataStore!
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
    private var pasteRun = UUID()
    private var retryInput: ClipboardInput?
    private var retryCommand: [String: Any]?
    private var pasteUsesS3 = false
    private var pasteAwaitingDecision = false
    private var copying: Set<String> = []
    private var copiedRequests: [String] = []
    private var clipboardGeneration = UUID()
    private struct CopyReservation { let documentID: String; let generation: UUID; let changeCount: Int }
    private var copyTickets: [String: CopyReservation] = [:]
    private var activeDocumentID: String?
    private var webFailed = false
    private var ruleRoot: URL?
    private let settings = ApplicationSettings()
    private let imageStorage = S3Settings(vault: KeychainVault())
    private var remoteImages: S3ImageService!
    private lazy var preferencesController = PreferencesController(settings: settings, storage: imageStorage)
    private lazy var outputController = DocumentOutputController(settings: settings)
    private let notifications = ExportNotifications()
    private var pendingExportLocationNotice = false
    private var pendingExportReveal: URL?
    private var preferences: [String: Any] { settings.values }
    private var readingEnabled = false
    private let windowPaper = WindowPaper()
    private var physicalShortcutMonitor: Any?
    private func l(_ text: String) -> String {
        guard settings.english else { return text }
        if text.hasPrefix("文件操作失败") { return text.replacingOccurrences(of: "文件操作失败", with: "File operation failed").replacingOccurrences(of: "（", with: " (").replacingOccurrences(of: "，", with: ", ").replacingOccurrences(of: "）", with: ")") }
        return nativeEnglish[text] ?? text
    }

    init(resources: EditorResources) { self.resources = resources }

    func prepareNotifications() {
        notifications.unavailable = { [weak self] in
            guard let self else { return }
            if self.ready { self.notice(self.settings.text("导出文件已移动或不可用。", "The exported file has moved or is unavailable.")) }
            else { self.pendingExportLocationNotice = true }
        }
        notifications.reveal = { [weak self] url in
            guard let self else { return }
            if self.initialLoadFinished { self.revealExport(url) } else { self.pendingExportReveal = url }
        }
        notifications.activate()
    }
    private func revealExport(_ url: URL) {
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            notice(settings.text("导出文件已移动或不可用。", "The exported file has moved or is unavailable.")); return
        }
        FinderReveal.show(url)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in do { try await start() } catch { fail("startupFailure", error) } }
    }

    private func start() async throws {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Markfine", isDirectory: true)
        runtime = try RuntimeDataStore(url: base.appendingPathComponent("Runtime", isDirectory: true))
        notifications.diagnostic = { [weak self] event, error in self?.record(event, error, level: "warning") }
        images = try ImageStore(root: base.appendingPathComponent("Staging", isDirectory: true), sessionID: sessionID)
        remoteImages = S3ImageService(settings: imageStorage, images: images)
        await images.cleanStaleSessions()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // This WebView displays only our offline page, never browses the web. Disable the
        // optional website-reputation lookup service; CSP and native navigation gates stay on.
        configuration.preferences.isFraudulentWebsiteWarningEnabled = false
        configuration.setURLSchemeHandler(EditorScheme(resources: resources, images: images, diagnostic: { [weak self] error in self?.record("resourceReadFailure", error) }, remoteImage: { [weak self] id, source in
            guard let self, self.documents[id] != nil else { throw ImageStoreFailure.denied }
            return try await self.remoteImages.read(documentID: id, source: source)
        }), forURLScheme: "markfine")
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
        let cache = try runtime.startSession()
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
        // Keep a real AppKit title bar, permanently outside the WebView. A transparent
        // full-size WK content view swallows title-bar dragging/double-click preferences.
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.tabbingMode = .disallowed // Documents use the editor's existing tabs, not a second native tab bar.
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0.141, green: 0.169, blue: 0.153, alpha: 1) : NSColor(srgbRed: 0.984, green: 0.988, blue: 0.980, alpha: 1)
        }
        webView.underPageBackgroundColor = window.backgroundColor
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false; window.contentView = webView; window.delegate = self; window.center()
        if !pendingURLs.isEmpty, let screen = window.screen ?? NSScreen.main { window.setFrame(screen.visibleFrame, display: false) }
        self.window = window
        // An input method may translate Ctrl-Shift-Backquote to “·” before WebKit
        // emits a usable DOM code. Route only this physical chord in our main window;
        // the existing editor command still validates focus, editability and composition.
        physicalShortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let window = self.window, NSApp.isActive, NSApp.keyWindow === window, window.attachedSheet == nil,
                  event.keyCode == 50,
                  event.modifierFlags.intersection([.command, .option, .control, .shift]) == [.control, .shift] else { return event }
            Task { @MainActor in
                do { _ = try await self.deliver(["kind": "hostCommand", "action": "strike"]) }
                catch { self.fail("hostDeliveryFailure", error) }
            }
            return nil
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let physicalShortcutMonitor { NSEvent.removeMonitor(physicalShortcutMonitor) }
        physicalShortcutMonitor = nil
    }

    private func configureMenu() {
        let main = NSMenu()
        func menu(_ name: String) -> NSMenu {
            let item = NSMenuItem(); let menu = NSMenu(title: l(name)); item.submenu = menu; main.addItem(item); return menu
        }
        let app = menu("Markfine")
        app.addItem(withTitle: l("关于 Markfine"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        add("首选项…", key: ",", action: "preferences", to: app)
        add(settings.text("缓存清理…", "Clear App Data…"), key: "", action: "clearCache", to: app)
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
        add(settings.text("导出…", "Export…"), key: "e", modifiers: [.command, .shift], action: "export", to: file)
        add(settings.text("打印…", "Print…"), key: "p", action: "print", to: file)
        file.addItem(.separator()); add("关闭标签页", key: "w", action: "close", to: file)
        add("关闭窗口", key: "w", modifiers: [.command, .shift], action: "closeWindow", to: file)
        let edit = menu("编辑")
        add("撤销", key: "z", action: "undo", to: edit)
        add("重做", key: "z", modifiers: [.command, .shift], action: "redo", to: edit)
        edit.addItem(.separator())
        add("剪切", key: "x", action: "cut", to: edit); add("复制", key: "c", action: "copy", to: edit)
        edit.addItem(withTitle: l("全选"), action: Selector("selectAll:"), keyEquivalent: "a")
        add("粘贴", key: "v", action: "paste", to: edit)
        edit.addItem(.separator())
        add(settings.text("删除整行", "Delete Line"), key: "k", modifiers: [.command, .shift], action: "deleteLine", to: edit)
        add(settings.text("删除整段", "Delete Paragraph"), key: "k", modifiers: [.command, .option, .shift], action: "deleteParagraph", to: edit)
        edit.addItem(.separator())
        add("查找", key: "f", action: "find", to: edit)
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
        add(settings.text("专注模式", "Focus Mode"), key: "", action: "toggleFocus", to: view)
        view.items.last?.state = preferences["focusMode"] as? Bool == true ? .on : .off
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
        let help = menu("帮助"); add(settings.text("Markfine 帮助", "Markfine Help"), key: "", action: "userGuide", to: help)
        add("快捷键说明", key: "?", action: "help", to: help); NSApp.helpMenu = help
        NSApp.mainMenu = main; NSApp.windowsMenu = windows
    }

    private func add(_ title: String, key: String, modifiers: NSEvent.ModifierFlags = .command, action: String, to menu: NSMenu) {
        let item = NSMenuItem(title: l(title), action: #selector(menuCommand(_:)), keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers; item.target = self; item.representedObject = action; menu.addItem(item)
    }
    @objc private func menuCommand(_ item: NSMenuItem) {
        if let url = item.representedObject as? URL { Task { @MainActor in await openLocation(url) }; return }
        guard let action = item.representedObject as? String else { return }
        if ["copy", "cut", "paste", "undo", "redo"].contains(action), NSApp.keyWindow !== window {
            NSApp.sendAction(Selector(action + ":"), to: nil, from: self); return
        }
        if (action == "close" || action == "closeWindow"), preferencesController.closeIfKey() { return }
        if (action == "close" || action == "closeWindow"), let key = NSApp.keyWindow, key !== window {
            // About and native system panels must never close a document in a background window.
            if let panel = key as? NSSavePanel { panel.cancel(item) }
            else if let parent = key.sheetParent { parent.endSheet(key, returnCode: .cancel) }
            else { key.performClose(item) }
            return
        }
        if action == "clearRecent" { recent.clear(); updateRecentMenu(); return }
        if action == "toggleWorkspaceRecents" { settings.set("showWorkspaceRecents", preferences["showWorkspaceRecents"] as? Bool != true); preferencesChanged(); return }
        if action == "clearCache" {
            guard let window, let runtime else { return }
            CacheCleanupController.show(window: window, runtime: runtime, settings: settings, recent: recent, positions: positions) { [weak self] clearedPositions in
                guard let self else { return }; self.preferencesChanged(); self.updateRecentMenu()
                if clearedPositions { self.pendingPositions.removeAll(); self.emit(["kind": "clearPositions"]) }
                self.notice(self.settings.text("已清理可清理的所选数据，使用中的依赖已保留。", "Selected removable app data cleared. Active dependencies were kept."))
            }; return
        }
        if action == "preferences" { showPreferences() }
        else if action == "closeWindow" { window?.performClose(nil) }
        else {
            // Enqueue while handling the menu action, before subsequent keyboard IPC.
            // An initial Task hop can let the first typed character overtake formatting.
            enqueueDelivery(["kind": "hostCommand", "action": action]) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let value):
                    if value as? Bool != true && ["copy", "cut", "paste", "undo", "redo"].contains(action) { NSApp.sendAction(Selector(action + ":"), to: nil, from: self) }
                case .failure(let error): self.fail("hostDeliveryFailure", error)
                }
            }
        }
    }

    private func showPreferences() {
        preferencesController.onStorageChange = { [weak self] in self?.storageChanged() }
        preferencesController.onChange = { [weak self] in self?.preferencesChanged() }; preferencesController.show()
    }
    private func storageChanged() {
        if pasteUsesS3, !pasteAwaitingDecision, let current = pasteTask { cancelPaste(id: current.id, documentID: current.documentID) }
        Task { await remoteImages.invalidate() }
        emit(["kind": "imageStorage", "value": imageStorage.editorInfo])
        preferencesController.refresh()
    }
    private func preferencesChanged() {
        recent.enforceLimit()
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
        // Keep one native content geometry for the lifetime of the window. AppKit handles
        // title-bar gestures and system double-click settings in both presentation modes.
        window.titleVisibility = enabled ? .hidden : .visible
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(button)?.isHidden = false }
        window.standardWindowButton(.documentIconButton)?.isHidden = enabled
        updateBackground()
    }
    private func updateBackground() {
        let appearance = preferences["appearance"] as? String ?? "system"
        NSApp.appearance = appearance == "dark" ? NSAppearance(named: .darkAqua) : appearance == "light" ? NSAppearance(named: .aqua) : nil
        let theme = preferences[readingEnabled ? "readTheme" : "editTheme"] as? String ?? "paper"
        let color = NSColor(name: nil) { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua { return NSColor(srgbRed: 0.102, green: 0.118, blue: 0.110, alpha: 1) }
            return theme == "kraft" ? NSColor(srgbRed: 0.878, green: 0.788, blue: 0.631, alpha: 1) : theme == "eye" ? NSColor(srgbRed: 0.898, green: 0.933, blue: 0.890, alpha: 1) : NSColor(srgbRed: 0.969, green: 0.953, blue: 0.906, alpha: 1)
        }
        window?.backgroundColor = windowPaper.background(theme: theme, resources: resources)
        webView.underPageBackgroundColor = color // WK's page fallback remains a solid color, not an NSColor pattern.
    }
    private func openLink(_ command: [String: Any]) {
        guard let id = command["documentID"] as? String, let metadata = documents[id], let href = command["href"] as? String, let request = command["requestID"] as? String else { return }
        do {
            let target = try ExternalLink.destination(href, documentURL: metadata.url, forTextEditing: true)
            if target.isFileURL {
                let values = try target.resourceValues(forKeys: [.isRegularFileKey, .isPackageKey, .contentTypeKey])
                guard values.isRegularFile == true, values.isPackage != true else { throw ExternalLinkFailure.executable }
                if TextDocument.isKnownText(target) || values.contentType?.conforms(to: .text) == true {
                    let fragment = WorkspaceStore.isMarkdown(target) ? URLComponents(url: target, resolvingAgainstBaseURL: false)?.percentEncodedFragment : nil
                    latestWorkspaceRequest = request
                    Task { @MainActor in await openLocation(URL(fileURLWithPath: target.path), requestID: request, fragment: fragment) }
                    return
                }
                guard values.contentType?.conforms(to: .executable) != true else { throw ExternalLinkFailure.executable }
                _ = try ExternalLink.destination(href, documentURL: metadata.url)
            }
            if !NSWorkspace.shared.open(target) { throw ExternalLinkFailure.unavailable }
        } catch { record("externalLinkRejected", error, level: "warning"); notice(settings.text("无法打开链接：文件不存在、路径无效或目标不安全。", "Cannot open link: the file is missing, the path is invalid, or the destination is unsafe.")) }
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
        _ = try await deliver(["kind": "imageStorage", "value": imageStorage.editorInfo])
        sendRecentLocations()
        let urls = pendingURLs; pendingURLs.removeAll()
        for url in urls { await openLocation(url) }
        initialLoadFinished = true
        let late = pendingURLs; pendingURLs.removeAll()
        for url in late { await openLocation(url) }
        _ = try await deliver(["kind": "initialReady"])
        if pendingExportLocationNotice { pendingExportLocationNotice = false; notice(settings.text("导出文件已移动或不可用。", "The exported file has moved or is unavailable.")) }
        if let url = pendingExportReveal { pendingExportReveal = nil; revealExport(url) }
    }

    private func register(_ loaded: FileDocumentLoad, preview: Bool = false, openRequestID: String = "", fragment: String? = nil) async throws {
        let metadata = loaded.document
        documents[metadata.id] = metadata
        if metadata.isMarkdown { try await images.register(metadata.id, url: metadata.url) }
        if let markdown = loaded.markdown {
            states[metadata.id] = (0, false, false)
            var payload: [String: Any] = ["kind": "load", "documentID": metadata.id, "title": metadata.title, "path": metadata.url?.path ?? "", "markdown": markdown, "preview": preview, "openRequestID": openRequestID,
                                        "textFile": !metadata.isMarkdown, "language": metadata.language, "encoding": metadata.encoding]
            if let fragment { payload["fragment"] = fragment }
            if let url = metadata.url, let position = positions.position(for: url) { payload["resume"] = ["mode": position.mode, "line": position.line, "fraction": position.fraction] }
            _ = try await deliver(payload)
        } else {
            var payload: [String: Any] = ["kind": "activate", "documentID": metadata.id, "pin": !preview, "openRequestID": openRequestID]
            if let fragment { payload["fragment"] = fragment }
            _ = try await deliver(payload)
        }
    }
    private func createDocument() async {
        guard closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        do { try await register(store.create()) } catch { fail("newDocumentFailure", error) }
    }
    private func openDocument(_ url: URL) async {
        guard closeRequest == nil else { notice(settings.text("请先完成当前关闭操作", "Finish the current close operation first")); return }
        opening += 1; defer { opening -= 1 }
        do { try await register(store.open(url)) } catch { record("documentOpenFailure", error); notice(settings.text("无法打开文档：", "Cannot open document: ") + l(String(describing: error))) }
    }
    private func updateRecentMenu() {
        recent.enforceLimit()
        sendRecentLocations()
        guard let menu = recentMenu else { return }; menu.removeAllItems()
        for url in recent.visibleURLs(includeWorkspaceFiles: preferences["showWorkspaceRecents"] as? Bool == true) {
            let item = NSMenuItem(title: url.lastPathComponent + " — " + url.deletingLastPathComponent().lastPathComponent, action: #selector(menuCommand(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = url; item.toolTip = url.path
            let kind = url.hasDirectoryPath ? settings.text("文件夹", "Folder") : settings.text("文件", "File")
            item.image = NSImage(systemSymbolName: recentSymbol(for: url), accessibilityDescription: kind)
            menu.addItem(item)
        }
        if menu.items.isEmpty { let item = NSMenuItem(title: settings.text("暂无最近记录", "No recent locations"), action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item) }
        menu.addItem(.separator())
        add(settings.text("显示从文件夹导航打开的文件", "Show files opened from folders"), key: "", action: "toggleWorkspaceRecents", to: menu)
        menu.items.last?.state = preferences["showWorkspaceRecents"] as? Bool == true ? .on : .off
        add(settings.text("清空最近记录", "Clear Recent"), key: "", action: "clearRecent", to: menu)
    }
    private func recentSymbol(for url: URL) -> String {
        if url.hasDirectoryPath { return "folder" }
        let ext = url.pathExtension.lowercased()
        if ["md", "markdown"].contains(ext) { return "doc.richtext" }
        guard let type = UTType(filenameExtension: ext) else { return "doc" }
        if type.conforms(to: .pdf) { return "doc.text.image" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .sourceCode) { return "chevron.left.forwardslash.chevron.right" }
        if type.conforms(to: .spreadsheet) { return "tablecells" }
        if type.conforms(to: .presentation) { return "rectangle.on.rectangle" }
        if type.conforms(to: .text) || ["doc", "docx", "pages"].contains(ext) { return "doc.text" }
        if type.conforms(to: .archive) { return "archivebox" }
        if type.conforms(to: .audiovisualContent) { return "play.rectangle" }
        return "doc"
    }
    private func sendRecentLocations() {
        guard ready else { return }; recentIDs.removeAll()
        let items: [[String: Any]] = recent.visibleURLs(includeWorkspaceFiles: preferences["showWorkspaceRecents"] as? Bool == true).map { url in
            let id = UUID().uuidString; recentIDs[id] = url
            return ["id": id, "name": url.lastPathComponent, "path": url.path, "directory": url.hasDirectoryPath]
        }
        emit(["kind": "recentLocations", "items": items])
    }
    private func openLocation(_ url: URL, preview: Bool = false, requestID: String = "", workspaceEntry: (id: String, generation: String, identity: FileIdentity)? = nil, fragment: String? = nil) async {
        guard closeRequest == nil else { return }
        opening += 1; defer { opening -= 1 }
        await locationOpenQueue.perform { await self.performOpenLocation(url, preview: preview, requestID: requestID, workspaceEntry: workspaceEntry, fragment: fragment) }
    }
    private func performOpenLocation(_ url: URL, preview: Bool, requestID: String, workspaceEntry: (id: String, generation: String, identity: FileIdentity)?, fragment: String? = nil) async {
        guard closeRequest == nil else { return }
        do {
            if !requestID.isEmpty && latestWorkspaceRequest != requestID { return }
            guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost", url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw FileStoreFailure.invalidURL }
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isPackageKey])
            if values.isDirectory == true && values.isPackage != true {
                latestWorkspaceRequest = nil
                let snapshot = try await workspace.open(url)
                let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
                recent.note(URL(fileURLWithPath: url.path, isDirectory: true)); updateRecentMenu()
                _ = try await deliver(["kind": "workspace", "workspace": value]); return
            }
            guard values.isRegularFile == true, values.isPackage != true else { throw WorkspaceFailure.unavailable }
            do {
                let loaded = try await store.open(url, expectedIdentity: workspaceEntry?.identity)
                if let entry = workspaceEntry, loaded.markdown != nil {
                    do {
                        guard let identity = loaded.document.identity else { throw WorkspaceFailure.stale }
                        try await workspace.verifyFile(entry.id, generation: entry.generation, identity: identity)
                    } catch { if loaded.markdown != nil { try? await store.closeDocument(loaded.document.id) }; throw error }
                }
                if !requestID.isEmpty && (latestWorkspaceRequest != requestID || loaded.document.url?.path != url.standardizedFileURL.path) {
                    if loaded.markdown != nil { try? await store.closeDocument(loaded.document.id) }; return
                }
                try await register(loaded, preview: preview, openRequestID: requestID, fragment: fragment)
            } catch let failure as FileStoreFailure where !WorkspaceStore.isMarkdown(url) && (failure == .notText || failure == .invalidUTF8) {
                let existing = unsupportedFiles.first { $0.value.standardizedFileURL == url.standardizedFileURL }?.key
                let id = existing ?? UUID().uuidString; unsupportedFiles[id] = url; states[id] = (0, false, false)
                if existing != nil { _ = try await deliver(["kind": "activate", "documentID": id, "openRequestID": requestID]) }
                else { _ = try await deliver(["kind": "load", "documentID": id, "title": url.lastPathComponent, "path": url.path, "markdown": "", "unsupported": true, "preview": true, "openRequestID": requestID]) }
            }
            recent.note(url, fromWorkspace: workspaceEntry != nil); updateRecentMenu()
        } catch {
            record("locationOpenFailure", error)
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
        } catch { record("workspaceReadFailure", error); emit(["kind": "workspaceChildren", "folderID": command["folderID"]!, "generation": command["generation"]!, "requestID": command["requestID"]!, "entries": [], "error": settings.text("目录不可用或已改变", "Folder unavailable or changed")]) }
    }
    private func openWorkspaceEntry(_ command: [String: Any]) async {
        let request = command["requestID"] as! String
        do {
            let selection = try await workspace.fileSelection(command["entryID"] as! String, generation: command["generation"] as! String)
            if latestWorkspaceRequest == request { await openLocation(selection.url, preview: true, requestID: request, workspaceEntry: (command["entryID"] as! String, command["generation"] as! String, selection.identity)) }
        } catch { record("workspaceOpenFailure", error); if latestWorkspaceRequest == request { emit(["kind": "openFailed", "openRequestID": request]); notice(settings.text("文件不存在、无权限或链接越界", "File missing, inaccessible or outside the chosen folder")) } }
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
        guard let metadata = documents[id], !saving.contains(id), pasteTask?.documentID != id, !copying.contains(id) else {
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
            if metadata.isMarkdown && snapshot.contains("markfine-staging/") {
                references = try await evaluate("return globalThis.markfine.stagedReferences(snapshot)", arguments: ["snapshot": snapshot]) as? [String] ?? []
            } else { references = [] }
            let migration = metadata.isMarkdown ? try await images.migrate(id, to: targetURL, references: references) : [:]
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
            if saved.isMarkdown, let url = saved.url {
                do { try await images.setURL(id, url: url) }
                catch { record("imageContextFailure", error); receipt["error"] = settings.text("正文已保存，但图片预览上下文未更新：", "Document saved, but the image preview context could not be updated: ") + l(String(describing: error)) }
            }
            updateWindowTitle()
        } catch {
            record("documentSaveFailure", error)
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
        guard pasteTask == nil, !saving.contains(id), closeRequest == nil, !copying.contains(id) else {
            emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": settings.text("请先等待当前保存或图片任务完成", "Wait for the current save or image operation to finish")]); return
        }
        let pasteboard = NSPasteboard.general // Read only in response to a user-initiated paste.
        let changeCount = pasteboard.changeCount
        if documents[id]?.isMarkdown == false {
            let text = pasteboard.string(forType: .string)
            let valid = pasteboard.changeCount == changeCount && text != nil && text!.utf8.count <= TextDocument.maximumBytes
            var receipt: [String: Any] = ["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": valid ? "success" : "failure"]
            if valid { receipt["text"] = text! } else { receipt["error"] = settings.text("剪贴板没有可用的纯文本，或内容超过文本上限。", "The clipboard has no usable plain text, or the text is too large.") }
            emit(receipt); return
        }
        do {
            let snapshot = try ClipboardReader.read(pasteboard)
            guard pasteboard.changeCount == changeCount else {
                emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": settings.text("读取期间剪贴板已变化，请重新粘贴", "The clipboard changed while reading. Please paste again")]); return
            }
            performPaste(command, input: snapshot.input, archive: snapshot.archive, local: false)
        } catch {
            emit(["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure", "error": l(String(describing: error))])
        }
    }
    private func performPaste(_ command: [String: Any], input: ClipboardInput, archive: Data?, local: Bool) {
        let id = command["documentID"] as! String, requestID = command["requestID"] as! String
        let run = UUID(); pasteRun = run; retryInput = input; retryCommand = command; pasteAwaitingDecision = false
        let useS3 = !local && archive == nil && imageStorage.destination == "s3" && (input.png != nil || input.jpeg != nil || input.tiff != nil || input.fileURL != nil)
        pasteUsesS3 = useS3
        let task = Task { @MainActor in
            var receipt: [String: Any] = ["kind": "pasteReceipt", "documentID": id, "requestID": requestID, "outcome": "failure"]
            do {
                let result: ImagePasteResult
                if let archive {
                    let fragment = try ClipboardArchive.decode(archive)
                    let sources = try await self.evaluate("return globalThis.markfine.imageSources(source)", arguments: ["source": fragment.markdown]) as? [String] ?? []
                    var mapping: [String: String] = [:]
                    for resource in fragment.images where sources.contains(resource.source) {
                        mapping[resource.source] = try await self.images.importImage(resource.data, documentID: id)
                    }
                    let text = try await self.evaluate("return globalThis.markfine.replaceImageDestinations(source,mapping)", arguments: ["source": fragment.markdown, "mapping": mapping]) as? String
                    guard let text else { throw BridgeFailure.malformed }; result = ImagePasteResult(reference: nil, text: text)
                } else {
                    let prepared = try await self.images.prepareClipboardInput(input)
                    try Task.checkCancellation()
                    guard self.pasteTask?.id == requestID, self.pasteRun == run else { return }
                    self.retryInput = prepared
                    if useS3 { result = try await self.remoteImages.upload(prepared, documentID: id) }
                    else { result = try await self.images.paste(prepared, documentID: id) }
                }
                try Task.checkCancellation()
                receipt["outcome"] = "success"
                if let reference = result.reference { receipt["reference"] = reference }
                if let text = result.text { receipt["text"] = text }
            } catch is CancellationError { receipt["outcome"] = "cancelled" }
            catch {
                self.record("imagePasteFailure", error)
                if useS3 && (error is S3Failure || error is CredentialFailure) { receipt["error"] = self.settings.text("上传未完成，请检查存储配置、钥匙串授权或网络。", "Upload did not finish. Check the storage configuration, Keychain access or network."); receipt["canRetry"] = true }
                else { receipt["error"] = self.l(String(describing: error)) }
            }
            guard self.pasteTask?.id == requestID, self.pasteRun == run else { return }
            if receipt["canRetry"] as? Bool == true { self.pasteAwaitingDecision = true; self.emit(receipt); return }
            self.pasteTask = nil
            self.retryInput = nil; self.retryCommand = nil; self.pasteUsesS3 = false
            self.emit(receipt)
        }
        pasteTask = (requestID, id, task)
    }
    private func resolvePaste(_ command: [String: Any]) {
        guard pasteAwaitingDecision, let current = pasteTask, current.id == command["requestID"] as? String, current.documentID == command["documentID"] as? String, let input = retryInput, let original = retryCommand else { return }
        current.task.cancel()
        performPaste(original, input: input, archive: nil, local: command["action"] as? String == "local")
    }
    private func cancelPaste(id: String, documentID: String) {
        guard let current = pasteTask, current.id == id, current.documentID == documentID else { return }
        pasteRun = UUID(); current.task.cancel(); pasteTask = nil; retryInput = nil; retryCommand = nil; pasteUsesS3 = false; pasteAwaitingDecision = false
        emit(["kind": "pasteReceipt", "documentID": documentID, "requestID": id, "outcome": "cancelled"])
    }

    private func readImage(_ reference: String, documentID: String) async throws -> LocalImage {
        guard documents[documentID]?.isMarkdown == true else { throw ImageStoreFailure.denied }
        let prefix = "markfine://app/image/" + documentID + "/"
        if reference.hasPrefix(prefix), let path = String(reference.dropFirst(prefix.count)).removingPercentEncoding { return try await images.read(documentID: documentID, relativePath: path) }
        if let source = EditorScheme.remoteSource(reference, documentID: documentID) { return try await remoteImages.read(documentID: documentID, source: source) }
        throw ImageStoreFailure.denied
    }
    private func beginCopy(_ command: [String: Any]) {
        let id = command["documentID"] as! String, ticket = command["requestID"] as! String
        guard !copying.contains(id), !copiedRequests.contains(ticket), pasteTask?.documentID != id, closeRequest == nil, documents[id] != nil else {
            emit(["kind":"beginCopyReceipt","documentID":id,"requestID":ticket,"outcome":"failure"]); return
        }
        let generation = UUID(); clipboardGeneration = generation; copying.insert(id)
        copiedRequests.append(ticket); if copiedRequests.count > 128 { copiedRequests.removeFirst() }
        copyTickets[ticket] = CopyReservation(documentID: id, generation: generation, changeCount: NSPasteboard.general.changeCount)
        emit(["kind":"beginCopyReceipt","documentID":id,"requestID":ticket,"ticket":ticket,"outcome":"success"])
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard let self, self.copyTickets[ticket]?.documentID == id else { return }
            self.copyTickets[ticket] = nil; self.copying.remove(id)
        }
    }
    private func abortCopy(_ command: [String: Any]) {
        let ticket = command["ticket"] as! String, id = command["documentID"] as! String
        guard copyTickets[ticket]?.documentID == id else { return }; copyTickets[ticket] = nil; copying.remove(id)
    }
    private func copyFragment(_ command: [String: Any]) async {
        let id = command["documentID"] as! String, request = command["requestID"] as! String
        var receipt: [String: Any] = ["kind": "copyReceipt", "documentID": id, "requestID": request, "outcome": "failure"]
        let ticket = command["ticket"] as! String
        guard let reservation = copyTickets[ticket], reservation.documentID == id else { emit(receipt); return }
        copyTickets[ticket] = nil
        defer { copying.remove(id); emit(receipt) }
        do {
            guard !copiedRequests.contains(request), documents[id] != nil, clipboardGeneration == reservation.generation else { throw ImageStoreFailure.denied }
            copiedRequests.append(request); if copiedRequests.count > 128 { copiedRequests.removeFirst() }
            let markdown = command["markdown"] as! String
            let contents: ClipboardContents
            if documents[id]?.isMarkdown == false || command["raw"] as? Bool == true { contents = ClipboardContents(values: [.string: Data(markdown.utf8)]) }
            else {
                let options = ExportOptions(chinese: settings.values["fontChinese"] as? String ?? "PingFangSC-Regular", english: settings.values["fontEnglish"] as? String ?? "PingFangSC-Regular")
                contents = try await RichClipboard.make(markdown: markdown, snapshot: command["snapshot"] as! [String: Any], options: options) { try await self.readImage($0, documentID: id) }
            }
            guard documents[id] != nil, clipboardGeneration == reservation.generation, NSPasteboard.general.changeCount == reservation.changeCount else { throw ImageStoreFailure.denied }
            try contents.write(to: .general); receipt["outcome"] = "success"
        } catch { record("clipboardCopyFailure", error); receipt["error"] = settings.text("复制未完成，请检查图片资源或稍后重试。", "Copy did not finish. Check the image resources or try again.") }
    }

    private func closeDocument(_ command: [String: Any]) async {
        let id = command["documentID"] as! String, request = command["requestID"] as! String, revision = command["revision"] as! Int
        var approved = false
        if !saving.contains(id), !outputController.busy, pasteTask?.documentID != id, !copying.contains(id), states[id]?.revision == revision, states[id]?.pending == false {
            do { if unsupportedFiles[id] != nil { unsupportedFiles[id] = nil } else { try await store.closeDocument(id); rememberClosedPosition(id); await remoteImages.close(id); await images.closeDocument(id) }; documents[id] = nil; states[id] = nil; pendingPositions[id] = nil; approved = true }
            catch { record("documentCloseFailure", error); notice(l(String(describing: error))) }
        }
        emit(["kind": "closeReceipt", "documentID": id, "requestID": request, "permitted": approved])
        updateWindowTitle()
    }
    private func requestCloseAll(terminating: Bool) {
        guard ready, opening == 0, saving.isEmpty, pasteTask == nil, copying.isEmpty, !outputController.busy else { notice(settings.text("请先等待保存、图片或导出任务完成，再关闭/退出", "Wait for saving, image processing or document output before closing / quitting")); return }
        if let current = closeRequest { if terminating { closeRequest = (current.id, true) }; return }
        let request = UUID().uuidString; closeRequest = (request, terminating)
        emit(["kind": "hostCommand", "action": "closeAll", "requestID": request])
    }
    private func finishCloseAll(_ command: [String: Any]) async {
        guard let request = closeRequest, request.id == command["requestID"] as? String else { return }
        let items = command["documents"] as! [[String: Any]]
        let ids = items.compactMap { $0["documentID"] as? String }
        var permitted = command["permitted"] as? Bool == true && saving.isEmpty && pasteTask == nil && copying.isEmpty && opening == 0 &&
            Set(ids) == Set(documents.keys).union(unsupportedFiles.keys) && ids.count == documents.count + unsupportedFiles.count && items.allSatisfy { states[$0["documentID"] as! String]?.revision == $0["revision"] as? Int && states[$0["documentID"] as! String]?.pending == false }
        if permitted {
            do {
                try await store.closeDocuments(ids.filter { documents[$0] != nil })
                for id in ids { rememberClosedPosition(id) }; pendingPositions.removeAll()
                await images.finish(); documents.removeAll(); unsupportedFiles.removeAll(); states.removeAll()
            } catch { record("documentCloseAllFailure", error); permitted = false; notice(l(String(describing: error))) }
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
        guard opening == 0, saving.isEmpty, pasteTask == nil, copying.isEmpty, !outputController.busy else { notice(settings.text("请先等待保存、图片或导出任务完成", "Wait for saving, image processing or document output")); return .terminateCancel }
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
            case "openRecent": if let url = recentIDs[command["entryID"] as! String] { Task { @MainActor in await openLocation(url) } }
            case "home": latestWorkspaceRequest = nil; activeDocumentID = nil; updateWindowTitle()
            case "removeRecent":
                let ids = command["entryIDs"] as! [String]
                guard ids.allSatisfy({ recentIDs[$0] != nil }) else { throw BridgeFailure.unauthorized }
                recent.remove(ids.compactMap { recentIDs[$0] }); updateRecentMenu()
            case "clearRecent": recent.clear(); updateRecentMenu()
            case "rememberPosition":
                pendingPositions[command["documentID"] as! String] = ReadingPosition(mode: command["mode"] as! String, line: command["line"] as! Int, fraction: command["fraction"] as! Double)
            case "exportDocument": Task { @MainActor in await exportDocument(command) }
            case "diagnostic": record("editor." + (command["event"] as! String))
            case "closeEmptyWindow": if documents.isEmpty && unsupportedFiles.isEmpty && initialLoadFinished { requestCloseAll(terminating: false) }
            case "workspaceChildren": Task { @MainActor in await workspaceChildren(command) }
            case "workspaceMetadata": Task { @MainActor in
                var dates: [String: Double] = [:]
                do { dates = try await workspace.modificationDates(command["entryIDs"] as! [String], generation: command["generation"] as! String) }
                catch { record("workspaceMetadataFailure", error) }
                emit(["kind": "workspaceMetadata", "generation": command["generation"]!, "requestID": command["requestID"]!, "dates": dates])
            }
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
                    } catch { record("unsupportedOpenRejected", error, level: "warning"); notice(settings.text("无法安全地打开此文件", "This file cannot be opened safely")) }
                }
            case "readingMode": setReadingMode(command["enabled"] as! Bool)
            case "openLink": openLink(command)
            case "setPreference":
                let key = command["key"] as! String
                if settings.set(key, command["value"]!) {
                    if key == "language" || key == "focusMode" { configureMenu(); updateWindowTitle() }
                    if key == "showWorkspaceRecents" { updateRecentMenu() }
                    // The editor already applied its own validated change. Do not echo an older zoom snapshot over a live gesture.
                    updateBackground(); if !["editZoom", "readZoom", "outlineWidth", "leftWidth", "rightWidth"].contains(key) { preferencesController.refresh() }
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
            case "resolvePaste": resolvePaste(command)
            case "copyFragment": Task { @MainActor in await copyFragment(command) }
            case "beginCopy": beginCopy(command)
            case "abortCopy": abortCopy(command)
            case "cancelPaste":
                cancelPaste(id: command["requestID"] as! String, documentID: command["documentID"] as! String)
            case "loadMermaid":
                if mermaidLoaded { emit(["kind": "mermaidReady"]); return }
                mermaidLoaded = true
                let script = String(decoding: try resources.data("mermaid-runtime.js"), as: UTF8.self)
                webView.evaluateJavaScript(script, in: nil, in: world) { [weak self] result in
                    Task { @MainActor in
                        switch result {
                        case .success: self?.emit(["kind": "mermaidReady"])
                        case .failure(let error): self?.record("diagramRuntimeFailure", error); self?.emit(["kind": "mermaidFailed", "error": String(describing: error)])
                        }
                    }
                }
            default: throw BridgeFailure.malformed
            }
        } catch { fail("rejectedBridgeMessage", error) }
    }

    private func notice(_ text: String, autoDismiss: Bool = false) { emit(["kind": "notice", "text": text, "autoDismiss": autoDismiss]) }
    private func updateWindowTitle() {
        let metadata = activeDocumentID.flatMap { documents[$0] }
        let unsupported = activeDocumentID.flatMap { unsupportedFiles[$0] }
        window?.title = metadata.map { $0.url == nil ? l("未命名") : $0.title } ?? unsupported?.lastPathComponent ?? ""
        window?.representedURL = metadata?.url ?? unsupported
        window?.standardWindowButton(.documentIconButton)?.isHidden = readingEnabled
        window?.isDocumentEdited = activeDocumentID.flatMap { states[$0]?.dirty } ?? false
    }
    private func emit(_ fields: [String: Any]) {
        Task { @MainActor in do { _ = try await deliver(fields) } catch { fail("hostDeliveryFailure", error) } }
    }
    private func rememberClosedPosition(_ id: String) {
        if let url = documents[id]?.url, let position = pendingPositions[id] { positions.note(position, for: url) }
    }
    private func exportDocument(_ command: [String: Any]) async {
        let id = command["documentID"] as! String
        guard let window, let metadata = documents[id], closeRequest == nil, pasteTask?.documentID != id, !outputController.busy else { return }
        do {
            let mode = command["mode"] as! String
            let result = try await outputController.perform(window: window, documentURL: metadata.url, title: metadata.url == nil ? l("未命名") : metadata.title, printing: command["printing"] as! Bool, lineHeight: settings.lineHeight(reading: mode == "read", source: mode == "source"), confirmed: { await self.notifications.prepare() }, snapshot: {
                guard let snapshot = try await self.evaluate("return await globalThis.markfine.exportSnapshot(id)", arguments: ["id": id]) as? [String: Any] else { throw BridgeFailure.malformed }; return snapshot
            }, image: { reference in
                return try await self.readImage(reference, documentID: id)
            })
            if case .exported(let url) = result { notice(settings.text("导出成功：", "Export complete: ") + url.lastPathComponent, autoDismiss: true); await notifications.send(success: true, name: url.lastPathComponent, english: settings.english, fileURL: url) }
        } catch {
            record("documentOutputFailure", error)
            notice(settings.text("导出／打印未完成：请检查排版参数、字体、图片或输出位置。", "Export / Print did not finish. Check layout options, fonts, images or the output location.") + " " + String(describing: error))
            if command["printing"] as? Bool == false { await notifications.send(success: false, name: metadata.title, english: settings.english) }
        }
    }
    private func deliver(_ fields: [String: Any]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in enqueueDelivery(fields) { continuation.resume(with: $0) } }
    }
    private func enqueueDelivery(_ fields: [String: Any], completion: @escaping @MainActor @Sendable (Result<Any, Error>) -> Void) {
        var payload = fields; payload["protocolVersion"] = 1; payload["sessionID"] = sessionID
        webView.callAsyncJavaScript("return globalThis.markfine.receive(message)", arguments: ["message": payload], in: nil, in: world, completionHandler: completion)
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
        record(event, error, level: "critical")
        if event == "webProcessTerminated" || event == "hostDeliveryFailure" { webFailed = true }
        if ready && !webFailed { notice(settings.text("操作未完成，当前编辑请勿关闭：", "Operation incomplete. Keep your current document open: ") + (error.map(String.init(describing:)) ?? event)) }
        else if let window, window.attachedSheet == nil {
            let alert = NSAlert(); alert.messageText = settings.text("编辑器发生异常", "Editor error"); alert.informativeText = settings.text("磁盘文件没有因此被覆盖。尚未保存的内容无法保证恢复，请不要继续覆盖原文件。", "Disk files have not been overwritten. Unsaved changes may not be recoverable. Do not overwrite the original file.") + "\n" + event
            alert.beginSheetModal(for: window)
        }
    }
    private func record(_ event: String, _ error: Error? = nil, level: String = "error") {
        let entry = DiagnosticEvent(event, level: level, error: error)
        if runtime?.record(entry, version: resources.info.version, session: sessionID) != true,
           let data = entry.data(version: resources.info.version, session: sessionID) { FileHandle.standardError.write(data) }
    }
}
