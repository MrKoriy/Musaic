import Foundation
import Security

/// Small Keychain wrapper for values that must not be persisted in UserDefaults.
@MainActor
final class KeychainService {
    static let shared = KeychainService()

    private let service: String

    init(service: String = Bundle.main.bundleIdentifier ?? "Musaic") {
        self.service = service
    }

    func string(forKey key: String) -> String? {
        var result: AnyObject?
        let status = SecItemCopyMatching(query(forKey: key, returnData: true) as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func setString(_ value: String, forKey key: String) -> Bool {
        let data = Data(value.utf8)
        let itemQuery = query(forKey: key)
        let updateAttributes: [String: Any] = [
            kSecValueData as String: data,
        ]

        let updateStatus = SecItemUpdate(itemQuery as CFDictionary, updateAttributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        guard updateStatus == errSecItemNotFound else { return false }

        var addQuery = itemQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    func delete(forKey key: String) -> Bool {
        let status = SecItemDelete(query(forKey: key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private func query(forKey key: String, returnData: Bool = false) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if returnData {
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
        }
        return query
    }
}
