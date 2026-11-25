import Foundation

// Opens every message of protocol/test/push-vectors.json with the extension's
// PushCrypto. macOS only (CryptoKit):
//   cd app/ios/App/KubernannyPushExtension
//   swiftc -o /tmp/push-vectors PushCrypto.swift Tests/main.swift && /tmp/push-vectors ../../../../protocol/test/push-vectors.json

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
}
print("PushCrypto.swift: \(vectors.count) vectors opened, tampering refused")
