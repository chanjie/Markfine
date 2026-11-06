// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Markfine",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Markfine", targets: ["Markfine"])
    ],
    targets: [
        .target(
            name: "MarkfineCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "Markfine",
            dependencies: ["MarkfineCore"],
            path: "Sources/Markfine",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
