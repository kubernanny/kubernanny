import Capacitor
import Foundation
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
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise)
    ]

    /// Keep in step with `WidgetData.swift` in the widget extension.
    static let appGroup = "group.app.kubernanny"
    static let key = "kubernanny.widget.clusters.v1"
    static let widgetKind = "KubernannyClusters"

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
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
        call.resolve()
    }
}
