package app.kubernanny.widget

import java.io.ByteArrayOutputStream
import java.security.GeneralSecurityException
import java.security.SecureRandom

/**
 * One call to an agent from the widget, without the app: a copy of the app's
 * end-to-end channel (protocol/src/noise.ts and envelope.ts, docs/PROTOCOL.md),
 * reduced to what a background refresh needs, the initiator side.
 *
 *   Noise_IK_25519_ChaChaPoly_BLAKE2b, prologue "kubernanny-e2e/1"
 *   request body:  0x01 | message 1 (payload: the request as JSON)
 *   response body: 0x01 | u16 len | message 2 (payload: {"s": status, "t": agent time})
 *                       | u16 len | frame | …  (frame: flag byte, bit 0 on the last, then body bytes)
 *
 * Plain Kotlin without Android types: AgentCallTest runs it on the JVM against
 * protocol/test/vectors.json, which the TypeScript side reproduces. X25519 and
 * the AEAD come in through [Primitives] (Tink and the platform on a phone).
 */
object AgentCall {
    /** The two primitives the platform supplies. */
    interface Primitives {
        /** X25519(secret, public), 32 bytes; throws on a low-order point (an all-zero result). */
        fun x25519(secretKey: ByteArray, publicKey: ByteArray): ByteArray

        /** ChaCha20-Poly1305 with associated data; the tag follows the ciphertext. */
        fun seal(key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray): ByteArray

        /** The reverse of [seal]; throws on a bad tag. */
        fun open(key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray): ByteArray
    }

    class ProtocolException(message: String) : GeneralSecurityException(message)

    const val VERSION = 1
    private val PROLOGUE = "kubernanny-e2e/1".toByteArray(Charsets.US_ASCII)
    private val PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2b".toByteArray(Charsets.US_ASCII)
    private const val DHLEN = 32
    private const val TAGLEN = 16
    private const val MAX_MESSAGE = 65535
    /** The largest answer opened; a status is a few hundred kilobytes at most. */
    const val MAX_RESPONSE_BODY = 4 * 1024 * 1024
    /**
     * The most bytes read from the wire for one answer: the body plus its framing (version byte, the
     * handshake message, per frame of up to 65518 bytes a length and a tag). Whoever answers (a relay, a
     * proxy, a wrong address) cannot make the reader hold more than this, which matters for an iOS widget
     * extension's small memory limit and keeps the Android worker in step.
     */
    const val MAX_WIRE_BYTES = MAX_RESPONSE_BODY + MAX_RESPONSE_BODY / 1000 + 1024
    private val BASEPOINT = ByteArray(32).also { it[0] = 9 }

    /** The answer: the agent's HTTP-like status, its clock (ms) and the body (JSON text). */
    data class Answer(val status: Int, val time: Long, val body: ByteArray)

    /** A sealed request: [body] goes out as the POST body, [open] reads exactly its answer, once. */
    class Sealed internal constructor(val body: ByteArray, private val initiator: Initiator) {
        private var used = false

        fun open(responseBody: ByteArray): Answer {
            if (used) throw ProtocolException("response already opened")
            used = true
            if (responseBody.isEmpty() || responseBody[0].toInt() != VERSION) {
                throw ProtocolException("unknown protocol version")
            }
            val frames = readFrames(responseBody)
            val message2 = frames.firstOrNull() ?: throw ProtocolException("no handshake message")
            val (head, receive) = try {
                initiator.readMessage2(message2)
            } catch (e: GeneralSecurityException) {
                throw ProtocolException("response not from the pinned agent")
            }
            val headJson = try {
                org.json.JSONObject(String(head, Charsets.UTF_8))
            } catch (e: Exception) {
                throw ProtocolException("invalid response head")
            }
            val status = headJson.opt("s")
            val time = headJson.opt("t")
            if (status !is Int || time !is Number) throw ProtocolException("invalid response head")
            val out = ByteArrayOutputStream()
            var last = false
            for (frame in frames.drop(1)) {
                if (last) throw ProtocolException("data after the last frame")
                val plain = try {
                    receive.decrypt(ByteArray(0), frame)
                } catch (e: GeneralSecurityException) {
                    throw ProtocolException("frame failed authentication")
                }
                if (plain.isEmpty() || (plain[0].toInt() and 0xfe) != 0) throw ProtocolException("invalid frame flags")
                last = (plain[0].toInt() and 1) == 1
                if (out.size() + plain.size - 1 > MAX_RESPONSE_BODY) throw ProtocolException("response too large")
                out.write(plain, 1, plain.size - 1)
            }
            if (!last) throw ProtocolException("response cut off")
            return Answer(status, time.toLong(), out.toByteArray())
        }
    }

