package app.kubernanny.push;

import android.Manifest;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Native push for the app (app/src/app/core/push/): whether this build can
 * do it, the notification permission, the FCM token, the per-cluster
 * push keys and the authenticity marker shown on every opened push.
 * Without google-services.json there is no FirebaseApp, and the app hides
 * the push option entirely.
 */
@CapacitorPlugin(name = "KubernannyPush", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class KubernannyPushPlugin extends Plugin {

    @PluginMethod
    public void isAvailable(PluginCall call) {
        boolean firebase = !FirebaseApp.getApps(getContext()).isEmpty();
        call.resolve(new JSObject().put("available", firebase && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P).put("platform", "android"));
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionAnswered");
            return;
        }
        call.resolve(new JSObject().put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled()));
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        call.resolve(new JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED));
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    call.resolve(new JSObject().put("token", task.getResult()));
                } else {
                    call.reject("no FCM token");
                }
            });
        } catch (IllegalStateException noFirebase) {
            call.reject("Firebase is not configured in this build");
        }
    }

    @PluginMethod
    public void storeKey(PluginCall call) {
        String kid = call.getString("kid");
        String secretKey = call.getString("secretKey");
        String publicKey = call.getString("publicKey");
        String agentKey = call.getString("agentKey");
        String clusterId = call.getString("clusterId");
        if (kid == null || secretKey == null || publicKey == null || agentKey == null || clusterId == null) {
            call.reject("kid, secretKey, publicKey, agentKey and clusterId are required");
            return;
        }
        try {
            PushKeyStore.put(getContext(), kid, new PushKeyStore.Entry(PushKeyStore.unb64(secretKey), PushKeyStore.unb64(publicKey), PushKeyStore.unb64(agentKey), clusterId));
            call.resolve();
        } catch (Exception e) {
            call.reject("cannot store the push key");
        }
    }

    @PluginMethod
    public void getMarker(PluginCall call) {
        String marker = PushKeyStore.getMarker(getContext());
        JSObject result = new JSObject();
        if (marker != null) {
            result.put("marker", marker);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void setMarker(PluginCall call) {
        String marker = call.getString("marker");
        // The app normalises it (at most 12 characters as a person counts them); this only keeps the store bounded.
        if (marker == null || marker.trim().isEmpty() || marker.length() > 64) {
            call.reject("marker must be 1 to 12 characters");
            return;
        }
        try {
            PushKeyStore.putMarker(getContext(), marker.trim());
            call.resolve();
        } catch (Exception e) {
            call.reject("cannot store the marker");
        }
    }

    @PluginMethod
    public void removeKey(PluginCall call) {
        String kid = call.getString("kid");
        if (kid != null) {
            PushKeyStore.remove(getContext(), kid);
        }
        call.resolve();
    }
}
