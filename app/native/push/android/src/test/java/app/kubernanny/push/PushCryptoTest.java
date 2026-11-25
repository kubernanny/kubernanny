package app.kubernanny.push;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.NamedParameterSpec;
import java.security.spec.XECPrivateKeySpec;
import java.security.spec.XECPublicKeySpec;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens every message of protocol/test/push-vectors.json with PushCrypto,
 * the JDK supplying X25519 and ChaCha20-Poly1305 (Tink and Conscrypt do on
 * a phone), and checks that a changed byte or another agent key fails.
 * A plain main, so it runs without Gradle or JUnit: `npm test` in
 * app/native/push.
 */
public final class PushCryptoTest {
    static final PushCrypto.Primitives JDK = new PushCrypto.Primitives() {
        @Override
        public byte[] x25519(byte[] secretKey, byte[] publicKey) throws GeneralSecurityException {
            KeyFactory factory = KeyFactory.getInstance("XDH");
            PrivateKey priv = factory.generatePrivate(new XECPrivateKeySpec(NamedParameterSpec.X25519, secretKey));
            byte[] reversed = new byte[32];
            for (int i = 0; i < 32; i++) {
                reversed[i] = publicKey[31 - i];
            }
            reversed[0] &= 0x7f; // RFC 7748: the top bit of u is ignored
            PublicKey pub = factory.generatePublic(new XECPublicKeySpec(NamedParameterSpec.X25519, new BigInteger(1, reversed)));
            KeyAgreement agreement = KeyAgreement.getInstance("XDH");
            agreement.init(priv);
            agreement.doPhase(pub, true);
            return agreement.generateSecret();
        }

        @Override
        public byte[] chachaOpen(byte[] key, byte[] nonce, byte[] ciphertextAndTag) throws GeneralSecurityException {
            Cipher cipher = Cipher.getInstance("ChaCha20-Poly1305");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "ChaCha20"), new IvParameterSpec(nonce));
            return cipher.doFinal(ciphertextAndTag);
        }
    };

    public static void main(String[] args) throws Exception {
        String json = Files.readString(Path.of(args.length > 0 ? args[0] : "../../../protocol/test/push-vectors.json"));
        HexFormat hex = HexFormat.of();
        int checked = 0;
        for (String vector : objects(json)) {
            byte[] message = hex.parseHex(field(vector, "message"));
            byte[] pushSecret = hex.parseHex(field(vector, "pushSecret"));
            byte[] pushPublic = hex.parseHex(field(vector, "pushPublic"));
            byte[] agentPublic = hex.parseHex(field(vector, "agentStaticPublic"));
            String plaintext = new String(PushCrypto.open(JDK, pushSecret, pushPublic, agentPublic, message), StandardCharsets.UTF_8);
            check(plaintext.equals(unescape(field(vector, "plaintext"))), "plaintext of " + field(vector, "name"));

            byte[] tampered = message.clone();
            tampered[tampered.length - 1] ^= 1;
            check(fails(() -> PushCrypto.open(JDK, pushSecret, pushPublic, agentPublic, tampered)), "a changed byte must not open");
            byte[] otherAgent = pushPublic.clone();
            check(fails(() -> PushCrypto.open(JDK, pushSecret, pushPublic, otherAgent, message)), "another agent key must not open");
            byte[] v2 = message.clone();
            v2[0] = 2;
            check(fails(() -> PushCrypto.open(JDK, pushSecret, pushPublic, agentPublic, v2)), "another version must not open");
            checked++;
        }
        check(checked >= 2, "vectors found");
        System.out.println("PushCrypto: " + checked + " vectors opened, tampering refused");
    }

    interface Attempt {
        void run() throws Exception;
    }

    static boolean fails(Attempt attempt) {
        try {
            attempt.run();
            return false;
        } catch (Exception expected) {
            return true;
        }
    }

    static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    /** The vectors, one string each from its "name" to the next; the file is generated, flat and known. */
    static List<String> objects(String json) {
        List<String> out = new ArrayList<>();
        String[] parts = json.split("\"name\":");
        for (int i = 1; i < parts.length; i++) {
            out.add("\"name\":" + parts[i]);
        }
        return out;
    }

    static String field(String object, String name) {
        Matcher m = Pattern.compile("\"" + name + "\":\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(object);
        if (!m.find()) {
            throw new AssertionError("no " + name);
        }
        return m.group(1);
    }

    static String unescape(String s) {
        return s.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
