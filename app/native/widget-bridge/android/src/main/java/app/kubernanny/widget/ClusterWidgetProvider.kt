package app.kubernanny.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews
import java.text.DateFormat

/**
 * The home-screen widget: up to three clusters, worst first, each with the
 * nanny's eye in its light, the headline, "as of HH:MM", and a tap that opens
 * that cluster in the app. It never talks to an agent and holds no key: all it
 * reads is the short list the app wrote (WidgetStore). A cluster whose last
 * check is over 30 minutes old is drawn grey, because the app only refreshes
 * while it is open.
 */
class ClusterWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(context, manager, it) }
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        render(context, manager, id)
    }

    private class Row(val row: Int, val light: Int, val name: Int, val demo: Int, val headline: Int, val time: Int)

    companion object {
        private val ROWS = listOf(
            Row(R.id.kn_row_0, R.id.kn_light_0, R.id.kn_name_0, R.id.kn_demo_0, R.id.kn_headline_0, R.id.kn_time_0),
            Row(R.id.kn_row_1, R.id.kn_light_1, R.id.kn_name_1, R.id.kn_demo_1, R.id.kn_headline_1, R.id.kn_time_1),
            Row(R.id.kn_row_2, R.id.kn_light_2, R.id.kn_name_2, R.id.kn_demo_2, R.id.kn_headline_2, R.id.kn_time_2),
        )
        private val SEVERITY = mapOf("red" to 0, "yellow" to 1, "unknown" to 2, "green" to 3)

        /** Redraws every placed widget; called by the plugin after each write. */
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            manager.getAppWidgetIds(ComponentName(context, ClusterWidgetProvider::class.java))
                .forEach { render(context, manager, it) }
        }

        private fun render(context: Context, manager: AppWidgetManager, id: Int) {
            val views = RemoteViews(context.packageName, R.layout.kn_widget_clusters)
            val now = System.currentTimeMillis()
            val clusters = WidgetStore.read(context).sortedBy { SEVERITY[it.light] ?: 2 }
            val shown = clusters.take(rowsFor(context, manager.getAppWidgetOptions(id)))

            views.setViewVisibility(R.id.kn_empty, if (shown.isEmpty()) View.VISIBLE else View.GONE)
            views.setOnClickPendingIntent(R.id.kn_root, openIntent(context, null))
            var anyStale = false
            ROWS.forEachIndexed { index, row ->
                val cluster = shown.getOrNull(index)
                if (cluster == null) {
                    views.setViewVisibility(row.row, View.GONE)
                    return@forEachIndexed
                }
                val stale = cluster.checkedAt == null || now - cluster.checkedAt > WidgetStore.STALE_AFTER_MS
                anyStale = anyStale || stale
                views.setViewVisibility(row.row, View.VISIBLE)
                views.setImageViewResource(row.light, if (stale) R.drawable.kn_light_unknown else lightDrawable(cluster.light))
                views.setTextViewText(row.name, cluster.name)
                views.setViewVisibility(row.demo, if (cluster.demo) View.VISIBLE else View.GONE)
                views.setTextViewText(row.headline, headline(context, cluster))
                views.setTextColor(row.headline, context.getColor(if (stale) R.color.kn_mute else toneColor(cluster.light)))
                views.setTextViewText(row.time, cluster.checkedAt?.let { context.getString(R.string.kn_widget_as_of, formatTime(it, now)) } ?: "")
                views.setOnClickPendingIntent(row.row, openIntent(context, cluster.id))
            }
            views.setViewVisibility(R.id.kn_stale, if (anyStale) View.VISIBLE else View.GONE)
            manager.updateAppWidget(id, views)
        }

        /**
         * How many rows fit. The launcher reports the widget's height in dp; a
         * row takes about 56 dp at normal text size and grows with the font scale.
         */
        private fun rowsFor(context: Context, options: Bundle): Int {
            val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
            val scale = context.resources.configuration.fontScale.coerceAtLeast(1f)
            return ((height - 30) / (56 * scale)).toInt().coerceIn(1, ROWS.size)
        }

        /** The same sentence as the app's headline, from the counts alone. */
        private fun headline(context: Context, c: WidgetCluster): String {
            val r = context.resources
            if (c.checkedAt == null || c.light == "unknown" && c.critical == 0 && c.warning == 0) {
                return r.getString(R.string.kn_widget_not_checked)
            }
            if (c.critical == 0 && c.warning == 0) {
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

        /** The time alone today (in the device's 12/24 h setting), the date on other days. */
        private fun formatTime(millis: Long, now: Long): String =
            DateUtils.formatSameDayTime(millis, now, DateFormat.SHORT, DateFormat.SHORT).toString()

        private fun lightDrawable(light: String) = when (light) {
            "green" -> R.drawable.kn_light_ok
            "yellow" -> R.drawable.kn_light_warn
            "red" -> R.drawable.kn_light_crit
            else -> R.drawable.kn_light_unknown
        }

        private fun toneColor(light: String) = when (light) {
            "green" -> R.color.kn_ok
            "yellow" -> R.color.kn_warn
            "red" -> R.color.kn_crit
            else -> R.color.kn_mute
        }

        /**
         * Opens the app's own launcher activity, with kubernanny://cluster?id=…
         * for a cluster row. Explicit, so no other app can catch it, and no
         * extra intent filter is needed: Capacitor's App plugin passes the
         * VIEW intent's data on as appUrlOpen (app/src/app/app.ts).
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
}
