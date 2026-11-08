import Foundation
import NIOCore
import NIOHTTP1
import NIOTransportServices

struct HelperVideoFrame {
    let sequence: UInt64
    let data: Data
}
@MainActor protocol HelperVideoSource { func frame() async -> HelperVideoFrame? }

private final class HelperConnections {
    private let lock = NSLock()
    private var channels: [ObjectIdentifier: Channel] = [:]
    func add(_ channel: Channel) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard channels.count < 16 else { return false }
        channels[ObjectIdentifier(channel)] = channel
        return true
    }
    func remove(_ channel: Channel) {
        lock.lock()
        channels.removeValue(forKey: ObjectIdentifier(channel))
        lock.unlock()
    }
    func all() -> [Channel] {
        lock.lock()
        defer { lock.unlock() }
        return Array(channels.values)
    }
}

final class HelperHTTPServer {
    let status: HelperStatus
    let executor: HelperExecutor
    let media: any HelperVideoSource
    private let group = NIOTSEventLoopGroup(loopCount: 2)
    private var channel: Channel?
    private let connections = HelperConnections()
    init(status: HelperStatus, executor: HelperExecutor, media: any HelperVideoSource) {
        self.status = status
        self.executor = executor
        self.media = media
    }
    func start(host: String, token: String, port: Int = 8100) async throws {
        guard HelperProtocol.authorized([("authorization", "Bearer \(token)")], token: token) else {
            throw HelperFailure("authentication", "Missing helper credential")
        }
        channel = try await NIOTSListenerBootstrap(group: group)
            .childChannelInitializer { channel in
                guard self.connections.add(channel) else { return channel.close() }
                channel.closeFuture.whenComplete { _ in self.connections.remove(channel) }
                return channel.pipeline.configureHTTPServerPipeline(withErrorHandling: true).flatMap
                {
                    channel.pipeline.addHandler(
                        HelperHTTPHandler(
                            token: token, status: self.status, executor: self.executor,
                            media: self.media))
                }
            }.bind(host: host, port: port).get()
    }
    var port: Int? { channel?.localAddress?.port }
    func stop() async {
        await executor.shutdown()
        try? await channel?.close().get()
        for child in connections.all() { try? await child.close().get() }
        try? await group.shutdownGracefully()
    }
}

