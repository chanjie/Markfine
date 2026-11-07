import AppKit
import UserNotifications

/// Local OS notifications only. Never registers for remote notifications or uses a push service.
@MainActor
final class ExportNotifications: NSObject, UNUserNotificationCenterDelegate {
    var diagnostic: ((String, Error?) -> Void)?
    private var asked = false
    func prepare() async {
        let center = UNUserNotificationCenter.current(); center.delegate = self
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined, !asked else { return }
        asked = true
        do { if try await !center.requestAuthorization(options: [.alert]) { diagnostic?("notificationPermissionDenied", nil) } }
        catch { diagnostic?("notificationPermissionFailure", error) }
    }
    func send(success: Bool, name: String, english: Bool) async {
        let center = UNUserNotificationCenter.current(); center.delegate = self
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { diagnostic?("notificationUnavailable", nil); return }
        let content = UNMutableNotificationContent()
        content.title = english ? (success ? "Export complete" : "Export failed") : (success ? "导出成功" : "导出失败")
        content.body = String(name.prefix(180)) + (success ? "" : (english ? " — Your original document is unchanged. See Markfine for details." : "——原文档未改变，请返回 Markfine 查看详情。"))
        do { try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) }
        catch { diagnostic?("notificationDeliveryFailure", error) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .list] }
}
