package app.kubernanny.push;

import com.google.crypto.tink.subtle.X25519;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * X25519 from Tink (Android has none of its own before API 33),
 * ChaCha20-Poly1305 from the platform (Conscrypt, API 28 and later; the
 * plugin reports push as unavailable below that).
 */
final class AndroidPrimitives implements PushCrypto.Primitives {
    @Override
    public byte[] x25519(byte[] secretKey, byte[] publicKey) throws GeneralSecurityException {
        byte[] shared;
        try {
            shared = X25519.computeSharedSecret(secretKey, publicKey);
        } catch (java.security.InvalidKeyException e) {
            throw new GeneralSecurityException(e);
        }
        int any = 0;
        for (byte b : shared) {
            any |= b;
        }
        if (any == 0) {
            throw new GeneralSecurityException("low-order point"); // as noble refuses it on the agent side
        }
        return shared;
    }

    @Override
    public byte[] chachaOpen(byte[] key, byte[] nonce, byte[] ciphertextAndTag) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("ChaCha20/Poly1305/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "ChaCha20"), new IvParameterSpec(nonce));
        return cipher.doFinal(ciphertextAndTag);
    }
}