private final class HelperHTTPHandler: ChannelInboundHandler {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart
    let token: String, status: HelperStatus, executor: HelperExecutor, media: any HelperVideoSource
    private var head: HTTPRequestHead?
    private var data = Data()
    private var rejected = false
    private var busy = false
    private var commandID: String?
    private var commandPermit: DispatchPermit?
    private var timer: RepeatedTask?
    private var deadline: Scheduled<Void>?
    private var videoPending = false
    private var lastVideoSequence: UInt64?
    private var observation: UUID?
    init(
        token: String, status: HelperStatus, executor: HelperExecutor, media: any HelperVideoSource
    ) {
        self.token = token
        self.status = status
        self.executor = executor
        self.media = media
    }
    func handlerAdded(context: ChannelHandlerContext) {
        deadline = context.eventLoop.scheduleTask(in: .seconds(5)) { context.close(promise: nil) }
    }
    func channelRead(context: ChannelHandlerContext, data incoming: NIOAny) {
        guard !rejected else { return }
        switch unwrapInboundIn(incoming) {
        case .head(let request):
            guard !busy, head == nil else {
                reject(context, .badRequest)
                return
            }
            guard
                request.headers.reduce(0, { $0 + $1.name.utf8.count + $1.value.utf8.count })
                    <= 16384
            else {
                reject(context, .requestHeaderFieldsTooLarge)
                return
            }
            guard
                HelperProtocol.authorized(request.headers.map { ($0.name, $0.value) }, token: token)
            else {
                reject(context, .unauthorized)
                return
            }
            guard request.headers["content-length"].count <= 1,
                request.headers["transfer-encoding"].isEmpty
            else {
                reject(context, .badRequest)
                return
            }
            head = request
        case .body(var buffer):
            guard head != nil, self.data.count + buffer.readableBytes <= 6 * 1024 * 1024 else {
                reject(context, .payloadTooLarge)
                return
            }
            self.data.append(contentsOf: buffer.readBytes(length: buffer.readableBytes) ?? [])
        case .end:
            deadline?.cancel()
            deadline = nil
            guard let request = head else {
                reject(context, .badRequest)
                return
            }
            head = nil
            busy = true
            switch (request.method, request.uri) {
            case (.GET, "/v1/status"):
                guard data.isEmpty else {
                    reject(context, .badRequest)
                    return
                }
                respond(context, status.snapshot())
            case (.POST, "/v1/commands"):
                guard
                    request.headers.first(name: "content-type")?.split(separator: ";").first
                        == "application/json"
                else {
                    reject(context, .unsupportedMediaType)
                    return
                }
                do {
                    let command = try HelperCommand.decode(data)
                    let permit = DispatchPermit(budgetMs: command.budgetMs)
                    commandID = command.id
                    commandPermit = permit
                    data.removeAll(keepingCapacity: true)
                    Task {
                        let reply = await executor.submit(command, permit: permit)
                        context.eventLoop.execute {
                            self.commandID = nil
                            self.commandPermit = nil
                            guard context.channel.isActive else { return }
                            self.respond(context, reply)
                        }
                    }
                } catch {
                    respond(context, HelperFailure.invalid("Invalid command"), code: .badRequest)
                }
            case (.GET, "/v1/events"):
                guard data.isEmpty else {
                    reject(context, .badRequest)
                    return
                }
                stream(context, video: false)
            case (.GET, "/v1/video"):
                guard data.isEmpty else {
                    reject(context, .badRequest)
                    return
                }
                stream(context, video: true)
            default: reject(context, .notFound)
            }
        }
    }
    private func respond<T: Encodable>(
        _ context: ChannelHandlerContext, _ value: T, code: HTTPResponseStatus = .ok
    ) {
        guard let bytes = try? JSONEncoder().encode(value) else {
            reject(context, .internalServerError)
            return
        }
        let headers = HTTPHeaders([
            ("content-type", "application/json"), ("content-length", String(bytes.count)),
            ("cache-control", "no-store"), ("x-iportal-helper-auth", "1"),
        ])
        context.write(
            wrapOutboundOut(.head(.init(version: .http1_1, status: code, headers: headers))),
            promise: nil)
        context.write(
            wrapOutboundOut(.body(.byteBuffer(context.channel.allocator.buffer(bytes: bytes)))),
            promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
        data.removeAll(keepingCapacity: true)
        busy = false
        deadline = context.eventLoop.scheduleTask(in: .seconds(15)) { context.close(promise: nil) }
    }
    private func reject(_ context: ChannelHandlerContext, _ code: HTTPResponseStatus) {
        rejected = true
        context.write(
            wrapOutboundOut(
                .head(
                    .init(
                        version: .http1_1, status: code,
                        headers: ["content-length": "0", "connection": "close"]))), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil))).whenComplete { _ in
            context.close(promise: nil)
        }
    }
    private func stream(_ context: ChannelHandlerContext, video: Bool) {
        let headers: HTTPHeaders = [
            "content-type": video
                ? "multipart/x-mixed-replace; boundary=frame" : "text/event-stream",
            "cache-control": "no-store", "x-iportal-helper-auth": "1",
        ]
        context.writeAndFlush(
            wrapOutboundOut(.head(.init(version: .http1_1, status: .ok, headers: headers))),
            promise: nil)
        if !video {
            observation = status.observe { value in
                context.eventLoop.execute { self.event(context, value) }
            }
        }
        timer = context.eventLoop.scheduleRepeatedTask(
            initialDelay: .zero, delay: video ? .milliseconds(16) : .seconds(1)
        ) { _ in
            guard context.channel.isActive, context.channel.isWritable else { return }
            if video {
                guard !self.videoPending else { return }
                self.videoPending = true
                Task {
                    let frame = await self.media.frame()
                    context.eventLoop.execute {
                        self.videoPending = false
                        guard context.channel.isActive, context.channel.isWritable, let frame,
                            frame.sequence != self.lastVideoSequence
                        else {
                            return
                        }
                        var bytes = Data(
                            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(frame.data.count)\r\n\r\n"
                                .utf8)
                        self.lastVideoSequence = frame.sequence
                        bytes.append(frame.data)
                        bytes.append(Data("\r\n".utf8))
                        context.writeAndFlush(
                            self.wrapOutboundOut(
                                .body(.byteBuffer(context.channel.allocator.buffer(bytes: bytes)))),
                            promise: nil)
                    }
                }
            } else {
                self.event(context, self.status.snapshot())
            }
        }
    }
    private func event(_ context: ChannelHandlerContext, _ value: JSONValue) {
        guard context.channel.isActive, context.channel.isWritable,
            let data = try? JSONEncoder().encode(value),
            let json = String(data: data, encoding: .utf8)
        else { return }
        context.writeAndFlush(
            wrapOutboundOut(
                .body(
                    .byteBuffer(
                        context.channel.allocator.buffer(string: "event: status\ndata: \(json)\n\n")
                    ))), promise: nil)
    }
    func channelInactive(context: ChannelHandlerContext) {
        timer?.cancel()
        deadline?.cancel()
        if let observation { status.removeObserver(observation) }
        commandPermit?.cancel(.init("cancelled", "Client disconnected before dispatch"))
        if let commandID { Task { await executor.cancel(commandID) } }
        context.fireChannelInactive()
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { context.close(promise: nil) }
}
