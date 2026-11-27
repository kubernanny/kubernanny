package app.kubernanny.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Redraws the widgets: after a push stored a cluster's new state
 * (WidgetPushStatus.java sends ACTION, explicitly to this class), at the
 * moment a cluster turns grey (WidgetRender's alarm), after an update of the
 * app (MY_PACKAGE_REPLACED) and after a change of the system language
 * (LOCALE_CHANGED: the launcher would keep the texts of the old language until
 * the next write). Not exported: no other app can reach it.
 */
class WidgetRefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == REFRESH_NOW) {
            // The widget's refresh button with the background refresh on: ask the agents now, in place.
            WidgetRefresher.refreshNow(context)
            return
        }
        WidgetRender.updateAll(context)
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            WidgetRefresher.schedule(context)
        }
    }

    companion object {
        /** Keep in step with WidgetPushStatus.REFRESH in app/native/push. */
        const val ACTION = "app.kubernanny.widget.REFRESH"
        /** The refresh button while the background refresh is on (WidgetRender.refreshIntent). */
        const val REFRESH_NOW = "app.kubernanny.widget.REFRESH_NOW"
    }
}
