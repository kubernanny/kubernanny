package app.kubernanny.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

/**
 * Receives Kubernanny pushes (FCM data messages: `k` key id, `m` sealed
 * message), opens them with the push key of that cluster and shows them,
 * unless the sealed time says the message is stale or not newer than the
 * last one shown for that key (PushFreshness).
 * Runs without the app's WebView. A message that does not open is dropped:
 * this service shows nothing the agent did not write, and what it shows
 * carries the person's authenticity marker (PushMarker) when they turned it
 * on (optional, off by default: no stored marker, no prefix). Someone holding the
 * relay's Firebase credentials can still have the system show an FCM
 * *notification* message without this code; that one has no marker.
 *
 * A status push (priority 0, sent about hourly to phones with a widget,
 * as a data message at normal priority) only updates the widget and shows
 * nothing. It must be fresh too, but does not count as "shown": a delayed
 * alert sealed before it still shows. Replaying one changes nothing, as the
 * widget only takes a check newer than the one it holds (WidgetPushStatus).
 *
 * A dead man's switch message (it carries `d`) was sealed ahead of time and
 * deposited with the relay, which sends it when the agent goes silent. It
 * is shown under a rule of its own (PushFreshness.deadmanFresh: within the
 * window sealed into it, its own replay marker, and not when this agent was
 * heard within the grace), and marks the widget "agent not answering".
 *
 * A tap opens kubernanny://cluster?id=… with the app's own cluster id, kept
 * in the key entry: the agent never knows that id, and the app only follows
 * the link to a cluster in its list (app/src/app/core/push/push-tap.ts).
 */
public class PushMessagingService extends FirebaseMessagingService {
    static final String CHANNEL = "kubernanny-status";

    @Override
    public void onMessageReceived(RemoteMessage remote) {
        Map<String, String> data = remote.getData();
        String kid = data.get("k");
        String sealed = data.get("m");
        if (kid == null || sealed == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return;
        }
        PushKeyStore.Entry entry = PushKeyStore.get(this, kid);
        if (entry == null) {
            return; // a key this phone no longer has (push turned off, cluster removed)
        }
        try {
            byte[] plain = PushCrypto.open(new AndroidPrimitives(), entry.secretKey, entry.publicKey, entry.agentKey, PushKeyStore.unb64(sealed));
            JSONObject content = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            long sealedAt = content.getLong("s");
            long now = System.currentTimeMillis();
            // A dead man's switch message (docs/PROTOCOL.md "Dead man's switch"): sealed ahead of time and sent by
            // the relay because the agent went silent. Its own freshness rule and replay marker; the widget turns
            // to "agent not answering".
            if (content.has("d")) {
                JSONObject d = content.optJSONObject("d");
                if (d == null || !(d.opt("u") instanceof Number) || !(d.opt("g") instanceof Number) || !PushFreshness.validGrace(d.getInt("g"))) {
                    return;
                }
                if (!PushFreshness.deadmanFresh(sealedAt, d.getLong("u"), d.getInt("g"), now, PushKeyStore.lastDeadman(this, kid), PushKeyStore.lastHeard(this, kid))) {
                    return;
                }
                PushKeyStore.markDeadman(this, kid, sealedAt);
                markUnreachable(this, entry.clusterId, now);
                String title = PushMarker.title(PushKeyStore.getMarker(this), content.getString("t"));
                show(this, entry.clusterId, title, content.getString("b"), content.optInt("p", 3), now);
                return;
            }
            // A status push (p 0, docs/PROTOCOL.md "Status pushes"): only the widget, never a notification.
            if (PushFreshness.isStatusOnly(content.optInt("p", 3))) {
                if (PushFreshness.statusFresh(sealedAt, now)) {
                    PushKeyStore.markHeard(this, kid, sealedAt);
                    updateWidget(this, entry.clusterId, content.optJSONObject("w"));
                }
                return;
            }
            // A replayed or stale message opens fine (the agent made it once) but says something old: not shown.
            if (!PushFreshness.fresh(sealedAt, now, PushKeyStore.lastShown(this, kid))) {
                return;
            }
            PushKeyStore.markShown(this, kid, sealedAt);
            PushKeyStore.markHeard(this, kid, sealedAt);
            // The cluster's state for the home-screen widget (agents that send it; docs/PROTOCOL.md "Push status").
            updateWidget(this, entry.clusterId, content.optJSONObject("w"));
            String title = PushMarker.title(PushKeyStore.getMarker(this), content.getString("t"));
            show(this, entry.clusterId, title, content.getString("b"), content.optInt("p", 3), sealedAt);
        } catch (Exception ignored) {
            // Not from the pinned agent, or damaged: nothing to show.
        }
    }

