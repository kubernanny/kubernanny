// swift-tools-version: 5.9
import PackageDescription

// The widget's own call to an agent (docs/ARCHITECTURE.md, Widgets): the app's
// end-to-end channel in Swift, read-only, for the background refresh. Plain
// Swift and CryptoKit, no Capacitor, so `swift test` runs it on a Mac against
// protocol/test/vectors.json. Used by the widget extension
// (app/ios/App/KubernannyWidget) and the WidgetBridge plugin, which stores the targets.
let package = Package(
    name: "KubernannyAgentCall",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "KubernannyAgentCall", targets: ["KubernannyAgentCall"])
    ],
    targets: [
        .target(name: "KubernannyAgentCall", path: "Sources/AgentCall"),
        .testTarget(name: "AgentCallTests", dependencies: ["KubernannyAgentCall"], path: "Tests/AgentCallTests")
    ]
)
