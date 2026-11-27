// swift-tools-version:5.9
// NEBULA native VM helper — Apple Virtualization.framework, no Tart dependency.
import PackageDescription

let package = Package(
    name: "NebulaVM",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "nebula-vm", targets: ["NebulaVM"]),
    ],
    targets: [
        .target(
            name: "NebulaVMCore",
            path: "Sources/NebulaVMCore",
            swiftSettings: [.unsafeFlags(["-swift-version", "5"])]
        ),
        .executableTarget(
            name: "NebulaVM",
            dependencies: ["NebulaVMCore"],
            path: "Sources/NebulaVM",
            swiftSettings: [.unsafeFlags(["-swift-version", "5"])]
        ),
        .testTarget(
            name: "NebulaVMCoreTests",
            dependencies: ["NebulaVMCore"],
            path: "Tests/NebulaVMCoreTests",
            swiftSettings: [.unsafeFlags(["-swift-version", "5"])]
        ),
    ]
)
