import Cocoa
import Combine

struct ClipboardTarget: Equatable {
    let port: Int
    let instance: String
    let device: String
    let generation: Int
    let epoch: Int
}

struct ClipboardPayload: Codable {
    let format: String
    let content: String
    static let limit = 4 * 1024 * 1024

    static func read(_ pasteboard: NSPasteboard) throws -> Self {
        if let data = pasteboard.data(forType: .png) { return try make("image", data) }
        if let data = pasteboard.data(forType: .tiff), let rep = NSBitmapImageRep(data: data),
           let png = rep.representation(using: .png, properties: [:]) { return try make("image", png) }
        if let url = pasteboard.string(forType: .URL) { return try make("url", Data(url.utf8)) }
        if let text = pasteboard.string(forType: .string), !text.isEmpty { return try make("text", Data(text.utf8)) }
        throw ClipboardFailure("Copy some text, a link, or an image first.")
    }
    static func make(_ format: String, _ data: Data) throws -> Self {
        let payload = Self(format: format, content: data.base64EncodedString())
        _ = try payload.item()
        return payload
    }
    func item() throws -> NSPasteboardItem {
        guard let data = Data(base64Encoded: content), !data.isEmpty,
              data.count <= (format == "image" ? Self.limit : 1024 * 1024) else {
            throw ClipboardFailure("Clipboard is empty or too large. Use up to 1 MB of text or a 4 MB image.")
        }
        let item = NSPasteboardItem()
        switch format {
        case "text", "url":
            guard let text = String(data: data, encoding: .utf8) else { throw ClipboardFailure("Clipboard text could not be read.") }
            item.setString(text, forType: .string)
            if format == "url" {
                guard URL(string: text)?.scheme != nil else { throw ClipboardFailure("Clipboard link could not be read.") }
                item.setString(text, forType: .URL)
            }
        case "image":
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
                  width > 0, height > 0, Double(width) * Double(height) <= 20_000_000 else {
                throw ClipboardFailure("Use an image smaller than 20 megapixels.")
            }
            item.setData(data, forType: .png)
        default: throw ClipboardFailure("This clipboard format isn’t supported.")
        }
        return item
    }
}

struct ClipboardFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

@MainActor
final class ClipboardBridge: ObservableObject {
    @Published private(set) var busy = false
    @Published var available = false
    @Published private(set) var message = "Text, links, and images."
    var target: () -> ClipboardTarget? = { nil }
    var reportError: (String) -> Void = { _ in }
    private var task: Task<Void, Never>?
    private let send: (URLRequest) async throws -> (Data, URLResponse)
    init(send: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.send = send
    }

    func cancel() { task?.cancel(); task = nil; available = false }
    func transfer(toDevice: Bool, pasteboard: NSPasteboard = .general) {
        guard !busy, let selected = target() else { return }
        let revision = pasteboard.changeCount
        var body: Data
        do { body = toDevice ? try JSONEncoder().encode(ClipboardPayload.read(pasteboard)) : Data("{}".utf8) }
        catch { fail(error.localizedDescription); return }
        busy = true
        message = "Transferring…"
        task = Task { [weak self] in
            guard let self else { return }
            defer { busy = false; task = nil }
            do {
                var request = URLRequest(url: URL(string: "http://127.0.0.1:\(selected.port)/api/clipboard-\(toDevice ? "write" : "read")")!)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue(selected.instance, forHTTPHeaderField: "x-iportal-instance")
                request.httpBody = body
                request.timeoutInterval = 30
                let (data, response) = try await send(request)
                try Task.checkCancellation()
                // An old response must never populate the Mac clipboard after a
                // detach/reconnect, server restart, or closing this device window.
                guard target() == selected else { throw ClipboardFailure("Connection changed. Try the transfer again.") }
                guard let response = response as? HTTPURLResponse,
                      response.value(forHTTPHeaderField: "x-iportal-instance") == selected.instance,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw ClipboardFailure("Clipboard transfer could not be confirmed.")
                }
                guard response.statusCode == 200, json["ok"] as? Bool == true else {
                    throw ClipboardFailure(json["error"] as? String ?? "Clipboard transfer failed.")
                }
                if !toDevice {
                    guard let value = json["value"] as? [String: Any], value["empty"] as? Bool != true else {
                        throw ClipboardFailure("The device clipboard is empty or contains an unsupported format.")
                    }
                    let payload = try JSONDecoder().decode(ClipboardPayload.self, from: JSONSerialization.data(withJSONObject: value))
                    let item = try payload.item()
                    guard pasteboard.changeCount == revision else {
                        throw ClipboardFailure("Your Mac clipboard changed during the transfer. Copy from the device again if needed.")
                    }
                    pasteboard.clearContents()
                    guard pasteboard.writeObjects([item]) else { throw ClipboardFailure("Couldn’t update the Mac clipboard.") }
                }
                message = toDevice ? "Copied to device." : "Copied to Mac."
            } catch is CancellationError { message = "Transfer cancelled." }
            catch {
                if Task.isCancelled { message = "Transfer cancelled." }
                else { fail(error.localizedDescription) }
            }
        }
    }
    private func fail(_ text: String) { message = text; reportError(text) }
}
