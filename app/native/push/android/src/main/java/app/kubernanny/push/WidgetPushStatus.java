package app.kubernanny.push;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Brings the home-screen widget up to date from a push: the agent seals the
 * cluster's state into every push (`w`, docs/PROTOCOL.md "Push status"), and
 * this writes it into the entry the app stored for that cluster in the
 * widget's storage (WidgetStore in app/native/widget-bridge: SharedPreferences
 * `kubernanny_widget`, key `clusters.v1`); PushMessagingService stores the
 * result and asks the widgets to redraw. Plain Java and org.json, so a JVM
 * test runs it without Android (WidgetPushStatusTest).
 *
 * It only updates an entry that is there: a cluster switched off for the
 * widget (or all of them) has none, and gets none from a push. It only writes
 * a state newer than the stored one, so a late push never covers what the app
 * wrote since. Mirrors WidgetPushStatus.swift in the iOS push extension.
 */
final class WidgetPushStatus {
    /** Keep in step with WidgetStore.kt. */
    static final String FILE = "kubernanny_widget";
    static final String KEY = "clusters.v1";
    /** Handled by WidgetRefreshReceiver in app/native/widget-bridge (not exported: only this app reaches it). */
    static final String REFRESH = "app.kubernanny.widget.REFRESH";
    static final String RECEIVER = "app.kubernanny.widget.WidgetRefreshReceiver";

    private WidgetPushStatus() {}

    /** The stored list with `status` applied to `clusterId`, or null when nothing changes. */
    static String merge(String stored, String clusterId, JSONObject status) {
        try {
            if (stored == null || status == null) {
                return null;
            }
            JSONArray list = new JSONArray(stored);
            JSONObject entry = null;
            for (int i = 0; i < list.length(); i++) {
                JSONObject candidate = list.optJSONObject(i);
                if (candidate != null && clusterId.equals(candidate.optString("id", null))) {
                    entry = candidate;
                    break;
                }
            }
            String light = status.optString("l", "");
            if (entry == null || !(light.equals("green") || light.equals("yellow") || light.equals("red") || light.equals("unknown"))) {
                return null;
            }
            if (!(status.opt("c") instanceof Number) || !(status.opt("n") instanceof Number) || !(status.opt("a") instanceof Number)) {
                return null;
            }
            int critical = status.getInt("c");
            int warning = status.getInt("n");
            long checkedAt = status.getLong("a");
            if (critical < 0 || warning < 0) {
                return null;
            }
            Long before = entry.isNull("checkedAt") ? null : parseIso(entry.optString("checkedAt", ""));
            if (before != null && before >= checkedAt) {
                return null;
            }
            JSONArray problems = new JSONArray();
            JSONArray items = status.optJSONArray("i");
            if (status.has("i") && items == null) {
                return null;
            }
            for (int i = 0; items != null && i < items.length() && i < 3; i++) {
                JSONObject item = items.optJSONObject(i);
                String s = item == null ? null : item.optString("s", null);
                if (item == null || !(item.opt("t") instanceof String) || !("c".equals(s) || "w".equals(s))) {
                    return null;
                }
                String title = item.getString("t");
                if (title.codePointCount(0, title.length()) > 120) {
                    title = title.substring(0, title.offsetByCodePoints(0, 120));
                }
                problems.put(new JSONObject().put("title", title).put("severity", "c".equals(s) ? "critical" : "warning"));
            }
            entry.put("light", light);
            entry.put("critical", critical);
            entry.put("warning", warning);
            entry.put("checkedAt", formatIso(checkedAt));
            entry.put("problems", problems);
            return list.toString();
        } catch (Exception malformed) {
            return null;
        }
    }

    /**
     * The stored list with `clusterId` marked as "agent not answering" since
     * `now` (field `unreachableSince`, written only here and in the iOS
     * extension; the app keeps it, WidgetCluster in widget-summary.ts). The
     * widgets show it while it is later than the entry's last check, so any
     * newer state supersedes it. Null when the cluster has no entry.
     */
    static String markUnreachable(String stored, String clusterId, long now) {
        try {
            if (stored == null) {
                return null;
            }
            JSONArray list = new JSONArray(stored);
            for (int i = 0; i < list.length(); i++) {
                JSONObject candidate = list.optJSONObject(i);
                if (candidate != null && clusterId.equals(candidate.optString("id", null))) {
                    candidate.put("unreachableSince", formatIso(now));
                    return list.toString();
                }
            }
            return null;
        } catch (Exception malformed) {
            return null;
        }
    }

    static String formatIso(long millis) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(millis));
    }

    /** ISO 8601 as the app and the agent write it, with or without milliseconds (WidgetStore.parseIso). */
    static Long parseIso(String text) {
        for (String pattern : new String[] {"yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX"}) {
            SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            ParsePosition position = new ParsePosition(0);
            Date date = f.parse(text, position);
            if (date != null && position.getIndex() == text.length()) {
                return date.getTime();
            }
        }
        return null;
    }
}
