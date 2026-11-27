import CryptoKit
import Foundation

/// One call to an agent from the widget, without the app: a copy of the app's
/// end-to-end channel (protocol/src/noise.ts and envelope.ts, docs/PROTOCOL.md),
/// the initiator side only, and of AgentCall.kt on Android; read them side by side.
///
///   Noise_IK_25519_ChaChaPoly_BLAKE2b, prologue "kubernanny-e2e/1"
///   request body:  0x01 | message 1 (payload: the request as JSON)
///   response body: 0x01 | u16 len | message 2 (payload: {"s": status, "t": agent time})
///                       | u16 len | frame | …  (frame: flag byte, bit 0 on the last, then body bytes)
///
/// X25519 and ChaCha20-Poly1305 come from CryptoKit; BLAKE2b, which it lacks, from Blake2b below.
public enum AgentCall {
    public struct ProtocolError: Error, CustomStringConvertible {
        public let description: String
        init(_ description: String) { self.description = description }
    }

    public struct Answer {
        public let status: Int
        /// The agent's clock, ms since the epoch.
        public let time: Double
        public let body: Data
    }

    static let version: UInt8 = 1
    static let prologue = Data("kubernanny-e2e/1".utf8)
    static let protocolName = Data("Noise_IK_25519_ChaChaPoly_BLAKE2b".utf8)
    static let maxMessage = 65535
    /// The largest answer opened; a status is a few hundred kilobytes at most.
    static let maxResponseBody = 8 * 1024 * 1024

    /// A sealed request: `body` goes out as the POST body, `open` reads exactly its answer, once.
    public final class Sealed {
        public let body: Data
        private let initiator: Initiator
        private var used = false

        init(body: Data, initiator: Initiator) {
            self.body = body
            self.initiator = initiator
        }

        public func open(_ responseBody: Data) throws -> Answer {
            guard !used else { throw ProtocolError("response already opened") }
            used = true
            let bytes = [UInt8](responseBody)
            guard bytes.first == version else { throw ProtocolError("unknown protocol version") }
            let frames = try readFrames(bytes)
            guard let message2 = frames.first else { throw ProtocolError("no handshake message") }
            let head: Data
            var receive: CipherState
            do {
                (head, receive) = try initiator.readMessage2(message2)
            } catch {
                throw ProtocolError("response not from the pinned agent")
            }
            guard
                let json = try? JSONSerialization.jsonObject(with: head) as? [String: Any],
                let status = json["s"] as? NSNumber, status.doubleValue == status.doubleValue.rounded(),
                let time = json["t"] as? NSNumber
            else {
                throw ProtocolError("invalid response head")
            }
            var out = Data()
            var last = false
            for frame in frames.dropFirst() {
                guard !last else { throw ProtocolError("data after the last frame") }
                let plain: Data
                do {
                    plain = try receive.decrypt(ad: Data(), frame)
                } catch {
                    throw ProtocolError("frame failed authentication")
                }
                guard let flags = plain.first, flags & 0xfe == 0 else { throw ProtocolError("invalid frame flags") }
                last = flags & 1 == 1
                guard out.count + plain.count - 1 <= maxResponseBody else { throw ProtocolError("response too large") }
                out.append(plain.dropFirst())
            }
            guard last else { throw ProtocolError("response cut off") }
            return Answer(status: status.intValue, time: time.doubleValue, body: out)
        }
    }

    /// Seals one request to the agent whose key was pinned at pairing.
    /// `ephemeralSecret` is only ever passed by the test vectors.
    public static func seal(deviceSecret: Data, agentPublic: Data, requestJson: Data, ephemeralSecret: Data? = nil) throws -> Sealed {
        guard deviceSecret.count == 32, agentPublic.count == 32 else { throw ProtocolError("keys must be 32 bytes") }
        let e = ephemeralSecret ?? Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        let initiator = try Initiator(s: deviceSecret, rs: agentPublic, e: e)
        let message1 = try initiator.writeMessage1(requestJson)
        return Sealed(body: Data([version]) + message1, initiator: initiator)
    }

    /// The inner request as JSON, in the app's key order (`m`, `p`, `t`, then `l`). GET only: the widget reads, it never acts.
    public static func requestJson(path: String, time: Double, language: String?) throws -> Data {
        guard path.range(of: "^/[A-Za-z0-9\\-._~/%?=&:,+]*$", options: .regularExpression) != nil else {
            throw ProtocolError("invalid path")
        }
        let lang = language == "en" || language == "de" ? ",\"l\":\"\(language!)\"" : ""
        return Data("{\"m\":\"GET\",\"p\":\"\(path)\",\"t\":\(Int64(time.rounded()))\(lang)}".utf8)
    }

