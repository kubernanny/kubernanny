import CryptoKit
import Foundation

/// Opens a Kubernanny push. A copy of openPush() in protocol/src/push.ts and
/// of PushCrypto.java (app/native/push/android), line for line; read them side
/// by side (docs/PROTOCOL.md, "Push messages"):
///
///   HPKE (RFC 9180) mode_auth, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
///   ChaCha20-Poly1305, info "kubernanny-push/1", empty aad
///   message = 0x01 | enc (32) | ciphertext
///
/// CryptoKit's own HPKE needs iOS 17 and its HKDF.extract iOS 16; the app
/// supports iOS 15, so extract and expand are written out with HMAC (one
/// block suffices for every length here). Checked against
/// protocol/test/push-vectors.json by Tests/main.swift (macOS only).
enum PushCrypto {
    enum Failure: Error { case version, aead }

    private static let info = Data("kubernanny-push/1".utf8)
    private static let hpkeV1 = Data("HPKE-v1".utf8)
    private static let kemSuite = Data("KEM".utf8) + Data([0x00, 0x20])
    private static let hpkeSuite = Data("HPKE".utf8) + Data([0x00, 0x20, 0x00, 0x01, 0x00, 0x03])

    static func open(pushSecret: Data, pushPublic: Data, agentPublic: Data, message: Data) throws -> Data {
        let bytes = [UInt8](message)
        guard bytes.count >= 1 + 32 + 16, bytes[0] == 1 else { throw Failure.version }
        let enc = Data(bytes[1..<33])
        let me = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: pushSecret)
        let dh = try raw(me.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: enc)))
            + raw(me.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: agentPublic)))
        let kemContext = enc + pushPublic + agentPublic
        let prk = labeledExtract(kemSuite, salt: Data(), label: "eae_prk", ikm: dh)
        let shared = labeledExpand(kemSuite, prk: prk, label: "shared_secret", info: kemContext, length: 32)

        let pskIdHash = labeledExtract(hpkeSuite, salt: Data(), label: "psk_id_hash", ikm: Data())
        let infoHash = labeledExtract(hpkeSuite, salt: Data(), label: "info_hash", ikm: info)
        let context = Data([0x02]) + pskIdHash + infoHash
        let secret = labeledExtract(hpkeSuite, salt: shared, label: "secret", ikm: Data())
        let key = labeledExpand(hpkeSuite, prk: secret, label: "key", info: context, length: 32)
        let nonce = labeledExpand(hpkeSuite, prk: secret, label: "base_nonce", info: context, length: 12)

        let body = Data(bytes[33...])
        guard body.count >= 16 else { throw Failure.aead }
        let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: body.dropLast(16), tag: body.suffix(16))
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key))
    }

    private static func raw(_ secret: SharedSecret) -> Data {
        secret.withUnsafeBytes { Data($0) }
    }

    private static func labeledExtract(_ suite: Data, salt: Data, label: String, ikm: Data) -> Data {
        hmac(key: salt.isEmpty ? Data(count: 32) : salt, data: hpkeV1 + suite + Data(label.utf8) + ikm)
    }

    private static func labeledExpand(_ suite: Data, prk: Data, label: String, info: Data, length: Int) -> Data {
        let labeled = Data([UInt8(length >> 8), UInt8(length & 0xff)]) + hpkeV1 + suite + Data(label.utf8) + info
        return hmac(key: prk, data: labeled + Data([0x01])).prefix(length)
    }

    private static func hmac(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }
}
