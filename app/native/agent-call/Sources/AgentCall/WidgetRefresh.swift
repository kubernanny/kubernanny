import Foundation
import Security

/// One cluster the background refresh asks: what the app's AgentClient needs for GET /status, no more.
public struct RefreshTarget: Codable, Equatable {
    /// The app's cluster id: the widget entry it updates.
    public let id: String
    public let url: String
    /// The relay, when the agent uses one; only tried when the agent's own address does not answer.
    public let relayUrl: String?
    /// base64url, as pinned at pairing.
    public let agentKey: String
    /// This device's secret key for the cluster, base64url (the app keeps it in its secure storage too).
    public let deviceKey: String

    public init(id: String, url: String, relayUrl: String?, agentKey: String, deviceKey: String) {
        self.id = id
        self.url = url
        self.relayUrl = relayUrl
        self.agentKey = agentKey
        self.deviceKey = deviceKey
    }
}

/// The background refresh as the app set it: how often, in which language, which clusters.
public struct RefreshSettings: Codable, Equatable {
    public let interval: Int
    public let language: String?
    public let targets: [RefreshTarget]

    public init(interval: Int, language: String?, targets: [RefreshTarget]) {
        self.interval = interval
        self.language = language
        self.targets = targets
    }
}

/// The widget's background refresh (docs/ARCHITECTURE.md, Widgets), the iOS side of
/// WidgetRefresher.kt: asks every agent of the widget list for its status the way the
/// app's AgentClient does (direct first, the relay when the agent's own address does not
/// answer) and writes the answer into the widget's App Group. Read-only: GET /status.
public enum WidgetRefresh {
    /// Keep in step with WidgetData.swift (widget extension) and WidgetBridgePlugin.swift.
    public static let appGroup = "group.app.kubernanny"
    public static let listKey = "kubernanny.widget.clusters.v1"
    /// The keychain access group the app and the widget extension share (the App Group's id).
    public static let accessGroup = "group.app.kubernanny"
    static let service = "app.kubernanny.widget.refresh"
    static let account = "settings.v1"

    static let probeTimeout: TimeInterval = 3
    static let callTimeout: TimeInterval = 12

    // MARK: - Settings in the keychain

