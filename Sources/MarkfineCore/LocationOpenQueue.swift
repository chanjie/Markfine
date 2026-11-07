import Foundation

/// Serialize user opens through registration, not just the disk read. A repeated/double click cannot
/// activate an identity that an older, cancelled request has not registered (or is about to discard).
@MainActor public final class LocationOpenQueue {
    private var tail: Task<Void, Never>?
    public init() {}
    public func perform(_ operation: @escaping @MainActor () async -> Void) async {
        let previous = tail
        let current = Task { @MainActor in await previous?.value; await operation() }
        tail = current; await current.value
    }
}
