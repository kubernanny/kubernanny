import SwiftUI
import WidgetKit

// The widgets' views. Navy like the app icon in both modes, the nanny's
// glasses as the one memorable element (docs/DESIGN.md), and the lights in
// the app's dark-theme tones, which read on navy. Colour repeats, never
// carries: every state is also a word or a symbol.

// MARK: - All clusters

struct OverviewWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClustersEntry

    var body: some View {
        switch family {
        case .systemSmall, .systemMedium, .systemLarge, .systemExtraLarge:
            content.navyBackground()
        default:
            if #available(iOSApplicationExtension 16.0, *) {
                let total = summary(entry.clusters)
                let all = WidgetCluster(id: "", name: String.localizedStringWithFormat(NSLocalizedString("widget.clusterCount", comment: "4 clusters"), entry.clusters.count), light: total.light, critical: total.critical, warning: total.warning, checkedAt: total.checkedAt, demo: false, problems: [])
                AccessoryView(cluster: all, stale: entry.clusters.allSatisfy { $0.isDim(at: entry.date) }, now: entry.date)
                    .accessoryBackground(circular: family == .accessoryCircular)
                    .widgetURL(entry.clusters.first?.url)
            }
        }
    }

    @ViewBuilder private var content: some View {
        if entry.clusters.isEmpty {
            EmptyStateView()
        } else {
            switch family {
            case .systemSmall:
                OverviewSmall(clusters: entry.clusters, now: entry.date)
                    .widgetURL(entry.clusters[0].url)
            case .systemMedium:
                OverviewMedium(clusters: entry.clusters, now: entry.date)
            default:
                OverviewLarge(clusters: entry.clusters, now: entry.date, rows: family == .systemExtraLarge ? 6 : 4, problems: family == .systemExtraLarge ? 6 : 3)
            }
        }
    }
}

/// All clusters added up, for the overview's headline: the worst light, the sums, the newest check
/// (each cluster's own age shows in its row, greyed when old).
private func summary(_ clusters: [WidgetCluster]) -> WidgetCluster {
    WidgetCluster(
        id: "",
        name: "",
        light: clusters.first?.light ?? "unknown",
        critical: clusters.reduce(0) { $0 + $1.critical },
        warning: clusters.reduce(0) { $0 + $1.warning },
        checkedAt: clusters.compactMap(\.checkedAt).max(),
        demo: false,
        problems: []
    )
}

private struct OverviewSmall: View {
    let clusters: [WidgetCluster]
    let now: Date

