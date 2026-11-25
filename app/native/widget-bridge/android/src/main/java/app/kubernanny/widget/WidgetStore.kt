package app.kubernanny.widget

import android.content.Context
import org.json.JSONArray
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** One cluster as the widget shows it: exactly the fields the app writes (WidgetCluster in the app). */
data class WidgetCluster(
    val id: String,
    val name: String,
    val light: String,
    val critical: Int,
    val warning: Int,
    /** Epoch milliseconds of the agent's last check, or null before its first run. */
    val checkedAt: Long?,
    val demo: Boolean,
)

/**
 * The widget's storage: one JSON string in a private SharedPreferences file
 * of its own, so it never mixes with the app's other preferences. Backups are
 * off for the whole app (allowBackup="false"), this file included.
 */
object WidgetStore {
    private const val FILE = "kubernanny_widget"
    private const val KEY = "clusters.v1"

    /** After this long without a check the widget greys out: the app only refreshes while it is open. */
    const val STALE_AFTER_MS = 30 * 60 * 1000L

    fun readJson(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null)

    /** null removes the entry: switched off, or nothing to show. commit(), so it is gone before the call returns. */
    fun writeJson(context: Context, json: String?) {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
        if (json == null) prefs.remove(KEY) else prefs.putString(KEY, json)
        prefs.commit()
    }

    /** Malformed entries are skipped, never shown half. */
    fun read(context: Context): List<WidgetCluster> {
        val array = runCatching { JSONArray(readJson(context) ?: return emptyList()) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            runCatching {
                val o = array.getJSONObject(i)
                WidgetCluster(
                    id = o.getString("id"),
                    name = o.getString("name"),
                    light = o.getString("light"),
                    critical = o.getInt("critical"),
                    warning = o.getInt("warning"),
                    checkedAt = if (o.isNull("checkedAt")) null else parseIso(o.getString("checkedAt")),
                    demo = o.getBoolean("demo"),
                )
            }.getOrNull()
        }
    }

    /**
     * ISO 8601 as the app and the agent write it, with or without
     * milliseconds. SimpleDateFormat rather than java.time: minSdk is 24 and
     * the app has no desugaring.
     */
    fun parseIso(text: String): Long? {
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")) {
            val format = SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            val position = ParsePosition(0)
            val date = format.parse(text, position)
            if (date != null && position.index == text.length) {
                return date.time
            }
        }
        return null
    }
}
