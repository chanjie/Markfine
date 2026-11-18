import AppKit

/// A user-initiated handoff. The system remains in control of application activation.
@MainActor
enum FinderReveal {
    static func perform(_ url: URL, yieldActivation: () -> Void, select: (URL) -> Void, activate: () -> Void) {
        yieldActivation()
        select(url)
        activate()
    }

    static func show(_ url: URL) {
        let finderID = "com.apple.finder"
        let finder = NSRunningApplication.runningApplications(withBundleIdentifier: finderID).first { !$0.isTerminated }
        perform(url, yieldActivation: {
            if #available(macOS 14, *) {
                if let finder { NSApp.yieldActivation(to: finder) }
                else { NSApp.yieldActivation(toApplicationWithBundleIdentifier: finderID) }
            }
        }, select: { NSWorkspace.shared.activateFileViewerSelecting([$0]) }, activate: {
            guard let finder else { return }
            if #available(macOS 14, *) {
                _ = finder.activate(from: NSRunningApplication.current, options: [])
            } else {
                _ = finder.activate(options: [.activateIgnoringOtherApps])
            }
        })
    }
}
