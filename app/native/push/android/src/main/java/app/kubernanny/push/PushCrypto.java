package app.kubernanny.push;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens a Kubernanny push on the phone. A copy of openPush() in
 * protocol/src/push.ts, line for line; read both side by side
 * (docs/PROTOCOL.md, "Push messages"):
 *
 *   HPKE (RFC 9180) mode_auth, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 *   ChaCha20-Poly1305, info "kubernanny-push/1", empty aad
 *   message = 0x01 | enc (32) | ciphertext
 *
 * Plain Java on purpose: PushCryptoTest runs it on any JDK against
 * protocol/test/push-vectors.json, which the TypeScript side reproduces.
 * X25519 and the AEAD come in through {@link Primitives}, because Android
 * before API 33 has no X25519 of its own (Tink provides it there).
 */
public final class PushCrypto {
    /** The two primitives the platform supplies. */
    public interface Primitives {
        /** X25519(secret, public), 32 bytes; throws on a low-order point (an all-zero result). */
        byte[] x25519(byte[] secretKey, byte[] publicKey) throws GeneralSecurityException;

        /** ChaCha20-Poly1305 decryption with empty associated data; throws on a bad tag. */
        byte[] chachaOpen(byte[] key, byte[] nonce, byte[] ciphertextAndTag) throws GeneralSecurityException;
    }

    public static final int VERSION = 1;
    private static final byte[] INFO = ascii("kubernanny-push/1");
    private static final byte[] HPKE_V1 = ascii("HPKE-v1");
    private static final byte[] KEM_SUITE = concat(ascii("KEM"), new byte[] {0x00, 0x20});
    private static final byte[] HPKE_SUITE = concat(ascii("HPKE"), new byte[] {0x00, 0x20, 0x00, 0x01, 0x00, 0x03});
    private static final byte[] EMPTY = new byte[0];
    private static final byte MODE_AUTH = 0x02;

    private PushCrypto() {}

    /**
     * @param pushSecret this phone's push secret key for the cluster
     * @param pushPublic its public half
     * @param agentPublic the agent key pinned at pairing: only the agent can have sealed what opens
     */
    public static byte[] open(Primitives p, byte[] pushSecret, byte[] pushPublic, byte[] agentPublic, byte[] message) throws GeneralSecurityException {
        if (message.length < 1 + 32 + 16 || message[0] != VERSION) {
            throw new GeneralSecurityException("not a push message of this version");
        }
        byte[] enc = Arrays.copyOfRange(message, 1, 33);
        byte[] dh = concat(p.x25519(pushSecret, enc), p.x25519(pushSecret, agentPublic));
        byte[] kemContext = concat(enc, pushPublic, agentPublic);
        byte[] prk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh);
        byte[] shared = labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, 32);

        byte[] pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY);
        byte[] infoHash = labeledExtract(HPKE_SUITE, EMPTY, "info_hash", INFO);
        byte[] context = concat(new byte[] {MODE_AUTH}, pskIdHash, infoHash);
        byte[] secret = labeledExtract(HPKE_SUITE, shared, "secret", EMPTY);
        byte[] key = labeledExpand(HPKE_SUITE, secret, "key", context, 32);
        byte[] nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12);
        return p.chachaOpen(key, nonce, Arrays.copyOfRange(message, 33, message.length));
    }

    private static byte[] labeledExtract(byte[] suite, byte[] salt, String label, byte[] ikm) throws GeneralSecurityException {
        return hmac(salt.length == 0 ? new byte[32] : salt, concat(HPKE_V1, suite, ascii(label), ikm));
    }

    /** HKDF-Expand (RFC 5869) of the labeled info; lengths here never exceed one block. */
    private static byte[] labeledExpand(byte[] suite, byte[] prk, String label, byte[] info, int length) throws GeneralSecurityException {
        byte[] labeled = concat(new byte[] {(byte) (length >> 8), (byte) length}, HPKE_V1, suite, ascii(label), info);
        byte[] block = hmac(prk, concat(labeled, new byte[] {0x01}));
        return Arrays.copyOf(block, length);
    }

    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.write(part, 0, part.length);
        }
        return out.toByteArray();
    }
}
