package app.kubernanny.widget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetSnapshotTest {
    private val stored = JSONArray()
        .put(
            JSONObject().put("id", "c1").put("name", "homelab").put("light", "green").put("critical", 0).put("warning", 0)
                .put("checkedAt", "2026-11-27T08:00:00.000Z").put("demo", false).put("problems", JSONArray())
                .put("unreachableSince", "2026-11-27T08:10:00.000Z"),
        )
        .put(JSONObject().put("id", "c2").put("name", "office").put("light", "green").put("critical", 0).put("warning", 0).put("checkedAt", JSONObject.NULL).put("demo", false))
        .toString()

    private fun issue(severity: String, title: String, silenced: Boolean = false) = JSONObject()
        .put("id", title).put("severity", severity).put("title", title)
        .also { if (silenced) it.put("silencedUntil", "2026-11-28T00:00:00.000Z") }

    private fun status(checkedAt: String?, vararg issues: JSONObject) = JSONObject()
        .put("light", "red").put("checkedAt", checkedAt ?: JSONObject.NULL).put("issues", JSONArray(issues.toList()))

    @Test
    fun `counts like the app's headline and keeps the three worst problems, outages first`() {
        val next = WidgetSnapshot.merge(
            stored,
            "c1",
            status(
                "2026-11-27T09:00:00.000Z",
                issue("warning", "w1"),
                issue("critical", "c1"),
                issue("info", "hint"),
                issue("critical", "muted", silenced = true),
                issue("warning", "w2"),
                issue("critical", "c2"),
            ),
        )!!
        val entry = JSONArray(next).getJSONObject(0)
        assertEquals("red", entry.getString("light"))
        assertEquals(2, entry.getInt("critical"))
        assertEquals(2, entry.getInt("warning"))
        assertEquals("2026-11-27T09:00:00.000Z", entry.getString("checkedAt"))
        val problems = entry.getJSONArray("problems")
        assertEquals(listOf("c1", "c2", "w1"), (0 until problems.length()).map { problems.getJSONObject(it).getString("title") })
        assertEquals("critical", problems.getJSONObject(0).getString("severity"))
        // Name, demo flag and the silence warning stay: a newer check supersedes the warning by its time.
        assertEquals("homelab", entry.getString("name"))
        assertEquals("2026-11-27T08:10:00.000Z", entry.getString("unreachableSince"))
        // The other cluster is untouched.
        assertEquals("office", JSONArray(next).getJSONObject(1).getString("name"))
    }

    @Test
    fun `takes only a newer check, only for a cluster in the list, only a valid status`() {
        assertNull(WidgetSnapshot.merge(stored, "c1", status("2026-11-27T08:00:00.000Z")))
        assertNull(WidgetSnapshot.merge(stored, "c1", status("2026-11-27T07:00:00Z")))
        assertNull(WidgetSnapshot.merge(stored, "c1", status(null)))
        assertNull(WidgetSnapshot.merge(stored, "gone", status("2026-11-27T09:00:00.000Z")))
        assertNull(WidgetSnapshot.merge(stored, "c1", status("2026-11-27T09:00:00.000Z").put("light", "purple")))
        assertNull(WidgetSnapshot.merge(null, "c1", status("2026-11-27T09:00:00.000Z")))
        // A cluster never checked before takes any check.
        val first = WidgetSnapshot.merge(stored, "c2", status("2026-11-27T09:00:00Z"))!!
        assertEquals("2026-11-27T09:00:00Z", JSONArray(first).getJSONObject(1).getString("checkedAt"))
    }

    @Test
    fun `clips a long title to 120 characters as a person counts them`() {
        assertEquals("abc", WidgetSnapshot.clip("abc", 120))
        val long = "🙂".repeat(130)
        val clipped = WidgetSnapshot.clip(long, 120)
        assertEquals(120, clipped.codePointCount(0, clipped.length))
        assertEquals("…", clipped.takeLast(1))
    }

    @Test
    fun `stores and reads the refresh settings as the plugin hands them over`() {
        val settings = RefreshSettings(
            30,
            "de",
            listOf(
                RefreshTarget("c1", "http://10.0.0.5", "https://relay.kubernanny.app", "AK", "DK"),
                RefreshTarget("c2", "https://k.example", null, "AK2", "DK2"),
            ),
        )
        assertEquals(settings, RefreshTargets.decode(JSONObject(RefreshTargets.encode(settings).toString())))
    }
}