    /**
     * Seals one request to the agent whose key was pinned at pairing.
     * `requestJson` is the inner request exactly as the app writes it ([requestJson]).
     * `ephemeralSecret` is only ever passed by the test vectors.
     */
    fun seal(
        p: Primitives,
        deviceSecret: ByteArray,
        agentPublic: ByteArray,
        requestJson: ByteArray,
        ephemeralSecret: ByteArray? = null,
    ): Sealed {
        require(deviceSecret.size == DHLEN && agentPublic.size == DHLEN) { "keys must be 32 bytes" }
        val e = ephemeralSecret ?: ByteArray(DHLEN).also { SecureRandom().nextBytes(it) }
        val initiator = Initiator(p, deviceSecret, agentPublic, e)
        val message1 = initiator.writeMessage1(requestJson)
        return Sealed(byteArrayOf(VERSION.toByte()) + message1, initiator)
    }

    /**
     * The inner request as JSON, in the app's key order (`m`, `p`, `t`, then `l`):
     * `{"m":"GET","p":"/status","t":1795000000000,"l":"de"}`. GET only: the widget reads, it never acts.
     */
    fun requestJson(path: String, time: Long, language: String?): ByteArray {
        require(path.matches(Regex("^/[A-Za-z0-9\\-._~/%?=&:,+]*$"))) { "invalid path" }
        val lang = if (language == "en" || language == "de") ",\"l\":\"$language\"" else ""
        return "{\"m\":\"GET\",\"p\":\"$path\",\"t\":$time$lang}".toByteArray(Charsets.UTF_8)
    }

    /** The agent's id at the relay: BLAKE2b-256 of its public key, base64url without padding (relayAgentId). */
    fun relayAgentId(agentPublic: ByteArray): String {
        require(agentPublic.size == DHLEN) { "a public key is 32 bytes" }
        return base64Url(Blake2b.hash(agentPublic, 32))
    }

    fun publicKey(p: Primitives, secret: ByteArray): ByteArray = p.x25519(secret, BASEPOINT)

    fun base64Url(bytes: ByteArray): String =
        java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun fromBase64Url(text: String): ByteArray = java.util.Base64.getUrlDecoder().decode(text.trimEnd('='))

    /** Splits `0x01 | (u16 len | bytes)*` into its parts. */
    private fun readFrames(body: ByteArray): List<ByteArray> {
        val frames = mutableListOf<ByteArray>()
        var offset = 1
        while (offset < body.size) {
            if (offset + 2 > body.size) throw ProtocolException("cut-off length")
            val length = ((body[offset].toInt() and 0xff) shl 8) or (body[offset + 1].toInt() and 0xff)
            offset += 2
            if (length == 0 || offset + length > body.size) throw ProtocolException("cut-off frame")
            frames += body.copyOfRange(offset, offset + length)
            offset += length
        }
        return frames
    }

    // ---------- Noise (revision 34), initiator of IK only ----------

    /** 96-bit nonce: 32 zero bits, then n as 64-bit little-endian (Noise section 12.3). */
    private fun nonce(n: Long) = ByteArray(12).also { for (i in 0 until 8) it[4 + i] = (n ushr (8 * i)).toByte() }

    internal class CipherState(private val p: Primitives, private val k: ByteArray?) {
        private var n = 0L

        fun encrypt(ad: ByteArray, plaintext: ByteArray): ByteArray {
            if (k == null) return plaintext
            return p.seal(k, nonce(n), ad, plaintext).also { n++ }
        }

        fun decrypt(ad: ByteArray, ciphertext: ByteArray): ByteArray {
            if (k == null) return ciphertext
            // n only advances on success (section 5.1).
            return p.open(k, nonce(n), ad, ciphertext).also { n++ }
        }
    }

    internal class Initiator(
        private val p: Primitives,
        private val s: ByteArray,
        private val rs: ByteArray,
        private val e: ByteArray,
    ) {
        private var h = ByteArray(Blake2b.OUTLEN).also { PROTOCOL_NAME.copyInto(it) }
        private var ck = h.copyOf()
        private var cipher = CipherState(p, null)
        private val ePublic = publicKey(p, e)

        init {
            mixHash(PROLOGUE)
            mixHash(rs) // pre-message "<- s"
        }

        private fun mixHash(data: ByteArray) {
            h = Blake2b.hash(h + data)
        }

        private fun mixKey(ikm: ByteArray) {
            val (next, temp) = hkdf(ck, ikm)
            ck = next
            cipher = CipherState(p, temp.copyOf(32))
        }

        private fun encryptAndHash(plaintext: ByteArray) = cipher.encrypt(h, plaintext).also { mixHash(it) }

        private fun decryptAndHash(ciphertext: ByteArray) = cipher.decrypt(h, ciphertext).also { mixHash(ciphertext) }

        /** -> e, es, s, ss, then the payload. */
        fun writeMessage1(payload: ByteArray): ByteArray {
            mixHash(ePublic)
            mixKey(p.x25519(e, rs))
            val encryptedStatic = encryptAndHash(publicKey(p, s))
            mixKey(p.x25519(s, rs))
            val encryptedPayload = encryptAndHash(payload)
            val message = ePublic + encryptedStatic + encryptedPayload
            if (message.size > MAX_MESSAGE) throw ProtocolException("request too large")
            return message
        }

        /** <- e, ee, se, then the payload; returns it with the cipher for the agent's frames. */
        fun readMessage2(message: ByteArray): Pair<ByteArray, CipherState> {
            if (message.size < DHLEN + TAGLEN || message.size > MAX_MESSAGE) throw ProtocolException("message 2 has a wrong length")
            val re = message.copyOfRange(0, DHLEN)
            mixHash(re)
            mixKey(p.x25519(e, re))
            mixKey(p.x25519(s, re))
            val payload = decryptAndHash(message.copyOfRange(DHLEN, message.size))
            val (_, receive) = hkdf(ck, ByteArray(0))
            return payload to CipherState(p, receive.copyOf(32))
        }
    }

