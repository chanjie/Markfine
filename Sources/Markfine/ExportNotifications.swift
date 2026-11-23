import AppKit
import UserNotifications

/// Local OS notifications only. Never registers for remote notifications or uses a push service.
@MainActor
final class ExportNotifications: NSObject, UNUserNotificationCenterDelegate {
    var diagnostic: ((String, Error?) -> Void)?
    var unavailable: (() -> Void)?
    var reveal: ((URL) -> Void)?
    private var asked = false
    func activate() { UNUserNotificationCenter.current().delegate = self }
    func prepare() async {
        let center = UNUserNotificationCenter.current(); center.delegate = self
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined, !asked else { return }
        asked = true
        do { if try await !center.requestAuthorization(options: [.alert]) { diagnostic?("notificationPermissionDenied", nil) } }
        catch { diagnostic?("notificationPermissionFailure", error) }
    }
    func send(success: Bool, name: String, english: Bool, fileURL: URL? = nil) async {
        await send(success: success, name: name, english: english, fileURL: fileURL, diagram: false)
    }
    func sendSavedDiagram(fileURL: URL, english: Bool) async {
        await send(success: true, name: fileURL.lastPathComponent, english: english, fileURL: fileURL, diagram: true)
    }
    private func send(success: Bool, name: String, english: Bool, fileURL: URL?, diagram: Bool) async {
        let center = UNUserNotificationCenter.current(); center.delegate = self
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { diagnostic?("notificationUnavailable", nil); return }
        let content = UNMutableNotificationContent()
        content.title = diagram ? (english ? "Diagram PNG saved" : "流程图 PNG 已保存")
            : english ? (success ? "Export complete" : "Export failed") : (success ? "导出成功" : "导出失败")
        content.body = String(name.prefix(180)) + (success ? "" : (english ? " — Your original document is unchanged. See Markfine for details." : "——原文档未改变，请返回 Markfine 查看详情。"))
        if success, let fileURL, fileURL.isFileURL {
            content.userInfo = ["exportURL": fileURL.absoluteString, "outputKind": diagram ? "diagram" : "document"]
        }
        do { try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) }
        catch { diagnostic?("notificationDeliveryFailure", error) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .list] }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let value = response.notification.request.content.userInfo["exportURL"] as? String,
              let url = URL(string: value), url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
               url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { return }
        let kind = response.notification.request.content.userInfo["outputKind"] as? String
        let allowed = kind == "diagram" ? ["png"] : kind == nil || kind == "document" ? ["pdf", "docx"] : []
        guard allowed.contains(url.pathExtension.lowercased()) else { return }
        await MainActor.run {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { self.unavailable?(); return }
            if let reveal = self.reveal { reveal(url) } else { FinderReveal.show(url) }
        }
    }
}
