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

// Dead man's switch messages: the same cases as deadmanFresh in push.spec.ts.
let ds = 1_795_000_000_000.0
let dmin = 60_000.0
let du = ds + 3 * 3_600_000
precondition(PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: du, graceMinutes: 15, now: ds + 2 * 3_600_000, lastDeadman: nil, lastHeard: nil))
precondition(PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: du, graceMinutes: 15, now: ds + 90 * dmin, lastDeadman: nil, lastHeard: ds - 10 * dmin))
precondition(PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: du, graceMinutes: 15, now: ds + 90 * dmin, lastDeadman: nil, lastHeard: ds + 20 * dmin))
precondition(!PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: du, graceMinutes: 15, now: ds + 90 * dmin, lastDeadman: ds, lastHeard: nil))
precondition(!PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: du, graceMinutes: 15, now: du + 1, lastDeadman: nil, lastHeard: nil))
precondition(!PushKeys.isDeadmanFresh(sealedAt: ds + 2 * 3_600_000, validUntil: du, graceMinutes: 15, now: ds, lastDeadman: nil, lastHeard: nil))
precondition(!PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: ds + 28 * 3_600_000, graceMinutes: 15, now: ds + dmin, lastDeadman: nil, lastHeard: nil))
precondition(!PushKeys.isDeadmanFresh(sealedAt: ds, validUntil: du, graceMinutes: 15, now: ds + 90 * dmin, lastDeadman: nil, lastHeard: ds + 80 * dmin))
precondition(PushKeys.validGrace(15) && !PushKeys.validGrace(20))
// The deadman vector carries its descriptor, and is no status push.
let dv = vectors.first { $0["name"] == "deadman" }!
let dplain = try PushCrypto.open(pushSecret: hex(dv["pushSecret"]!), pushPublic: hex(dv["pushPublic"]!), agentPublic: hex(dv["agentStaticPublic"]!), message: hex(dv["message"]!))
let djson = try JSONSerialization.jsonObject(with: dplain) as! [String: Any]
let dd = djson["d"] as! [String: Any]
precondition((dd["g"] as! NSNumber).intValue == 15 && !StatusPush.isStatusOnly(djson))
// The widget's "agent not answering" mark.
let silentList = WidgetPushStatus.markUnreachable(stored: #"[{"id":"a","name":"homelab","light":"green","critical":0,"warning":0,"checkedAt":null,"demo":false}]"#, clusterId: "a", now: 1_795_000_200_000)!
precondition(silentList.contains("\"unreachableSince\":\"2026-11-18T"), silentList)
precondition(WidgetPushStatus.markUnreachable(stored: silentList, clusterId: "gone", now: 1) == nil)
print("PushKeys.isDeadmanFresh: as deadmanFresh in push-content.ts")
