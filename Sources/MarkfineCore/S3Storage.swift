import CryptoKit
import Foundation

public enum S3Failure: Error { case configuration, credentials, unavailable, response(Int), tooLarge, image, superseded }
public struct S3Credentials: Codable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let accessKey: String
    public let secretKey: String
    public let token: String
    public let binding: String
    public init(accessKey: String, secretKey: String, token: String = "", binding: String = "") { self.accessKey = accessKey; self.secretKey = secretKey; self.token = token; self.binding = binding }
    public func bound(to binding: String) -> S3Credentials { S3Credentials(accessKey: accessKey, secretKey: secretKey, token: token, binding: binding) }
    public var description: String { "S3Credentials(redacted)" }
    public var debugDescription: String { description }
    public var valid: Bool {
        accessKey.range(of: "^[A-Za-z0-9._-]{1,256}$", options: .regularExpression) != nil && !secretKey.isEmpty && secretKey.utf8.count <= 4096 && token.utf8.count <= 8192 && binding.utf8.count <= 8192 &&
        [accessKey, secretKey, token].allSatisfy { $0.rangeOfCharacter(from: .controlCharacters) == nil } && token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    }
}
public protocol S3CredentialVault: Sendable {
    func read(_ id: String) throws -> S3Credentials
    func write(_ value: S3Credentials, id: String) throws
    func remove(_ id: String) throws
}
public struct S3Profile: Codable, Sendable, Equatable {
    public var credentialID: String
    public var endpoint: String
    public var region: String
    public var bucket: String
    public var prefix: String
    public var pathStyle: Bool
    public var access: String
    public var publicBase: String
    public init(credentialID: String = UUID().uuidString, endpoint: String, region: String, bucket: String, prefix: String = "", pathStyle: Bool = true, access: String = "credentials", publicBase: String = "") {
        self.credentialID = credentialID; self.endpoint = endpoint; self.region = region; self.bucket = bucket; self.prefix = prefix.trimmingCharacters(in: CharacterSet(charactersIn: "/")); self.pathStyle = pathStyle; self.access = access; self.publicBase = publicBase
    }
    private static func address(_ value: String) -> URLComponents? {
        guard !value.isEmpty, value.utf8.count <= 4096, value.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
              let c = URLComponents(string: value), c.scheme == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              !c.path.contains("\\"), c.path.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." && !$0.contains("%") }) else { return nil }
        return c
    }
    public var valid: Bool {
        UUID(uuidString: credentialID) != nil && Self.address(endpoint) != nil && (publicBase.isEmpty || Self.address(publicBase) != nil) &&
        region.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) != nil &&
        bucket.range(of: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", options: .regularExpression) != nil &&
        ["credentials", "public"].contains(access) && prefix.utf8.count <= 1024 &&
        prefix.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_/.")).contains($0) }) &&
        prefix.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ prefix.isEmpty || (!$0.isEmpty && $0 != "." && $0 != "..") })
    }
    public var binding: String { [endpoint, region, bucket, prefix, String(pathStyle)].joined(separator: "\n") }
    public var securityBinding: String { [binding, access, publicBase].joined(separator: "\n") }
    public static func escape(_ value: String) -> String {
        value.utf8.map { byte in (byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || [45,46,95,126].contains(byte)) ? String(UnicodeScalar(byte)) : String(format: "%%%02X", byte) }.joined()
    }
    public func objectURL(_ key: String, publicURL: Bool = false) throws -> URL {
        guard valid, !key.isEmpty, !key.contains("\\"), key.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("%") }),
              prefix.isEmpty || key.hasPrefix(prefix + "/") else { throw S3Failure.configuration }
        let external = publicURL && access == "public" && !publicBase.isEmpty
        guard var c = Self.address(external ? publicBase : endpoint) else { throw S3Failure.configuration }
        var parts = c.path.split(separator: "/").map(String.init)
        if !external { if pathStyle { parts.append(bucket) } else { c.host = bucket + "." + c.host! } }
        parts += key.split(separator: "/").map(String.init); c.percentEncodedPath = "/" + parts.map(Self.escape).joined(separator: "/")
        guard let result = c.url else { throw S3Failure.configuration }; return result
    }
    public var imageBase: String {
        guard let url = try? objectURL((prefix.isEmpty ? "" : prefix + "/") + "image.png", publicURL: access == "public") else { return "" }
        return String(url.absoluteString.dropLast("image.png".count))
    }
    public var allowedImageBases: [String] {
        let key = (prefix.isEmpty ? "" : prefix + "/") + "image.png"
        var result: [String] = []
        if let value = try? objectURL(key).absoluteString { result.append(String(value.dropLast("image.png".count))) }
        if !publicBase.isEmpty { var publicProfile = self; publicProfile.access = "public"; if let value = try? publicProfile.objectURL(key, publicURL: true).absoluteString { result.append(String(value.dropLast("image.png".count))) } }
        return Array(Set(result)).sorted()
    }
    public func key(for source: String) throws -> String {
        guard valid, source.utf8.count <= 8192, let url = URLComponents(string: source), url.scheme == "https", url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw S3Failure.configuration }
        let bases = allowedImageBases
        for base in bases where !base.isEmpty && source.hasPrefix(base) {
            let encoded = String(source.dropFirst(base.count)); guard let suffix = encoded.removingPercentEncoding, !suffix.isEmpty,
                suffix.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                suffix.range(of: "[\\\\:%?#\\x00-\\x20]", options: .regularExpression) == nil,
                ["png","jpg","jpeg","gif","webp","tif","tiff","heic"].contains((suffix as NSString).pathExtension.lowercased()) else { throw S3Failure.configuration }
            let key = (prefix.isEmpty ? "" : prefix + "/") + suffix
            // Reconstruct every request from this profile, never request an arbitrary document URL.
            _ = try objectURL(key); return key
        }
        throw S3Failure.configuration
    }
}

