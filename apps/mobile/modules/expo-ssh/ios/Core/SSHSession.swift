import Foundation
import Crypto
import NIOCore
import NIOPosix
import NIOSSH

struct SSHFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

enum SSHCredential {
    case password(String)
    case key(Data)
}

func sshPublicKey(seed: Data) throws -> String {
    String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key:
        try Curve25519.Signing.PrivateKey(rawRepresentation: seed)).publicKey)
}

func sshFingerprint(_ key: String) throws -> String {
    let parts = key.split(separator: " ")
    guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else {
        throw SSHFailure("Invalid SSH host key")
    }
    return "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString()
        .replacingOccurrences(of: "=", with: "")
}

private final class HostTrust: NIOSSHClientServerAuthenticationDelegate {
    let expected: String?
    init(_ expected: String?) { self.expected = expected }
    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let actual = String(openSSHPublicKey: hostKey)
        if actual == expected {
            validationCompletePromise.succeed(())
        } else {
            // Discovery stops key exchange BEFORE user authentication. The app
            // must explicitly approve a first key; a changed pin is never replaced.
            validationCompletePromise.fail(SSHFailure("SSH_HOST_KEY:" + actual))
        }
    }
}

private final class UserAuth: NIOSSHClientUserAuthenticationDelegate {
    let username: String
    var credential: SSHCredential?
    init(_ username: String, _ credential: SSHCredential) {
        self.username = username
        self.credential = credential
    }
    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods,
                                nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard let credential else {
            nextChallengePromise.fail(SSHFailure("SSH authentication failed. Check the user and credential."))
            return
        }
        self.credential = nil
        do {
            let offer: NIOSSHUserAuthenticationOffer.Offer
            switch credential {
            case .password(let password):
                guard availableMethods.contains(.password) else {
                    throw SSHFailure("This server does not allow password authentication. Use an SSH key.")
                }
                offer = .password(.init(password: password))
            case .key(let seed):
                guard availableMethods.contains(.publicKey) else {
                    throw SSHFailure("This server does not allow SSH key authentication.")
                }
                offer = .privateKey(.init(privateKey: NIOSSHPrivateKey(ed25519Key:
                    try Curve25519.Signing.PrivateKey(rawRepresentation: seed))))
            }
            nextChallengePromise.succeed(.init(username: username, serviceName: "", offer: offer))
        } catch { nextChallengePromise.fail(error) }
    }
}

private final class ParentLifecycle: ChannelInboundHandler {
    typealias InboundIn = Any
    private var ready: EventLoopPromise<Void>?
    init(_ ready: EventLoopPromise<Void>) { self.ready = ready }
    func fail(_ error: Error) { ready?.fail(error); ready = nil }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is UserAuthSuccessEvent {
            ready?.succeed(()); ready = nil
        }
        context.fireUserInboundEventTriggered(event)
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) {
        fail(error)
        context.close(promise: nil)
    }
    func channelInactive(context: ChannelHandlerContext) {
        ready?.fail(SSHFailure("SSH connection closed before authentication")); ready = nil
        context.fireChannelInactive()
    }
}

struct SSHResult {
    let stdout: String
    let stderr: String
    let code: Int
}

private final class CommandHandler: ChannelDuplexHandler {
    typealias InboundIn = SSHChannelData
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = SSHChannelData
    let command: String
    let onLine: ((String) -> Void)?
    var ready: EventLoopPromise<Void>?
    var result: EventLoopPromise<SSHResult>?
    var stdout = Data(), stderr = Data()
    var pending = ByteBuffer()
    var exitCode: Int?

