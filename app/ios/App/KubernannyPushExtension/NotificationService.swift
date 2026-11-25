import UserNotifications

/// Replaces the generic alert FCM delivers ("Kubernanny: new status from a
/// cluster") with the text the agent sealed for this phone, its title
/// prefixed with the person's authenticity marker. If the message does not
/// open (no key for its id, not from the pinned agent, damaged), the generic
/// text of this file is shown, whatever alert text arrived, and no marker.
///
/// This extension only runs for alerts with `mutable-content`. Whoever holds
/// the relay's Firebase credentials can send an alert without it, and iOS
/// shows that one as sent, without this code: such a notification can say
/// anything, but it cannot carry the marker, which only the phone knows
/// (docs/NOTIFICATIONS.md, "Is this push real?").
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        let german = Locale.preferredLanguages.first?.hasPrefix("de") == true
        content.title = "Kubernanny"
        content.subtitle = ""
        content.body = german ? "Neuer Status eines Clusters. Öffne Kubernanny, um ihn zu sehen." : "New status from a cluster. Open Kubernanny to see it."
        // A message that did not open leads nowhere when tapped.
        content.userInfo = [:]
        fallback = content
        defer { contentHandler(content) }
        let info = request.content.userInfo
        guard
            let kid = info["k"] as? String,
            let sealed = (info["m"] as? String).flatMap(PushKeys.base64url),
            let entry = PushKeys.entry(for: kid),
            let plain = try? PushCrypto.open(pushSecret: entry.secretKey, pushPublic: entry.publicKey, agentPublic: entry.agentKey, message: sealed),
            let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let title = json["t"] as? String,
            let body = json["b"] as? String
        else {
            return
        }
        content.title = PushKeys.markedTitle(PushKeys.marker(), title)
        content.body = body
        content.threadIdentifier = entry.clusterId
        // The key id only: the app resolves it to its cluster on a tap (push-tap.ts), and to nothing it does not know.
        content.userInfo = ["k": kid]
        if let priority = json["p"] as? Int, priority >= 5, #available(iOS 15.0, *) {
            content.interruptionLevel = .timeSensitive
        }
    }

    /// Out of time (about 30 s): show what there is, the generic text.
    override func serviceExtensionTimeWillExpire() {
        if let handler = handler, let fallback = fallback {
            handler(fallback)
        }
    }
}
