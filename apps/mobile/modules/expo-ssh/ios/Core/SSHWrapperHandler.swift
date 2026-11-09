import NIOCore
import NIOSSH

final class SSHWrapperHandler: ChannelDuplexHandler {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = SSHChannelData
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let packet = unwrapInboundIn(data)
        guard packet.type == .channel, case .byteBuffer(let buffer) = packet.data else {
            context.close(promise: nil); return
        }
        context.fireChannelRead(wrapInboundOut(buffer))
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        context.write(wrapOutboundOut(SSHChannelData(type: .channel,
            data: .byteBuffer(unwrapOutboundIn(data)))), promise: promise)
    }
}
