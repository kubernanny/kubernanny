import AppIntents
import SwiftUI
import WidgetKit

// "Choose cluster" for the one-cluster widget (iOS 17 and later). The choices
// are the clusters in the widget's list (WidgetData), so a cluster switched
// off for the widget in the app cannot be chosen. A chosen cluster that is
// gone later falls back to the worst one.

@available(iOSApplicationExtension 17.0, *)
struct ClusterEntity: AppEntity {
    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "widget.cluster")
    static var defaultQuery = ClusterQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

@available(iOSApplicationExtension 17.0, *)
struct ClusterQuery: EntityQuery {
    func entities(for identifiers: [ClusterEntity.ID]) async throws -> [ClusterEntity] {
        WidgetData.load().filter { identifiers.contains($0.id) }.map { ClusterEntity(id: $0.id, name: $0.name) }
    }

    func suggestedEntities() async throws -> [ClusterEntity] {
        WidgetData.load().map { ClusterEntity(id: $0.id, name: $0.name) }
    }

    /// Unset: the worst cluster, decided at every render (ClustersEntry.cluster).
    func defaultResult() async -> ClusterEntity? {
        nil
    }
}

@available(iOSApplicationExtension 17.0, *)
struct SelectClusterIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "widget.chooseCluster"
    static var description = IntentDescription("widget.chooseClusterHint")

    @Parameter(title: "widget.cluster")
    var cluster: ClusterEntity?
}

@available(iOSApplicationExtension 17.0, *)
struct ChosenClusterProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ClustersEntry {
        ClustersEntry(date: Date(), clusters: WidgetData.sample)
    }

    func snapshot(for configuration: SelectClusterIntent, in context: Context) async -> ClustersEntry {
        Timelines.snapshot(in: context, chosenId: configuration.cluster?.id)
    }

    func timeline(for configuration: SelectClusterIntent, in context: Context) async -> Timeline<ClustersEntry> {
        Timelines.entries(chosenId: configuration.cluster?.id)
    }
}

/// One cluster, chosen per widget.
@available(iOSApplicationExtension 17.0, *)
struct ChosenClusterWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetData.clusterKind, intent: SelectClusterIntent.self, provider: ChosenClusterProvider()) { entry in
            ClusterWidgetView(entry: entry)
        }
        .configurationDisplayName(Text("widget.clusterName"))
        .description(Text("widget.clusterDescription"))
        .supportedFamilies(ClusterFamilies.all)
    }
}
