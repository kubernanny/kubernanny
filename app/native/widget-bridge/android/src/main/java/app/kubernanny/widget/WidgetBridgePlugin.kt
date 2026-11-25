package app.kubernanny.widget

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
}
