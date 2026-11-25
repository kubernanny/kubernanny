import Foundation

/// One cluster as the widget shows it: exactly the fields the app writes
/// (`WidgetCluster` in app/src/app/core/widget/widget-summary.ts).
struct WidgetCluster: Decodable, Identifiable {
    let id: String
    let name: String
    let light: String
    let critical: Int
    let warning: Int
    let checkedAt: Date?
    let demo: Bool

    /// The app only refreshes while it is open, so a check older than this is shown grey.
    static let staleAfter: TimeInterval = 30 * 60

    func isStale(at now: Date) -> Bool {
        guard let checkedAt else { return true }
        return now.timeIntervalSince(checkedAt) > Self.staleAfter
    }

    /// When this cluster turns grey, for the timeline (nil once it is grey already or never checked).
    func staleDate(after now: Date) -> Date? {
        guard let checkedAt else { return nil }
        let date = checkedAt.addingTimeInterval(Self.staleAfter)
        return date > now ? date : nil
    }

    /// red, yellow, unknown, green: the worst cluster comes first.
    var severityRank: Int {
        ["red": 0, "yellow": 1, "unknown": 2, "green": 3][light] ?? 2
    }

    /// The deep link a tap opens; app/src/app/app.ts routes it to the cluster.
    var url: URL? {
        var parts = URLComponents()
        parts.scheme = "kubernanny"
        parts.host = "cluster"
        parts.queryItems = [URLQueryItem(name: "id", value: id)]
        return parts.url
    }

    /// The same sentence as the app's headline, from the counts alone.
    var headline: String {
        if checkedAt == nil || (light == "unknown" && critical == 0 && warning == 0) {
            return String(localized: "widget.notChecked")
        }
        if critical == 0 && warning == 0 {
            return light == "yellow" ? String(localized: "widget.partly") : String(localized: "widget.allGood")
        }
        // Plurals come from Localizable.stringsdict.
        let outages = String.localizedStringWithFormat(NSLocalizedString("widget.outages", comment: "1 outage / 3 outages"), critical)
        let warnings = String.localizedStringWithFormat(NSLocalizedString("widget.warnings", comment: "1 warning / 3 warnings"), warning)
        if critical > 0 && warning > 0 {
            return String(format: String(localized: "widget.both"), outages, warnings)
        }
        return critical > 0 ? outages : warnings
    }
}

/// Reads what the app's WidgetBridge plugin wrote into the shared App Group.
enum WidgetData {
    /// Keep in step with WidgetBridgePlugin.swift (app/native/widget-bridge).
    static let appGroup = "group.app.kubernanny"
    static let key = "kubernanny.widget.clusters.v1"
    static let kind = "KubernannyClusters"

    static func load() -> [WidgetCluster] {
        guard
            let json = UserDefaults(suiteName: appGroup)?.string(forKey: key),
            let data = json.data(using: .utf8)
        else {
            return []
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = isoWithFraction.date(from: text) ?? isoPlain.date(from: text) {
                return date
            }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO date"))
        }
        // One malformed entry must not blank the widget: decode them one by one.
        let raw = (try? JSONSerialization.jsonObject(with: data)) as? [Any] ?? []
        return raw.compactMap { entry in
            guard let entryData = try? JSONSerialization.data(withJSONObject: entry) else { return nil }
            return try? decoder.decode(WidgetCluster.self, from: entryData)
        }
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()
}
