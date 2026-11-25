package app.kubernanny.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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
 * message), opens them with the push key of that cluster and shows them.
 * Runs without the app's WebView. A message that does not open is dropped:
 * this service shows nothing the agent did not write, and what it shows
 * carries the person's authenticity marker (PushMarker). Someone holding the
 * relay's Firebase credentials can still have the system show an FCM
 * *notification* message without this code; that one has no marker.
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
            String title = PushMarker.title(PushKeyStore.getMarker(this), content.getString("t"));
            show(this, entry.clusterId, title, content.getString("b"), content.optInt("p", 3), content.optLong("s", System.currentTimeMillis()));
        } catch (Exception ignored) {
            // Not from the pinned agent, or damaged: nothing to show.
        }
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
        try {
            // One notification per cluster: the newest state replaces the one before.
            NotificationManagerCompat.from(context).notify(clusterId, 1, builder.build());
        } catch (SecurityException noPermission) {
            // Notifications were turned off for the app since.
        }
    }
}