public final class S3Settings: @unchecked Sendable {
    private let defaults: UserDefaults
    public let vault: any S3CredentialVault
    private let profileKey = "imageS3Profile"
    private let ownedKey = "imageS3CredentialIDs"
    private let coordination = NSLock()
    private var generation: UInt64 = 0
    public init(defaults: UserDefaults = .standard, vault: any S3CredentialVault) { self.defaults = defaults; self.vault = vault }
    public var destination: String { defaults.string(forKey: "imageDestination") == "s3" ? "s3" : "local" }
    public var profile: S3Profile? { guard let data = defaults.data(forKey: profileKey), data.count <= 16_384, let p = try? JSONDecoder().decode(S3Profile.self, from: data), p.valid else { return nil }; return p }
    public func useLocal() { coordination.lock(); generation &+= 1; defaults.set("local", forKey: "imageDestination"); coordination.unlock() }
    /// Reserve synchronously in the initiating UI event, before scheduling any background work.
    public func beginChange() -> UInt64 { coordination.lock(); defer { coordination.unlock() }; generation &+= 1; return generation }
    private var ownedIDs: [String] { (defaults.stringArray(forKey: ownedKey) ?? []).filter { UUID(uuidString: $0) != nil }.prefix(128).map { $0 } }
    private func forget(_ id: String) { coordination.lock(); defaults.set(ownedIDs.filter { $0 != id }, forKey: ownedKey); coordination.unlock() }
    private func discard(_ id: String) { if (try? vault.remove(id)) != nil { forget(id) } }
    public func credentials(for profile: S3Profile) throws -> S3Credentials {
        let value = try vault.read(profile.credentialID)
        guard value.valid, value.binding == profile.securityBinding else { throw S3Failure.credentials }; return value
    }
    public func save(_ proposal: S3Profile, credentials: S3Credentials?, ticket: UInt64? = nil) throws {
        var value = proposal; guard value.valid else { throw S3Failure.configuration }
        coordination.lock()
        if let ticket { guard generation == ticket else { coordination.unlock(); throw S3Failure.superseded } } else { generation &+= 1 }
        let epoch = generation, previous = profile
        if let credentials {
            guard credentials.valid else { coordination.unlock(); throw S3Failure.credentials }
        } else {
            guard let previous, previous.binding == value.binding else { coordination.unlock(); throw S3Failure.credentials }
        }
        guard ownedIDs.count < 128 else { coordination.unlock(); throw S3Failure.credentials }
        value.credentialID = UUID().uuidString
        defaults.set(Array(Set(ownedIDs + [value.credentialID])), forKey: ownedKey)
        coordination.unlock()
        do {
            let secret: S3Credentials
            if let credentials { secret = credentials } else { secret = try self.credentials(for: previous!) }
            coordination.lock(); let current = generation == epoch; coordination.unlock(); guard current else { throw S3Failure.superseded }
            try vault.write(secret.bound(to: value.securityBinding), id: value.credentialID)
            let data = try JSONEncoder().encode(value)
            coordination.lock()
            guard generation == epoch else { coordination.unlock(); throw S3Failure.superseded }
            defaults.set(data, forKey: profileKey); defaults.set("s3", forKey: "imageDestination"); coordination.unlock()
        } catch { discard(value.credentialID); throw error }
        if let previous, previous.credentialID != value.credentialID { discard(previous.credentialID) }
    }
    public func removeCredentials(ticket: UInt64? = nil) throws {
        coordination.lock()
        if let ticket { guard generation == ticket else { coordination.unlock(); throw S3Failure.superseded } } else { generation &+= 1 }
        let ids = Set(ownedIDs + (profile.map { [$0.credentialID] } ?? []))
        defaults.removeObject(forKey: profileKey); defaults.set("local", forKey: "imageDestination"); coordination.unlock()
        var failure: Error?
        for id in ids { do { try vault.remove(id); forget(id) } catch { failure = error } }
        if let failure { throw failure }
    }
    public var editorInfo: [String: Any] { ["mode": destination, "prefixes": profile?.allowedImageBases ?? []] }
}

