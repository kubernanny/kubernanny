import UserNotifications

/// Replaces the generic alert FCM delivers ("Kubernanny: new status from a
/// cluster") with the text the agent sealed for this phone. If the message
/// does not open (no key for its id, not from the pinned agent, damaged),
/// the generic text of this file is shown, whatever alert text arrived:
/// whoever holds the relay's Firebase credentials can send any alert, and
/// must not be able to put words of their own on the screen.
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
        fallback = content
        defer { contentHandler(content) }
        guard
            let kid = request.content.userInfo["k"] as? String,
            let sealed = (request.content.userInfo["m"] as? String).flatMap(PushKeys.base64url),
            let entry = PushKeys.entry(for: kid),
            let plain = try? PushCrypto.open(pushSecret: entry.secretKey, pushPublic: entry.publicKey, agentPublic: entry.agentKey, message: sealed),
            let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let title = json["t"] as? String,
            let body = json["b"] as? String
        else {
            return
        }
        content.title = title
        content.body = body
        content.threadIdentifier = entry.clusterId
        content.userInfo = ["kubernannyCluster": entry.clusterId]
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
