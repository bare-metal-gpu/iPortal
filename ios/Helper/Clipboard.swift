import Foundation
import ImageIO
import UIKit
import XCTest

@MainActor final class HelperClipboard {
    private var lease: String?
    private var previous: XCUIApplication?
    private var expiry: Task<Void, Never>?
    private var pending: Task<Data?, Never>?
    private var result: Data?
    private var finished = false
    private var revision = 0
    private var format = ""
    private let foreground: () throws -> XCUIApplication
    init(foreground: @escaping () throws -> XCUIApplication) { self.foreground = foreground }
    private func failure(_ message: String) -> HelperFailure {
        .init("invalid element state", message)
    }
    func prepare() throws -> JSONValue {
        guard lease == nil, pending == nil else {
            throw failure("Finish the current clipboard transfer on your device first")
        }
        guard IPApple.locked()?.boolValue == false else {
            throw failure("Unlock your device to transfer the clipboard")
        }
        let app = try foreground()
        let own = Bundle.main.bundleIdentifier!
        previous = app.bundleIdentifier == own ? nil : app
        lease = UUID().uuidString
        expiry = Task {
            try? await Task.sleep(for: .seconds(25))
            if !Task.isCancelled { restore() }
        }
        do {
            if previous != nil { try IPApple.activate(XCUIApplication(bundleIdentifier: own)) }
        } catch {
            restore()
            throw error
        }
        return .object([
            "lease": .string(lease!), "helperBundleId": .string(own),
            "restoreBundleId": previous.map { .string($0.bundleIdentifier) } ?? .null,
        ])
    }
    func restore() {
        let app = previous
        previous = nil
        lease = nil
        result = nil
        finished = false
        expiry?.cancel()
        expiry = nil
        // A pending paste permission read cannot be cancelled by cancelling its
        // Task. Keep it owned until UIKit actually returns before admitting more.
        if let app, UIApplication.shared.applicationState == .active,
            IPApple.locked()?.boolValue == false {
            _ = try? withApple {
                if app.state.rawValue >= XCUIApplication.State.runningBackgroundSuspended.rawValue {
                    try IPApple.activate(app)
                }
            }
        }
    }
    private func scheduleRestore() {
        let completedLease = lease
        Task {
            if lease == completedLease { restore() }
        }
    }
    func transfer(_ operation: Operation, args: JSONValue) throws -> JSONValue {
        if operation == .clipboardStatus {
            try args.keys([])
            return .object(["changeCount": .number(Double(UIPasteboard.general.changeCount))])
        }
        guard try args.text("lease", max: 128) == lease else {
            throw failure("Clipboard transfer expired; try again")
        }
        if operation == .clipboardCancel || operation == .clipboardRestore {
            try args.keys(["lease"], required: ["lease"])
            restore()
            return .object(["cancelled": .bool(true)])
        }
        try args.keys(
            operation == .clipboardWrite ? ["lease", "format", "content"] : ["lease"],
            required: operation == .clipboardWrite ? ["lease", "format", "content"] : ["lease"])
        guard IPApple.locked()?.boolValue == false else {
            restore()
            throw failure("Unlock your device to transfer the clipboard")
        }
        guard UIApplication.shared.applicationState == .active else {
            return .object(["pending": .bool(true)])
        }
        let pb = UIPasteboard.general
        if operation == .clipboardWrite {
            let format = try args.text("format", max: 16)
            let content = try args.text("content", max: 5_592_408)
            guard let data = Data(base64Encoded: content), data.base64EncodedString() == content,
                !data.isEmpty, data.count <= 4 * 1024 * 1024
            else { throw failure("Invalid clipboard data") }
            let type: String
            let value: Any
            if format == "text" || format == "url" {
                guard data.count <= 1024 * 1024, let text = String(data: data, encoding: .utf8)
                else { throw failure("Invalid clipboard text") }
                if format == "url" {
                    guard let url = URL(string: text), url.scheme != nil else {
                        throw failure("Invalid clipboard URL")
                    }
                    type = "public.url"
                    value = url
                } else {
                    type = "public.utf8-plain-text"
                    value = text
                }
            } else if format == "image" {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                        as? [CFString: Any],
                    let width = properties[kCGImagePropertyPixelWidth] as? Double,
                    let height = properties[kCGImagePropertyPixelHeight] as? Double, width > 0,
                    height > 0, width * height <= 20_000_000,
                    let png = UIImage(data: data)?.pngData(), png.count <= 4 * 1024 * 1024
                else { throw failure("Unsupported clipboard image") }
                type = "public.png"
                value = png
            } else {
                throw failure("Unsupported clipboard content")
            }
            pb.setItems([[type: value]], options: [.localOnly: true])
            scheduleRestore()
            return .object(["format": .string(format), "bytes": .number(Double(data.count))])
        }
        if pending == nil && !finished {
            format = pb.hasImages ? "image" : pb.hasURLs ? "url" : pb.hasStrings ? "text" : ""
            if format.isEmpty {
                scheduleRestore()
                return .object(["empty": .bool(true)])
            }
            revision = pb.changeCount
            let readFormat = format
            let readLease = lease
            // Paste permission can synchronously wait inside UIKit. Run this read
            // off the main queue so its native permission sheet can be presented.
            let task = Task.detached { () -> Data? in
                let pasteboard = UIPasteboard.general
                if readFormat == "image" { return pasteboard.image?.pngData() }
                return (readFormat == "url" ? pasteboard.url?.absoluteString : pasteboard.string)?
                    .data(using: .utf8)
            }
            pending = task
            Task {
                let data = await task.value
                pending = nil
                if lease == readLease {
                    result = data
                    finished = true
                }
            }
        }
        if !finished { return .object(["pending": .bool(true)]) }
        defer {
            finished = false
            scheduleRestore()
        }
        guard revision == pb.changeCount else {
            throw failure("Device clipboard changed; try again")
        }
        guard let result, !result.isEmpty else {
            throw failure("Clipboard access was not allowed or the clipboard is empty")
        }
        guard result.count <= (format == "image" ? 4 * 1024 * 1024 : 1024 * 1024) else {
            throw failure("Clipboard is too large")
        }
        return .object([
            "format": .string(format), "content": .string(result.base64EncodedString()),
        ])
    }
}
