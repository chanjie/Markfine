import Foundation
import MarkfineCore

/// One bounded read/materialization at a time. Canonical cache keys deduplicate URL aliases.
actor S3ImageService {
    let settings: S3Settings
    let images: ImageStore
    private let client: S3Client
    private var cached: [String: [String: String]] = [:]
    private var shared: [String: (document: String, reference: String)] = [:]
    private var resident: (identity: String, image: LocalImage)?
    private var active: [UUID: (document: String, task: Task<LocalImage, Error>)] = [:]
    private var owner: UUID?
    private var queue: [(UUID, CheckedContinuation<Void, Error>)] = []
    private var generation = 0
    init(settings: S3Settings, images: ImageStore, client: S3Client = S3Client()) { self.settings = settings; self.images = images; self.client = client }
    private func identity(_ profile: S3Profile, key: String) -> String { profile.credentialID + "\n" + profile.securityBinding + "\n" + key }
    func upload(_ input: ClipboardInput, documentID: String) async throws -> ImagePasteResult {
        let staged = try await images.stage(input, documentID: documentID)
        guard let reference = staged.reference else { return staged }
        guard let profile = settings.profile else { throw S3Failure.configuration }
        let local = try await images.read(documentID: documentID, relativePath: reference), settings = settings
        let credentials = try await Task.detached { try settings.credentials(for: profile) }.value
        try Task.checkCancellation(); guard settings.profile == profile else { throw S3Failure.superseded }
        let source = try await client.upload(local.data, extensionName: local.mime == "image/png" ? "png" : "jpg", profile: profile, credentials: credentials)
        try Task.checkCancellation(); guard settings.profile == profile, await images.contains(documentID) else { throw S3Failure.superseded }
        let key = identity(profile, key: try profile.key(for: source))
        cached[documentID, default: [:]][key] = reference; shared[key] = (documentID, reference); resident = (key, local)
        return ImagePasteResult(reference: source, text: nil)
    }
    func read(documentID: String, source: String) async throws -> LocalImage {
        guard await images.contains(documentID), let profile = settings.profile else { throw ImageStoreFailure.denied }
        let key = identity(profile, key: try profile.key(for: source)), epoch = generation, request = UUID()
        guard active.count < 32 else { throw S3Failure.tooLarge }
        let task = Task { try await self.serialRead(documentID: documentID, source: source, profile: profile, key: key, epoch: epoch, request: request) }
        active[request] = (documentID, task); defer { active[request] = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    private func serialRead(documentID: String, source: String, profile: S3Profile, key: String, epoch: Int, request: UUID) async throws -> LocalImage {
        try await acquire(request); defer { next(request) }
        try Task.checkCancellation(); guard settings.profile == profile, epoch == generation, await images.contains(documentID) else { throw S3Failure.superseded }
        if let reference = cached[documentID]?[key] {
            if let resident, resident.identity == key { return resident.image }
            let image = try await images.read(documentID: documentID, relativePath: reference); resident = (key, image); return image
        }
        let local: LocalImage
        if let resident, resident.identity == key { local = resident.image }
        else if let value = shared[key], let image = try? await images.read(documentID: value.document, relativePath: value.reference) { local = image }
        else {
            let settings = settings
            // Public reads also validate the protected configuration binding, but do not
            // transmit credentials to the CDN or public image address.
            let credentials = try await Task.detached { try settings.credentials(for: profile) }.value
            try Task.checkCancellation(); guard settings.profile == profile, epoch == generation else { throw S3Failure.superseded }
            let data = try await client.read(source, profile: profile, credentials: credentials)
            local = try ImageStore.validatedImage(data)
        }
        try Task.checkCancellation(); guard settings.profile == profile, epoch == generation else { throw S3Failure.superseded }
        let reference = try await images.importImage(local.data, documentID: documentID, local: false)
        try Task.checkCancellation(); guard settings.profile == profile, epoch == generation else { throw S3Failure.superseded }
        cached[documentID, default: [:]][key] = reference; shared[key] = (documentID, reference); resident = (key, local)
        return local
    }
    private func acquire(_ id: UUID) async throws {
        try Task.checkCancellation()
        if owner == nil { owner = id; return }
        try await withTaskCancellationHandler { try await withCheckedThrowingContinuation { queue.append((id, $0)) } } onCancel: { Task { await self.cancelSlot(id) } }
    }
    private func cancelSlot(_ id: UUID) { if let i = queue.firstIndex(where: { $0.0 == id }) { queue.remove(at: i).1.resume(throwing: CancellationError()) } }
    private func next(_ id: UUID) { guard owner == id else { return }; if queue.isEmpty { owner = nil } else { let value = queue.removeFirst(); owner = value.0; value.1.resume() } }
    func close(_ id: String) {
        cached[id] = nil; shared = shared.filter { $0.value.document != id }
        for value in active.values where value.document == id { value.task.cancel() }
        if cached.isEmpty { resident = nil }
    }
    func invalidate() { generation += 1; for value in active.values { value.task.cancel() }; cached.removeAll(); shared.removeAll(); resident = nil }
}
