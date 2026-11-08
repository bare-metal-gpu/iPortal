// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "HelperCore", platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "HelperCore", targets: ["HelperCore"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.99.0"),
        .package(url: "https://github.com/apple/swift-nio-transport-services.git", exact: "1.28.0"),
    ],
    targets: [
        .target(
            name: "HelperCore",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOTransportServices", package: "swift-nio-transport-services"),
            ], path: ".",
            exclude: [
                "Tests", "Package.swift", "Info.plist", "AppleCompatibility.h",
                "AppleCompatibility.m",
                "Bridge.h", "Automation.swift", "Clipboard.swift", "ElementTypes.swift",
                "Inspection.swift", "Media.swift", "PortalStatus.h", "PortalStatus.m",
                "Runner.swift",
            ],
            sources: [
                "Protocol.swift", "Lifecycle.swift", "SelectorParser.swift", "Executor.swift",
                "Transport.swift",
            ]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"], path: "Tests"),
    ], swiftLanguageModes: [.v5])
