package app.kubernanny.widget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.spec.NamedParameterSpec
import java.security.spec.XECPrivateKeySpec
import java.security.spec.XECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The widget's copy of the end-to-end channel against protocol/test/vectors.json:
 * fixed keys give the same request bytes as the TypeScript side, and the agent's
 * answer opens to the same status, time and body. The JDK supplies X25519 and
 * ChaCha20-Poly1305 here (Tink and Conscrypt do on a phone).
 */
class AgentCallTest {
    private val vectors = JSONArray(File("../../../../protocol/test/vectors.json").readText())

    @Test
    fun `seals every request of the vectors byte for byte and opens the agent's answer`() {
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val request = v.getJSONObject("request")
            if (request.getString("method") != "GET") continue // the widget only reads
            val agentPublic = AgentCall.publicKey(JDK, hex(v.getString("agentStaticSecret")))
            val sealed = AgentCall.seal(
                JDK,
                hex(v.getString("deviceStaticSecret")),
                agentPublic,
                AgentCall.requestJson(request.getString("path"), request.getLong("time"), null),
                hex(v.getString("deviceEphemeralSecret")),
            )
            assertEquals(v.getString("name"), v.getString("requestBody"), hexOf(sealed.body))
            val answer = sealed.open(hex(v.getString("responseBody")))
            val response = v.getJSONObject("response")
            assertEquals(response.getInt("status"), answer.status)
            assertEquals(response.getLong("time"), answer.time)
            assertEquals(response.getString("body"), String(answer.body, Charsets.UTF_8))
        }
    }

    @Test
    fun `refuses a changed byte, a second open and an answer of another agent`() {
        val v = vectors.getJSONObject(0)
        fun sealed(agentSecret: String = v.getString("agentStaticSecret")) = AgentCall.seal(
            JDK,
            hex(v.getString("deviceStaticSecret")),
            AgentCall.publicKey(JDK, hex(agentSecret)),
            AgentCall.requestJson("/status", 1795000000000, null),
            hex(v.getString("deviceEphemeralSecret")),
        )
        val body = hex(v.getString("responseBody"))
        for (index in listOf(0, 5, 40, body.size - 1)) {
            val changed = body.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            assertThrows("byte $index", AgentCall.ProtocolException::class.java) { sealed().open(changed) }
        }
        assertThrows(AgentCall.ProtocolException::class.java) { sealed().open(body.copyOf(body.size - 20)) }
        val once = sealed()
        once.open(body)
        assertThrows(AgentCall.ProtocolException::class.java) { once.open(body) }
        val other = "00" + v.getString("agentStaticSecret").substring(2)
        assertThrows(AgentCall.ProtocolException::class.java) { sealed(other).open(body) }
    }

    @Test
    fun `writes the request in the app's key order, with the language only when known`() {
        assertEquals("{\"m\":\"GET\",\"p\":\"/status\",\"t\":12}", String(AgentCall.requestJson("/status", 12, null)))
        assertEquals("{\"m\":\"GET\",\"p\":\"/status\",\"t\":12,\"l\":\"de\"}", String(AgentCall.requestJson("/status", 12, "de")))
        assertEquals("{\"m\":\"GET\",\"p\":\"/status\",\"t\":12}", String(AgentCall.requestJson("/status", 12, "fr")))
        assertThrows(IllegalArgumentException::class.java) { AgentCall.requestJson("/status\"}", 12, null) }
    }

    @Test
    fun `computes BLAKE2b as RFC 7693 and the relay's agent id`() {
        // RFC 7693 appendix A: BLAKE2b-512("abc").
        assertEquals(
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
                "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
            hexOf(Blake2b.hash("abc".toByteArray())),
        )
        // The empty input, and one over a block (two compressions).
        assertEquals(
            "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419" +
                "d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
            hexOf(Blake2b.hash(ByteArray(0))),
        )
        assertEquals(43, AgentCall.relayAgentId(ByteArray(32)).length)
    }

    companion object {
        /** X25519 and ChaCha20-Poly1305 from the JDK, as PushCryptoTest does. */
        val JDK = object : AgentCall.Primitives {
            override fun x25519(secretKey: ByteArray, publicKey: ByteArray): ByteArray {
                val factory = KeyFactory.getInstance("XDH")
                val priv = factory.generatePrivate(XECPrivateKeySpec(NamedParameterSpec.X25519, secretKey))
                val u = BigInteger(1, publicKey.reversedArray())
                val pub = factory.generatePublic(XECPublicKeySpec(NamedParameterSpec.X25519, u))
                val agreement = KeyAgreement.getInstance("XDH")
                agreement.init(priv)
                agreement.doPhase(pub, true)
                return agreement.generateSecret()
            }

            override fun seal(key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray) =
                chacha(Cipher.ENCRYPT_MODE, key, nonce, ad, plaintext)

            override fun open(key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray) =
                chacha(Cipher.DECRYPT_MODE, key, nonce, ad, ciphertext)

            private fun chacha(mode: Int, key: ByteArray, nonce: ByteArray, ad: ByteArray, input: ByteArray): ByteArray {
                val cipher = Cipher.getInstance("ChaCha20-Poly1305")
                cipher.init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
                cipher.updateAAD(ad)
                return cipher.doFinal(input)
            }
        }

        fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

        fun hexOf(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    }
}
