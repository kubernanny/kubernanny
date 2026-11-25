import Foundation

/// One open problem as the larger widgets list it (`WidgetProblem` in the app).
struct WidgetProblem: Decodable, Hashable {
    let title: String
    let severity: String

    var critical: Bool { severity == "critical" }
}

/// One cluster as the widget shows it: exactly the fields the app writes
/// (`WidgetCluster` in app/src/app/core/widget/widget-summary.ts), and that the
/// push extension updates from a sealed push (WidgetPushStatus.swift).
struct WidgetCluster: Decodable, Identifiable {
    let id: String
    let name: String
    let light: String
    let critical: Int
    let warning: Int
    let checkedAt: Date?
    let demo: Bool
    /// The worst open problems, outages first; absent in lists an older app version stored.
    let problems: [WidgetProblem]

    init(id: String, name: String, light: String, critical: Int, warning: Int, checkedAt: Date?, demo: Bool, problems: [WidgetProblem]) {
        self.id = id
        self.name = name
        self.light = light
        self.critical = critical
        self.warning = warning
        self.checkedAt = checkedAt
        self.demo = demo
        self.problems = problems
    }

    private enum CodingKeys: String, CodingKey { case id, name, light, critical, warning, checkedAt, demo, problems }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        light = try c.decode(String.self, forKey: .light)
        critical = try c.decode(Int.self, forKey: .critical)
        warning = try c.decode(Int.self, forKey: .warning)
        checkedAt = try c.decodeIfPresent(Date.self, forKey: .checkedAt)
        demo = try c.decode(Bool.self, forKey: .demo)
        problems = (try? c.decodeIfPresent([WidgetProblem].self, forKey: .problems)) ?? []
    }

    /// Nothing refreshes the widget but the open app and pushes, so a check older than this is shown grey.
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

    var hasProblems: Bool { critical + warning > 0 }

    var notChecked: Bool { checkedAt == nil || (light == "unknown" && !hasProblems) }

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
        if notChecked {
            return String(localized: "widget.notChecked")
        }
        if !hasProblems {
            return light == "yellow" ? String(localized: "widget.partly") : String(localized: "widget.allGood")
        }
        if critical > 0 && warning > 0 {
            return String(format: String(localized: "widget.both"), outagesText, warningsText)
        }
        return critical > 0 ? outagesText : warningsText
    }

    /// The headline without the conjunction, for one line: "2 outages · 3 warnings".
    var shortHeadline: String {
        if notChecked || !hasProblems {
            return headline
        }
        return [critical > 0 ? outagesText : nil, warning > 0 ? warningsText : nil].compactMap { $0 }.joined(separator: " · ")
    }

    // Plurals come from Localizable.stringsdict.
    var outagesText: String {
        String.localizedStringWithFormat(NSLocalizedString("widget.outages", comment: "1 outage / 3 outages"), critical)
    }

    var warningsText: String {
        String.localizedStringWithFormat(NSLocalizedString("widget.warnings", comment: "1 warning / 3 warnings"), warning)
    }
}

/// Reads what the app's WidgetBridge plugin (and the push extension) wrote into the shared App Group.
enum WidgetData {
    /// Keep in step with WidgetBridgePlugin.swift (app/native/widget-bridge) and WidgetPushStatus.swift.
    static let appGroup = "group.app.kubernanny"
    static let key = "kubernanny.widget.clusters.v1"
    /// The overview of all clusters (the widget's original kind, so placed widgets stay).
    static let kind = "KubernannyClusters"
    /// One cluster, chosen per widget.
    static let clusterKind = "KubernannyCluster"

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

    /// Worst first; equal lights keep the app's order.
    static func sorted(_ clusters: [WidgetCluster]) -> [WidgetCluster] {
        clusters.enumerated()
            .sorted { ($0.element.severityRank, $0.offset) < ($1.element.severityRank, $1.offset) }
            .map(\.element)
    }

    /// The moments the timeline needs: now, every minute for the first hour (the age reads
    /// "2 min ago"), then sparser, and each moment a cluster turns grey. Entries cost no
    /// refresh budget; only the reload at the end does, once a day.
    static func timelineDates(now: Date, clusters: [WidgetCluster]) -> [Date] {
        var minutes = Array(0...60)
        minutes += stride(from: 65, through: 180, by: 5)
        minutes += stride(from: 210, through: 24 * 60, by: 30)
        let dates = minutes.map { now.addingTimeInterval(Double($0) * 60) } + clusters.compactMap { $0.staleDate(after: now) }
        return Array(Set(dates)).sorted()
    }

    /// "just now", "2 min ago", "3 hr ago" relative to the entry's moment.
    static func age(_ date: Date?, now: Date) -> String {
        guard let date else { return "" }
        if now.timeIntervalSince(date) < 60 {
            return String(localized: "widget.justNow")
        }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        f.dateTimeStyle = .numeric
        return f.localizedString(for: min(date, now), relativeTo: now)
    }

    /// Example clusters for the widget gallery.
    static let sample: [WidgetCluster] = [
        WidgetCluster(id: "s1", name: "homelab", light: "red", critical: 1, warning: 2, checkedAt: Date().addingTimeInterval(-120), demo: false, problems: [
            WidgetProblem(title: "default/api: CrashLoopBackOff", severity: "critical"),
            WidgetProblem(title: "Certificate shop.example expires in 9 days", severity: "warning"),
            WidgetProblem(title: "Last backup of default/shop-db was 31 h ago", severity: "warning")
        ]),
        WidgetCluster(id: "s2", name: "production", light: "green", critical: 0, warning: 0, checkedAt: Date().addingTimeInterval(-60), demo: false, problems: []),
        WidgetCluster(id: "s3", name: "staging", light: "yellow", critical: 0, warning: 1, checkedAt: Date().addingTimeInterval(-240), demo: false, problems: [
            WidgetProblem(title: "Node worker-2 has disk pressure", severity: "warning")
        ])
    ]

    private static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()
}