public enum S3Signer {
    public static func request(url: URL, method: String, body: Data = Data(), contentType: String? = nil, region: String, credentials: S3Credentials, date: Date = Date()) throws -> URLRequest {
        guard credentials.valid, let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "https", let host = c.host, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else { throw S3Failure.configuration }
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX"); format.timeZone = TimeZone(secondsFromGMT: 0); format.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        let timestamp = format.string(from: date), day = String(timestamp.prefix(8)), scope = "\(day)/\(region)/s3/aws4_request"
        let hash = hex(Data(SHA256.hash(data: body)))
        var headers = ["host": host + (c.port.map { $0 == 443 ? "" : ":\($0)" } ?? ""), "x-amz-date": timestamp, "x-amz-content-sha256": hash]
        if let contentType { headers["content-type"] = contentType }; if !credentials.token.isEmpty { headers["x-amz-security-token"] = credentials.token }
        let names = headers.keys.sorted(), signed = names.joined(separator: ";"), canonicalHeaders = names.map { "\($0):\(headers[$0]!)\n" }.joined()
        let canonical = [method, c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath, "", canonicalHeaders, signed, hash].joined(separator: "\n")
        let message = "AWS4-HMAC-SHA256\n\(timestamp)\n\(scope)\n\(hex(Data(SHA256.hash(data: Data(canonical.utf8)))))"
        func hmac(_ key: Data, _ text: String) -> Data { Data(HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: SymmetricKey(data: key))) }
        let key = hmac(hmac(hmac(hmac(Data(("AWS4" + credentials.secretKey).utf8), day), region), "s3"), "aws4_request")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60); request.httpMethod = method
        if method == "PUT" { request.httpBody = body }
        for name in names { request.setValue(headers[name], forHTTPHeaderField: name) }
        request.setValue("AWS4-HMAC-SHA256 Credential=\(credentials.accessKey)/\(scope), SignedHeaders=\(signed), Signature=\(hex(hmac(key, message)))", forHTTPHeaderField: "Authorization")
        return request
    }
    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}