    init(_ command: String, ready: EventLoopPromise<Void>, result: EventLoopPromise<SSHResult>,
         onLine: ((String) -> Void)?) {
        self.command = command; self.ready = ready; self.result = result; self.onLine = onLine
    }
    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true))
            .whenFailure { error in context.fireErrorCaught(error) }
    }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        switch event {
        case is ChannelSuccessEvent: ready?.succeed(()); ready = nil
        case is ChannelFailureEvent: fail(SSHFailure("SSH server refused the command"), context)
        case let status as SSHChannelRequestEvent.ExitStatus: exitCode = status.exitStatus
        case is SSHChannelRequestEvent.ExitSignal: exitCode = 255
        default: context.fireUserInboundEventTriggered(event)
        }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let packet = unwrapInboundIn(data)
        guard case .byteBuffer(var bytes) = packet.data else { return }
        if packet.type == .stdErr {
            // Stderr is never part of the JSON protocol.
            stderr.append(contentsOf: bytes.readableBytesView.prefix(max(0, 16384 - stderr.count)))
        } else if packet.type == .channel {
            if let onLine {
                pending.writeBuffer(&bytes)
                while let newline = pending.readableBytesView.firstIndex(of: 10) {
                    let length = newline - pending.readerIndex
                    guard length <= 16 * 1024 * 1024,
                          let line = pending.readString(length: length) else {
                        fail(SSHFailure("Invalid SSH protocol frame"), context); return
                    }
                    pending.moveReaderIndex(forwardBy: 1)
                    if !line.isEmpty { onLine(line) }
                }
                if pending.readableBytes > 16 * 1024 * 1024 {
                    fail(SSHFailure("SSH protocol frame is too large"), context)
                } else { pending.discardReadBytes() }
            } else {
                guard stdout.count + bytes.readableBytes <= 1024 * 1024 else {
                    fail(SSHFailure("SSH command output is too large"), context); return
                }
                stdout.append(contentsOf: bytes.readableBytesView)
            }
        }
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        context.write(wrapOutboundOut(SSHChannelData(type: .channel,
            data: .byteBuffer(unwrapOutboundIn(data)))), promise: promise)
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(error, context) }
    private func fail(_ error: Error, _ context: ChannelHandlerContext) {
        ready?.fail(error); ready = nil
        result?.fail(error); result = nil
        context.close(promise: nil)
    }
    func channelInactive(context: ChannelHandlerContext) {
        ready?.fail(SSHFailure("SSH command closed before starting")); ready = nil
        if let exitCode {
            result?.succeed(SSHResult(stdout: String(decoding: stdout, as: UTF8.self),
                stderr: String(decoding: stderr, as: UTF8.self), code: exitCode))
        } else { result?.fail(SSHFailure("SSH connection lost")) }
        result = nil
        context.fireChannelInactive()
    }
}

