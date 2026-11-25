package app.kubernanny.push;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * The phone's push keys, one per cluster, readable by the messaging service
 * while the app is not running. Each entry is encrypted with an AES key that
 * lives in the Android Keystore and never leaves it, like the device keys of
 * @aparajita/capacitor-secure-storage; the entries themselves sit in the
 * app's private preferences. Not in a backup: backups are off for the app.
 *
 * An entry holds the push secret key (only ever used to open pushes), its
 * public half, the agent key pinned at pairing and the app's cluster id.
 */
final class PushKeyStore {
    static final class Entry {
        final byte[] secretKey;
        final byte[] publicKey;
        final byte[] agentKey;
        final String clusterId;

        Entry(byte[] secretKey, byte[] publicKey, byte[] agentKey, String clusterId) {
            this.secretKey = secretKey;
            this.publicKey = publicKey;
            this.agentKey = agentKey;
            this.clusterId = clusterId;
        }
    }

    private static final String PREFS = "kubernanny.push";
    private static final String ALIAS = "kubernanny-push-keys";

    private PushKeyStore() {}

    static void put(Context context, String kid, Entry entry) throws Exception {
        JSONObject json = new JSONObject()
            .put("s", b64(entry.secretKey))
            .put("p", b64(entry.publicKey))
            .put("a", b64(entry.agentKey))
            .put("c", entry.clusterId);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey());
        byte[] sealed = PushCrypto.concat(cipher.getIV(), cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8)));
        prefs(context).edit().putString("key." + kid, b64(sealed)).apply();
    }

    static Entry get(Context context, String kid) {
        String stored = prefs(context).getString("key." + kid, null);
        if (stored == null) {
            return null;
        }
        try {
            byte[] sealed = unb64(stored);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), new GCMParameterSpec(128, Arrays.copyOf(sealed, 12)));
            JSONObject json = new JSONObject(new String(cipher.doFinal(Arrays.copyOfRange(sealed, 12, sealed.length)), StandardCharsets.UTF_8));
            return new Entry(unb64(json.getString("s")), unb64(json.getString("p")), unb64(json.getString("a")), json.getString("c"));
        } catch (Exception e) {
            return null;
        }
    }

    static void remove(Context context, String kid) {
        prefs(context).edit().remove("key." + kid).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey wrappingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    static String b64(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    static byte[] unb64(String text) {
        return Base64.decode(text, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }
}
