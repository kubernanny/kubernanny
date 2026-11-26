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

    /// The marker the person picked (app/src/app/core/push/push-marker.ts), nil while the setting is off (the default).
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

    /// Mirrors `statusPushFresh` in push-content.ts and PushFreshness.statusFresh:
    /// a status push (never shown) only has to be sealed within the hour. It is
    /// not compared with, and does not move, the last push shown.
    static func isStatusFresh(sealedAt: Double, now: Double) -> Bool {
        isFresh(sealedAt: sealedAt, now: now, lastShown: nil)
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
        storeTime(seenAccount(kid), sealedAt)
    }

    /// The longest validity a dead man's switch message may carry (DEADMAN_MAX_VALIDITY_MS in protocol/src/push.ts).
    static let deadmanMaxValidity: Double = 27 * 60 * 60 * 1000

    /// Whether a dead man's switch message may be shown: the phone's clock within
    /// its window `validUntil`, not sealed more than an hour ahead, later than the
    /// last such message shown for its key (a replay marker of its own), and no
    /// push of this agent opened within the grace (`lastHeard`). Mirrors
    /// deadmanFresh in push-content.ts and PushFreshness.deadmanFresh.
    static func isDeadmanFresh(sealedAt: Double, validUntil: Double, graceMinutes: Int, now: Double, lastDeadman: Double?, lastHeard: Double?) -> Bool {
        guard sealedAt.isFinite, validUntil.isFinite, sealedAt - now <= maxAge, now <= validUntil, validUntil - sealedAt <= deadmanMaxValidity else {
            return false
        }
        if let last = lastDeadman, sealedAt <= last {
            return false
        }
        guard let heard = lastHeard else {
            return true
        }
        return heard < now - Double(graceMinutes) * 60_000
    }

    /// The graces the protocol allows (DEADMAN_GRACE_MINUTES).
    static func validGrace(_ minutes: Int) -> Bool {
        [10, 15, 30, 60].contains(minutes)
    }

    /// The dead man's switch message's own replay marker, and when the agent was last heard (any push opened and accepted).
    static func deadmanAccount(_ kid: String) -> String {
        "deadman.\(kid)"
    }

    static func heardAccount(_ kid: String) -> String {
        "heard.\(kid)"
    }

    static func lastDeadman(_ kid: String) -> Double? {
        time(deadmanAccount(kid))
    }

    static func markDeadman(_ kid: String, sealedAt: Double) {
        storeTime(deadmanAccount(kid), sealedAt)
    }

    static func lastHeard(_ kid: String) -> Double? {
        time(heardAccount(kid))
    }

    static func markHeard(_ kid: String, sealedAt: Double) {
        if let before = lastHeard(kid), before >= sealedAt {
            return
        }
        storeTime(heardAccount(kid), sealedAt)
    }

    private static func time(_ account: String) -> Double? {
        item(account).flatMap { String(data: $0, encoding: .utf8) }.flatMap(Double.init)
    }

    private static func storeTime(_ account: String, _ value: Double) {
        var base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup
        ]
        SecItemDelete(base as CFDictionary)
        base[kSecValueData as String] = Data(String(format: "%.0f", value).utf8)
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
