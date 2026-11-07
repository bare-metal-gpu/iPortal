import XCTest

@testable import HelperCore

@MainActor private final class VideoProbe: HelperVideoSource {
    var captures = 0
    func frame() -> HelperVideoFrame? {
        captures += 1
        return nil
    }
}

final class TransportTests: XCTestCase {
    @MainActor func testAuthenticationPrecedesCaptureAndExecution() async throws {
        let state = HelperStatus()
        let video = VideoProbe()
        var commands = 0
        let executor = HelperExecutor(status: state) { _ in
            commands += 1
            return .null
        }
        let server = HelperHTTPServer(status: state, executor: executor, media: video)
        let token = String(repeating: "a", count: 64)
        try await server.start(host: "127.0.0.1", token: token, port: 0)
        let port = try XCTUnwrap(server.port)
        for path in ["/v1/status", "/v1/commands", "/v1/video"] {
            let (_, response) = try await URLSession.shared.data(
                from: URL(string: "http://127.0.0.1:\(port)\(path)")!)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
        }
        XCTAssertEqual(video.captures, 0)
        XCTAssertEqual(commands, 0)
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/status")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(
            try JSONDecoder().decode(JSONValue.self, from: data)["generation"],
            .string(state.generation))
        request.setValue("null", forHTTPHeaderField: "origin")
        let (_, browser) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((browser as? HTTPURLResponse)?.statusCode, 401)
        await server.stop()
    }
    @MainActor func testMalformedCommandsNeverReachExecutor() async throws {
        let state = HelperStatus()
        let video = VideoProbe()
        var commands = 0
        let executor = HelperExecutor(status: state) { _ in
            commands += 1
            return .null
        }
        let server = HelperHTTPServer(status: state, executor: executor, media: video)
        let token = String(repeating: "b", count: 64)
        try await server.start(host: "127.0.0.1", token: token, port: 0)
        let port = try XCTUnwrap(server.port)
        for body in ["{}", "{invalid", "[]"] {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/commands")!)
            request.httpMethod = "POST"
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 400)
        }
        XCTAssertEqual(commands, 0)
        await server.stop()
    }
}
