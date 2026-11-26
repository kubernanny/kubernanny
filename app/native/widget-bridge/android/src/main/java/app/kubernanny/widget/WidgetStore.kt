package app.kubernanny.widget

import android.content.Context
import org.json.JSONArray
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** One open problem as the larger widgets list it (WidgetProblem in the app). */
data class WidgetProblem(val title: String, val critical: Boolean)

/**
 * One cluster as the widget shows it: exactly the fields the app writes
 * (WidgetCluster in the app), and that the push service updates from a sealed
 * push (WidgetPushStatus.java in app/native/push).
 */
data class WidgetCluster(
    val id: String,
    val name: String,
    val light: String,
    val critical: Int,
    val warning: Int,
    /** Epoch milliseconds of the agent's last check, or null before its first run. */
    val checkedAt: Long?,
    val demo: Boolean,
    /** The worst open problems, outages first; absent in lists an older app version stored. */
    val problems: List<WidgetProblem> = emptyList(),
    /** Epoch ms when this phone showed the dead man's switch message for the cluster (written by the push service), or null. */
    val unreachableSince: Long? = null,
) {
    val hasProblems get() = critical + warning > 0
    /** "Agent not answering": the silence warning came after the last check; any newer check ends it (isUnreachable in the app). */
    val unreachable get() = unreachableSince != null && (checkedAt == null || unreachableSince > checkedAt)
    val notChecked get() = checkedAt == null || (light == "unknown" && !hasProblems)

    fun isStale(now: Long) = checkedAt == null || now - checkedAt > WidgetStore.STALE_AFTER_MS
}

/**
 * The widget's storage: one JSON string in a private SharedPreferences file
 * of its own, so it never mixes with the app's other preferences. Backups are
 * off for the whole app (allowBackup="false"), this file included.
 */
object WidgetStore {
    // Keep in step with WidgetPushStatus.java (app/native/push), which writes a push's state here.
    private const val FILE = "kubernanny_widget"
    private const val KEY = "clusters.v1"

    /**
     * After this long without a check the widget greys out: only the open app and pushes refresh it
     * (on a quiet day a status push about hourly). Two hours: one missed status push does not grey a
     * healthy cluster. Same as staleAfter on iOS and WIDGET_STALE_HOURS in the app.
     */
    const val STALE_AFTER_MS = 2 * 60 * 60 * 1000L

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
                    problems = o.optJSONArray("problems")?.let { list ->
                        (0 until minOf(list.length(), 3)).mapNotNull { j ->
                            list.optJSONObject(j)?.let { p -> WidgetProblem(p.getString("title"), p.getString("severity") == "critical") }
                        }
                    } ?: emptyList(),
                    unreachableSince = o.optString("unreachableSince", "").takeIf { it.isNotEmpty() }?.let { parseIso(it) },
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
