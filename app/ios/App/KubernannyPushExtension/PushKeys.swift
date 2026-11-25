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

    /// A push sealed longer ago (or further ahead) than this is not shown.
    static let maxAge: Double = 60 * 60 * 1000

    /// Mirrors `pushFresh` in push-content.ts and PushFreshness.java: within an
    /// hour of the phone's clock and later than the last push shown for the key.
    /// Times are milliseconds since the epoch, as the agent seals them.
    static func isFresh(sealedAt: Double, now: Double, lastShown: Double?) -> Bool {
        guard sealedAt.isFinite, abs(now - sealedAt) <= maxAge else {
            return false
        }
        guard let last = lastShown else {
            return true
        }
        return sealedAt > last
    }

    /// Key ids are 16 characters: `seen.<kid>` never names a key or the marker.
    static func seenAccount(_ kid: String) -> String {
        "seen.\(kid)"
    }

    /// The sealed time of the last push shown for this key, nil before the first.
    static func lastShown(_ kid: String) -> Double? {
        item(seenAccount(kid)).flatMap { String(data: $0, encoding: .utf8) }.flatMap(Double.init)
    }

    /// Kept next to the key, in the same group; the app's removeKey deletes it with the key.
    static func markShown(_ kid: String, sealedAt: Double) {
        var base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: seenAccount(kid),
            kSecAttrAccessGroup as String: accessGroup
        ]
        SecItemDelete(base as CFDictionary)
        base[kSecValueData as String] = Data(String(format: "%.0f", sealedAt).utf8)
        base[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        base[kSecAttrSynchronizable as String] = false
        SecItemAdd(base as CFDictionary, nil)
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
