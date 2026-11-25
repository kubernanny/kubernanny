package app.kubernanny.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

/**
 * All clusters, worst first (the widget's original receiver, so placed widgets
 * stay): small shows everything added up with a dot per cluster, medium a row
 * per cluster, large adds the summary and the worst problems. Drawn by
 * WidgetRender from what the app and pushes stored (WidgetStore).
 */
class ClusterWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WidgetRender.updateAll(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        WidgetRender.renderOverview(context, manager, id)
    }

    companion object {
        /** Redraws every placed widget of both kinds; called by the plugin after each write. */
        fun updateAll(context: Context) = WidgetRender.updateAll(context)
    }
}
