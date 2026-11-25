import Foundation

// Applies the push status of protocol/test/push-vectors.json ("widget-status")
// to a stored widget list with WidgetPushStatus.merge. macOS only (CryptoKit):
//   cd app/ios/App/KubernannyPushExtension
//   swiftc -o /tmp/widget-status PushCrypto.swift WidgetPushStatus.swift Tests/WidgetStatus/main.swift && /tmp/widget-status ../../../../protocol/test/push-vectors.json

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

func list(_ json: String?) -> [[String: Any]] {
    (try! JSONSerialization.jsonObject(with: json!.data(using: .utf8)!)) as! [[String: Any]]
}

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "../../../../protocol/test/push-vectors.json"
let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [[String: String]]
let v = vectors.first { $0["name"] == "widget-status" }!
let plain = try PushCrypto.open(pushSecret: hex(v["pushSecret"]!), pushPublic: hex(v["pushPublic"]!), agentPublic: hex(v["agentStaticPublic"]!), message: hex(v["message"]!))
let content = try JSONSerialization.jsonObject(with: plain) as! [String: Any]
let status = content["w"] as! [String: Any]

let stored = #"[{"id":"a","name":"homelab","light":"green","critical":0,"warning":0,"checkedAt":"2026-11-18T09:00:00.000Z","demo":false},{"id":"b","name":"other","light":"green","critical":0,"warning":0,"checkedAt":null,"demo":false}]"#

// Newer: applied to that cluster only, name and the other cluster untouched.
let merged = list(WidgetPushStatus.merge(stored: stored, clusterId: "a", status: status))
precondition(merged[0]["light"] as? String == "red" && merged[0]["critical"] as? Int == 1 && merged[0]["warning"] as? Int == 1, "counts")
precondition(merged[0]["name"] as? String == "homelab", "name kept")
precondition(WidgetPushStatus.parseIso(merged[0]["checkedAt"] as! String)!.timeIntervalSince1970 * 1000 == 1795000110000, "checkedAt")
let problems = merged[0]["problems"] as! [[String: String]]
precondition(problems.count == 2 && problems[0]["severity"] == "critical" && problems[1]["title"] == "Certificate shop.example expires in 9 days", "problems")
precondition(merged[1]["light"] as? String == "green", "other cluster untouched")

// Older than what is stored, an unknown cluster (switched off for the widget), nothing stored, or malformed: nothing written.
let newer = stored.replacingOccurrences(of: "2026-11-18T09:00:00.000Z", with: "2026-11-30T09:00:00.000Z")
precondition(WidgetPushStatus.merge(stored: newer, clusterId: "a", status: status) == nil, "older push ignored")
precondition(WidgetPushStatus.merge(stored: stored, clusterId: "gone", status: status) == nil, "no entry, no write")
precondition(WidgetPushStatus.merge(stored: nil, clusterId: "a", status: status) == nil, "nothing stored")
var bad = status
bad["l"] = "pink"
precondition(WidgetPushStatus.merge(stored: stored, clusterId: "a", status: bad) == nil, "bad light")
bad = status
bad["a"] = NSNull()
precondition(WidgetPushStatus.merge(stored: stored, clusterId: "a", status: bad) == nil, "no check time")

// Minimal detail: counts without titles clear the old titles.
var minimal = status
minimal.removeValue(forKey: "i")
precondition((list(WidgetPushStatus.merge(stored: stored, clusterId: "a", status: minimal))[0]["problems"] as! [Any]).isEmpty, "minimal")
print("WidgetPushStatus.swift: push status applied, older, unknown and malformed ones refused")