    var body: some View {
        let total = summary(clusters)
        let stale = clusters.allSatisfy { $0.isDim(at: now) }
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                NannyEye(light: total.light, stale: clusters.allSatisfy { $0.isDim(at: now) }, width: 46)
                Spacer(minLength: 4)
                Text(String.localizedStringWithFormat(NSLocalizedString("widget.clusterCount", comment: "4 clusters"), clusters.count))
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(Palette.mute)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            // A cluster whose agent went silent outranks every count: say which one, in coral.
            let silent = clusters.filter(\.unreachable)
            Text(silent.isEmpty ? total.headline : silent.count == 1 ? "\(silent[0].name): \(String(localized: "widget.silent"))" : String.localizedStringWithFormat(NSLocalizedString("widget.silentMany", comment: "2 agents not answering"), silent.count))
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .foregroundColor(silent.isEmpty ? Palette.tone(total.light) : Palette.crit)
                .lineLimit(3)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 6)
            HStack(spacing: 5) {
                ForEach(clusters.prefix(9)) { cluster in
                    Circle()
                        .fill(cluster.isDim(at: now) ? Palette.stale : Palette.tone(cluster.light))
                        .frame(width: 9, height: 9)
                }
            }
            .padding(.bottom, 5)
            AgeLine(date: total.checkedAt, stale: stale, now: now)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct OverviewMedium: View {
    let clusters: [WidgetCluster]
    let now: Date

    var body: some View {
        let shown = clusters.count > 4 ? Array(clusters.prefix(3)) : clusters
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, cluster in
                if index > 0 {
                    Spacer(minLength: 2)
                }
                ClusterRow(cluster: cluster, now: now)
            }
            if clusters.count > 4 {
                Spacer(minLength: 2)
                Text(String.localizedStringWithFormat(NSLocalizedString("widget.more", comment: "+2 more clusters"), clusters.count - 3))
                    .font(.caption.weight(.semibold))
                    .foregroundColor(Palette.mute)
                    .padding(.leading, 26)
            }
            if shown.count < 4 {
                Spacer(minLength: 0)
                if clusters.allSatisfy({ $0.isDim(at: now) }) {
                    StaleHint()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct OverviewLarge: View {
    let clusters: [WidgetCluster]
    let now: Date
    let rows: Int
    let problems: Int

    var body: some View {
        let total = summary(clusters)
        let top = clusters.flatMap { cluster in cluster.problems.map { (cluster: cluster, problem: $0) } }
            .enumerated()
            .sorted { ($0.element.problem.critical ? 0 : 1, $0.offset) < ($1.element.problem.critical ? 0 : 1, $1.offset) }
            .map(\.element)
            .prefix(problems)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                NannyEye(light: total.light, stale: clusters.allSatisfy { $0.isDim(at: now) }, width: 50)
                VStack(alignment: .leading, spacing: 2) {
                    Text(total.headline)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundColor(Palette.tone(total.light))
                        .lineLimit(2)
                        .minimumScaleFactor(0.75)
                    Text(String.localizedStringWithFormat(NSLocalizedString("widget.clusterCount", comment: "4 clusters"), clusters.count))
                        .font(.caption.weight(.semibold))
                        .foregroundColor(Palette.mute)
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                ForEach(clusters.prefix(rows)) { cluster in
                    ClusterRow(cluster: cluster, now: now)
                }
                if clusters.count > rows {
                    Text(String.localizedStringWithFormat(NSLocalizedString("widget.more", comment: "+2 more clusters"), clusters.count - rows))
                        .font(.caption.weight(.semibold))
                        .foregroundColor(Palette.mute)
                        .padding(.leading, 26)
                }
            }
            Rectangle().fill(Palette.line).frame(height: 1)
            if top.isEmpty {
                NoProblems()
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(top.enumerated()), id: \.offset) { _, item in
                        Link(destination: item.cluster.url ?? URL(string: "kubernanny://")!) {
                            ProblemRow(problem: item.problem, cluster: item.cluster.name, stale: item.cluster.isDim(at: now))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            if clusters.allSatisfy({ $0.isDim(at: now) }) {
                StaleHint()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Under a list whose every cluster is grey: what to do about it ("Not current · Open Kubernanny").
private struct StaleHint: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock.badge.exclamationmark")
            Text("\(String(localized: "widget.staleTag")) · \(String(localized: "widget.staleOpen"))")
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .font(.caption2.weight(.semibold))
        .foregroundColor(Palette.warnSoft)
    }
}

/// One cluster in a list: its light, name, counts and age; a tap opens it.
private struct ClusterRow: View {
    let cluster: WidgetCluster
    let now: Date

    var body: some View {
        let stale = cluster.isDim(at: now)
        Link(destination: cluster.url ?? URL(string: "kubernanny://")!) {
            HStack(spacing: 10) {
                LightDot(light: cluster.light, stale: stale, size: 16)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        Text(cluster.name)
                            .font(.subheadline.weight(.bold))
                            .foregroundColor(Palette.ink)
                            .lineLimit(1)
                        if cluster.demo {
                            DemoPill()
                        }
                    }
                    // Colour never carries alone: an old check also says so in words.
                    Text(cluster.unreachable ? String(localized: "widget.silent") : stale && cluster.checkedAt != nil ? "\(String(localized: "widget.staleTag")) · \(cluster.shortHeadline)" : cluster.shortHeadline)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(cluster.unreachable ? Palette.crit : stale ? Palette.mute : Palette.tone(cluster.light))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 4)
                AgeText(date: cluster.checkedAt, stale: stale, now: now)
            }
        }
    }
}

// MARK: - One cluster

struct ClusterWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClustersEntry

    var body: some View {
        if let cluster = entry.cluster {
            view(for: cluster).widgetURL(cluster.url)
        } else {
            empty
        }
    }

    @ViewBuilder private func view(for cluster: WidgetCluster) -> some View {
        let stale = cluster.isDim(at: entry.date)
        switch family {
        case .systemMedium:
            ClusterMedium(cluster: cluster, stale: stale, now: entry.date).navyBackground()
        case .systemLarge, .systemExtraLarge:
            ClusterLarge(cluster: cluster, stale: stale, now: entry.date).navyBackground()
        case .systemSmall:
            ClusterSmall(cluster: cluster, stale: stale, now: entry.date).navyBackground()
        default:
            if #available(iOSApplicationExtension 16.0, *) {
                AccessoryView(cluster: cluster, stale: stale, now: entry.date).accessoryBackground(circular: family == .accessoryCircular)
            }
        }
    }

    @ViewBuilder private var empty: some View {
        switch family {
        case .systemSmall, .systemMedium, .systemLarge, .systemExtraLarge:
            EmptyStateView().navyBackground()
        default:
            if #available(iOSApplicationExtension 16.0, *) {
                Image(systemName: "eyeglasses").font(.title3).accessoryBackground(circular: family == .accessoryCircular)
            }
        }
    }
}

/// Eye, name, the counts as large type, and the age.
private struct ClusterSmall: View {
    let cluster: WidgetCluster
    let stale: Bool
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                NannyEye(light: cluster.light, stale: stale, width: 46)
                Spacer(minLength: 4)
                if cluster.demo {
                    DemoPill()
                }
            }
            Spacer(minLength: 4)
            Text(cluster.name)
                .font(.headline)
                .foregroundColor(Palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Counts(cluster: cluster, stale: stale, size: 17)
            Spacer(minLength: 4)
            AgeLine(date: cluster.checkedAt, stale: stale, now: now)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// The small widget on the left, its worst problems on the right.
private struct ClusterMedium: View {
    let cluster: WidgetCluster
    let stale: Bool
    let now: Date

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ClusterSmall(cluster: cluster, stale: stale, now: now)
                .frame(width: 128)
            VStack(alignment: .leading, spacing: 8) {
                if cluster.problems.isEmpty {
                    Spacer(minLength: 0)
                    NoProblems(cluster: cluster)
                    Spacer(minLength: 0)
                } else {
                    ForEach(Array(cluster.problems.prefix(3).enumerated()), id: \.offset) { _, problem in
                        ProblemRow(problem: problem, cluster: nil, stale: stale)
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// Eye and name, two count tiles, the problems, the time of the check.
private struct ClusterLarge: View {
    let cluster: WidgetCluster
    let stale: Bool
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                NannyEye(light: cluster.light, stale: stale, width: 58)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(cluster.name)
                            .font(.title3.weight(.bold))
                            .foregroundColor(Palette.ink)
                            .lineLimit(1)
                        if cluster.demo {
                            DemoPill()
                        }
                    }
                    Text(cluster.unreachable ? String(localized: "widget.silent") : cluster.headline)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(cluster.unreachable ? Palette.crit : stale ? Palette.mute : Palette.tone(cluster.light))
                        .lineLimit(2)
                }
            }
            HStack(spacing: 10) {
                CountTile(count: cluster.critical, label: "widget.outagesTile", tone: Palette.crit, dim: stale || cluster.critical == 0)
                CountTile(count: cluster.warning, label: "widget.warningsTile", tone: Palette.warn, dim: stale || cluster.warning == 0)
            }
            if cluster.problems.isEmpty {
                NoProblems(cluster: cluster)
            } else {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(Array(cluster.problems.prefix(3).enumerated()), id: \.offset) { _, problem in
                        ProblemRow(problem: problem, cluster: nil, stale: stale)
                    }
                }
            }
            Spacer(minLength: 0)
            AgeLine(date: cluster.checkedAt, stale: stale, now: now, withTime: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Lock Screen and StandBy accessories

@available(iOSApplicationExtension 16.0, *)
private struct AccessoryView: View {
    @Environment(\.widgetFamily) private var family
    let cluster: WidgetCluster
    let stale: Bool
    let now: Date

    /// The state as a symbol: the accessories are drawn in one tint, so colour cannot say it.
    private var symbol: String {
        if stale || cluster.notChecked { return "questionmark.circle" }
        switch cluster.light {
        case "red": return "xmark.octagon.fill"
        case "yellow": return "exclamationmark.triangle.fill"
        default: return "checkmark.circle.fill"
        }
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            VStack(spacing: 0) {
                Image(systemName: symbol)
                    .font(.system(size: cluster.hasProblems ? 13 : 24, weight: .semibold))
                    .widgetAccentable()
                if cluster.hasProblems {
                    Text("\(cluster.critical > 0 ? cluster.critical : cluster.warning)")
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.6)
                }
            }
            .accessibilityLabel(Text("\(cluster.name): \(cluster.headline)"))
        case .accessoryInline:
            Text("\(Image(systemName: symbol)) \(cluster.name): \(cluster.shortHeadline)")
        default:
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Image(systemName: symbol).widgetAccentable()
                    Text(cluster.name).font(.headline).lineLimit(1)
                }
                Text(cluster.shortHeadline)
                    .font(.subheadline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(stale ? "\(String(localized: "widget.staleTag")) · \(WidgetData.age(cluster.checkedAt, now: now))" : WidgetData.age(cluster.checkedAt, now: now))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Parts

private struct EmptyStateView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            NannyEye(light: "unknown", stale: true, width: 46)
            Text("widget.name").font(.caption.bold()).foregroundColor(Palette.accent)
            Text("widget.empty").font(.footnote).foregroundColor(Palette.ink2)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// "2 outages" in coral over "3 warnings" in amber, or the one calm sentence.
private struct Counts: View {
    let cluster: WidgetCluster
    let stale: Bool
    let size: CGFloat

    var body: some View {
        if cluster.unreachable {
            // The dead man's switch fired: said in words and in coral, whatever the last state was.
            Text(String(localized: "widget.silent"))
                .font(.system(size: size, weight: .bold, design: .rounded))
                .foregroundColor(Palette.crit)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        } else if cluster.hasProblems && !cluster.notChecked {
            VStack(alignment: .leading, spacing: 0) {
                if cluster.critical > 0 {
                    Text(cluster.outagesText)
                        .font(.system(size: size, weight: .bold, design: .rounded))
                        .foregroundColor(stale ? Palette.mute : Palette.crit)
                }
                if cluster.warning > 0 {
                    Text(cluster.warningsText)
                        .font(.system(size: cluster.critical > 0 ? size - 3 : size, weight: .bold, design: .rounded))
                        .foregroundColor(stale ? Palette.mute : Palette.warn)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        } else {
            Text(cluster.headline)
                .font(.system(size: size, weight: .bold, design: .rounded))
                .foregroundColor(stale ? Palette.mute : Palette.tone(cluster.light))
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        }
    }
}

private struct CountTile: View {
    let count: Int
    let label: LocalizedStringKey
    let tone: Color
    let dim: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(count)")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundColor(dim ? Palette.mute : tone)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundColor(Palette.ink2)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.raised))
    }
}

/// A problem's title behind a dot in its severity, with "Outage" / "Warning" for those who cannot tell the colours.
/// Hidden on a locked device's Lock Screen (privacySensitive): titles name workloads and hosts.
private struct ProblemRow: View {
    let problem: WidgetProblem
    let cluster: String?
    let stale: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(stale ? Palette.stale : problem.critical ? Palette.crit : Palette.warn)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(problem.title)
                    .font(.footnote.weight(.medium))
                    .foregroundColor(Palette.ink)
                    .lineLimit(2)
                    .privacySensitive()
                if let cluster {
                    Text(cluster)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(Palette.mute)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(problem.critical ? "widget.outageLabel" : "widget.warningLabel") + Text(": \(problem.title)"))
    }
}

private struct NoProblems: View {
    var cluster: WidgetCluster? = nil

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundColor(cluster?.notChecked == true ? Palette.mute : Palette.ok)
            Text(cluster?.notChecked == true ? "widget.notChecked" : "widget.noProblems")
                .font(.footnote.weight(.semibold))
                .foregroundColor(Palette.ink2)
                .lineLimit(2)
        }
    }
}

/// "2 min ago", or "Not current · 3 h ago" with "Open Kubernanny" under it once the check is too old (WidgetCluster.staleAfter).
private struct AgeLine: View {
    let date: Date?
    let stale: Bool
    let now: Date
    var withTime = false

    var body: some View {
        if let date {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Image(systemName: stale ? "clock.badge.exclamationmark" : "clock")
                        .font(.caption2.weight(.semibold))
                    Text(text(date))
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if stale {
                    // What to do about it, under the clock's text: the age stays readable in the small sizes.
                    Text(String(localized: "widget.staleOpen"))
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.leading, 18)
                }
            }
            .foregroundColor(stale ? Palette.warnSoft : Palette.mute)
        }
    }

    private func text(_ date: Date) -> String {
        var parts = [WidgetData.age(date, now: now)]
        if stale {
            parts.insert(String(localized: "widget.staleTag"), at: 0)
        }
        if withTime {
            parts.append(asOf(date))
        }
        return parts.joined(separator: " · ")
    }
}

/// Only the age, right-aligned in a row.
private struct AgeText: View {
    let date: Date?
    let stale: Bool
    let now: Date

    var body: some View {
        Text(WidgetData.age(date, now: now))
            .font(.caption2.weight(.semibold))
            .foregroundColor(stale ? Palette.warnSoft : Palette.mute)
            .lineLimit(1)
    }
}

/// "as of 10:42" today, with the date on other days; follows the device's 12/24 h setting.
private func asOf(_ date: Date) -> String {
    let time = Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(date: .abbreviated, time: .shortened)
    return String(format: String(localized: "widget.asOf"), time)
}

/// The nanny's glasses from the app icon (branding/): the left lens with a dark
/// pupil, the right one in the cluster's light with a soft glow; an empty grey
/// ring when the state is unknown or no longer current.
struct NannyEye: View {
    let light: String
    let stale: Bool
    let width: CGFloat

    var body: some View {
        let lens = width * 0.42
        let line = max(2, lens * 0.13)
        let tone = Palette.tone(light)
        let off = stale || light == "unknown"
        HStack(spacing: width - 2 * lens) {
            ZStack {
                Circle().fill(Palette.lens)
                Circle().stroke(Palette.frame, lineWidth: line)
                Circle().fill(Palette.pupil).frame(width: lens * 0.38, height: lens * 0.38).offset(x: lens * 0.03, y: lens * 0.05)
            }
            .frame(width: lens, height: lens)
            ZStack {
                if !off {
                    Circle().fill(tone.opacity(0.45)).frame(width: lens * 1.5, height: lens * 1.5).blur(radius: lens * 0.22)
                }
                Circle().fill(Palette.lens)
                Circle().stroke(Palette.frame, lineWidth: line)
                if off {
                    Circle().stroke(Palette.stale, lineWidth: line * 0.8).frame(width: lens * 0.42, height: lens * 0.42)
                } else {
                    Circle().fill(tone).frame(width: lens * 0.44, height: lens * 0.44).offset(x: lens * 0.03, y: lens * 0.05)
                    Circle().fill(Color.white.opacity(0.8)).frame(width: lens * 0.12, height: lens * 0.12).offset(x: lens * 0.12, y: -lens * 0.05)
                }
            }
            .frame(width: lens, height: lens)
        }
        .overlay(
            // The bridge.
            Path { p in
                let mid = width / 2
                p.move(to: CGPoint(x: mid - (width - 2 * lens) / 2 - line * 0.3, y: lens * 0.46))
                p.addQuadCurve(to: CGPoint(x: mid + (width - 2 * lens) / 2 + line * 0.3, y: lens * 0.46), control: CGPoint(x: mid, y: lens * 0.3))
            }
            .stroke(Palette.frame, style: StrokeStyle(lineWidth: line, lineCap: .round)),
            alignment: .topLeading
        )
        .frame(width: width, height: lens)
        .accessibilityHidden(true)
    }
}

/// A light as a small dot with a ring, for list rows.
private struct LightDot: View {
    let light: String
    let stale: Bool
    let size: CGFloat

    var body: some View {
        let off = stale || light == "unknown"
        ZStack {
            Circle().stroke(off ? Palette.stale : Palette.tone(light).opacity(0.45), lineWidth: size * 0.14)
            Circle().fill(off ? Color.clear : Palette.tone(light)).padding(size * 0.26)
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

/// The app's colours on navy (app/src/styles.scss, dark theme; branding/ for the glasses).
enum Palette {
    static let navyTop = rgb(0x1D2B4D)
    static let navyBottom = rgb(0x0F1626)
    static let raised = rgb(0x24335A).opacity(0.7)
    static let line = rgb(0x2C3A5E)
    static let ink = rgb(0xE9EDF7)
    static let ink2 = rgb(0xC3CBE0)
    static let mute = rgb(0x8D97B5)
    static let accent = rgb(0x8EA2FF)
    static let stale = rgb(0x5A6585)
    static let ok = rgb(0x36D6A8)
    static let warn = rgb(0xF5B83D)
    static let warnSoft = rgb(0xD9B56E)
    static let crit = rgb(0xFF5D73)
    static let lens = rgb(0xEEF1FF)
    static let frame = rgb(0x7B90F3)
    static let pupil = rgb(0x16213B)

    static func tone(_ light: String) -> Color {
        switch light {
        case "green": return ok
        case "yellow": return warn
        case "red": return crit
        default: return mute
        }
    }

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension View {
    /// The navy of the app icon. iOS 17 requires containerBackground (it is left out in StandBy and tinted modes); earlier versions take a plain background.
    @ViewBuilder func navyBackground() -> some View {
        let gradient = LinearGradient(colors: [Palette.navyTop, Palette.navyBottom], startPoint: .top, endPoint: .bottom)
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) { gradient }
        } else {
            padding().background(gradient)
        }
    }

    /// Lock Screen accessories draw on the system's own background; the round one on its soft disc.
    @available(iOSApplicationExtension 16.0, *)
    @ViewBuilder func accessoryBackground(circular: Bool) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) {
                if circular {
                    AccessoryWidgetBackground()
                }
            }
        } else if circular {
            ZStack {
                AccessoryWidgetBackground()
                self
            }
        } else {
            self
        }
    }
}
