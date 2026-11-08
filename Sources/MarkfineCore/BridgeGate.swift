import CoreFoundation
import Foundation

public enum BridgeFailure: Error { case unauthorized, malformed }

/// WebKit origin/frame/content-world checks must precede this schema gate.
public struct BridgeGate {
    public let sessionID: String
    public let capability: String
    public let documentIDs: Set<String>

    public init(sessionID: String, capability: String, documentIDs: Set<String> = []) {
        self.sessionID = sessionID
        self.capability = capability
        self.documentIDs = documentIDs
    }

    public func decode(_ body: Any) throws -> [String: Any] {
        guard let object = body as? [String: Any], JSONSerialization.isValidJSONObject(object),
              let version = object["protocolVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              object["sessionID"] as? String == sessionID,
              object["capability"] as? String == capability,
              let kind = object["kind"] as? String else { throw BridgeFailure.unauthorized }
        let common: Set<String> = ["protocolVersion", "sessionID", "capability", "kind"]
        let fields: Set<String>
        switch kind {
        case "ready", "new", "open", "loadMermaid", "closeEmptyWindow": fields = []
        case "workspaceChildren": fields = ["folderID", "generation", "showAll", "requestID"]
        case "workspaceMetadata": fields = ["entryIDs", "generation", "requestID"]
        case "openWorkspaceEntry": fields = ["entryID", "generation", "requestID"]
        case "openRecent": fields = ["entryID"]
        case "rememberPosition": fields = ["documentID", "mode", "line", "fraction"]
        case "exportDocument": fields = ["documentID", "printing", "mode"]
        case "diagnostic": fields = ["event"]
        case "openUnsupported": fields = ["documentID"]
        case "readingMode": fields = ["enabled"]
        case "setPreference": fields = ["key", "value"]
        case "openLink": fields = ["documentID", "href", "requestID"]
        case "state": fields = ["documentID", "revision", "dirty", "pending"]
        case "activeDocument": fields = ["documentID"]
        case "save": fields = ["documentID", "requestID", "revision", "snapshot"]
        case "closeDocument": fields = ["documentID", "requestID", "revision"]
        case "closeAllResult": fields = ["requestID", "permitted", "documents"]
        case "paste": fields = ["documentID", "requestID", "revision", "anchor", "head"]
        case "resolvePaste": fields = ["documentID", "requestID", "action"]
        case "beginCopy": fields = ["documentID", "requestID"]
        case "abortCopy": fields = ["documentID", "ticket"]
        case "copyFragment": fields = ["documentID", "requestID", "ticket", "revision", "markdown", "snapshot", "raw"]
        case "cancelPaste": fields = ["documentID", "requestID"]
        default: throw BridgeFailure.malformed
        }
        guard Set(object.keys) == common.union(fields) else { throw BridgeFailure.malformed }
        if fields.contains("documentID") {
            guard let id = object["documentID"] as? String, documentIDs.contains(id) else { throw BridgeFailure.unauthorized }
        }
        for name in ["requestID", "ticket"] where fields.contains(name) {
            guard let id = object[name] as? String, UUID(uuidString: id) != nil else { throw BridgeFailure.malformed }
        }
        for name in ["revision", "anchor", "head"] where fields.contains(name) {
            guard let value = object[name] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
                  value.doubleValue.rounded() == value.doubleValue else { throw BridgeFailure.malformed }
        }
        if kind == "save" {
            guard let snapshot = object["snapshot"] as? String, snapshot.utf8.count <= TextDocument.maximumBridgeBytes else { throw BridgeFailure.malformed }
        }
        if kind == "resolvePaste", !["retry", "local"].contains(object["action"] as? String ?? "") { throw BridgeFailure.malformed }
        func boolean(_ value: Any?) -> Bool {
            guard let number = value as? NSNumber else { return false }
            return CFGetTypeID(number) == CFBooleanGetTypeID()
        }
        if kind == "state", !(boolean(object["dirty"]) && boolean(object["pending"])) { throw BridgeFailure.malformed }
        if kind == "readingMode", !boolean(object["enabled"]) { throw BridgeFailure.malformed }
        if kind == "copyFragment" {
            guard boolean(object["raw"]), let markdown = object["markdown"] as? String, markdown.utf8.count <= 8 * 1_048_576,
                  let snapshot = object["snapshot"] as? [String: Any], Set(snapshot.keys) == ["html", "resources", "imageBindings"],
                  let html = snapshot["html"] as? String, html.utf8.count <= 32 * 1_048_576,
                  let resources = snapshot["resources"] as? [String], resources.count <= 512, resources.allSatisfy({ $0.utf8.count <= 12_000 }),
                  let bindings = snapshot["imageBindings"] as? [[String: String]], bindings.count <= 512,
                  bindings.allSatisfy({ Set($0.keys) == ["source", "resource"] && $0.values.allSatisfy({ $0.utf8.count <= 12_000 }) }) else { throw BridgeFailure.malformed }
        }
        if kind == "exportDocument", !boolean(object["printing"]) { throw BridgeFailure.malformed }
        if kind == "exportDocument", !["edit", "source", "read"].contains(object["mode"] as? String ?? "") { throw BridgeFailure.malformed }
        if kind == "diagnostic", !["globalError", "unhandledRejection", "editorException", "renderFailure", "imageFailure", "diagramFailure", "blockedNetwork"].contains(object["event"] as? String ?? "") { throw BridgeFailure.malformed }
        if kind == "rememberPosition" {
            guard let mode = object["mode"] as? String, let line = object["line"] as? NSNumber, let fraction = object["fraction"] as? NSNumber,
                  CFGetTypeID(line) != CFBooleanGetTypeID(), CFGetTypeID(fraction) != CFBooleanGetTypeID(), line.doubleValue.rounded() == line.doubleValue,
                  line.doubleValue > 0, line.doubleValue <= 10_000_000,
                  ReadingPosition(mode: mode, line: line.intValue, fraction: fraction.doubleValue).valid else { throw BridgeFailure.malformed }
        }
        for name in ["folderID", "entryID", "generation"] where fields.contains(name) {
            guard let id = object[name] as? String, UUID(uuidString: id) != nil else { throw BridgeFailure.malformed }
        }
        if kind == "workspaceChildren", !boolean(object["showAll"]) { throw BridgeFailure.malformed }
        if kind == "workspaceMetadata" {
            guard let ids = object["entryIDs"] as? [String], ids.count <= 4096, ids.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw BridgeFailure.malformed }
        }
        if kind == "setPreference" {
            guard let key = object["key"] as? String, let value = object["value"], ApplicationSettings.accepts(key, value) else { throw BridgeFailure.malformed }
        }
        if kind == "openLink" {
            guard let href = object["href"] as? String, !href.isEmpty, href.utf16.count <= 8192,
                  href.rangeOfCharacter(from: .controlCharacters) == nil else { throw BridgeFailure.malformed }
        }
        if kind == "closeAllResult" {
            guard boolean(object["permitted"]), let items = object["documents"] as? [[String: Any]], items.count <= 1_000,
                  items.allSatisfy({ item in
                      guard Set(item.keys) == ["documentID", "revision"], documentIDs.contains(item["documentID"] as? String ?? ""),
                            let revision = item["revision"] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID() else { return false }
                      return revision.doubleValue >= 0 && revision.doubleValue <= 9_007_199_254_740_991 && revision.doubleValue.rounded() == revision.doubleValue
                  }) else { throw BridgeFailure.malformed }
        }
        return object
    }
}
