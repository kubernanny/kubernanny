import SwiftUI
import WidgetKit

// The home-screen widget (small and medium). It never talks to an agent and
// holds no key: all it shows is the short list the app wrote into the App
// Group (WidgetData). The app writes while it is open; a cluster whose last
// check is over 30 minutes old is drawn grey.

struct ClustersEntry: TimelineEntry {
    let date: Date
    let clusters: [WidgetCluster]
}

struct ClustersProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClustersEntry {
        ClustersEntry(date: Date(), clusters: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (ClustersEntry) -> Void) {
        completion(ClustersEntry(date: Date(), clusters: sorted(WidgetData.load())))
    }

    /// One entry now and one for each moment a cluster turns grey; the app
    /// asks for a new timeline whenever it writes (WidgetCenter.reloadTimelines).
    func getTimeline(in context: Context, completion: @escaping (Timeline<ClustersEntry>) -> Void) {
        let now = Date()
        let clusters = sorted(WidgetData.load())
        let turns = Set(clusters.compactMap { $0.staleDate(after: now) }).sorted()
        let entries = [ClustersEntry(date: now, clusters: clusters)] + turns.map { ClustersEntry(date: $0, clusters: clusters) }
        completion(Timeline(entries: entries, policy: .never))
    }

    private func sorted(_ clusters: [WidgetCluster]) -> [WidgetCluster] {
        // Stable: equal lights keep the app's order.
        clusters.enumerated()
            .sorted { ($0.element.severityRank, $0.offset) < ($1.element.severityRank, $1.offset) }
            .map(\.element)
    }
}

@main
struct KubernannyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetData.kind, provider: ClustersProvider()) { entry in
            ClustersWidgetView(entry: entry)
        }
        .configurationDisplayName(Text("widget.name"))
        .description(Text("widget.description"))
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct ClustersWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClustersEntry

    var body: some View {
        content
            .widgetBackground(Palette.ground)
    }

    @ViewBuilder private var content: some View {
        if entry.clusters.isEmpty {
            EmptyStateView()
        } else if family == .systemSmall {
            // Small widgets take one tap target: the worst cluster.
            SmallClusterView(cluster: entry.clusters[0], more: entry.clusters.count - 1, now: entry.date)
                .widgetURL(entry.clusters[0].url)
        } else {
            MediumClustersView(clusters: Array(entry.clusters.prefix(3)), now: entry.date)
        }
    }
}

private struct EmptyStateView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("widget.name").font(.caption.bold()).foregroundColor(Palette.accent)
            Text("widget.empty").font(.footnote).foregroundColor(Palette.mute)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SmallClusterView: View {
    let cluster: WidgetCluster
    let more: Int
    let now: Date

    var body: some View {
        let stale = cluster.isStale(at: now)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 6) {
                EyeLight(light: cluster.light, stale: stale, size: 26)
                Spacer(minLength: 0)
                if cluster.demo {
                    DemoPill()
                }
            }
            Text(cluster.name)
                .font(.headline)
                .foregroundColor(Palette.ink)
                .lineLimit(1)
            Text(cluster.headline)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(stale ? Palette.mute : Palette.tone(cluster.light))
                .lineLimit(3)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
            StatusFooter(cluster: cluster, stale: stale, more: more)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MediumClustersView: View {
    let clusters: [WidgetCluster]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(clusters) { cluster in
                let stale = cluster.isStale(at: now)
                Link(destination: cluster.url ?? URL(string: "kubernanny://")!) {
                    HStack(spacing: 10) {
                        EyeLight(light: cluster.light, stale: stale, size: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(cluster.name).font(.subheadline.bold()).foregroundColor(Palette.ink).lineLimit(1)
                                if cluster.demo {
                                    DemoPill()
                                }
                            }
                            Text(cluster.headline)
                                .font(.caption.weight(.semibold))
                                .foregroundColor(stale ? Palette.mute : Palette.tone(cluster.light))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        Spacer(minLength: 4)
                        if let checkedAt = cluster.checkedAt {
                            Text(asOf(checkedAt)).font(.caption2).foregroundColor(Palette.mute).lineLimit(1)
                        }
                    }
                }
            }
            if clusters.contains(where: { $0.isStale(at: now) }) {
                Spacer(minLength: 0)
                Text("widget.stale").font(.caption2).foregroundColor(Palette.mute).lineLimit(2).minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct StatusFooter: View {
    let cluster: WidgetCluster
    let stale: Bool
    let more: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let checkedAt = cluster.checkedAt {
                Text(asOf(checkedAt)).font(.caption2).foregroundColor(Palette.mute).lineLimit(1)
            }
            if stale {
                Text("widget.staleShort").font(.caption2).foregroundColor(Palette.mute).lineLimit(2).minimumScaleFactor(0.8)
            } else if more > 0 {
                Text(String.localizedStringWithFormat(NSLocalizedString("widget.more", comment: "+2 more clusters"), more))
                    .font(.caption2).foregroundColor(Palette.mute).lineLimit(1)
            }
        }
    }
}

/// "as of 10:42" today, with the date on other days; follows the device's 12/24 h setting.
private func asOf(_ date: Date) -> String {
    let time = Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(date: .abbreviated, time: .shortened)
    return String(format: String(localized: "widget.asOf"), time)
}

/// The nanny's eye from branding/: a lit pupil inside a ring of the same colour, grey when stale.
private struct EyeLight: View {
    let light: String
    let stale: Bool
    let size: CGFloat

    var body: some View {
        let color = stale ? Palette.stale : Palette.tone(light)
        ZStack {
            Circle().stroke(color, lineWidth: size * 0.1)
            Circle().fill(color).padding(size * 0.24)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct DemoPill: View {
    var body: some View {
        Text("widget.demo")
            .font(.caption2.bold())
            .foregroundColor(Palette.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(Palette.accent, lineWidth: 1))
    }
}

/// The app's colours (app/src/styles.scss), light and dark.
enum Palette {
    static let ground = dynamic(light: 0xF3F5F9, dark: 0x0F1626)
    static let ink = dynamic(light: 0x121A2C, dark: 0xE9EDF7)
    static let mute = dynamic(light: 0x5B6582, dark: 0x8D97B5)
    static let accent = dynamic(light: 0x4D5FD6, dark: 0x8EA2FF)
    static let stale = dynamic(light: 0x9AA3BC, dark: 0x4A5470)
    static let ok = dynamic(light: 0x0E9F77, dark: 0x36D6A8)
    static let warn = dynamic(light: 0xB97800, dark: 0xF5B83D)
    static let crit = dynamic(light: 0xD92D4A, dark: 0xFF5D73)

    static func tone(_ light: String) -> Color {
        switch light {
        case "green": return ok
        case "yellow": return warn
        case "red": return crit
        default: return mute
        }
    }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? uiColor(dark) : uiColor(light) })
    }

    private static func uiColor(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

private extension View {
    /// iOS 17 requires containerBackground in widgets; earlier versions take a plain background.
    @ViewBuilder func widgetBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(color, for: .widget)
        } else {
            padding().background(color)
        }
    }
}
