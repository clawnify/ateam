import XCTest
import Foundation
import NIOCore
import NIOPosix
@testable import AteamSSH

private final class HTTPReply: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var reply = context.channel.allocator.buffer(capacity: 128)
        reply.writeString("HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nssh-forward-ok")
        context.writeAndFlush(wrapOutboundOut(reply)).whenComplete { _ in context.close(promise: nil) }
    }
}

final class OpenSSHTests: XCTestCase {
    func testRealOpenSSH() async throws {
        // Explicit opt-in: creates a temporary loopback-only sshd with a temporary
        // authorized key; never touches the user's SSH configuration or keys.
        guard ProcessInfo.processInfo.environment["ATEAM_SSH_INTEGRATION"] == "1" else {
            throw XCTSkip("Run with ATEAM_SSH_INTEGRATION=1 on macOS with /usr/sbin/sshd")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ateam-ssh-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func run(_ executable: String, _ arguments: [String]) throws -> String {
            let p = Process(), pipe = Pipe()
            p.executableURL = URL(fileURLWithPath: executable); p.arguments = arguments
            p.standardOutput = pipe; p.standardError = pipe
            try p.run(); p.waitUntilExit()
            let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            guard p.terminationStatus == 0 else { throw SSHFailure(output) }
            return output
        }
        let keyFile = dir.appendingPathComponent("host").path
        _ = try run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile])
        let hostKey = try String(contentsOfFile: keyFile + ".pub", encoding: .utf8)
            .split(separator: " ").prefix(2).joined(separator: " ")
        let expectedFingerprint = try run("/usr/bin/ssh-keygen", ["-l", "-f", keyFile, "-E", "sha256"])
            .split(separator: " ")[1]
        XCTAssertEqual(try sshFingerprint(hostKey), String(expectedFingerprint))
        let seed = Data(repeating: 7, count: 32)
        let authorized = dir.appendingPathComponent("authorized_keys")
        try (sshPublicKey(seed: seed) + "\n").write(to: authorized, atomically: true, encoding: .utf8)
        let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        let reservation = try await ServerBootstrap(group: group).bind(host: "127.0.0.1", port: 0).get()
        let port = reservation.localAddress!.port!
        try await reservation.close().get()
        let config = dir.appendingPathComponent("sshd_config")
        try """
        Port \(port)
        ListenAddress 127.0.0.1
        HostKey \(keyFile)
        PidFile \(dir.path)/sshd.pid
        AuthorizedKeysFile \(authorized.path)
        StrictModes no
        PasswordAuthentication no
        KbdInteractiveAuthentication no
        UsePAM no
        AllowTcpForwarding yes
        AllowUsers \(NSUserName())
        LogLevel ERROR
        """.write(to: config, atomically: true, encoding: .utf8)
        let daemon = Process(), log = Pipe()
        daemon.executableURL = URL(fileURLWithPath: "/usr/sbin/sshd")
        daemon.arguments = ["-D", "-e", "-f", config.path]
        daemon.standardError = log
        try daemon.run()
        defer { if daemon.isRunning { daemon.terminate(); daemon.waitUntilExit() } }
        try await Task.sleep(nanoseconds: 300_000_000)
        guard daemon.isRunning else {
            throw SSHFailure(String(decoding: log.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
        }
        do {
            _ = try await SSHSession.open(host: "127.0.0.1", port: port, user: NSUserName(), credential: .key(seed), hostKey: nil)
            XCTFail("Unknown host must not authenticate")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SSH_HOST_KEY:")) }
        do {
            _ = try await SSHSession.open(host: "127.0.0.1", port: port, user: NSUserName(), credential: .key(Data(repeating: 9, count: 32)), hostKey: hostKey)
            XCTFail("Wrong client key must fail")
        } catch { XCTAssertFalse(error.localizedDescription.contains("SSH_HOST_KEY:")) }
        let session = try await SSHSession.open(host: "127.0.0.1", port: port, user: NSUserName(), credential: .key(seed), hostKey: hostKey)
        let result = try await session.exec("printf 'out'; printf 'err' >&2; exit 7")
        XCTAssertEqual(result.stdout, "out"); XCTAssertEqual(result.stderr, "err"); XCTAssertEqual(result.code, 7)
        let server = try await ServerBootstrap(group: group).childChannelInitializer {
            $0.pipeline.addHandler(HTTPReply())
        }.bind(host: "127.0.0.1", port: 0).get()
        let forwarded = try await session.forward(server.localAddress!.port!)
        let (body, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(forwarded)")!)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "ssh-forward-ok")
        let line = expectation(description: "UTF-8 split across packets is retained")
        let closed = expectation(description: "Remote exit closes the stream")
        try await session.attach(command: "printf '\\342'; sleep 0.1; printf '\\202\\254\\n'", onLine: {
            XCTAssertEqual($0, "€"); line.fulfill()
        }, onClose: { _ in closed.fulfill() })
        await fulfillment(of: [line, closed], timeout: 5)
        await session.close()
        try await server.close().get()
        try await group.shutdownGracefully()
    }
}
