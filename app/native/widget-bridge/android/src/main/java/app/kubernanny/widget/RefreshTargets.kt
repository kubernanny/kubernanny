package app.kubernanny.widget

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One cluster the background refresh asks: what the app's AgentClient needs for GET /status, no more. */
data class RefreshTarget(
    /** The app's cluster id: the widget entry it updates. */
    val id: String,
    val url: String,
    /** The relay, when the agent uses one; only tried when the agent's own address does not answer. */
    val relayUrl: String?,
    /** base64url, as pinned at pairing. */
    val agentKey: String,
    /** This device's secret key for the cluster, base64url (the app keeps it in its secure storage too). */
    val deviceKey: String,
)

/** The background refresh as the app set it: how often, in which language, which clusters. */
data class RefreshSettings(val intervalMinutes: Int, val language: String?, val targets: List<RefreshTarget>)

/**
 * Where the background refresh keeps its targets. They hold this device's
 * secret key per cluster, so the whole list is sealed with an AES key that
 * lives in the Android Keystore and never leaves it, like the push keys
 * (PushKeyStore in app/native/push); the sealed text sits in a private
 * SharedPreferences file of its own. Backups are off for the app.
 *
 * Next to it, not sealed: whether a refresh is set up at all, so drawing the
 * widget (refresh button) needs no Keystore operation.
 */
object RefreshTargets {
    private const val FILE = "kubernanny_widget_refresh"
    private const val KEY = "targets.v1"
    private const val ENABLED = "enabled"
    private const val ALIAS = "kubernanny-widget-refresh"

    fun enabled(context: Context): Boolean = prefs(context).getBoolean(ENABLED, false)

    /** null when nothing is set up, or what is stored cannot be opened (a restored device): the refresh then does nothing. */
    fun read(context: Context): RefreshSettings? {
        val stored = prefs(context).getString(KEY, null) ?: return null
        return runCatching { decode(JSONObject(unseal(stored))) }.getOrNull()
    }

    /** Interval 0 or no targets: switched off, the stored list is removed. commit(): gone before the call returns. */
    fun write(context: Context, settings: RefreshSettings) {
        val on = settings.intervalMinutes > 0 && settings.targets.isNotEmpty()
        val edit = prefs(context).edit()
        if (on) {
            edit.putString(KEY, seal(encode(settings).toString())).putBoolean(ENABLED, true)
        } else {
            edit.remove(KEY).putBoolean(ENABLED, false)
        }
        edit.commit()
    }

    fun encode(s: RefreshSettings): JSONObject = JSONObject()
        .put("interval", s.intervalMinutes)
        .put("language", s.language ?: JSONObject.NULL)
        .put("targets", JSONArray(s.targets.map { t ->
            JSONObject().put("id", t.id).put("url", t.url).put("relayUrl", t.relayUrl ?: JSONObject.NULL)
                .put("agentKey", t.agentKey).put("deviceKey", t.deviceKey)
        }))

    fun decode(o: JSONObject): RefreshSettings {
        val list = o.getJSONArray("targets")
        return RefreshSettings(
            intervalMinutes = o.getInt("interval"),
            language = if (o.isNull("language")) null else o.getString("language"),
            targets = (0 until list.length()).map { i ->
                val t = list.getJSONObject(i)
                RefreshTarget(
                    id = t.getString("id"),
                    url = t.getString("url"),
                    relayUrl = if (t.isNull("relayUrl")) null else t.getString("relayUrl"),
                    agentKey = t.getString("agentKey"),
                    deviceKey = t.getString("deviceKey"),
                )
            },
        )
    }

    private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private fun seal(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    private fun unseal(stored: String): String {
        val sealed = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, sealed.copyOf(12)))
        return String(cipher.doFinal(sealed.copyOfRange(12, sealed.size)), Charsets.UTF_8)
    }

    /** Synchronized: the app and the worker may both ask first, and two generated keys would orphan the list. */
    @Synchronized
    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
