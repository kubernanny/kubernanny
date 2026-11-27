import Foundation
import XCTest
@testable import KubernannyAgentCall

/// The widget's copy of the end-to-end channel against protocol/test/vectors.json: fixed keys give
/// the same request bytes as the TypeScript side, and the agent's answer opens to the same status,
/// time and body. Run with `swift test` in app/native/agent-call (macOS).
final class AgentCallTests: XCTestCase {
    struct Vector: Decodable {
        struct Request: Decodable { let method: String; let path: String; let time: Double }
        struct Response: Decodable { let status: Int; let time: Double; let body: String }
        let name: String
        let deviceStaticSecret: String
        let deviceEphemeralSecret: String
        let agentStaticSecret: String
        let request: Request
        let response: Response
        let requestBody: String
        let responseBody: String
    }

    static let vectors: [Vector] = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().appendingPathComponent("../../../../../protocol/test/vectors.json").standardized
        return try! JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }()

    func testSealsEveryGetOfTheVectorsByteForByteAndOpensTheAnswer() throws {
        var checked = 0
        for v in Self.vectors where v.request.method == "GET" {
            let sealed = try AgentCall.seal(
                deviceSecret: hex(v.deviceStaticSecret),
                agentPublic: try AgentCall.publicKey(secret: hex(v.agentStaticSecret)),
                requestJson: try AgentCall.requestJson(path: v.request.path, time: v.request.time, language: nil),
                ephemeralSecret: hex(v.deviceEphemeralSecret)
            )
            XCTAssertEqual(hexOf(sealed.body), v.requestBody, v.name)
            let answer = try sealed.open(hex(v.responseBody))
            XCTAssertEqual(answer.status, v.response.status)
            XCTAssertEqual(answer.time, v.response.time)
            XCTAssertEqual(String(data: answer.body, encoding: .utf8), v.response.body)
            checked += 1
        }
        XCTAssertGreaterThan(checked, 0)
    }

    func testRefusesAChangedByteASecondOpenAndAnotherAgent() throws {
        let v = Self.vectors[0]
        func sealed(_ agentSecret: String = v.agentStaticSecret) throws -> AgentCall.Sealed {
            try AgentCall.seal(
                deviceSecret: hex(v.deviceStaticSecret),
                agentPublic: try AgentCall.publicKey(secret: hex(agentSecret)),
                requestJson: try AgentCall.requestJson(path: "/status", time: 1795000000000, language: nil),
                ephemeralSecret: hex(v.deviceEphemeralSecret)
            )
        }
        let body = hex(v.responseBody)
        for index in [0, 5, 40, body.count - 1] {
            var changed = body
            changed[index] ^= 1
            XCTAssertThrowsError(try sealed().open(changed), "byte \(index)")
        }
        XCTAssertThrowsError(try sealed().open(body.prefix(body.count - 20)))
        let once = try sealed()
        _ = try once.open(body)
        XCTAssertThrowsError(try once.open(body))
        XCTAssertThrowsError(try sealed("00" + v.agentStaticSecret.dropFirst(2)).open(body))
    }

    func testWritesTheRequestInTheAppsKeyOrder() throws {
        XCTAssertEqual(String(data: try AgentCall.requestJson(path: "/status", time: 12, language: nil), encoding: .utf8), "{\"m\":\"GET\",\"p\":\"/status\",\"t\":12}")
        XCTAssertEqual(String(data: try AgentCall.requestJson(path: "/status", time: 12, language: "de"), encoding: .utf8), "{\"m\":\"GET\",\"p\":\"/status\",\"t\":12,\"l\":\"de\"}")
        XCTAssertEqual(String(data: try AgentCall.requestJson(path: "/status", time: 12, language: "fr"), encoding: .utf8), "{\"m\":\"GET\",\"p\":\"/status\",\"t\":12}")
        XCTAssertThrowsError(try AgentCall.requestJson(path: "/status\"}", time: 12, language: nil))
    }

    func testBlake2bAsRfc7693AndTheRelayAgentId() {
        XCTAssertEqual(hexOf(Blake2b.hash(Data("abc".utf8))),
                       "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923")
        XCTAssertEqual(hexOf(Blake2b.hash(Data())),
                       "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce")
        // Over one block: the same as the Kotlin copy and noble (checked there against the vectors).
        XCTAssertEqual(Blake2b.hash(Data(repeating: 7, count: 300)).count, 64)
        XCTAssertEqual(AgentCall.relayAgentId(agentPublic: Data(count: 32)).count, 43)
    }

    func testSnapshotCountsLikeTheAppAndTakesOnlyANewerCheck() throws {
        let stored = String(data: try JSONSerialization.data(withJSONObject: [
            ["id": "c1", "name": "homelab", "light": "green", "critical": 0, "warning": 0, "checkedAt": "2026-11-27T08:00:00.000Z", "demo": false, "problems": []],
            ["id": "c2", "name": "office", "light": "green", "critical": 0, "warning": 0, "checkedAt": NSNull(), "demo": false]
        ]), encoding: .utf8)
        func issue(_ severity: String, _ title: String, silenced: Bool = false) -> [String: Any] {
            var i: [String: Any] = ["id": title, "severity": severity, "title": title]
            if silenced { i["silencedUntil"] = "2026-11-28T00:00:00Z" }
            return i
        }
        let status: [String: Any] = ["light": "red", "checkedAt": "2026-11-27T09:00:00.000Z", "issues": [
            issue("warning", "w1"), issue("critical", "c1"), issue("info", "hint"), issue("critical", "muted", silenced: true),
            issue("warning", "w2"), issue("critical", "c2")
        ]]
        let next = try XCTUnwrap(WidgetSnapshot.merge(stored: stored, clusterId: "c1", status: status))
        let list = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(next.utf8)) as? [[String: Any]])
        XCTAssertEqual(list[0]["critical"] as? Int, 2)
        XCTAssertEqual(list[0]["warning"] as? Int, 2)
        XCTAssertEqual(list[0]["name"] as? String, "homelab")
        XCTAssertEqual((list[0]["problems"] as? [[String: String]])?.map { $0["title"]! }, ["c1", "c2", "w1"])
        var older = status
        older["checkedAt"] = "2026-11-27T08:00:00Z"
        XCTAssertNil(WidgetSnapshot.merge(stored: stored, clusterId: "c1", status: older))
        XCTAssertNil(WidgetSnapshot.merge(stored: stored, clusterId: "gone", status: status))
        XCTAssertNotNil(WidgetSnapshot.merge(stored: stored, clusterId: "c2", status: status))
        let clipped = WidgetSnapshot.clip(String(repeating: "🙂", count: 130), max: 120)
        XCTAssertEqual(clipped.unicodeScalars.count, 120)
        XCTAssertEqual(WidgetRefresh.usableRelay("https://relay.kubernanny.app/"), "https://relay.kubernanny.app")
        XCTAssertNil(WidgetRefresh.usableRelay("http://evil.example"))
    }

    private func hex(_ text: String) -> Data {
        var out = Data()
        var i = text.startIndex
        while i < text.endIndex {
            let j = text.index(i, offsetBy: 2)
            out.append(UInt8(text[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    private func hex(_ text: Substring) -> Data { hex(String(text)) }

    private func hexOf(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
