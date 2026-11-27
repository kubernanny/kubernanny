package app.kubernanny.widget

import org.json.JSONArray
import org.json.JSONObject

/**
 * Turns an agent's status (GET /status, the app's Snapshot) into the widget's
 * entry for that cluster, as the app does (widgetCluster in
 * app/src/app/core/widget/widget-summary.ts): open outages and warnings
 * counted like the headline (silenced ones and hints left out), the three
 * worst problems, outages first. Plain org.json, so a JVM test runs it.
 *
 * It only updates an entry the app stored (a cluster switched off for the
 * widget has none), keeps its name and demo flag, and only takes a check newer
 * than the stored one, like a push (WidgetPushStatus).
 */
object WidgetSnapshot {
    private const val MAX_PROBLEMS = 3
    private const val MAX_TITLE = 120
    private val LIGHTS = setOf("green", "yellow", "red", "unknown")

    /** The stored list with `clusterId` brought up to `status`, or null when nothing changes. */
    fun merge(stored: String?, clusterId: String, status: JSONObject): String? {
        return try {
            if (stored == null) return null
            val list = JSONArray(stored)
            val entry = (0 until list.length()).mapNotNull { list.optJSONObject(it) }.firstOrNull { it.optString("id") == clusterId }
                ?: return null
            val light = status.optString("light")
            val checkedAtText = if (status.isNull("checkedAt")) null else status.optString("checkedAt", "")
            val checkedAt = checkedAtText?.let { WidgetStore.parseIso(it) } ?: return null
            if (light !in LIGHTS) return null
            val before = if (entry.isNull("checkedAt")) null else WidgetStore.parseIso(entry.optString("checkedAt", ""))
            if (before != null && before >= checkedAt) return null
            val issues = status.optJSONArray("issues") ?: return null
            val counted = (0 until issues.length()).mapNotNull { issues.optJSONObject(it) }.filter {
                val severity = it.optString("severity")
                (severity == "critical" || severity == "warning") && (it.isNull("silencedUntil") || !it.has("silencedUntil"))
            }
            val outages = counted.filter { it.optString("severity") == "critical" }
            val warnings = counted.filter { it.optString("severity") != "critical" }
            val problems = JSONArray()
            for (issue in (outages + warnings).take(MAX_PROBLEMS)) {
                problems.put(
                    JSONObject()
                        .put("title", clip(issue.optString("title"), MAX_TITLE))
                        .put("severity", if (issue.optString("severity") == "critical") "critical" else "warning"),
                )
            }
            entry.put("light", light)
            entry.put("critical", outages.size)
            entry.put("warning", warnings.size)
            entry.put("checkedAt", checkedAtText)
            entry.put("problems", problems)
            list.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** At most `max` characters as a person counts them, the last one an ellipsis when cut (clip in the app). */
    fun clip(text: String, max: Int): String {
        val count = text.codePointCount(0, text.length)
        if (count <= max) return text
        return text.substring(0, text.offsetByCodePoints(0, max - 1)) + "…"
    }
}
