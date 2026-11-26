package app.kubernanny.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.format.DateUtils
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import java.text.DateFormat

/**
 * Draws both home-screen widgets from the stored list (WidgetStore). They never
 * talk to an agent and hold no key; the list is written by the app while it is
 * open and updated from every native push (WidgetPushStatus.java). Each widget
 * shows the time of the check, and a cluster whose check is over two hours
 * old (WidgetStore.STALE_AFTER_MS) is drawn grey with "Not current" and "Open
 * Kubernanny": an alarm redraws at that moment (not waking the device), and
 * updatePeriodMillis every 30 minutes as a fallback.
 *
 * Responsive: from Android 12 the launcher picks the layout for the widget's
 * size from a map; before, the size the launcher reports decides.
 */
object WidgetRender {
    private val SEVERITY = mapOf("red" to 0, "yellow" to 1, "unknown" to 2, "green" to 3)

    /** Redraws every placed widget of both kinds; after each write by the app or a push. */
    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        manager.getAppWidgetIds(ComponentName(context, ClusterWidgetProvider::class.java)).forEach { renderOverview(context, manager, it) }
        manager.getAppWidgetIds(ComponentName(context, ClusterDetailWidgetProvider::class.java)).forEach { renderCluster(context, manager, it) }
        scheduleNextStale(context)
    }

    private fun clusters(context: Context) = WidgetStore.read(context).withIndex().sortedWith(compareBy({ SEVERITY[it.value.light] ?: 2 }, { it.index })).map { it.value }

    // ---------- all clusters ----------

    fun renderOverview(context: Context, manager: AppWidgetManager, id: Int) {
        val list = clusters(context)
        val now = System.currentTimeMillis()
        val layouts = OverviewLayout.SPECS.map { spec ->
            SizeF(spec.minWidth, spec.minHeight) to {
                if (spec.small) overviewSmall(context, list, now) else overviewList(context, list, now, spec)
            }
        }
        manager.updateAppWidget(id, responsive(context, manager.getAppWidgetOptions(id), layouts))
    }

    private fun overviewSmall(context: Context, list: List<WidgetCluster>, now: Long): RemoteViews {
        val v = RemoteViews(context.packageName, R.layout.kn_overview_small)
        v.setOnClickPendingIntent(R.id.kn_root, openIntent(context, list.firstOrNull()?.id))
        if (list.isEmpty()) {
            v.setViewVisibility(R.id.kn_empty, View.VISIBLE)
            v.setViewVisibility(R.id.kn_headline, View.GONE)
            v.setViewVisibility(R.id.kn_time, View.GONE)
            return v
        }
        v.setViewVisibility(R.id.kn_empty, View.GONE)
        v.setViewVisibility(R.id.kn_headline, View.VISIBLE)
        val total = summary(list)
        val allStale = list.all { it.isStale(now) }
        v.setImageViewResource(R.id.kn_eye, eye(total.light, allStale))
        v.setTextViewText(R.id.kn_count, count(context, list.size))
        // A cluster whose agent went silent outranks every count: say which one, in coral.
        val silent = list.filter { it.unreachable }
        if (silent.isEmpty()) {
            v.setTextViewText(R.id.kn_headline, headline(context, total))
            v.setTextColor(R.id.kn_headline, context.getColor(tone(total.light)))
        } else {
            v.setTextViewText(R.id.kn_headline, if (silent.size == 1) silent[0].name + ": " + context.getString(R.string.kn_widget_silent) else context.getString(R.string.kn_widget_silent_many, silent.size))
            v.setTextColor(R.id.kn_headline, context.getColor(R.color.kn_crit))
        }
        for (i in 0 until 8) {
            val dotId = context.resources.getIdentifier("kn_sdot_$i", "id", context.packageName)
            val cluster = list.getOrNull(i)
            v.setViewVisibility(dotId, if (cluster == null) View.GONE else View.VISIBLE)
            cluster?.let { v.setImageViewResource(dotId, dot(it.light, it.isStale(now) || it.unreachable)) }
        }
        time(context, v, R.id.kn_time, total.checkedAt, allStale, now)
        return v
    }

    /**
     * Every optional view gets its visibility set both ways: the sizes share one
     * layout, and when the launcher switches size it reapplies these actions to
     * the view the previous size drew, so a "+1 more" or a summary set visible
     * there would otherwise stay.
     */
    private fun overviewList(context: Context, list: List<WidgetCluster>, now: Long, spec: OverviewSpec): RemoteViews {
        val header = spec.header
        val rows = spec.rows
        val problems = spec.problems
        val v = RemoteViews(context.packageName, R.layout.kn_overview_list)
        v.setOnClickPendingIntent(R.id.kn_root, openIntent(context, null))
        v.setViewVisibility(R.id.kn_empty, if (list.isEmpty()) View.VISIBLE else View.GONE)
        val shown = list.take(OverviewLayout.shown(list.size, spec))
        v.setViewVisibility(R.id.kn_header, if (header && list.isNotEmpty()) View.VISIBLE else View.GONE)
        if (header && list.isNotEmpty()) {
            val total = summary(list)
            v.setImageViewResource(R.id.kn_eye, eye(total.light, list.all { it.isStale(now) }))
            v.setTextViewText(R.id.kn_headline, headline(context, total))
            v.setTextColor(R.id.kn_headline, context.getColor(tone(total.light)))
            v.setTextViewText(R.id.kn_count, count(context, list.size))
        }
        for (i in 0 until 5) {
            val cluster = shown.getOrNull(i)
            val row = id(context, "kn_row_$i")
            if (cluster == null) {
                v.setViewVisibility(row, View.GONE)
                continue
            }
            val stale = cluster.isStale(now) || cluster.unreachable
            v.setViewVisibility(row, View.VISIBLE)
            v.setImageViewResource(id(context, "kn_dot_$i"), dot(cluster.light, stale))
            v.setTextViewText(id(context, "kn_name_$i"), cluster.name)
            v.setViewVisibility(id(context, "kn_demo_$i"), if (cluster.demo) View.VISIBLE else View.GONE)
            // Colour never carries alone: an old check also says so in words.
            val line = shortHeadline(context, cluster)
            v.setTextViewText(
                id(context, "kn_headline_$i"),
                when {
                    cluster.unreachable -> context.getString(R.string.kn_widget_silent)
                    stale && cluster.checkedAt != null -> context.getString(R.string.kn_widget_stale_tag) + " · " + line
                    else -> line
                },
            )
            v.setTextColor(id(context, "kn_headline_$i"), context.getColor(if (cluster.unreachable) R.color.kn_crit else if (stale) R.color.kn_mute else tone(cluster.light)))
            v.setTextViewText(id(context, "kn_time_$i"), cluster.checkedAt?.let { formatTime(it, now) } ?: "")
            v.setTextColor(id(context, "kn_time_$i"), context.getColor(if (stale) R.color.kn_warn_soft else R.color.kn_mute))
            v.setOnClickPendingIntent(row, openIntent(context, cluster.id))
        }
        val more = OverviewLayout.more(list.size, spec)
        v.setViewVisibility(R.id.kn_more, if (more > 0) View.VISIBLE else View.GONE)
        if (more > 0) {
            v.setTextViewText(R.id.kn_more, context.resources.getQuantityString(R.plurals.kn_widget_more, more, more))
        }
        // Every cluster grey: say what to do about it, where a free row or the large size leaves room.
        val staleHint = list.isNotEmpty() && list.all { it.isStale(now) } && (problems || list.size < rows)
        v.setViewVisibility(R.id.kn_stale_hint, if (staleHint) View.VISIBLE else View.GONE)
        if (staleHint) {
            v.setTextViewText(R.id.kn_stale_hint, context.getString(R.string.kn_widget_stale_tag) + " · " + context.getString(R.string.kn_widget_stale_open))
        }
        v.setViewVisibility(R.id.kn_divider, if (problems && list.isNotEmpty()) View.VISIBLE else View.GONE)
        if (problems && list.isNotEmpty()) {
            val top = list.flatMap { c -> c.problems.map { c to it } }.sortedBy { if (it.second.critical) 0 else 1 }.take(3)
            problems(context, v, top.map { it.second }, top.map { it.first }, now, withCluster = true, max = 4)
        } else {
            for (i in 0 until 4) {
                v.setViewVisibility(id(context, "kn_prob_$i"), View.GONE)
            }
            v.setViewVisibility(R.id.kn_no_problems, View.GONE)
        }
        return v
    }

    // ---------- one cluster ----------

    fun renderCluster(context: Context, manager: AppWidgetManager, id: Int) {
        val cluster = clusters(context).firstOrNull()
        val now = System.currentTimeMillis()
        val small = { clusterViews(context, R.layout.kn_cluster_small, cluster, now) }
        val wide = { clusterViews(context, R.layout.kn_cluster_wide, cluster, now) }
        val large = { clusterViews(context, R.layout.kn_cluster_large, cluster, now) }
        manager.updateAppWidget(id, responsive(context, manager.getAppWidgetOptions(id), listOf(SizeF(40f, 40f) to small, SizeF(250f, 40f) to wide, SizeF(220f, 340f) to large)))
    }

    private fun clusterViews(context: Context, layout: Int, cluster: WidgetCluster?, now: Long): RemoteViews {
        val v = RemoteViews(context.packageName, layout)
        v.setOnClickPendingIntent(R.id.kn_root, openIntent(context, cluster?.id))
        if (cluster == null) {
            v.setViewVisibility(R.id.kn_empty, View.VISIBLE)
            for (gone in listOf(R.id.kn_name, R.id.kn_line1, R.id.kn_time)) {
                v.setViewVisibility(gone, View.GONE)
            }
            if (layout == R.layout.kn_cluster_large) {
                v.setViewVisibility(R.id.kn_tiles, View.GONE)
            }
            return v
        }
        // Both ways, as in overviewList: an update reapplies to the view the last one drew.
        v.setViewVisibility(R.id.kn_empty, View.GONE)
        for (shown in listOf(R.id.kn_name, R.id.kn_line1, R.id.kn_time)) {
            v.setViewVisibility(shown, View.VISIBLE)
        }
        if (layout == R.layout.kn_cluster_large) {
            v.setViewVisibility(R.id.kn_tiles, View.VISIBLE)
        } else {
            v.setViewVisibility(R.id.kn_line2, View.GONE)
        }
        val stale = cluster.isStale(now) || cluster.unreachable
        v.setImageViewResource(R.id.kn_eye, eye(cluster.light, stale))
        v.setTextViewText(R.id.kn_name, cluster.name)
        v.setViewVisibility(R.id.kn_demo, if (cluster.demo) View.VISIBLE else View.GONE)
        val r = context.resources
        if (layout == R.layout.kn_cluster_large) {
            v.setTextViewText(R.id.kn_line1, headline(context, cluster))
            v.setTextColor(R.id.kn_line1, context.getColor(if (stale) R.color.kn_mute else tone(cluster.light)))
            v.setTextViewText(R.id.kn_tile_crit, cluster.critical.toString())
            v.setTextColor(R.id.kn_tile_crit, context.getColor(if (stale || cluster.critical == 0) R.color.kn_mute else R.color.kn_crit))
            v.setTextViewText(R.id.kn_tile_warn, cluster.warning.toString())
            v.setTextColor(R.id.kn_tile_warn, context.getColor(if (stale || cluster.warning == 0) R.color.kn_mute else R.color.kn_warn))
            problems(context, v, cluster.problems, null, now, withCluster = false, max = 4, stale = stale, calm = cluster)
        } else {
            // "2 outages" in coral over "3 warnings" in amber, or the one calm sentence.
            if (cluster.hasProblems && !cluster.notChecked) {
                val first = if (cluster.critical > 0) r.getQuantityString(R.plurals.kn_widget_outages, cluster.critical, cluster.critical) else r.getQuantityString(R.plurals.kn_widget_warnings, cluster.warning, cluster.warning)
                v.setTextViewText(R.id.kn_line1, first)
                v.setTextColor(R.id.kn_line1, context.getColor(if (stale) R.color.kn_mute else if (cluster.critical > 0) R.color.kn_crit else R.color.kn_warn))
                if (cluster.critical > 0 && cluster.warning > 0) {
                    v.setViewVisibility(R.id.kn_line2, View.VISIBLE)
                    v.setTextViewText(R.id.kn_line2, r.getQuantityString(R.plurals.kn_widget_warnings, cluster.warning, cluster.warning))
                    v.setTextColor(R.id.kn_line2, context.getColor(if (stale) R.color.kn_mute else R.color.kn_warn))
                }
            } else {
                v.setTextViewText(R.id.kn_line1, headline(context, cluster))
                v.setTextColor(R.id.kn_line1, context.getColor(if (stale) R.color.kn_mute else tone(cluster.light)))
            }
            if (layout == R.layout.kn_cluster_wide) {
                problems(context, v, cluster.problems, null, now, withCluster = false, max = 3, stale = stale, calm = cluster)
            }
        }
        if (cluster.unreachable) {
            // The dead man's switch fired: say so in words and in coral, whatever the last state was.
            if (layout != R.layout.kn_cluster_large) {
                v.setViewVisibility(R.id.kn_line2, View.GONE)
            }
            v.setTextViewText(R.id.kn_line1, context.getString(R.string.kn_widget_silent))
            v.setTextColor(R.id.kn_line1, context.getColor(R.color.kn_crit))
        }
        time(context, v, R.id.kn_time, cluster.checkedAt, stale, now)
        return v
    }

    // ---------- parts ----------

    private fun problems(context: Context, v: RemoteViews, list: List<WidgetProblem>, owners: List<WidgetCluster>?, now: Long, withCluster: Boolean, max: Int, stale: Boolean = false, calm: WidgetCluster? = null) {
        for (i in 0 until max) {
            val problem = list.getOrNull(i)
            val row = id(context, "kn_prob_$i")
            if (problem == null) {
                v.setViewVisibility(row, View.GONE)
                continue
            }
            val owner = owners?.getOrNull(i)
            val grey = stale || (owner?.isStale(now) ?: false)
            v.setViewVisibility(row, View.VISIBLE)
            v.setImageViewResource(id(context, "kn_prob_dot_$i"), if (grey) R.drawable.kn_dot_off else if (problem.critical) R.drawable.kn_dot_crit else R.drawable.kn_dot_warn)
            v.setTextViewText(id(context, "kn_prob_title_$i"), problem.title)
            v.setContentDescription(row, context.getString(if (problem.critical) R.string.kn_widget_outage_label else R.string.kn_widget_warning_label) + ": " + problem.title)
            if (withCluster && owner != null) {
                v.setTextViewText(id(context, "kn_prob_cluster_$i"), owner.name)
                v.setOnClickPendingIntent(row, openIntent(context, owner.id))
            }
        }
        v.setViewVisibility(R.id.kn_no_problems, if (list.isEmpty()) View.VISIBLE else View.GONE)
        if (list.isEmpty()) {
            if (calm?.notChecked == true) {
                v.setTextViewText(R.id.kn_no_problems, context.getString(R.string.kn_widget_not_checked))
            }
        }
    }

    /**
     * "as of 10:42", or once the check is too old "Not current · as of 9:20" with "Open Kubernanny"
     * on a second line, in a softer amber (the time view allows two lines in every layout).
     */
    private fun time(context: Context, v: RemoteViews, viewId: Int, checkedAt: Long?, stale: Boolean, now: Long) {
        if (checkedAt == null) {
            v.setViewVisibility(viewId, View.GONE)
            return
        }
        v.setViewVisibility(viewId, View.VISIBLE)
        val text = formatTime(checkedAt, now)
        v.setTextViewText(viewId, if (stale) context.getString(R.string.kn_widget_stale_time, text) + "\n" + context.getString(R.string.kn_widget_stale_open) else context.getString(R.string.kn_widget_as_of, text))
        v.setTextColor(viewId, context.getColor(if (stale) R.color.kn_warn_soft else R.color.kn_mute))
    }

    /**
     * From Android 12 a map of layouts (the launcher picks the largest that
     * fits, by size in dp); before, the size the launcher reports decides (min
     * width in portrait, max height), with the font scale counted in.
     */
    private fun responsive(context: Context, options: Bundle, layouts: List<Pair<SizeF, () -> RemoteViews>>): RemoteViews {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return RemoteViews(layouts.associate { (size, build) -> size to build() })
        }
        val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110)
        val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110)
        val scale = context.resources.configuration.fontScale.coerceAtLeast(1f)
        val fits = layouts.filter { (size, _) -> size.width * scale <= width && size.height * scale <= height }
        return (fits.lastOrNull() ?: layouts.first()).second()
    }

    /** All clusters added up: the worst light, the sums, the newest check (each row shows its own). */
    private fun summary(list: List<WidgetCluster>) = WidgetCluster(
        id = "",
        name = "",
        light = list.firstOrNull()?.light ?: "unknown",
        critical = list.sumOf { it.critical },
        warning = list.sumOf { it.warning },
        checkedAt = list.mapNotNull { it.checkedAt }.maxOrNull(),
        demo = false,
    )

    /** The same sentence as the app's headline, from the counts alone. */
    fun headline(context: Context, c: WidgetCluster): String {
        val r = context.resources
        if (c.notChecked) {
            return r.getString(R.string.kn_widget_not_checked)
        }
        if (!c.hasProblems) {
            return r.getString(if (c.light == "yellow") R.string.kn_widget_partly else R.string.kn_widget_all_good)
        }
        val outages = r.getQuantityString(R.plurals.kn_widget_outages, c.critical, c.critical)
        val warnings = r.getQuantityString(R.plurals.kn_widget_warnings, c.warning, c.warning)
        return when {
            c.critical > 0 && c.warning > 0 -> r.getString(R.string.kn_widget_both, outages, warnings)
            c.critical > 0 -> outages
            else -> warnings
        }
    }

    /** One line: "2 outages · 3 warnings". */
    private fun shortHeadline(context: Context, c: WidgetCluster): String {
        if (c.notChecked || !c.hasProblems) {
            return headline(context, c)
        }
        val r = context.resources
        return listOfNotNull(
            if (c.critical > 0) r.getQuantityString(R.plurals.kn_widget_outages, c.critical, c.critical) else null,
            if (c.warning > 0) r.getQuantityString(R.plurals.kn_widget_warnings, c.warning, c.warning) else null,
        ).joinToString(" · ")
    }

    private fun count(context: Context, n: Int) = context.resources.getQuantityString(R.plurals.kn_widget_cluster_count, n, n)

    /** The time alone today (in the device's 12/24 h setting), the date on other days. */
    private fun formatTime(millis: Long, now: Long): String =
        DateUtils.formatSameDayTime(millis, now, DateFormat.SHORT, DateFormat.SHORT).toString()

    private fun eye(light: String, stale: Boolean) = if (stale) R.drawable.kn_eye_off else when (light) {
        "green" -> R.drawable.kn_eye_ok
        "yellow" -> R.drawable.kn_eye_warn
        "red" -> R.drawable.kn_eye_crit
        else -> R.drawable.kn_eye_off
    }

    private fun dot(light: String, stale: Boolean) = if (stale) R.drawable.kn_dot_off else when (light) {
        "green" -> R.drawable.kn_dot_ok
        "yellow" -> R.drawable.kn_dot_warn
        "red" -> R.drawable.kn_dot_crit
        else -> R.drawable.kn_dot_off
    }

    private fun tone(light: String) = when (light) {
        "green" -> R.color.kn_ok
        "yellow" -> R.color.kn_warn
        "red" -> R.color.kn_crit
        else -> R.color.kn_mute
    }

    private fun id(context: Context, name: String) = context.resources.getIdentifier(name, "id", context.packageName)

    /**
     * Redraws when the next cluster turns grey. Not exact and not waking the
     * device: the alarm fires at the next moment the device is awake anyway.
     */
    private fun scheduleNextStale(context: Context) {
        val now = System.currentTimeMillis()
        val next = WidgetStore.read(context).mapNotNull { it.checkedAt?.plus(WidgetStore.STALE_AFTER_MS) }.filter { it > now }.minOrNull()
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(WidgetRefreshReceiver.ACTION).setClass(context, WidgetRefreshReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        if (next == null) {
            alarms.cancel(intent)
        } else {
            alarms.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + (next - now) + 1_000, intent)
        }
    }

    /**
     * Opens the app's own launcher activity, with kubernanny://cluster?id=…
     * for a cluster. Explicit, so no other app can catch it, and no extra
     * intent filter is needed: Capacitor's App plugin passes the VIEW intent's
     * data on as appUrlOpen (app/src/app/app.ts).
     */
    private fun openIntent(context: Context, clusterId: String?): PendingIntent {
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).apply {
            if (clusterId != null) {
                action = Intent.ACTION_VIEW
                data = Uri.Builder().scheme("kubernanny").authority("cluster").appendQueryParameter("id", clusterId).build()
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        return PendingIntent.getActivity(
            context,
            clusterId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
