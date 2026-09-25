// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenScreen",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "OpenScreenCore", targets: ["OpenScreenCore"]),
        .library(name: "CaptureKit", targets: ["CaptureKit"]),
        .library(name: "CursorKit", targets: ["CursorKit"]),
        .library(name: "RenderKit", targets: ["RenderKit"]),
        .library(name: "EditKit", targets: ["EditKit"]),
        .library(name: "ExportKit", targets: ["ExportKit"]),
        .library(name: "CaptionsKit", targets: ["CaptionsKit"]),
        .library(name: "AppFeature", targets: ["AppFeature"]),
    ],
    targets: [
        .target(name: "OpenScreenCore"),
        .target(name: "CaptureKit", dependencies: ["OpenScreenCore"]),
        .target(name: "CursorKit", dependencies: ["OpenScreenCore"]),
        .target(name: "RenderKit", dependencies: ["OpenScreenCore", "CursorKit"]),
        .target(name: "EditKit", dependencies: ["OpenScreenCore"]),
        .target(name: "ExportKit", dependencies: ["OpenScreenCore", "RenderKit", "EditKit", "CursorKit"]),
        .target(name: "CaptionsKit", dependencies: ["OpenScreenCore"]),
        .target(
            name: "AppFeature",
            dependencies: [
                "OpenScreenCore", "CaptureKit", "CursorKit",
                "RenderKit", "EditKit", "ExportKit", "CaptionsKit",
            ]
        ),
        .testTarget(name: "OpenScreenCoreTests", dependencies: ["OpenScreenCore"]),
        .testTarget(name: "CursorKitTests", dependencies: ["CursorKit"]),
        .testTarget(name: "EditKitTests", dependencies: ["EditKit"]),
    ]
)
