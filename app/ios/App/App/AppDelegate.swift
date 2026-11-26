import UIKit
import Capacitor
import WidgetKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    /// The hourly status push for the home-screen widget, a background push
    /// (`content-available`, no alert; docs/NOTIFICATIONS.md, "The home-screen
    /// widget"). Opened natively with the push key, like the extension does,
    /// written into the widget's App Group and the widgets redrawn, without the
    /// WebView. iOS decides whether and when it arrives: throttled, and never
    /// for an app the person force-quit. Alerts are not handled here: the
    /// Notification Service Extension opens those.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        let changed = StatusPush.handle(userInfo: userInfo, now: Date().timeIntervalSince1970 * 1000)
        if changed {
            WidgetCenter.shared.reloadAllTimelines()
        }
        completionHandler(changed ? .newData : .noData)
    }
}
