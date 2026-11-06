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
            withExtendedLifetime(delegate) { application.run() }
        } catch {
            fputs("Markfine: \(error)\n", stderr)
            exit(error is LaunchFailure ? 2 : 1)
        }
    }
}
