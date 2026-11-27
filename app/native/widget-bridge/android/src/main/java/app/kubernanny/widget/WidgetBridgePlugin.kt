package app.kubernanny.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Hands the home-screen widget its short list of clusters. The app builds
 * and checks the list (app/src/app/core/widget/); this side only stores it
 * in the widget's SharedPreferences and redraws the widgets.
 */
@CapacitorPlugin(name = "WidgetBridge")
class WidgetBridgePlugin : Plugin() {

    @PluginMethod
    fun read(call: PluginCall) {
        val json = WidgetStore.readJson(context)
        val clusters = runCatching { JSArray(json ?: "[]") }.getOrDefault(JSArray())
        call.resolve(JSObject().put("clusters", clusters))
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val clusters = call.getArray("clusters") ?: JSArray()
        WidgetStore.writeJson(context, if (clusters.length() == 0) null else clusters.toString())
        ClusterWidgetProvider.updateAll(context)
        call.resolve()
    }

    /**
     * How many widgets of both kinds are placed. Both show every cluster of
     * the list or the worst of them, so the app tells each agent of the list
     * that a widget shows it (silent hourly status pushes, docs/NOTIFICATIONS.md).
     */
    @PluginMethod
    fun placed(call: PluginCall) {
        val manager = AppWidgetManager.getInstance(context)
        val count = listOf(ClusterWidgetProvider::class.java, ClusterDetailWidgetProvider::class.java).sumOf { provider ->
            runCatching { manager.getAppWidgetIds(ComponentName(context, provider)).size }.getOrDefault(0)
        }
        call.resolve(JSObject().put("count", count))
    }

    /**
     * The background refresh (WidgetRefresher): how often (minutes, 0 off), in which language, and per
     * cluster of the widget list what GET /status needs. Sealed into the Keystore-backed store, then the
     * periodic work is (re)scheduled. Resolves whether this device can do it at all (API 28 and later).
     */
    @PluginMethod
    fun setRefresh(call: PluginCall) {
        val minutes = call.getInt("intervalMinutes") ?: 0
        val list = call.getArray("targets") ?: JSArray()
        val targets = try {
            (0 until list.length()).map { i ->
                val t = list.getJSONObject(i)
                RefreshTarget(
                    id = t.getString("id"),
                    url = t.getString("url"),
                    relayUrl = t.optString("relayUrl", "").ifEmpty { null },
                    agentKey = t.getString("agentKey"),
                    deviceKey = t.getString("deviceKey"),
                )
            }
        } catch (e: Exception) {
            call.reject("invalid refresh targets")
            return
        }
        val supported = WidgetRefresher.supported
        try {
            RefreshTargets.write(context, RefreshSettings(if (supported) minutes else 0, call.getString("language"), targets))
            WidgetRefresher.schedule(context)
        } catch (e: Exception) {
            call.reject("cannot store the refresh targets")
            return
        }
        // The refresh button changes with it: in place, or opening the app.
        WidgetRender.updateAll(context)
        call.resolve(JSObject().put("supported", supported))
    }

    /** The app's page in the system settings, where its battery use can be set to "Unrestricted". */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        val intent = android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(android.net.Uri.fromParts("package", context.packageName, null))
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("cannot open the settings")
        }
    }

    /**
     * After a refresh from the widget's button (kubernanny://refresh): back to
     * the home screen the person came from, the app staying in the background.
     */
    @PluginMethod
    fun moveToBack(call: PluginCall) {
        val host = activity
        if (host == null) {
            call.resolve(JSObject().put("moved", false))
            return
        }
        host.runOnUiThread {
            call.resolve(JSObject().put("moved", host.moveTaskToBack(true)))
        }
    }
}
