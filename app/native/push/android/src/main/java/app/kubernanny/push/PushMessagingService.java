package app.kubernanny.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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
 * on Android nothing is shown that the agent did not write.
 */
public class PushMessagingService extends FirebaseMessagingService {
    static final String CHANNEL = "kubernanny-status";
    static final String EXTRA_CLUSTER = "kubernannyCluster";

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
            show(this, entry.clusterId, content.getString("t"), content.getString("b"), content.optInt("p", 3), content.optLong("s", System.currentTimeMillis()));
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
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = null;
        if (open != null) {
            open.putExtra(EXTRA_CLUSTER, clusterId);
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
