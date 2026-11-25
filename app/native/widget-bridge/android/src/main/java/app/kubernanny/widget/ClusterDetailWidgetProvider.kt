package app.kubernanny.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

/**
 * One cluster, the one in the worst state: small with its counts, wide with
 * its worst problems beside them, large with count tiles and the problems.
 * Drawn by WidgetRender from what the app and pushes stored (WidgetStore).
 */
class ClusterDetailWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WidgetRender.updateAll(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        WidgetRender.renderCluster(context, manager, id)
    }
}
