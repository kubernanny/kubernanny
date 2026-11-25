import Capacitor
import FirebaseCore
import FirebaseMessaging
import Foundation
import Security
import UIKit
import UserNotifications

/// Native push for the app (app/src/app/core/push/): whether this build can
/// do it, the notification permission, the FCM token and the per-cluster
/// push keys.
///
/// The push keys go into a keychain item of the access group
/// `group.app.kubernanny.push` (an App Group used as keychain access group),
/// which the Notification Service Extension (ios/App/KubernannyPushExtension)
/// shares: it opens each push while the app is not running. The device keys
/// of @aparajita/capacitor-secure-storage stay in the app's own group; the
/// extension never sees them (decisions/0007-native-push.md).
///
/// Without GoogleService-Info.plist in the app bundle Firebase is never
/// configured and `isAvailable` says no: the app then hides push entirely.
@objc(KubernannyPushPlugin)
public class KubernannyPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KubernannyPushPlugin"
    public let jsName = "KubernannyPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeKey", returnType: CAPPluginReturnPromise)
    ]

    /// Keep in step with `PushKeys.swift` in the extension.
    static let accessGroup = "group.app.kubernanny.push"
    static let service = "app.kubernanny.push"

    public override func load() {
        if FirebaseApp.app() == nil, Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
        }
    }

    private var available: Bool { FirebaseApp.app() != nil }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": available, "platform": "ios"])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
            call.resolve(["granted": granted])
        }
    }

    /// The FCM token needs the APNs token first, which arrives shortly after registerForRemoteNotifications: a few tries.
    @objc func getToken(_ call: CAPPluginCall) {
        guard available else {
            call.reject("Firebase is not configured in this build")
            return
        }
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        fetchToken(call, attempt: 0)
    }

    private func fetchToken(_ call: CAPPluginCall, attempt: Int) {
        Messaging.messaging().token { token, _ in
            if let token = token, !token.isEmpty {
                call.resolve(["token": token])
            } else if attempt < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.fetchToken(call, attempt: attempt + 1) }
            } else {
                call.reject("no FCM token")
            }
        }
    }

    @objc func storeKey(_ call: CAPPluginCall) {
        guard
            let kid = call.getString("kid"),
            let secretKey = call.getString("secretKey"),
            let publicKey = call.getString("publicKey"),
            let agentKey = call.getString("agentKey"),
            let clusterId = call.getString("clusterId"),
            let value = try? JSONSerialization.data(withJSONObject: ["s": secretKey, "p": publicKey, "a": agentKey, "c": clusterId])
        else {
            call.reject("kid, secretKey, publicKey, agentKey and clusterId are required")
            return
        }
        SecItemDelete(query(kid) as CFDictionary)
        var add = query(kid)
        add[kSecValueData as String] = value
        // The extension runs while the phone is locked; after the first unlock is the tightest class that allows it. Never synced, never restored elsewhere.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("cannot store the push key (\(status)); is the keychain group \(Self.accessGroup) in the entitlements?")
        }
    }

    @objc func removeKey(_ call: CAPPluginCall) {
        if let kid = call.getString("kid") {
            SecItemDelete(query(kid) as CFDictionary)
        }
        call.resolve()
    }

    private func query(_ kid: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: kid,
            kSecAttrAccessGroup as String: Self.accessGroup,
            kSecAttrSynchronizable as String: false
        ]
    }
}
