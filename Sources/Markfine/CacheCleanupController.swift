import AppKit
import MarkfineCore

@MainActor
enum CacheCleanupController {
    static func show(window: NSWindow, runtime: RuntimeDataStore, settings: ApplicationSettings, recent: RecentLocations,
                     positions: ReadingPositions, completion: @escaping (Bool) -> Void) {
        guard window.attachedSheet == nil else { return }
        let alert = NSAlert(); alert.messageText = settings.text("缓存清理", "Clear App Data")
        alert.informativeText = settings.text("仅管理 Markfine 自身产生的运行数据，不扫描或清理文档、附件与图片暂存。正在使用的临时依赖受保护；系统统一日志不在本应用的清理权限内。", "Only Markfine runtime data is managed. Documents, attachments and staged images are never scanned or removed. Active dependencies are protected; system unified logs are not managed here.")
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        var controls: [(NSButton, RuntimeDataStore.Category?)] = []
        func checkbox(_ title: String, bytes: Int64, selected: Bool, category: RuntimeDataStore.Category? = nil) -> NSButton {
            let button = NSButton(checkboxWithTitle: title + " — " + ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file), target: nil, action: nil)
            button.state = selected ? .on : .off; stack.addArrangedSubview(button); controls.append((button, category)); return button
        }
        for (category, zh, en) in [(RuntimeDataStore.Category.logs, "应用日志", "App logs"), (.temporary, "运行临时文件／临时依赖", "Temporary files / dependencies"), (.cache, "可重建运行缓存", "Rebuildable runtime cache")] {
            _ = checkbox(settings.text(zh, en), bytes: runtime.bytes(category), selected: true, category: category)
        }
        let preferences = checkbox(settings.text("配置数据（恢复默认设置）", "Preferences (restore defaults)"), bytes: Int64(settings.storedByteCount), selected: false)
        let recents = checkbox(settings.text("全局数据：最近打开记录", "Global data: recent locations"), bytes: Int64(recent.byteCount), selected: false)
        let navigation = checkbox(settings.text("全局数据：编辑／阅读位置记录", "Global data: editing / reading positions"), bytes: Int64(positions.byteCount), selected: false)
        let note = NSTextField(wrappingLabelWithString: settings.text("配置与全局记录默认不清理。勾选后会失去相应偏好或历史，不影响磁盘文档及当前编辑内容。", "Preferences and global records are kept by default. Selecting them removes those settings or history, never disk documents or current edits.")); note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor; note.preferredMaxLayoutWidth = 420; stack.addArrangedSubview(note)
        stack.setFrameSize(NSSize(width: 440, height: 265)); alert.accessoryView = stack
        alert.addButton(withTitle: settings.text("清理选中项", "Clear Selected")); alert.addButton(withTitle: settings.text("取消", "Cancel"))
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            let perform = {
                for (button, category) in controls where button.state == .on { if let category { runtime.clear(category) } }
                if preferences.state == .on { settings.reset() }
                if recents.state == .on { recent.clear() }
                if navigation.state == .on { positions.clear() }
                completion(navigation.state == .on)
            }
            if preferences.state == .on || recents.state == .on || navigation.state == .on {
                let confirmation = NSAlert(); confirmation.messageText = settings.text("清除所选配置或历史记录？", "Remove selected settings or history?")
                confirmation.informativeText = settings.text("此操作不能撤销。只清除刚才勾选的 App 配置或全局记录，不会清理文档与附件。", "This cannot be undone. Only the selected app settings and global records are removed; documents and attachments are untouched.")
                confirmation.addButton(withTitle: settings.text("确认清除", "Clear")); confirmation.addButton(withTitle: settings.text("取消", "Cancel"))
                confirmation.beginSheetModal(for: window) { if $0 == .alertFirstButtonReturn { perform() } }
            } else { perform() }
        }
    }
}
