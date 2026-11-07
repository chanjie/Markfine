import AppKit
import MarkfineCore

@MainActor
final class PreferencesController: NSObject, NSComboBoxDataSource, NSComboBoxDelegate {
    let settings: ApplicationSettings
    var onChange: (() -> Void)?
    private var panel: NSPanel?
    private var fonts: [(title: String, value: String)] = []
    private var filteredFonts: [String: [(title: String, value: String)]] = [:]
    init(settings: ApplicationSettings) { self.settings = settings }
    func show() {
        if panel == nil {
            panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 550, height: 585), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel!.isReleasedWhenClosed = false; panel!.center()
        }
        rebuild(); panel!.makeKeyAndOrderFront(nil)
    }
    func refresh() { if panel?.isVisible == true { rebuild() } }
    func closeIfKey() -> Bool {
        guard let panel, panel.isKeyWindow || panel.attachedSheet?.isKeyWindow == true else { return false }
        if let sheet = panel.attachedSheet { panel.endSheet(sheet, returnCode: .cancel) } else { panel.performClose(nil) }; return true
    }
    private func rebuild() {
        guard let panel else { return }
        panel.title = settings.text("首选项", "Preferences")
        let content = NSView(); panel.contentView = content
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 26)])
        let values = settings.values
        let heading = NSTextField(labelWithString: settings.text("让页面适合你的写作习惯", "A page that feels like yours")); heading.font = .systemFont(ofSize: 18, weight: .medium); stack.addArrangedSubview(heading)
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
        let themes = [(settings.text("纸质效果", "Paper"), "paper"), (settings.text("牛皮纸效果", "Kraft paper"), "kraft"), (settings.text("护眼效果", "Soft green"), "eye")]
        popup("编辑页面", "Editing theme", key: "editTheme", choices: themes)
        popup("阅读页面", "Reading theme", key: "readTheme", choices: themes)
        popup("文档目录位置", "Outline position", key: "outlineSide", choices: [(settings.text("左侧", "Left"), "left"), (settings.text("右侧", "Right"), "right")])
        for (zh, en, key) in [("开启快捷键提示", "Show shortcut hints", "shortcutHints"), ("开启专注模式", "Focus mode (editing & source)", "focusMode"), ("显示源文档行号", "Show source line numbers", "lineNumbers")] {
            let button = NSButton(checkboxWithTitle: settings.text(zh, en), target: self, action: #selector(changeCheckbox(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(key); button.state = values[key] as? Bool == true ? .on : .off; stack.addArrangedSubview(button)
        }
        let note = NSTextField(wrappingLabelWithString: settings.text("所有设置仅保存在当前 macOS 用户中，不写入 Markdown。\n时间设置用于应用的保存时间提示，不改写文档。", "Settings belong to the current macOS user, never to a Markdown file.\nThe time zone applies to save timestamps, not document content."))
        note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor; stack.addArrangedSubview(note)
        let restore = NSButton(title: settings.text("恢复出厂设置…", "Restore Defaults…"), target: self, action: #selector(restoreDefaults))
        restore.bezelStyle = .rounded; stack.addArrangedSubview(restore)
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
        guard let combo = notification.object as? NSComboBox, let key = combo.identifier?.rawValue else { return }
        if let font = fonts.first(where: { $0.title.caseInsensitiveCompare(combo.stringValue) == .orderedSame || $0.value.caseInsensitiveCompare(combo.stringValue) == .orderedSame }), settings.set(key, font.value) { onChange?() }
        combo.stringValue = fonts.first { $0.value == settings.values[key] as? String }?.title ?? "PingFang"
        filteredFonts[key] = fonts; combo.reloadData()
    }
    @objc private func restoreDefaults() {
        guard let panel else { return }
        let alert = NSAlert(); alert.messageText = settings.text("恢复默认偏好设置？", "Restore default preferences?")
        alert.informativeText = settings.text("将重置外观、字体、语言、缩放等偏好。当前文档、未保存内容、附件和最近打开记录都会保留。", "Appearance, fonts, language, zoom and other preferences will reset. Documents, unsaved edits, attachments and recent locations are kept.")
        alert.addButton(withTitle: settings.text("恢复默认", "Restore Defaults")); alert.addButton(withTitle: settings.text("取消", "Cancel"))
        alert.beginSheetModal(for: panel) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }; self.settings.reset(); self.onChange?(); self.rebuild()
        }
    }
}
