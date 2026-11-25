// swift-tools-version: 5.9
import PackageDescription

// Picked up by `npx cap sync` like any npm Capacitor plugin: the CLI names
// the package after the npm name (@kubernanny/push-native -> KubernannyPushNative).
let package = Package(
    name: "KubernannyPushNative",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "KubernannyPushNative", targets: ["KubernannyPushPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // Messaging only. Without GoogleService-Info.plist in the app the plugin never configures Firebase and reports push as unavailable.
        .package(url: "https://github.com/firebase/firebase-ios-sdk.git", from: "12.0.0")
    ],
    targets: [
        .target(
            name: "KubernannyPushPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "FirebaseMessaging", package: "firebase-ios-sdk")
            ],
            path: "ios/Sources/KubernannyPushPlugin"
        )
    ]
)
