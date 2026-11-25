package app.kubernanny.push;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The same cases as Tests/WidgetStatus/main.swift in the iOS push extension:
 * the status of the "widget-status" push vector applied to a stored widget
 * list. Plain JVM, but it needs org.json (Android has it built in), so it is
 * not part of `npm test`; with any org.json jar:
 *   javac -cp json.jar -d build/jvm-widget android/src/main/java/app/kubernanny/push/WidgetPushStatus.java android/src/test/java/app/kubernanny/push/WidgetPushStatusTest.java
 *   java -cp build/jvm-widget:json.jar app.kubernanny.push.WidgetPushStatusTest ../../../protocol/test/push-vectors.json
 */
public final class WidgetPushStatusTest {
    public static void main(String[] args) throws Exception {
        JSONArray vectors = new JSONArray(new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8));
        JSONObject status = null;
        for (int i = 0; i < vectors.length(); i++) {
            if ("widget-status".equals(vectors.getJSONObject(i).getString("name"))) {
                status = new JSONObject(vectors.getJSONObject(i).getString("plaintext")).getJSONObject("w");
            }
        }
        String stored = "[{\"id\":\"a\",\"name\":\"homelab\",\"light\":\"green\",\"critical\":0,\"warning\":0,\"checkedAt\":\"2026-11-18T09:00:00.000Z\",\"demo\":false},"
            + "{\"id\":\"b\",\"name\":\"other\",\"light\":\"green\",\"critical\":0,\"warning\":0,\"checkedAt\":null,\"demo\":false}]";

        JSONArray merged = new JSONArray(WidgetPushStatus.merge(stored, "a", status));
        JSONObject a = merged.getJSONObject(0);
        check(a.getString("light").equals("red") && a.getInt("critical") == 1 && a.getInt("warning") == 1, "counts");
        check(a.getString("name").equals("homelab"), "name kept");
        check(WidgetPushStatus.parseIso(a.getString("checkedAt")) == 1795000110000L, "checkedAt");
        JSONArray problems = a.getJSONArray("problems");
        check(problems.length() == 2 && problems.getJSONObject(0).getString("severity").equals("critical")
            && problems.getJSONObject(1).getString("title").equals("Certificate shop.example expires in 9 days"), "problems");
        check(merged.getJSONObject(1).getString("light").equals("green"), "other cluster untouched");

        String newer = stored.replace("2026-11-18T09:00:00.000Z", "2026-11-30T09:00:00.000Z");
        check(WidgetPushStatus.merge(newer, "a", status) == null, "older push ignored");
        check(WidgetPushStatus.merge(stored, "gone", status) == null, "no entry, no write");
        check(WidgetPushStatus.merge(null, "a", status) == null, "nothing stored");
        check(WidgetPushStatus.merge(stored, "a", new JSONObject(status.toString()).put("l", "pink")) == null, "bad light");
        check(WidgetPushStatus.merge(stored, "a", new JSONObject(status.toString()).put("a", JSONObject.NULL)) == null, "no check time");

        JSONObject minimal = new JSONObject(status.toString());
        minimal.remove("i");
        check(new JSONArray(WidgetPushStatus.merge(stored, "a", minimal)).getJSONObject(0).getJSONArray("problems").length() == 0, "minimal");
        System.out.println("WidgetPushStatus.java: push status applied, older, unknown and malformed ones refused");
    }

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }
}
