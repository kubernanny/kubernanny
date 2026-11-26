import Foundation

/// The hourly status push for the home-screen widget (docs/PROTOCOL.md,
/// "Status pushes"): sealed like every push, but with priority 0, no text and
/// only the cluster's state `w`. The relay sends it to iOS as a background
/// push (`content-available`, no alert), which iOS hands to the app itself
/// (AppDelegate), in the background and only when it allows: not to an app
/// the person force-quit, and throttled by the system.
///
/// Compiled into the app and into the Notification Service Extension (which
/// only sees it if a relay sent it as an alert; it then shows the generic
/// text). Uses the same keys, crypto and widget code as the extension:
/// PushKeys.swift, PushCrypto.swift, WidgetPushStatus.swift.
enum StatusPush {
    /// The priority of a status push (PUSH_STATUS_ONLY in protocol/src/push.ts).
    static let priority = 0

    /// Whether opened content is a status push.
    static func isStatusOnly(_ json: [String: Any]) -> Bool {
        (json["p"] as? NSNumber)?.intValue == priority
    }

    /// The state to apply from opened content: a status push, fresh (PushKeys.isStatusFresh), with a `w`. nil otherwise.
    static func status(fromOpened json: [String: Any], now: Double) -> [String: Any]? {
        guard
            isStatusOnly(json),
            let sealedAt = (json["s"] as? NSNumber)?.doubleValue,
            PushKeys.isStatusFresh(sealedAt: sealedAt, now: now),
            let status = json["w"] as? [String: Any]
        else {
            return nil
        }
        return status
    }

    /// Opens a push's data (`k`, `m`) and, for a fresh status push, writes its
    /// state into the widget's App Group. True when the widget should redraw.
    /// Anything else (no key, not from the pinned agent, an alert, stale) changes nothing.
    static func handle(userInfo: [AnyHashable: Any], now: Double) -> Bool {
        guard
            let kid = userInfo["k"] as? String,
            let sealed = (userInfo["m"] as? String).flatMap(PushKeys.base64url),
            let entry = PushKeys.entry(for: kid),
            let plain = try? PushCrypto.open(pushSecret: entry.secretKey, pushPublic: entry.publicKey, agentPublic: entry.agentKey, message: sealed),
            let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let status = status(fromOpened: json, now: now)
        else {
            return false
        }
        return WidgetPushStatus.apply(clusterId: entry.clusterId, status: status)
    }
}
