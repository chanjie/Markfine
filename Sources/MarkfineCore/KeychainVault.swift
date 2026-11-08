import Foundation
import Security

public enum CredentialFailure: Error { case unavailable(OSStatus), invalid }
/// Generic-password values in the current user's login keychain. No shared access group or sync.
public final class KeychainVault: S3CredentialVault, @unchecked Sendable {
    private let service = "local.markfine.s3.credentials"
    public init() {}
    private func query(_ id: String) throws -> [String: Any] {
        guard UUID(uuidString: id) != nil else { throw CredentialFailure.invalid }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id, kSecAttrSynchronizable as String: false]
    }
    public func read(_ id: String) throws -> S3Credentials {
        var query = try query(id); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &value)
        guard status == errSecSuccess, let data = value as? Data, data.count <= 32_768,
              let credentials = try? JSONDecoder().decode(S3Credentials.self, from: data), credentials.valid else { throw CredentialFailure.unavailable(status) }
        return credentials
    }
    public func write(_ value: S3Credentials, id: String) throws {
        guard value.valid else { throw CredentialFailure.invalid }
        let data = try JSONEncoder().encode(value); guard data.count <= 32_768 else { throw CredentialFailure.invalid }
        var query = try query(id); query[kSecAttrLabel as String] = "Markfine S3"; query[kSecValueData as String] = data
        // Let macOS establish the creator application's normal keychain access control.
        // Never grant all applications access, and never place secrets in searchable attributes.
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw CredentialFailure.unavailable(status) }
    }
    public func remove(_ id: String) throws {
        let status = SecItemDelete(try query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialFailure.unavailable(status) }
    }
}
