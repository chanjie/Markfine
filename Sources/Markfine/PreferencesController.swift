import AppKit
import MarkfineCore

private final class PreferencesPage: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
final class PreferencesController: NSObject, NSComboBoxDataSource, NSComboBoxDelegate, NSWindowDelegate {
    let settings: ApplicationSettings
    var onChange: (() -> Void)?
    var onStorageChange: (() -> Void)?
    private let storage: S3Settings
    private var tabs: NSTabView?
    private var storageForm: ImageStoragePreferences?
    private var panel: NSPanel?
    private var fonts: [(title: String, value: String)] = []
    private var filteredFonts: [String: [(title: String, value: String)]] = [:]
    private var spacingFields: [String: NSTextField] = [:]
    private var recentLimitField: NSTextField?
    init(settings: ApplicationSettings, storage: S3Settings = S3Settings(vault: KeychainVault())) { self.settings = settings; self.storage = storage }
    func show() {
        if panel == nil {
            panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 720), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel!.delegate = self
            panel!.isReleasedWhenClosed = false; panel!.center()
        }
        rebuild(); panel!.makeKeyAndOrderFront(nil)
    }
    func refresh() { if panel?.isVisible == true { rebuild() } }
    func windowWillClose(_ notification: Notification) { storageForm?.clearSecrets() }
    func closeIfKey() -> Bool {
        guard let panel, panel.isKeyWindow || panel.attachedSheet?.isKeyWindow == true else { return false }
        if let sheet = panel.attachedSheet { panel.endSheet(sheet, returnCode: .cancel) } else { panel.performClose(nil) }; return true
    }
    private func rebuild() {
        guard let panel else { return }
        panel.title = settings.text("首选项", "Preferences")
        panel.contentView = makeContent()
    }
    func makeContent() -> NSTabView {
        let selected = tabs?.selectedTabViewItem?.identifier ?? "general"
        storageForm?.clearSecrets()
        let tabs = NSTabView(); self.tabs = tabs
        func page(_ id: String, _ zh: String, _ en: String) -> NSStackView {
            let item = NSTabViewItem(identifier: id); item.label = settings.text(zh, en)
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; item.view = scroll; tabs.addTabViewItem(item)
            let content = PreferencesPage(); scroll.documentView = content; content.translatesAutoresizingMaskIntoConstraints = false; content.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
            let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(stack)
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 26), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -26)])
            return stack
        }
        let general = page("general", "通用", "General"), editing = page("editing", "编辑与导航", "Editing & Navigation"), appearance = page("appearance", "外观", "Appearance"), images = page("images", "图片与存储", "Images & Storage")
        var stack = general
        let values = settings.values
        func popup(_ zh: String, _ en: String, key: String, choices: [(String, String)]) {
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 14
            let label = NSTextField(labelWithString: settings.text(zh, en)); label.widthAnchor.constraint(equalToConstant: 130).isActive = true
            let control = NSPopUpButton(); control.identifier = NSUserInterfaceItemIdentifier(key); control.target = self; control.action = #selector(changePopup(_:))
            for (title, value) in choices { control.addItem(withTitle: title); control.lastItem?.representedObject = value }
            if let selected = choices.firstIndex(where: { $0.1 == values[key] as? String }) { control.selectItem(at: selected) }
            control.widthAnchor.constraint(equalToConstant: 310).isActive = true; row.addArrangedSubview(label); row.addArrangedSubview(control); stack.addArrangedSubview(row)
        }
        popup("界面语言", "Language", key: "language", choices: [(settings.text("跟随系统", "System"), "system"), ("简体中文", "zh-Hans"), ("English", "en")])
        popup("时间显示", "Time zone", key: "timeZone", choices: [(settings.text("本地时间（跟随系统）", "Local (system time zone)"), "local"), ("UTC", "UTC")])
        stack = appearance
        popup("界面外观", "Appearance", key: "appearance", choices: [(settings.text("跟随系统（默认）", "System (default)"), "system"), (settings.text("浅色", "Light"), "light"), (settings.text("深色", "Dark"), "dark")])
        let families = NSFontManager.shared.availableFontFamilies.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        fonts = [(settings.text("苹方（默认）", "PingFang (default)"), "PingFangSC-Regular")] + families.filter { $0 != "PingFang SC" }.compactMap { family in
            NSFont(name: family, size: 17).map { (family, $0.fontName) }
        }
        for (zh, en, key) in [("中文字体", "Chinese font", "fontChinese"), ("英文字体", "English font", "fontEnglish")] {
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 14
            let label = NSTextField(labelWithString: settings.text(zh, en)); label.widthAnchor.constraint(equalToConstant: 130).isActive = true
            let combo = NSComboBox(); combo.identifier = NSUserInterfaceItemIdentifier(key); combo.usesDataSource = true; combo.dataSource = self; combo.delegate = self
            combo.numberOfVisibleItems = 12; combo.completes = false; combo.placeholderString = settings.text("输入字体关键字查找", "Search fonts by keyword")
            combo.widthAnchor.constraint(equalToConstant: 310).isActive = true; filteredFonts[key] = fonts
            combo.stringValue = fonts.first { $0.value == values[key] as? String }?.title ?? settings.text("苹方（默认）", "PingFang (default)")
            row.addArrangedSubview(label); row.addArrangedSubview(combo); stack.addArrangedSubview(row)
        }
        let themes = [(settings.text("纯白", "Pure white"), "white"), (settings.text("纸质效果", "Paper"), "paper"), (settings.text("牛皮纸效果", "Kraft paper"), "kraft"), (settings.text("护眼效果", "Soft green"), "eye")]
        popup("编辑页面", "Editing theme", key: "editTheme", choices: themes)
        popup("阅读页面", "Reading theme", key: "readTheme", choices: themes)
        spacingFields.removeAll()
        for (zh, en, key) in [("编辑行间距", "Editing spacing", "editLineSpacing"), ("阅读行间距", "Reading spacing", "readLineSpacing")] {
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 10
            let label = NSTextField(labelWithString: settings.text(zh, en)); label.widthAnchor.constraint(equalToConstant: 130).isActive = true
            let preset = NSPopUpButton(); preset.identifier = NSUserInterfaceItemIdentifier(key); preset.target = self; preset.action = #selector(changeSpacing(_:))
            let value = values[key] as? Double ?? 1.3
            for (zh, en, multiplier) in [("紧凑 · 1×", "Compact · 1×", 1.0), ("默认 · 1.3×", "Default · 1.3×", 1.3), ("宽松 · 1.5×", "Relaxed · 1.5×", 1.5), ("自定义", "Custom", 0.0)] {
                preset.addItem(withTitle: settings.text(zh, en)); preset.lastItem?.representedObject = multiplier
            }
            preset.selectItem(at: [1.0, 1.3, 1.5].firstIndex(of: value) ?? 3); preset.widthAnchor.constraint(equalToConstant: 160).isActive = true
            let field = NSTextField(string: String(format: "%g", value)); field.identifier = NSUserInterfaceItemIdentifier(key); field.target = self; field.action = #selector(changeSpacingValue(_:)); field.delegate = self
            field.widthAnchor.constraint(equalToConstant: 65).isActive = true; field.isEnabled = preset.indexOfSelectedItem == 3; spacingFields[key] = field
            row.addArrangedSubview(label); row.addArrangedSubview(preset); row.addArrangedSubview(field); row.addArrangedSubview(NSTextField(labelWithString: "×")); stack.addArrangedSubview(row)
        }
        for field in spacingFields.values { field.toolTip = settings.text("相对紧凑行距，范围 0.75–2.5 倍。", "Relative to compact spacing, from 0.75× to 2.5×.") }
        stack = editing
        popup("文档目录位置", "Outline position", key: "outlineSide", choices: [(settings.text("左侧", "Left"), "left"), (settings.text("右侧", "Right"), "right")])
        popup("文件夹导航位置", "Folder position", key: "filesSide", choices: [(settings.text("左侧", "Left"), "left"), (settings.text("右侧", "Right"), "right")])
        for (zh, en, key) in [("开启快捷键提示", "Show shortcut hints", "shortcutHints"), ("开启专注模式", "Focus mode (editing & source)", "focusMode"), ("显示源文档行号", "Show source line numbers", "lineNumbers"), ("最近记录显示从文件夹导航打开的文件", "Show files opened from folders in recent locations", "showWorkspaceRecents")] {
            let button = NSButton(checkboxWithTitle: settings.text(zh, en), target: self, action: #selector(changeCheckbox(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(key); button.state = values[key] as? Bool == true ? .on : .off; stack.addArrangedSubview(button)
        }
        let recentRow = NSStackView(); recentRow.orientation = .horizontal; recentRow.spacing = 10
        let recentLabel = NSTextField(labelWithString: settings.text("最近记录上限", "Recent locations limit")); recentLabel.widthAnchor.constraint(equalToConstant: 130).isActive = true
        let recentField = NSTextField(string: String(values["recentLimit"] as? Int ?? 20)); recentLimitField = recentField
        recentField.identifier = NSUserInterfaceItemIdentifier("recentLimit"); recentField.target = self; recentField.action = #selector(changeRecentLimit(_:)); recentField.delegate = self
        recentField.widthAnchor.constraint(equalToConstant: 65).isActive = true
        recentRow.addArrangedSubview(recentLabel); recentRow.addArrangedSubview(recentField)
        recentRow.addArrangedSubview(NSTextField(labelWithString: settings.text("条（0–1000，0 不记录）", "(0–1000; 0 disables history)"))); stack.addArrangedSubview(recentRow)
        let recentNote = NSTextField(wrappingLabelWithString: settings.text("输入后按回车确认。调低上限会移除较早的超额记录，不删除文件。", "Press Return to apply. Lowering the limit removes older excess records, not files."))
        recentNote.font = .systemFont(ofSize: 11); recentNote.textColor = .secondaryLabelColor; stack.addArrangedSubview(recentNote)
        let form = ImageStoragePreferences(storage: storage, settings: settings); storageForm = form; form.onChange = { [weak self] in self?.onStorageChange?() }; images.addArrangedSubview(form.makeView())
        stack = general
        let restore = NSButton(title: settings.text("恢复默认设置…", "Restore Defaults…"), target: self, action: #selector(restoreDefaults))
        restore.bezelStyle = .rounded; stack.addArrangedSubview(restore)
        tabs.selectTabViewItem(withIdentifier: selected)
        return tabs
    }
    @objc private func changeSpacing(_ sender: NSPopUpButton) {
        guard let key = sender.identifier?.rawValue, let value = sender.selectedItem?.representedObject as? Double, let field = spacingFields[key] else { return }
        field.isEnabled = value == 0
        if value == 0 { panel?.makeFirstResponder(field); field.selectText(nil) }
        else if settings.set(key, value) { field.stringValue = String(format: "%g", value); onChange?() }
    }
    @objc private func changeSpacingValue(_ sender: NSTextField) {
        guard let key = sender.identifier?.rawValue else { return }
        if let value = Double(sender.stringValue.replacingOccurrences(of: ",", with: ".")), settings.set(key, value) { onChange?() }
        sender.stringValue = String(format: "%g", settings.values[key] as? Double ?? 1.3)
    }
    @objc private func changeRecentLimit(_ sender: NSTextField) {
        if let value = Int(sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), settings.set("recentLimit", value) { onChange?() }
        sender.stringValue = String(settings.values["recentLimit"] as? Int ?? 20)
    }
    @objc private func changePopup(_ sender: NSPopUpButton) {
        guard let key = sender.identifier?.rawValue, let value = sender.selectedItem?.representedObject as? String, settings.set(key, value) else { return }
        onChange?(); if key == "language" { rebuild() }
    }
    @objc private func changeCheckbox(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue, settings.set(key, sender.state == .on) else { return }; onChange?()
    }
    func numberOfItems(in comboBox: NSComboBox) -> Int { filteredFonts[comboBox.identifier?.rawValue ?? ""]?.count ?? 0 }
    func comboBox(_ comboBox: NSComboBox, objectValueForItemAt index: Int) -> Any? {
        guard let list = filteredFonts[comboBox.identifier?.rawValue ?? ""], list.indices.contains(index) else { return nil }; return list[index].title
    }
    func controlTextDidChange(_ notification: Notification) {
        guard let combo = notification.object as? NSComboBox, let key = combo.identifier?.rawValue else { return }
        let query = combo.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        filteredFonts[key] = query.isEmpty ? fonts : fonts.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.value.localizedCaseInsensitiveContains(query) }
        combo.reloadData()
    }
    func comboBoxSelectionDidChange(_ notification: Notification) {
        guard let combo = notification.object as? NSComboBox, let key = combo.identifier?.rawValue, let list = filteredFonts[key], list.indices.contains(combo.indexOfSelectedItem) else { return }
        let font = list[combo.indexOfSelectedItem]; combo.stringValue = font.title
        if settings.values[key] as? String != font.value, settings.set(key, font.value) { onChange?() }
    }
    func controlTextDidEndEditing(_ notification: Notification) {
        if let field = notification.object as? NSTextField, field === recentLimitField { changeRecentLimit(field); return }
        if let field = notification.object as? NSTextField, !(field is NSComboBox), spacingFields[field.identifier?.rawValue ?? ""] === field { changeSpacingValue(field); return }
        guard let combo = notification.object as? NSComboBox, let key = combo.identifier?.rawValue else { return }
        if let font = fonts.first(where: { $0.title.caseInsensitiveCompare(combo.stringValue) == .orderedSame || $0.value.caseInsensitiveCompare(combo.stringValue) == .orderedSame }), settings.set(key, font.value) { onChange?() }
        combo.stringValue = fonts.first { $0.value == settings.values[key] as? String }?.title ?? "PingFang"
        filteredFonts[key] = fonts; combo.reloadData()
    }
    @objc private func restoreDefaults() {
        guard let panel else { return }
        let alert = NSAlert(); alert.messageText = settings.text("恢复默认偏好设置？", "Restore default preferences?")
        alert.informativeText = settings.text("恢复默认偏好，并清除记住的 PDF／Word 导出配置。最近记录上限恢复为20条，超额的旧记录会移除。文档、附件和S3凭据保留。", "Restore default preferences and clear saved PDF / Word export layouts. The recent limit returns to 20, removing older excess records. Documents, attachments and S3 credentials are kept.")
        alert.addButton(withTitle: settings.text("恢复默认", "Restore Defaults")); alert.addButton(withTitle: settings.text("取消", "Cancel"))
        alert.beginSheetModal(for: panel) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }; self.settings.reset(); self.storage.useLocal(); self.onStorageChange?(); self.onChange?(); self.rebuild()
        }
    }
}