    /** Writes a push's cluster state into the widget's storage and redraws the widgets (WidgetPushStatus). */
    static void updateWidget(Context context, String clusterId, JSONObject status) {
        if (status == null) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(WidgetPushStatus.FILE, Context.MODE_PRIVATE);
        String next = WidgetPushStatus.merge(prefs.getString(WidgetPushStatus.KEY, null), clusterId, status);
        if (next == null) {
            return;
        }
        prefs.edit().putString(WidgetPushStatus.KEY, next).commit();
        context.sendBroadcast(new Intent(WidgetPushStatus.REFRESH).setClassName(context.getPackageName(), WidgetPushStatus.RECEIVER));
    }

    /** Marks the cluster's widget entry as "agent not answering" and redraws the widgets (WidgetPushStatus.markUnreachable). */
    static void markUnreachable(Context context, String clusterId, long now) {
        SharedPreferences prefs = context.getSharedPreferences(WidgetPushStatus.FILE, Context.MODE_PRIVATE);
        String next = WidgetPushStatus.markUnreachable(prefs.getString(WidgetPushStatus.KEY, null), clusterId, now);
        if (next == null) {
            return;
        }
        prefs.edit().putString(WidgetPushStatus.KEY, next).commit();
        context.sendBroadcast(new Intent(WidgetPushStatus.REFRESH).setClassName(context.getPackageName(), WidgetPushStatus.RECEIVER));
    }

    @Override
    public void onNewToken(String token) {
        // The app compares its stored token with the current one on every start and registers again when it changed.
    }

    static void show(Context context, String clusterId, String title, String body, int priority, long when) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, context.getString(R.string.kn_push_channel), NotificationManager.IMPORTANCE_HIGH));
        }
        // Explicit (the app's own launcher activity), like the widget's: Capacitor's App plugin passes the VIEW data on as appUrlOpen.
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = null;
        if (open != null) {
            open.setAction(Intent.ACTION_VIEW);
            open.setData(new Uri.Builder().scheme("kubernanny").authority("cluster").appendQueryParameter("id", clusterId).build());
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            tap = PendingIntent.getActivity(context, clusterId.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.kn_push_icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setWhen(when)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setGroup(clusterId)
            .setPriority(priority >= 4 ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(tap);
        // The group's summary: Android shows the cluster's pushes as one expandable stack under it. It carries
        // the newest push's text (what a collapsed stack shows) and never alerts itself: the push does.
        NotificationCompat.Builder summary = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.kn_push_icon)
            .setContentTitle(title)
            .setContentText(body)
            .setWhen(when)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setGroup(clusterId)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .setContentIntent(tap);
        try {
            // One notification per push, stacked per cluster: a resolution no longer wipes the alert before it.
            NotificationManagerCompat notifications = NotificationManagerCompat.from(context);
            notifications.notify(clusterId, NotificationStack.idFor(when), builder.build());
            notifications.notify(clusterId, NotificationStack.SUMMARY_ID, summary.build());
            trim(manager, clusterId);
        } catch (SecurityException noPermission) {
            // Notifications were turned off for the app since.
        }
    }

    /** At most NotificationStack.KEEP notifications per cluster: the oldest beyond go. */
    private static void trim(NotificationManager manager, String clusterId) {
        java.util.List<NotificationStack.Shown> shown = new java.util.ArrayList<>();
        for (android.service.notification.StatusBarNotification n : manager.getActiveNotifications()) {
            if (clusterId.equals(n.getTag())) {
                shown.add(new NotificationStack.Shown(n.getId(), n.getNotification().when));
            }
        }
        for (int id : NotificationStack.toCancel(shown)) {
            manager.cancel(clusterId, id);
        }
    }
}
