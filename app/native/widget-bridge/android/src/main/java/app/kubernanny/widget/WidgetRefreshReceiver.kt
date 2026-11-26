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
        WidgetRender.updateAll(context)
    }

    companion object {
        /** Keep in step with WidgetPushStatus.REFRESH in app/native/push. */
        const val ACTION = "app.kubernanny.widget.REFRESH"
    }
}
