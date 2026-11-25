import Foundation
import Security

/// Reads the push key the app stored for a key id, and the person's
/// authenticity marker (KubernannyPushPlugin.swift writes both). Keep the
/// group, service and the marker's account in step with the plugin.
enum PushKeys {
    static let accessGroup = "group.app.kubernanny.push"
    static let service = "app.kubernanny.push"
    /// Key ids are 16 characters, so this account never names a key.
    static let markerAccount = "marker"

    struct Entry {
        let secretKey: Data
        let publicKey: Data
        let agentKey: Data
        let clusterId: String
    }

    static func entry(for kid: String) -> Entry? {
        guard
            let data = item(kid),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
            let s = json["s"].flatMap(base64url), let p = json["p"].flatMap(base64url), let a = json["a"].flatMap(base64url), let c = json["c"]
        else {
            return nil
        }
        return Entry(secretKey: s, publicKey: p, agentKey: a, clusterId: c)
    }

    /// The marker the person picked (app/src/app/core/push/push-marker.ts), nil before they picked one.
    static func marker() -> String? {
        item(markerAccount).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// Mirrors `markedTitle` in push-marker.ts and PushMarker.java: only text this extension opened gets the marker.
    static func markedTitle(_ marker: String?, _ title: String) -> String {
        let m = marker?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return m.isEmpty ? title : "\(m) \(title)"
    }

    private static func item(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    static func base64url(_ text: String) -> Data? {
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        return Data(base64Encoded: b64)
    }
}
