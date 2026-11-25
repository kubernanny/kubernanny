import Foundation
import Security

/// Reads the push key the app stored for a key id (KubernannyPushPlugin.swift
/// writes it). Keep the group and service in step with the plugin.
enum PushKeys {
    static let accessGroup = "group.app.kubernanny.push"
    static let service = "app.kubernanny.push"

    struct Entry {
        let secretKey: Data
        let publicKey: Data
        let agentKey: Data
        let clusterId: String
    }

    static func entry(for kid: String) -> Entry? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: kid,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard
            SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
            let s = json["s"].flatMap(base64url), let p = json["p"].flatMap(base64url), let a = json["a"].flatMap(base64url), let c = json["c"]
        else {
            return nil
        }
        return Entry(secretKey: s, publicKey: p, agentKey: a, clusterId: c)
    }

    static func base64url(_ text: String) -> Data? {
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        return Data(base64Encoded: b64)
    }
}