    /// The agent's id at the relay: BLAKE2b-256 of its public key, base64url without padding (relayAgentId).
    public static func relayAgentId(agentPublic: Data) -> String {
        base64Url(Blake2b.hash(agentPublic, outLength: 32))
    }

    public static func publicKey(secret: Data) throws -> Data {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret).publicKey.rawRepresentation
    }

    public static func base64Url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func fromBase64Url(_ text: String) -> Data? {
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        return Data(base64Encoded: b64)
    }

    /// Splits `0x01 | (u16 len | bytes)*` into its parts.
    static func readFrames(_ body: [UInt8]) throws -> [Data] {
        var frames: [Data] = []
        var offset = 1
        while offset < body.count {
            guard offset + 2 <= body.count else { throw ProtocolError("cut-off length") }
            let length = Int(body[offset]) << 8 | Int(body[offset + 1])
            offset += 2
            guard length > 0, offset + length <= body.count else { throw ProtocolError("cut-off frame") }
            frames.append(Data(body[offset..<offset + length]))
            offset += length
        }
        return frames
    }

    // MARK: - Noise (revision 34), initiator of IK only

    static func dh(_ secret: Data, _ publicKey: Data) throws -> Data {
        let shared = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
            .sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey))
            .withUnsafeBytes { Data($0) }
        // As noble refuses a low-order point on the agent's side.
        guard shared.contains(where: { $0 != 0 }) else { throw ProtocolError("low-order point") }
        return shared
    }

    /// 96-bit nonce: 32 zero bits, then n as 64-bit little-endian (Noise section 12.3).
    static func nonce(_ n: UInt64) -> Data {
        var out = Data(count: 4)
        for i in 0..<8 { out.append(UInt8(truncatingIfNeeded: n >> (8 * UInt64(i)))) }
        return out
    }

    struct CipherState {
        let key: Data?
        var n: UInt64 = 0

        mutating func encrypt(ad: Data, _ plaintext: Data) throws -> Data {
            guard let key else { return plaintext }
            let box = try ChaChaPoly.seal(plaintext, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: AgentCall.nonce(n)), authenticating: ad)
            n += 1
            return box.ciphertext + box.tag
        }

        mutating func decrypt(ad: Data, _ ciphertext: Data) throws -> Data {
            guard let key else { return ciphertext }
            guard ciphertext.count >= 16 else { throw ProtocolError("short ciphertext") }
            let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: AgentCall.nonce(n)), ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
            // n only advances on success (section 5.1).
            let plain = try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
            n += 1
            return plain
        }
    }

    final class Initiator {
        private let s: Data
        private let rs: Data
        private let e: Data
        private let ePublic: Data
        private var h: Data
        private var ck: Data
        private var cipher = CipherState(key: nil)

        init(s: Data, rs: Data, e: Data) throws {
            self.s = s
            self.rs = rs
            self.e = e
            ePublic = try AgentCall.publicKey(secret: e)
            var name = protocolName
            name.append(Data(count: Blake2b.outLength - name.count))
            h = name
            ck = name
            mixHash(prologue)
            mixHash(rs) // pre-message "<- s"
        }

        private func mixHash(_ data: Data) {
            h = Blake2b.hash(h + data)
        }

        private func mixKey(_ ikm: Data) {
            let (next, temp) = hkdf(ck, ikm)
            ck = next
            cipher = CipherState(key: temp.prefix(32))
        }

        private func encryptAndHash(_ plaintext: Data) throws -> Data {
            let c = try cipher.encrypt(ad: h, plaintext)
            mixHash(c)
            return c
        }

        private func decryptAndHash(_ ciphertext: Data) throws -> Data {
            let p = try cipher.decrypt(ad: h, ciphertext)
            mixHash(ciphertext)
            return p
        }

        /// -> e, es, s, ss, then the payload.
        func writeMessage1(_ payload: Data) throws -> Data {
            mixHash(ePublic)
            mixKey(try dh(e, rs))
            let encryptedStatic = try encryptAndHash(try AgentCall.publicKey(secret: s))
            mixKey(try dh(s, rs))
            let encryptedPayload = try encryptAndHash(payload)
            let message = ePublic + encryptedStatic + encryptedPayload
            guard message.count <= maxMessage else { throw ProtocolError("request too large") }
            return message
        }

        /// <- e, ee, se, then the payload; returns it with the cipher for the agent's frames.
        func readMessage2(_ message: Data) throws -> (Data, CipherState) {
            guard message.count >= 32 + 16, message.count <= maxMessage else { throw ProtocolError("message 2 has a wrong length") }
            let re = Data(message.prefix(32))
            mixHash(re)
            mixKey(try dh(e, re))
            mixKey(try dh(s, re))
            let payload = try decryptAndHash(Data(message.dropFirst(32)))
            let (_, receive) = hkdf(ck, Data())
            return (payload, CipherState(key: receive.prefix(32)))
        }
    }

    /// HKDF() of Noise section 4.3 with HMAC-BLAKE2b, two outputs.
    static func hkdf(_ chainingKey: Data, _ ikm: Data) -> (Data, Data) {
        let temp = Blake2b.hmac(key: chainingKey, message: ikm)
        let out1 = Blake2b.hmac(key: temp, message: Data([1]))
        let out2 = Blake2b.hmac(key: temp, message: out1 + Data([2]))
        return (out1, out2)
    }
}

