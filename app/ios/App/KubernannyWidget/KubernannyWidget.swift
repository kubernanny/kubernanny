import AppIntents
import KubernannyAgentCall
import SwiftUI
import WidgetKit

// The home-screen and Lock Screen widgets. They show the short list in the App
// Group (WidgetData), written by the app while it is open and updated from
// every native push by the push extension (WidgetPushStatus.swift). With the
// background refresh switched on in the app, the timeline also asks the agents
// itself before it is built (KubernannyAgentCall, WidgetRefresh), as often as
// iOS allows; the keys for that are in the keychain group the app shares.
// Each entry shows its age, and a cluster whose last check is over two hours
// old is drawn grey.
//
// Two kinds:
// - "Kubernanny" (KubernannyClusters, the original kind, so placed widgets
//   stay): all clusters, worst first; small, medium, large, extra large (iPad).
//   From iOS 16 also on the Lock Screen, for all clusters added up.
// - "Cluster" (KubernannyCluster, iOS 17 and later): one cluster with its
//   worst problems, chosen per widget (ClusterIntent.swift; until one is
//   chosen, the worst); small, medium, large and the Lock Screen accessories.

struct ClustersEntry: TimelineEntry {
    let date: Date
    let clusters: [WidgetCluster]
    /// The cluster this widget was set to; nil means the worst one.
    var chosenId: String? = nil

    /// The cluster a one-cluster widget shows: the chosen one if it is still there, else the worst.
    var cluster: WidgetCluster? {
        clusters.first { $0.id == chosenId } ?? clusters.first
    }
}

enum Timelines {
    static func entries(now: Date = Date(), chosenId: String? = nil) -> Timeline<ClustersEntry> {
        let clusters = WidgetData.sorted(WidgetData.load())
        let dates = WidgetData.timelineDates(now: now, clusters: clusters)
        let entries = dates.map { ClustersEntry(date: $0, clusters: clusters, chosenId: chosenId) }
        // With the background refresh: the next timeline (and with it the next question to the agents) after
        // the chosen interval, as far as iOS's budget allows. Without: the app and the push extension reload on
        // every write; this only renews the ticking age after a day.
        if let minutes = RefreshState.interval {
            return Timeline(entries: entries, policy: .after(now.addingTimeInterval(Double(minutes) * 60)))
        }
        return Timeline(entries: entries, policy: .after(dates.last ?? now.addingTimeInterval(86_400)))
    }

    /// The timeline, after asking the agents when the background refresh is on.
    static func refreshedEntries(chosenId: String? = nil) async -> Timeline<ClustersEntry> {
        if RefreshState.enabled {
            await WidgetRefresh.refreshAll()
        }
        return entries(chosenId: chosenId)
    }

    static func snapshot(in context: TimelineProviderContext, chosenId: String? = nil) -> ClustersEntry {
        let clusters = WidgetData.sorted(WidgetData.load())
        return ClustersEntry(date: Date(), clusters: context.isPreview && clusters.isEmpty ? WidgetData.sample : clusters, chosenId: chosenId)
    }
}

struct ClustersProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClustersEntry {
        ClustersEntry(date: Date(), clusters: WidgetData.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (ClustersEntry) -> Void) {
        completion(Timelines.snapshot(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ClustersEntry>) -> Void) {
        Task {
            completion(await Timelines.refreshedEntries())
        }
    }
}

@main
struct KubernannyWidgets: WidgetBundle {
    var body: some Widget {
        ClustersWidget()
        // A WidgetBundleBuilder takes `if #available` without an `else`: on iOS 15 and 16 only the
        // overview is offered (with the Lock Screen accessories from 16, for all clusters together).
        if #available(iOSApplicationExtension 17.0, *) {
            ChosenClusterWidget()
        }
    }
}

/// All clusters.
struct ClustersWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetData.kind, provider: ClustersProvider()) { entry in
            OverviewWidgetView(entry: entry)
        }
        .configurationDisplayName(Text("widget.name"))
        .description(Text("widget.description"))
        .supportedFamilies(ClusterFamilies.overview)
    }
}

enum ClusterFamilies {
    static var overview: [WidgetFamily] {
        var families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge]
        if #available(iOSApplicationExtension 16.0, *) {
            families += [.accessoryCircular, .accessoryRectangular, .accessoryInline]
        }
        return families
    }

    static var all: [WidgetFamily] {
        var families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
        if #available(iOSApplicationExtension 16.0, *) {
            families += [.accessoryCircular, .accessoryRectangular, .accessoryInline]
        }
        return families
    }
}

/// Whether the app switched the background refresh on, and how often (minutes): read from the keychain.
enum RefreshState {
    static var interval: Int? {
        guard let settings = WidgetRefresh.load(), settings.interval > 0, !settings.targets.isEmpty else { return nil }
        return settings.interval
    }

    static var enabled: Bool { interval != nil }
}

/// The widget's refresh button (iOS 17 and later): asks every agent of the list now, in the widget
/// extension, then every widget reloads with what came back.
@available(iOSApplicationExtension 17.0, *)
struct RefreshWidgetsIntent: AppIntent {
    static var title: LocalizedStringResource = "widget.refresh"
    static var isDiscoverable = false

    func perform() async throws -> some IntentResult {
        await WidgetRefresh.refreshAll()
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