    /// The targets hold this device's secret key per cluster, so they live in the keychain
    /// (this device only, readable after the first unlock so the widget can refresh while
    /// the phone is locked), in the group the widget extension shares, never in UserDefaults.
    public static func store(_ settings: RefreshSettings) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup
        ]
        SecItemDelete(base as CFDictionary)
        guard settings.interval > 0, !settings.targets.isEmpty else {
            return true
        }
        guard let data = try? JSONEncoder().encode(settings) else { return false }
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecAttrSynchronizable as String] = false
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    public static func load() -> RefreshSettings? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(RefreshSettings.self, from: data)
    }

    // MARK: - One round

    /// Asks every target and writes what answered; true when the widget list changed.
    /// Each failure is that cluster's alone: it keeps its last state and greys out on its own.
    @discardableResult
    public static func refreshAll(session: URLSession = .shared) async -> Bool {
        guard let settings = load() else { return false }
        var changed = false
        await withTaskGroup(of: (String, [String: Any]?).self) { group in
            for target in settings.targets {
                group.addTask { (target.id, try? await status(target, language: settings.language, session: session)) }
            }
            for await (id, status) in group {
                guard let status, let defaults = UserDefaults(suiteName: appGroup) else { continue }
                if let next = WidgetSnapshot.merge(stored: defaults.string(forKey: listKey), clusterId: id, status: status) {
                    defaults.set(next, forKey: listKey)
                    changed = true
                }
            }
        }
        return changed
    }

    /// GET /status of one agent, opened and checked; nil when it was not a status.
    static func status(_ target: RefreshTarget, language: String?, session: URLSession) async throws -> [String: Any]? {
        guard
            let agentKey = AgentCall.fromBase64Url(target.agentKey), agentKey.count == 32,
            let deviceKey = AgentCall.fromBase64Url(target.deviceKey), deviceKey.count == 32
        else {
            return nil
        }
        let base = target.url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let direct = "\(base)/api/e2e"
        let viaRelay = usableRelay(target.relayUrl).map { "\($0)/v1/agents/\(AgentCall.relayAgentId(agentPublic: agentKey))/e2e" }
        // Like the app: a quick look at the agent's own address decides; a slow answer is not an unreachable agent.
        var endpoints = [direct]
        if let viaRelay {
            endpoints = await probe("\(base)/healthz", session: session) ? [direct, viaRelay] : [viaRelay]
        }
        for endpoint in endpoints {
            let answer: AgentCall.Answer
            do {
                answer = try await call(endpoint, deviceKey: deviceKey, agentKey: agentKey, language: language, session: session)
            } catch is URLError {
                continue // never reached the agent: the next path, if any
            }
            guard answer.status == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: answer.body) as? [String: Any]
        }
        return nil
    }

    /// One sealed request, sent again once with the agent's clock when it says ours is off (E2E_CLOCK_SKEW).
    static func call(_ endpoint: String, deviceKey: Data, agentKey: Data, language: String?, session: URLSession) async throws -> AgentCall.Answer {
        guard let url = URL(string: endpoint) else { throw URLError(.badURL) }
        var offset: Double = 0
        for attempt in 0..<2 {
            let now = Date().timeIntervalSince1970 * 1000
            let sealed = try AgentCall.seal(
                deviceSecret: deviceKey,
                agentPublic: agentKey,
                requestJson: try AgentCall.requestJson(path: "/status", time: now + offset, language: language)
            )
            var request = URLRequest(url: url, timeoutInterval: callTimeout)
            request.httpMethod = "POST"
            request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
            request.httpBody = sealed.body
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                // A relay or proxy answered instead of the agent (502 to 504), or nothing usable came back.
                throw URLError(.badServerResponse)
            }
            let answer = try sealed.open(data)
            let skew = answer.status == 401
                && ((try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any])?["code"] as? String) == "E2E_CLOCK_SKEW"
            if attempt == 0 && skew {
                offset = answer.time - (now + Date().timeIntervalSince1970 * 1000) / 2
                continue
            }
            return answer
        }
        throw URLError(.cannotConnectToHost)
    }

    static func probe(_ url: String, session: URLSession) async -> Bool {
        guard let u = URL(string: url) else { return false }
        let request = URLRequest(url: u, timeoutInterval: probeTimeout)
        guard let (_, response) = try? await session.data(for: request) else { return false }
        return (200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    /// https, or plain http to this machine only (usableRelay in the app).
    public static func usableRelay(_ url: String?) -> String? {
        guard let url, let u = URL(string: url), let scheme = u.scheme else { return nil }
        let local = ["localhost", "127.0.0.1", "::1"].contains(u.host ?? "")
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        var out = url
        while out.hasSuffix("/") { out.removeLast() }
        return out
    }
}

/// Turns an agent's status (GET /status, the app's Snapshot) into the widget's entry for that
/// cluster, as the app does (widgetCluster in app/src/app/core/widget/widget-summary.ts), and
/// WidgetSnapshot.kt on Android: open outages and warnings counted like the headline (silenced
/// ones and hints left out), the three worst problems, outages first. Only an entry the app
/// stored, keeping its name and demo flag, and only a check newer than the stored one.
public enum WidgetSnapshot {
    static let lights: Set<String> = ["green", "yellow", "red", "unknown"]

    public static func merge(stored json: String?, clusterId: String, status: [String: Any]) -> String? {
        guard
            let json, let data = json.data(using: .utf8),
            var list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
            let index = list.firstIndex(where: { $0["id"] as? String == clusterId }),
            let light = status["light"] as? String, lights.contains(light),
            let checkedText = status["checkedAt"] as? String, let checkedAt = parseIso(checkedText),
            let issues = status["issues"] as? [[String: Any]]
        else {
            return nil
        }
        if let before = (list[index]["checkedAt"] as? String).flatMap(parseIso), before >= checkedAt {
            return nil
        }
        let counted = issues.filter { issue in
            let severity = issue["severity"] as? String
            let silenced = issue["silencedUntil"].map { !($0 is NSNull) } ?? false
            return (severity == "critical" || severity == "warning") && !silenced
        }
        let outages = counted.filter { $0["severity"] as? String == "critical" }
        let warnings = counted.filter { $0["severity"] as? String != "critical" }
        let problems: [[String: String]] = (outages + warnings).prefix(3).map {
            [
                "title": clip($0["title"] as? String ?? "", max: 120),
                "severity": $0["severity"] as? String == "critical" ? "critical" : "warning"
            ]
        }
        var entry = list[index]
        entry["light"] = light
        entry["critical"] = outages.count
        entry["warning"] = warnings.count
        entry["checkedAt"] = checkedText
        entry["problems"] = problems
        list[index] = entry
        guard let out = try? JSONSerialization.data(withJSONObject: list) else { return nil }
        return String(data: out, encoding: .utf8)
    }

    /// At most `max` characters as a person counts them (code points, like Array.from in the app), the last an ellipsis when cut.
    public static func clip(_ text: String, max: Int) -> String {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count > max else { return text }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars.prefix(max - 1))
        return String(out) + "…"
    }

    static func parseIso(_ text: String) -> Date? {
        isoWithFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
