import AppKit
import Darwin
import MarkfineCore

@main
struct MarkfineMain {
    @MainActor static func main() {
        // Parse before touching NSApplication. Unknown arguments must never open UI.
        do {
            let packaged = Bundle.main.bundleURL.pathExtension == "app"
            _ = try LaunchMode.parse(Array(CommandLine.arguments.dropFirst()), packaged: packaged)
            let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let resources = try EditorResources.locate(executable: executable)
            let application = NSApplication.shared
            let policy: NSApplication.ActivationPolicy = .regular
            application.setActivationPolicy(policy)
            // Verify the effective policy, not whether the setter reported a transition.
            guard application.activationPolicy() == policy else {
                throw ResourceFailure.invalid("activation policy")
            }
            let delegate = AppDelegate(resources: resources)
            application.delegate = delegate
            delegate.prepareNotifications()
            withExtendedLifetime(delegate) { application.run() }
        } catch {
            let event = DiagnosticEvent("launchFailure", level: "critical", error: error)
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown", session = UUID().uuidString
            var recorded = false
            if Bundle.main.bundleURL.pathExtension == "app", !(error is LaunchFailure),
               let base = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true),
               let runtime = try? RuntimeDataStore(url: base.appendingPathComponent("Markfine/Runtime", isDirectory: true)) { recorded = runtime.record(event, version: version, session: session) }
            if !recorded, let data = event.data(version: version, session: session) { FileHandle.standardError.write(data) }
            exit(error is LaunchFailure ? 2 : 1)
        }
    }
}
