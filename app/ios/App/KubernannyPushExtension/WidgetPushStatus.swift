import Foundation

/// Brings the home-screen widget up to date from a push: the agent seals the
/// cluster's state into every push (`w`, docs/PROTOCOL.md "Push status"), and
/// this writes it into the entry the app stored for that cluster in the
/// widget's App Group (`WidgetData.swift`, `kubernanny.widget.clusters.v1`).
///
/// It only updates an entry that is there: a cluster switched off for the
/// widget (or all of them) has none, and gets none from a push. It only
/// writes a state newer than the stored one, so a late push never covers what
/// the app wrote since. Mirrors `WidgetStore.applyPushStatus` on Android.
enum WidgetPushStatus {
    /// Keep in step with WidgetData.swift and WidgetBridgePlugin.swift.
    static let appGroup = "group.app.kubernanny"
    static let key = "kubernanny.widget.clusters.v1"
    static let lights: Set<String> = ["green", "yellow", "red", "unknown"]

    /// The stored list with `status` applied to `clusterId`, or nil when nothing changes.
    static func merge(stored json: String?, clusterId: String, status: [String: Any]) -> String? {
        guard
            let json, let data = json.data(using: .utf8),
            var list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
            let index = list.firstIndex(where: { $0["id"] as? String == clusterId }),
            let light = status["l"] as? String, lights.contains(light),
            let critical = (status["c"] as? NSNumber)?.intValue, critical >= 0,
            let warning = (status["n"] as? NSNumber)?.intValue, warning >= 0,
            let checkedMs = (status["a"] as? NSNumber)?.doubleValue, checkedMs.isFinite
        else {
            return nil
        }
        let checkedAt = Date(timeIntervalSince1970: checkedMs / 1000)
        if let before = (list[index]["checkedAt"] as? String).flatMap(parseIso), before >= checkedAt {
            return nil
        }
        var problems: [[String: String]] = []
        for item in (status["i"] as? [[String: Any]] ?? []).prefix(3) {
            guard let title = item["t"] as? String, let s = item["s"] as? String, s == "c" || s == "w" else {
                return nil
            }
            problems.append(["title": String(title.prefix(120)), "severity": s == "c" ? "critical" : "warning"])
        }
        var entry = list[index]
        entry["light"] = light
        entry["critical"] = critical
        entry["warning"] = warning
        entry["checkedAt"] = isoWithFraction.string(from: checkedAt)
        entry["problems"] = problems
        list[index] = entry
        guard let out = try? JSONSerialization.data(withJSONObject: list) else {
            return nil
        }
        return String(data: out, encoding: .utf8)
    }

    /// Writes into the App Group; true when the widget should redraw.
    /// The stored list with `clusterId` marked "agent not answering" since `now`
    /// (ms; field `unreachableSince`, written only here and by the Android push
    /// service; the app keeps it). The widgets show it while it is later than
    /// the entry's last check, so any newer state supersedes it. Nil without an entry.
    static func markUnreachable(stored json: String?, clusterId: String, now: Double) -> String? {
        guard
            let json = json,
            var list = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[String: Any]],
            let index = list.firstIndex(where: { ($0["id"] as? String) == clusterId })
        else {
            return nil
        }
        list[index]["unreachableSince"] = isoWithFraction.string(from: Date(timeIntervalSince1970: now / 1000))
        guard let data = try? JSONSerialization.data(withJSONObject: list) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func markUnreachable(clusterId: String, now: Double) -> Bool {
        guard
            let defaults = UserDefaults(suiteName: appGroup),
            let next = markUnreachable(stored: defaults.string(forKey: key), clusterId: clusterId, now: now)
        else {
            return false
        }
        defaults.set(next, forKey: key)
        return true
    }

    static func apply(clusterId: String, status: [String: Any]) -> Bool {
        guard
            let defaults = UserDefaults(suiteName: appGroup),
            let next = merge(stored: defaults.string(forKey: key), clusterId: clusterId, status: status)
        else {
            return false
        }
        defaults.set(next, forKey: key)
        return true
    }

    static func parseIso(_ text: String) -> Date? {
        isoWithFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