    /** HKDF() of Noise section 4.3 with HMAC-BLAKE2b, two outputs. */
    private fun hkdf(chainingKey: ByteArray, ikm: ByteArray): Pair<ByteArray, ByteArray> {
        val temp = Blake2b.hmac(chainingKey, ikm)
        val out1 = Blake2b.hmac(temp, byteArrayOf(1))
        val out2 = Blake2b.hmac(temp, out1 + byteArrayOf(2))
        return out1 to out2
    }
}

/**
 * BLAKE2b (RFC 7693), unkeyed, and HMAC over it (RFC 2104, block size 128),
 * as @noble/hashes computes them. Android has no BLAKE2b of its own.
 */
object Blake2b {
    const val OUTLEN = 64
    private const val BLOCK = 128

    private val IV = longArrayOf(
        0x6a09e667f3bcc908, -0x4498517a7b3558c5, 0x3c6ef372fe94f82b, -0x5ab00ac5a0e2c90f,
        0x510e527fade682d1, -0x64fa9773d4c193e1, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
    )

    private val SIGMA = arrayOf(
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
        intArrayOf(14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3),
        intArrayOf(11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4),
        intArrayOf(7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8),
        intArrayOf(9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13),
        intArrayOf(2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9),
        intArrayOf(12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11),
        intArrayOf(13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10),
        intArrayOf(6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5),
        intArrayOf(10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0),
    )

    fun hash(data: ByteArray, outLen: Int = OUTLEN): ByteArray {
        require(outLen in 1..64)
        val h = IV.copyOf()
        h[0] = h[0] xor (0x01010000L or outLen.toLong())
        var offset = 0
        // Every block but the last is compressed as it comes; the last (possibly empty, zero-padded) is final.
        while (data.size - offset > BLOCK) {
            compress(h, data, offset, (offset + BLOCK).toLong(), false)
            offset += BLOCK
        }
        val last = ByteArray(BLOCK)
        data.copyInto(last, 0, offset, data.size)
        compress(h, last, 0, data.size.toLong(), true)
        val out = ByteArray(64)
        for (i in 0 until 8) for (j in 0 until 8) out[i * 8 + j] = (h[i] ushr (8 * j)).toByte()
        return out.copyOf(outLen)
    }

    fun hmac(key: ByteArray, message: ByteArray): ByteArray {
        val k = (if (key.size > BLOCK) hash(key) else key).copyOf(BLOCK)
        val inner = ByteArray(BLOCK) { (k[it].toInt() xor 0x36).toByte() }
        val outer = ByteArray(BLOCK) { (k[it].toInt() xor 0x5c).toByte() }
        return hash(outer + hash(inner + message))
    }

    private fun compress(h: LongArray, block: ByteArray, offset: Int, counter: Long, last: Boolean) {
        val m = LongArray(16) { i ->
            var x = 0L
            for (j in 7 downTo 0) x = (x shl 8) or (block[offset + i * 8 + j].toLong() and 0xff)
            x
        }
        val v = LongArray(16)
        h.copyInto(v, 0)
        IV.copyInto(v, 8)
        v[12] = v[12] xor counter
        if (last) v[14] = v[14].inv()
        for (round in 0 until 12) {
            val s = SIGMA[round % 10]
            g(v, 0, 4, 8, 12, m[s[0]], m[s[1]])
            g(v, 1, 5, 9, 13, m[s[2]], m[s[3]])
            g(v, 2, 6, 10, 14, m[s[4]], m[s[5]])
            g(v, 3, 7, 11, 15, m[s[6]], m[s[7]])
            g(v, 0, 5, 10, 15, m[s[8]], m[s[9]])
            g(v, 1, 6, 11, 12, m[s[10]], m[s[11]])
            g(v, 2, 7, 8, 13, m[s[12]], m[s[13]])
            g(v, 3, 4, 9, 14, m[s[14]], m[s[15]])
        }
        for (i in 0 until 8) h[i] = h[i] xor v[i] xor v[i + 8]
    }

    private fun g(v: LongArray, a: Int, b: Int, c: Int, d: Int, x: Long, y: Long) {
        v[a] = v[a] + v[b] + x
        v[d] = java.lang.Long.rotateRight(v[d] xor v[a], 32)
        v[c] = v[c] + v[d]
        v[b] = java.lang.Long.rotateRight(v[b] xor v[c], 24)
        v[a] = v[a] + v[b] + y
        v[d] = java.lang.Long.rotateRight(v[d] xor v[a], 16)
        v[c] = v[c] + v[d]
        v[b] = java.lang.Long.rotateRight(v[b] xor v[c], 63)
    }
}
