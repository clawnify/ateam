// swift-tools-version:6.1
import PackageDescription

// Also builds the transport on macOS so the OpenSSH integration harness exercises
// the exact core compiled into the Expo module.
let package = Package(
    name: "AteamSSH",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [.library(name: "AteamSSH", targets: ["AteamSSH"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio-ssh.git", exact: "0.15.1"),
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.105.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", exact: "5.1.1"),
    ],
    targets: [
        .target(name: "AteamSSH", dependencies: [
            .product(name: "NIOSSH", package: "swift-nio-ssh"),
            .product(name: "NIOPosix", package: "swift-nio"),
            .product(name: "Crypto", package: "swift-crypto"),
        ], path: "ios/Core", exclude: ["NIOSSH-LICENSE.txt"]),
        .testTarget(name: "AteamSSHTests", dependencies: ["AteamSSH",
            .product(name: "NIOPosix", package: "swift-nio")], path: "Tests"),
    ],
    swiftLanguageModes: [.v5]
)