actor SSHSession {
    private static let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    let parent: Channel
    private var stream: Channel?
    private var listeners: [Int: Channel] = [:]
    private var closed = false
    private init(_ parent: Channel) { self.parent = parent }

    static func open(host: String, port: Int, user: String, credential: SSHCredential,
                     hostKey: String?) async throws -> SSHSession {
        let loop = group.next()
        let ready = loop.makePromise(of: Void.self)
        let lifecycle = ParentLifecycle(ready)
        let connecting = ClientBootstrap(group: loop)
            .connectTimeout(.seconds(15))
            .channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    try channel.pipeline.syncOperations.addHandlers(NIOSSHHandler(role: .client(.init(
                        userAuthDelegate: UserAuth(user, credential), serverAuthDelegate: HostTrust(hostKey))),
                        allocator: channel.allocator, inboundChildChannelInitializer: nil), lifecycle)
                }
            }.connect(host: host, port: port)
        connecting.whenFailure { lifecycle.fail($0) }
        let parent = try await connecting.get()
        let timeout = loop.scheduleTask(in: .seconds(15)) { parent.close(promise: nil) }
        do {
            try await ready.futureResult.get()
            timeout.cancel()
            return SSHSession(parent)
        } catch {
            timeout.cancel(); try? await parent.close().get(); throw error
        }
    }

    private func start(_ command: String, onLine: ((String) -> Void)? = nil)
        async throws -> (Channel, EventLoopFuture<SSHResult>) {
        guard !closed else { throw SSHFailure("SSH connection is closed") }
        let ready = parent.eventLoop.makePromise(of: Void.self)
        let result = parent.eventLoop.makePromise(of: SSHResult.self)
        // Observe failures even if exec readiness fails first.
        result.futureResult.whenFailure { _ in }
        // A silent server can stall channel creation as well as exec acceptance.
        // Close the parent on that deadline so NIOSSH fails all outstanding opens.
        let timer = parent.eventLoop.scheduleTask(in: .seconds(15)) { self.parent.close(promise: nil) }
        defer { timer.cancel() }
        let opening = parent.pipeline.handler(type: NIOSSHHandler.self).flatMap { ssh in
            let promise = self.parent.eventLoop.makePromise(of: Channel.self)
            ssh.createChannel(promise) { child, _ in
                child.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).flatMap {
                    child.pipeline.addHandler(CommandHandler(command, ready: ready, result: result, onLine: onLine))
                }
            }
            return promise.futureResult
        }
        opening.whenFailure { error in ready.fail(error); result.fail(error) }
        let child = try await opening.get()
        do { try await ready.futureResult.get(); return (child, result.futureResult) }
        catch { try? await child.close().get(); throw error }
    }

    func exec(_ command: String) async throws -> SSHResult {
        let (child, result) = try await start(command)
        let timer = child.eventLoop.scheduleTask(in: .seconds(30)) { child.close(promise: nil) }
        defer { timer.cancel() }
        return try await result.get()
    }

    func attach(command: String = "bash -lc 'exec ateam attach --stdio'",
                onLine: @escaping (String) -> Void, onClose: @escaping (String) -> Void) async throws {
        let (child, result) = try await start(command, onLine: onLine)
        if closed { try? await child.close().get(); throw SSHFailure("SSH connection is closed") }
        stream = child
        result.whenComplete { result in
            switch result {
            case .success(let r): onClose(r.stderr.isEmpty ? "SSH connection closed" : r.stderr)
            case .failure(let e): onClose(e.localizedDescription)
            }
        }
    }

    func write(_ line: String) async throws {
        guard !closed, let stream, stream.isActive else { throw SSHFailure("SSH connection is closed") }
        guard line.utf8.count <= 16 * 1024 * 1024 else { throw SSHFailure("SSH frame is too large") }
        var buffer = stream.allocator.buffer(capacity: line.utf8.count + 1)
        buffer.writeString(line); buffer.writeInteger(UInt8(10))
        try await stream.writeAndFlush(buffer).get()
    }

    func forward(_ port: Int) async throws -> Int {
        guard !closed, (1...65535).contains(port) else { throw SSHFailure("Invalid forwarding port") }
        if let existing = listeners[port]?.localAddress?.port { return existing }
        let parent = self.parent
        let listener = try await ServerBootstrap(group: parent.eventLoop)
            .childChannelOption(ChannelOptions.allowRemoteHalfClosure, value: true)
            .childChannelInitializer { local in
                // GlueHandler requires both pipelines on the same event loop.
                parent.closeFuture.whenComplete { _ in local.close(promise: nil) }
                return parent.pipeline.handler(type: NIOSSHHandler.self).flatMap { ssh in
                    let promise = parent.eventLoop.makePromise(of: Channel.self)
                    let destination = SSHChannelType.DirectTCPIP(targetHost: "127.0.0.1",
                        targetPort: port, originatorAddress: local.remoteAddress!)
                    ssh.createChannel(promise, channelType: .directTCPIP(destination)) { remote, _ in
                        remote.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).flatMap {
                            let (a, b) = GlueHandler.matchedPair()
                            return remote.pipeline.addHandlers(SSHWrapperHandler(), a).flatMap {
                                local.pipeline.addHandler(b)
                            }
                        }
                    }
                    return promise.futureResult.map { _ in () }
                }
            }.bind(host: "127.0.0.1", port: 0).get()
        parent.closeFuture.whenComplete { _ in listener.close(promise: nil) }
        if closed { try? await listener.close().get(); throw SSHFailure("SSH connection is closed") }
        if let existing = listeners[port]?.localAddress?.port {
            try? await listener.close().get(); return existing
        }
        listeners[port] = listener
        return listener.localAddress!.port!
    }

    func close() async {
        closed = true
        for listener in listeners.values { try? await listener.close().get() }
        listeners.removeAll()
        try? await parent.close().get()
    }
}