/// BLAKE2b (RFC 7693), unkeyed, and HMAC over it (RFC 2104, block size 128), as @noble/hashes computes them.
public enum Blake2b {
    public static let outLength = 64
    static let block = 128

    static let iv: [UInt64] = [
        0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
        0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179
    ]

    static let sigma: [[Int]] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
        [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
        [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
        [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
        [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
        [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
        [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
        [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
        [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]
    ]

    public static func hash(_ data: Data, outLength: Int = outLength) -> Data {
        precondition((1...64).contains(outLength))
        var h = iv
        h[0] ^= 0x01010000 ^ UInt64(outLength)
        let bytes = [UInt8](data)
        var offset = 0
        // Every block but the last is compressed as it comes; the last (possibly empty, zero-padded) is final.
        while bytes.count - offset > block {
            compress(&h, Array(bytes[offset..<offset + block]), counter: UInt64(offset + block), last: false)
            offset += block
        }
        var lastBlock = Array(bytes[offset...])
        lastBlock += [UInt8](repeating: 0, count: block - lastBlock.count)
        compress(&h, lastBlock, counter: UInt64(bytes.count), last: true)
        var out = Data()
        for word in h {
            for j in 0..<8 { out.append(UInt8(truncatingIfNeeded: word >> (8 * UInt64(j)))) }
        }
        return out.prefix(outLength)
    }

    public static func hmac(key: Data, message: Data) -> Data {
        var k = [UInt8](key.count > block ? hash(key) : key)
        k += [UInt8](repeating: 0, count: block - k.count)
        let inner = Data(k.map { $0 ^ 0x36 })
        let outer = Data(k.map { $0 ^ 0x5c })
        return hash(outer + hash(inner + message))
    }

    private static func compress(_ h: inout [UInt64], _ block: [UInt8], counter: UInt64, last: Bool) {
        var m = [UInt64](repeating: 0, count: 16)
        for i in 0..<16 {
            var x: UInt64 = 0
            for j in (0..<8).reversed() { x = x << 8 | UInt64(block[i * 8 + j]) }
            m[i] = x
        }
        var v = h + iv
        v[12] ^= counter
        if last { v[14] = ~v[14] }
        for round in 0..<12 {
            let s = sigma[round % 10]
            g(&v, 0, 4, 8, 12, m[s[0]], m[s[1]])
            g(&v, 1, 5, 9, 13, m[s[2]], m[s[3]])
            g(&v, 2, 6, 10, 14, m[s[4]], m[s[5]])
            g(&v, 3, 7, 11, 15, m[s[6]], m[s[7]])
            g(&v, 0, 5, 10, 15, m[s[8]], m[s[9]])
            g(&v, 1, 6, 11, 12, m[s[10]], m[s[11]])
            g(&v, 2, 7, 8, 13, m[s[12]], m[s[13]])
            g(&v, 3, 4, 9, 14, m[s[14]], m[s[15]])
        }
        for i in 0..<8 { h[i] ^= v[i] ^ v[i + 8] }
    }

    private static func rotr(_ x: UInt64, _ n: UInt64) -> UInt64 { x >> n | x << (64 - n) }

    private static func g(_ v: inout [UInt64], _ a: Int, _ b: Int, _ c: Int, _ d: Int, _ x: UInt64, _ y: UInt64) {
        v[a] = v[a] &+ v[b] &+ x
        v[d] = rotr(v[d] ^ v[a], 32)
        v[c] = v[c] &+ v[d]
        v[b] = rotr(v[b] ^ v[c], 24)
        v[a] = v[a] &+ v[b] &+ y
        v[d] = rotr(v[d] ^ v[a], 16)
        v[c] = v[c] &+ v[d]
        v[b] = rotr(v[b] ^ v[c], 63)
    }
}
