import Foundation

// Opens every message of protocol/test/push-vectors.json with the extension's
// PushCrypto. macOS only (CryptoKit):
//   cd app/ios/App/KubernannyPushExtension
//   swiftc -o /tmp/push-vectors PushCrypto.swift PushKeys.swift WidgetPushStatus.swift StatusPush.swift Tests/main.swift && /tmp/push-vectors ../../../../protocol/test/push-vectors.json

func hex(_ text: String) -> Data {
    var data = Data()
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        data.append(UInt8(text[index..<next], radix: 16)!)
        index = next
    }
    return data
}

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "../../../../protocol/test/push-vectors.json"
let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [[String: String]]
for v in vectors {
    let message = hex(v["message"]!)
    let plain = try PushCrypto.open(pushSecret: hex(v["pushSecret"]!), pushPublic: hex(v["pushPublic"]!), agentPublic: hex(v["agentStaticPublic"]!), message: message)
    precondition(String(data: plain, encoding: .utf8) == v["plaintext"], "plaintext of \(v["name"]!)")
    var tampered = message
    tampered[tampered.count - 1] ^= 1
    precondition((try? PushCrypto.open(pushSecret: hex(v["pushSecret"]!), pushPublic: hex(v["pushPublic"]!), agentPublic: hex(v["agentStaticPublic"]!), message: tampered)) == nil, "tampering must fail")
    precondition((try? PushCrypto.open(pushSecret: hex(v["pushSecret"]!), pushPublic: hex(v["pushPublic"]!), agentPublic: hex(v["pushPublic"]!), message: message)) == nil, "another agent must fail")
    // Status pushes (StatusPush.swift): only priority 0 is one, applied within the hour of its sealing.
    let json = try JSONSerialization.jsonObject(with: plain) as! [String: Any]
    let sealedAt = (json["s"] as! NSNumber).doubleValue
    let statusOnly = v["name"] == "status-only"
    precondition(StatusPush.isStatusOnly(json) == statusOnly, "status-only flag of \(v["name"]!)")
    precondition((StatusPush.status(fromOpened: json, now: sealedAt + 60_000) != nil) == statusOnly, "status of \(v["name"]!)")
    if statusOnly {
        precondition(StatusPush.status(fromOpened: json, now: sealedAt + 3_600_001) == nil, "a stale status push is dropped")
        // A status push never moves the replay marker of alerts, so it is fresh whatever was shown since.
        precondition(PushKeys.isStatusFresh(sealedAt: sealedAt, now: sealedAt + 1) && !PushKeys.isFresh(sealedAt: sealedAt, now: sealedAt + 1, lastShown: sealedAt + 1))
    }
}
print("PushCrypto.swift: \(vectors.count) vectors opened, tampering refused")

// The marker on an opened title: the same cases as push-marker.spec.ts and PushMarkerTest.java.
precondition(PushKeys.markedTitle("🦉", "homelab: 2 problems") == "🦉 homelab: 2 problems")
precondition(PushKeys.markedTitle(" Kiwi ", "homelab: ok") == "Kiwi homelab: ok")
precondition(PushKeys.markedTitle(nil, "homelab: ok") == "homelab: ok")
precondition(PushKeys.markedTitle("  ", "homelab: ok") == "homelab: ok")
print("PushKeys.markedTitle: titles as in push-marker.ts")

// Freshness: the same cases as pushFresh in push.spec.ts and PushFreshnessTest.java.
let now = 1_795_000_000_000.0
precondition(PushKeys.isFresh(sealedAt: now - 5_000, now: now, lastShown: nil))
precondition(PushKeys.isFresh(sealedAt: now - 5_000, now: now, lastShown: now - 60_000))
precondition(PushKeys.isFresh(sealedAt: now - PushKeys.maxAge, now: now, lastShown: nil))
precondition(!PushKeys.isFresh(sealedAt: now - PushKeys.maxAge - 1, now: now, lastShown: nil))
precondition(!PushKeys.isFresh(sealedAt: now - 60_000, now: now, lastShown: now - 60_000))
precondition(!PushKeys.isFresh(sealedAt: now - 60_000, now: now, lastShown: now - 5_000))
precondition(!PushKeys.isFresh(sealedAt: now + PushKeys.maxAge + 1, now: now, lastShown: nil))
print("PushKeys.isFresh: as pushFresh in push-content.ts")
