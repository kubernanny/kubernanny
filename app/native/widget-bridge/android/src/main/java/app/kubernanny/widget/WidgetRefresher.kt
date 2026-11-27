package app.kubernanny.widget

import android.content.Context
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.GeneralSecurityException
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The widget's background refresh (docs/ARCHITECTURE.md, Widgets): asks every
 * agent of the widget list for its status, the way the app's AgentClient does
 * (direct first, the relay when the agent's own address does not answer), and
 * writes the answer into the widget's storage. Read-only: GET /status, nothing
 * else. Off unless the person switched it on in the app (RefreshTargets).
 */
object WidgetRefresher {
    private const val PROBE_TIMEOUT_MS = 3_000
    private const val CALL_TIMEOUT_MS = 15_000
    /** How long the widget says "refreshing" after a tap, at most (the worker clears it when done). */
    const val REFRESHING_MS = 90_000L
    private const val PERIODIC = "kubernanny-widget-refresh"
    private const val NOW = "kubernanny-widget-refresh-now"
    private const val STATE = "kubernanny_widget_refresh_state"
    private const val REFRESHING = "refreshingSince"

    /** Tink's X25519 (Android has none of its own before API 33) and the platform's ChaCha20-Poly1305 (API 28+). */
    private val ANDROID = object : AgentCall.Primitives {
        override fun x25519(secretKey: ByteArray, publicKey: ByteArray): ByteArray {
            val shared = X25519.computeSharedSecret(secretKey, publicKey)
            if (shared.all { it.toInt() == 0 }) throw GeneralSecurityException("low-order point")
            return shared
        }

        override fun seal(key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray) =
            chacha(Cipher.ENCRYPT_MODE, key, nonce, ad, plaintext)

        override fun open(key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray) =
            chacha(Cipher.DECRYPT_MODE, key, nonce, ad, ciphertext)

        private fun chacha(mode: Int, key: ByteArray, nonce: ByteArray, ad: ByteArray, input: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
            cipher.init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
            cipher.updateAAD(ad)
            return cipher.doFinal(input)
        }
    }

    /** The platform's ChaCha20-Poly1305 arrived with API 28; below, the widget refreshes only from the app and pushes. */
    val supported get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P

    /** (Re)schedules the periodic refresh from what is stored, or cancels it when it is off. */
    fun schedule(context: Context) {
        val work = WorkManager.getInstance(context)
        val settings = if (supported && RefreshTargets.enabled(context)) RefreshTargets.read(context) else null
        if (settings == null || settings.intervalMinutes <= 0 || settings.targets.isEmpty()) {
            work.cancelUniqueWork(PERIODIC)
            return
        }
        val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(settings.intervalMinutes.toLong().coerceAtLeast(15), TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        // UPDATE keeps the running period when only the targets changed; a new interval takes effect with it.
        work.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    /** The widget's refresh button: one run now, and the widget says "refreshing" until it is through. */
    fun refreshNow(context: Context) {
        context.getSharedPreferences(STATE, Context.MODE_PRIVATE).edit().putLong(REFRESHING, System.currentTimeMillis()).commit()
        WidgetRender.updateAll(context)
        // Without a network the run waits; the widget stops saying "refreshing" after a while all the same.
        context.getSystemService(android.app.AlarmManager::class.java)?.set(
            android.app.AlarmManager.ELAPSED_REALTIME,
            android.os.SystemClock.elapsedRealtime() + REFRESHING_MS + 1_000,
            android.app.PendingIntent.getBroadcast(
                context,
                1,
                android.content.Intent(WidgetRefreshReceiver.ACTION).setClass(context, WidgetRefreshReceiver::class.java),
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, request)
    }

    /** True for a short while after a tap on the refresh button, until the run is through. */
    fun refreshing(context: Context, now: Long): Boolean {
        val since = context.getSharedPreferences(STATE, Context.MODE_PRIVATE).getLong(REFRESHING, 0L)
        return since > 0 && now - since in 0..REFRESHING_MS
    }

    /** One round over every target; each failure is that cluster's alone (it keeps its last state and greys out). */
    fun refreshAll(context: Context) {
        try {
            val settings = if (supported) RefreshTargets.read(context) else null
            for (target in settings?.targets.orEmpty()) {
                val status = runCatching { status(target, settings?.language) }.getOrNull() ?: continue
                synchronized(WidgetStore) {
                    val next = WidgetSnapshot.merge(WidgetStore.readJson(context), target.id, status)
                    if (next != null) WidgetStore.writeJson(context, next)
                }
            }
        } finally {
            context.getSharedPreferences(STATE, Context.MODE_PRIVATE).edit().remove(REFRESHING).commit()
            WidgetRender.updateAll(context)
        }
    }

    /** GET /status of one agent, opened and checked; null when no answer came or it was not a status. */
    private fun status(target: RefreshTarget, language: String?): JSONObject? {
        val relay = usableRelay(target.relayUrl)
        val direct = "${target.url.trimEnd('/')}/api/e2e"
        val viaRelay = relay?.let { "$it/v1/agents/${AgentCall.relayAgentId(AgentCall.fromBase64Url(target.agentKey))}/e2e" }
        // Like the app: a quick look at the agent's own address decides; a slow answer is not an unreachable agent.
        val endpoints = when {
            viaRelay == null -> listOf(direct)
            probe("${target.url.trimEnd('/')}/healthz") -> listOf(direct, viaRelay)
            else -> listOf(viaRelay)
        }
        for (endpoint in endpoints) {
            val answer = try {
                call(target, endpoint, language)
            } catch (e: IOException) {
                continue // never reached the agent: the next path, if any
            }
            if (answer.status != 200) return null
            return JSONObject(String(answer.body, Charsets.UTF_8))
        }
        return null
    }

    /** One sealed request, sent again once with the agent's clock when it says ours is off (E2E_CLOCK_SKEW). */
    private fun call(target: RefreshTarget, endpoint: String, language: String?): AgentCall.Answer {
        var offset = 0L
        for (attempt in 0..1) {
            val sealed = AgentCall.seal(
                ANDROID,
                AgentCall.fromBase64Url(target.deviceKey),
                AgentCall.fromBase64Url(target.agentKey),
                AgentCall.requestJson("/status", System.currentTimeMillis() + offset, language),
            )
            val sentAt = System.currentTimeMillis()
            val answer = sealed.open(post(endpoint, sealed.body))
            val skew = answer.status == 401 && runCatching {
                JSONObject(String(answer.body, Charsets.UTF_8)).optString("code") == "E2E_CLOCK_SKEW"
            }.getOrDefault(false)
            if (attempt == 0 && skew) {
                offset = answer.time - (sentAt + System.currentTimeMillis()) / 2
                continue
            }
            return answer
        }
        throw IOException("unreachable")
    }

    /** The response body of a POST; IOException when the agent was not reached (network, timeout, a proxy's 502-504). */
    private fun post(endpoint: String, body: ByteArray): ByteArray {
        val connection = URL(endpoint).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = CALL_TIMEOUT_MS
            connection.readTimeout = CALL_TIMEOUT_MS
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("content-type", "application/octet-stream")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val code = connection.responseCode
            if (code != 200) throw IOException("HTTP $code")
            // Capped while reading, not after: whoever answers decides how much comes.
            if (connection.contentLengthLong > AgentCall.MAX_WIRE_BYTES) throw IOException("answer too large")
            return connection.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    if (out.size() + n > AgentCall.MAX_WIRE_BYTES) throw IOException("answer too large")
                    out.write(buffer, 0, n)
                }
                out.toByteArray()
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun probe(url: String): Boolean = try {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = PROBE_TIMEOUT_MS
        connection.readTimeout = PROBE_TIMEOUT_MS
        try {
            connection.responseCode in 200..299
        } finally {
            connection.disconnect()
        }
    } catch (e: IOException) {
        false
    }

    /** https, or plain http to this machine only (usableRelay in the app). */
    fun usableRelay(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val u = runCatching { URL(url) }.getOrNull() ?: return null
        val ok = u.protocol == "https" || (u.protocol == "http" && u.host in setOf("localhost", "127.0.0.1", "[::1]", "::1"))
        return if (ok) url.trimEnd('/') else null
    }
}

/** Runs [WidgetRefresher.refreshAll] off the main thread, scheduled by WorkManager. */
class WidgetRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        WidgetRefresher.refreshAll(applicationContext)
        Result.success()
    }
}
