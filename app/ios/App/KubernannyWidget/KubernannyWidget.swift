import SwiftUI
import WidgetKit

// The home-screen and Lock Screen widgets. They never talk to an agent and
// hold no key: all they show is the short list in the App Group (WidgetData),
// written by the app while it is open and updated from every native push by
// the push extension (WidgetPushStatus.swift). Nothing else can refresh them,
// so each entry shows its age, and a cluster whose last check is over 30
// minutes old is drawn grey.
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
        // The app and the push extension reload on every write; this only renews the ticking age after a day.
        return Timeline(entries: entries, policy: .after(dates.last ?? now.addingTimeInterval(86_400)))
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
        completion(Timelines.entries())
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