public protocol S3Transport: Sendable { func send(_ request: URLRequest, limit: Int) async throws -> Data }
public struct S3HTTPTransport: S3Transport {
    public init() {}
    public func send(_ request: URLRequest, limit: Int) async throws -> Data {
        let transfer = S3Transfer(limit: limit)
        return try await withTaskCancellationHandler { try Task.checkCancellation(); return try await withCheckedThrowingContinuation { transfer.start(request, continuation: $0) } } onCancel: { transfer.cancel() }
    }
}
private final class S3Transfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let limit: Int; let lock = NSLock(); var task: URLSessionDataTask?; var session: URLSession?; var continuation: CheckedContinuation<Data, Error>?; var cancelled = false
    var data = Data(); var failure: Error?
    init(limit: Int) { self.limit = limit }
    func start(_ request: URLRequest, continuation: CheckedContinuation<Data, Error>) {
        lock.lock()
        if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        let config = URLSessionConfiguration.ephemeral; config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 120
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil); self.session = session
        self.continuation = continuation; let task = session.dataTask(with: request); self.task = task; lock.unlock(); task.resume()
    }
    func cancel() { lock.lock(); cancelled = true; let task = task; lock.unlock(); task?.cancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { failure = S3Failure.response((response as? HTTPURLResponse)?.statusCode ?? 0); completionHandler(.cancel); return }
        guard response.expectedContentLength <= limit else { failure = S3Failure.tooLarge; completionHandler(.cancel); return }; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) { if chunk.count > limit - data.count { failure = S3Failure.tooLarge; dataTask.cancel() } else { data.append(chunk) } }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let continuation = continuation; self.continuation = nil; self.task = nil; self.session = nil; let cancelled = cancelled; lock.unlock()
        session.invalidateAndCancel()
        if cancelled { continuation?.resume(throwing: CancellationError()) }
        else if let failure { continuation?.resume(throwing: failure) }
        else if error != nil { continuation?.resume(throwing: S3Failure.unavailable) }
        else { continuation?.resume(returning: data) }
    }
}
public struct S3Client: Sendable {
    public let transport: any S3Transport
    public init(transport: any S3Transport = S3HTTPTransport()) { self.transport = transport }
    public func upload(_ data: Data, extensionName: String, profile: S3Profile, credentials: S3Credentials) async throws -> String {
        guard !data.isEmpty, data.count <= 64 * 1_048_576, ["png","jpg"].contains(extensionName) else { throw S3Failure.image }
        let key = (profile.prefix.isEmpty ? "" : profile.prefix + "/") + "image-" + UUID().uuidString.lowercased() + "." + extensionName
        let request = try S3Signer.request(url: profile.objectURL(key), method: "PUT", body: data, contentType: extensionName == "png" ? "image/png" : "image/jpeg", region: profile.region, credentials: credentials)
        _ = try await transport.send(request, limit: 262_144); try Task.checkCancellation()
        return try profile.objectURL(key, publicURL: profile.access == "public").absoluteString
    }
    public func read(_ source: String, profile: S3Profile, credentials: S3Credentials?) async throws -> Data {
        let key = try profile.key(for: source), url = try profile.objectURL(key, publicURL: profile.access == "public")
        let request: URLRequest
        if profile.access == "public" { request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60) }
        else { guard let credentials else { throw S3Failure.credentials }; request = try S3Signer.request(url: url, method: "GET", region: profile.region, credentials: credentials) }
        let data = try await transport.send(request, limit: 64 * 1_048_576); try Task.checkCancellation(); return data
    }
}
