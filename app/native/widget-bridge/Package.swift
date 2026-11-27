// swift-tools-version: 5.9
import PackageDescription

// Picked up by `npx cap sync` like any npm Capacitor plugin: the CLI names
// the package after the npm name (@kubernanny/widget-bridge -> KubernannyWidgetBridge).
let package = Package(
    name: "KubernannyWidgetBridge",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "KubernannyWidgetBridge", targets: ["WidgetBridgePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // The background refresh's store and call, shared with the widget extension.
        .package(name: "KubernannyAgentCall", path: "../agent-call")
    ],
    targets: [
        .target(
            name: "WidgetBridgePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "KubernannyAgentCall", package: "KubernannyAgentCall")
            ],
            path: "ios/Sources/WidgetBridgePlugin"
        )
    ]
)
