import Darwin
import Foundation

/// Deliberately structured: no free-form error messages, paths, source, URLs or stacks are persisted.
public struct DiagnosticEvent {
    public let event: String
    public let level: String
    public let code: Int?
    public let errorType: String?
    public let domain: String?
    public init(_ event: String, level: String = "error", error: Error? = nil) {
        self.event = event; self.level = level
        errorType = error.map { String(reflecting: type(of: $0)) }
        if let failure = error as? FileStoreFailure, case .posix(_, let value) = failure { code = Int(value); domain = NSPOSIXErrorDomain }
        else {
            code = error.map { ($0 as NSError).code }
            let value = error.map { ($0 as NSError).domain }
            domain = value.map { [NSCocoaErrorDomain, NSPOSIXErrorDomain, NSOSStatusErrorDomain, "WKErrorDomain", "UNErrorDomain"].contains($0) ? $0 : "SwiftError" }
        }
    }
    public func data(version: String, session: String) -> Data? {
        func identifier(_ value: String) -> String { String(value.unicodeScalars.filter { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-").contains($0) }.prefix(100)) }
        var object: [String: Any] = ["time": ISO8601DateFormatter().string(from: Date()), "event": identifier(event),
            "level": ["warning", "error", "critical"].contains(level) ? level : "error", "version": identifier(version), "session": identifier(session)]
        if let code { object["code"] = code }; if let errorType { object["type"] = identifier(errorType) }
        if let domain { object["domain"] = domain }
        guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return nil }
        data.append(10); return data
    }
}
