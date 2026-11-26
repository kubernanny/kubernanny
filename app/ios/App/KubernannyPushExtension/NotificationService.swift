import UserNotifications
import WidgetKit

/// Replaces the generic alert FCM delivers ("Kubernanny: new status from a
/// cluster") with the text the agent sealed for this phone, its title
/// prefixed with the person's authenticity marker. If the message does not
/// open (no key for its id, not from the pinned agent, damaged), or is stale
/// or not newer than the last one shown for its key (a replay), the generic
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
        defer { deliver(content) }
        let info = request.content.userInfo
        guard
            let kid = info["k"] as? String,
            let sealed = (info["m"] as? String).flatMap(PushKeys.base64url),
            let entry = PushKeys.entry(for: kid),
            let plain = try? PushCrypto.open(pushSecret: entry.secretKey, pushPublic: entry.publicKey, agentPublic: entry.agentKey, message: sealed),
            let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
            let title = json["t"] as? String,
            let body = json["b"] as? String,
            let sealedAt = (json["s"] as? NSNumber)?.doubleValue
        else {
            return
        }
        // A status push reaches the app as a background push (AppDelegate). Should one arrive here
        // as an alert, the widget still takes its state, and the generic text is what shows.
        let now = Date().timeIntervalSince1970 * 1000
        // A dead man's switch message (docs/PROTOCOL.md "Dead man's switch"): sealed ahead of time, sent by the
        // relay because the agent went silent. Its own freshness rule and replay marker (a stale or replayed one
        // gets the generic text, without the marker); the widget turns to "agent not answering".
        if json["d"] != nil {
            guard
                let d = json["d"] as? [String: Any],
                let validUntil = (d["u"] as? NSNumber)?.doubleValue,
                let grace = (d["g"] as? NSNumber)?.intValue,
                PushKeys.validGrace(grace),
                PushKeys.isDeadmanFresh(sealedAt: sealedAt, validUntil: validUntil, graceMinutes: grace, now: now, lastDeadman: PushKeys.lastDeadman(kid), lastHeard: PushKeys.lastHeard(kid))
            else {
                return
            }
            PushKeys.markDeadman(kid, sealedAt: sealedAt)
            if WidgetPushStatus.markUnreachable(clusterId: entry.clusterId, now: now) {
                WidgetCenter.shared.reloadAllTimelines()
            }
            content.title = PushKeys.markedTitle(PushKeys.marker(), title)
            content.body = body
            content.threadIdentifier = entry.clusterId
            content.userInfo = ["k": kid]
            return
        }
        if StatusPush.isStatusOnly(json) {
            if let status = StatusPush.status(fromOpened: json, now: now) {
                PushKeys.markHeard(kid, sealedAt: sealedAt)
                if WidgetPushStatus.apply(clusterId: entry.clusterId, status: status) {
                    WidgetCenter.shared.reloadAllTimelines()
                }
            }
            return
        }
        // A replayed or stale message opens fine (the agent made it once) but says something old.
        // iOS shows every alert that arrives, so it gets the generic text, without the marker.
        guard PushKeys.isFresh(sealedAt: sealedAt, now: now, lastShown: PushKeys.lastShown(kid)) else {
            return
        }
        PushKeys.markShown(kid, sealedAt: sealedAt)
        PushKeys.markHeard(kid, sealedAt: sealedAt)
        // The cluster's state for the home-screen widget (agents that send it; docs/PROTOCOL.md "Push status").
        if let status = json["w"] as? [String: Any], WidgetPushStatus.apply(clusterId: entry.clusterId, status: status) {
            WidgetCenter.shared.reloadAllTimelines()
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
        if let fallback = fallback {
            deliver(fallback)
        }
    }

    /// iOS takes exactly one answer per notification: whichever comes first wins, the other is dropped.
    private func deliver(_ content: UNNotificationContent) {
        guard let handler = handler else {
            return
        }
        self.handler = nil
        handler(content)
    }
}
