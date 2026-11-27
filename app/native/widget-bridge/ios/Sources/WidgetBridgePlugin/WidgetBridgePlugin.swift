import Capacitor
import Foundation
import KubernannyAgentCall
import WidgetKit

/// Hands the home-screen widget its short list of clusters.
///
/// The app writes the list (built and checked in app/src/app/core/widget/) as
/// one JSON string into the App Group's UserDefaults, which the widget
/// extension reads (app/ios/App/KubernannyWidget/). Nothing else is shared:
/// no address, no key, no issue text. Both the app and the extension need the
/// App Group capability `group.app.kubernanny` (docs/RELEASING.md, Widgets).
@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRefresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placed", returnType: CAPPluginReturnPromise)
    ]

    /// Keep in step with `WidgetData.swift` in the widget extension.
    static let appGroup = "group.app.kubernanny"
    static let key = "kubernanny.widget.clusters.v1"

    /// nil when the App Group is missing from the signing (a build without the capability).
    private var defaults: UserDefaults? { UserDefaults(suiteName: Self.appGroup) }

    @objc func read(_ call: CAPPluginCall) {
        guard
            let json = defaults?.string(forKey: Self.key),
            let data = json.data(using: .utf8),
            let clusters = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else {
            call.resolve(["clusters": []])
            return
        }
        call.resolve(["clusters": clusters])
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let defaults = defaults else {
            call.reject("App Group \(Self.appGroup) is not available")
            return
        }
        let clusters = call.getArray("clusters") ?? []
        if clusters.isEmpty {
            // Off, or nothing to show: remove the key rather than keep an empty value around.
            defaults.removeObject(forKey: Self.key)
        } else {
            guard
                JSONSerialization.isValidJSONObject(clusters),
                let data = try? JSONSerialization.data(withJSONObject: clusters),
                let json = String(data: data, encoding: .utf8)
            else {
                call.reject("Invalid widget data")
                return
            }
            defaults.set(json, forKey: Self.key)
        }
        // Every kind reads this key (the overview and the one-cluster widget),
        // so reload all of them, not only the overview.
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    /// How many widgets of the app are placed, of every kind (home screen, Lock Screen). Every kind shows
    /// every cluster of the list or the worst of them, so the app tells each agent of the list that a widget
    /// shows it (the silent hourly status pushes, docs/NOTIFICATIONS.md). Without this method the app took
    /// "none" and never asked for them on iOS.
    @objc func placed(_ call: CAPPluginCall) {
        WidgetCenter.shared.getCurrentConfigurations { result in
            switch result {
            case .success(let widgets):
                call.resolve(["count": widgets.count])
            case .failure:
                call.resolve(["count": 0])
            }
        }
    }

    /// The background refresh (KubernannyAgentCall, WidgetRefresh): how often (minutes, 0 off), in which
    /// language, and per cluster of the widget list what GET /status needs. Stored in the keychain group the
    /// widget extension shares (this device only); interval 0 or no targets removes it. The widgets reload,
    /// so their next timeline asks the agents and the refresh button changes with it.
    @objc func setRefresh(_ call: CAPPluginCall) {
        let minutes = call.getInt("intervalMinutes") ?? 0
        var targets: [RefreshTarget] = []
        for case let t as [String: Any] in call.getArray("targets") ?? [] {
            guard
                let id = t["id"] as? String, let url = t["url"] as? String,
                let agentKey = t["agentKey"] as? String, let deviceKey = t["deviceKey"] as? String
            else {
                call.reject("invalid refresh targets")
                return
            }
            targets.append(RefreshTarget(id: id, url: url, relayUrl: t["relayUrl"] as? String, agentKey: agentKey, deviceKey: deviceKey))
        }
        guard WidgetRefresh.store(RefreshSettings(interval: minutes, language: call.getString("language"), targets: targets)) else {
            call.reject("cannot store the refresh targets; is the keychain group \(WidgetRefresh.accessGroup) in the entitlements?")
            return
        }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["supported": true])
    }
}
