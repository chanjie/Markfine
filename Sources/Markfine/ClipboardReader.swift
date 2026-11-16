import AppKit
import Foundation
import MarkfineCore

/// Snapshot only the representations needed for a user-initiated paste.
@MainActor
enum ClipboardReader {
    static func read(_ pasteboard: NSPasteboard) throws -> (input: ClipboardInput, archive: Data?) {
        let archive = pasteboard.data(forType: ClipboardContents.archiveType)
        if archive != nil { return (ClipboardInput(), archive) }

        let items = pasteboard.pasteboardItems ?? []
        let files = items.filter { $0.types.contains(.fileURL) }
        if !files.isEmpty {
            // Finder may offer an image of the file's icon as TIFF. Never paste
            // that representation in place of the file the user copied.
            guard items.count == 1, files.count == 1,
                  let address = files[0].string(forType: .fileURL),
                  let url = URL(string: address), url.isFileURL,
                  url.host == nil || url.host == "" || url.host == "localhost",
                  url.query == nil, url.fragment == nil else { throw ImageStoreFailure.unsupported }
            return (ClipboardInput(text: pasteboard.string(forType: .string), fileURL: url), nil)
        }
        return (ClipboardInput(png: pasteboard.data(forType: .png),
                               jpeg: pasteboard.data(forType: NSPasteboard.PasteboardType("public.jpeg")),
                               tiff: pasteboard.data(forType: .tiff),
                               text: pasteboard.string(forType: .string)), nil)
    }
}
