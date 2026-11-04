import Cocoa

@main struct ClipboardTests {
    @MainActor static func main() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let target = ClipboardTarget(port: 7100, instance: "instance", device: "phone-a", generation: 1, epoch: 1)
        var current: ClipboardTarget? = target
        var outcome = "success"
        var requests = 0
        let payload = try ClipboardPayload.make("text", Data("iPortal 👋 café\n日本語".utf8))
        let bridge = ClipboardBridge { request in
            requests += 1
            assert(request.value(forHTTPHeaderField: "x-iportal-instance") == "instance")
            if outcome == "changed clipboard" { pasteboard.clearContents(); pasteboard.setString("newer copy", forType: .string) }
            if outcome == "changed target" { current = nil }
            if outcome == "disconnect" { throw URLError(.networkConnectionLost) }
            var value: [String: Any] = ["format":payload.format,"content":payload.content]
            if outcome == "empty" { value = ["empty":true] }
            let json = try JSONSerialization.data(withJSONObject: ["ok":true,"value":value])
            return (json, HTTPURLResponse(url:request.url!, statusCode:200, httpVersion:nil, headerFields:["x-iportal-instance":"instance"])!)
        }
        bridge.target = { current }
        for _ in 0..<20 { await Task.yield() }
        current = nil
        bridge.cancel()
        current = target
        for _ in 0..<20 { await Task.yield() }
        assert(requests == 0, "connecting or reconnecting must never read the clipboard or trigger Paste permission")
        for mode in ["success", "empty", "disconnect", "changed clipboard", "changed target"] {
            current = target; outcome = mode
            pasteboard.clearContents(); pasteboard.setString("previous copy", forType: .string)
            bridge.transfer(toDevice: false, pasteboard: pasteboard)
            while bridge.busy { await Task.yield() }
            let expected = mode == "success" ? "iPortal 👋 café\n日本語" : mode == "changed clipboard" ? "newer copy" : "previous copy"
            assert(pasteboard.string(forType: .string) == expected, mode)
        }
        let url = try ClipboardPayload.make("url", Data("https://example.com/test".utf8)).item()
        assert(url.string(forType: .URL) == "https://example.com/test")
        assert(url.string(forType: .string) == "https://example.com/test")
        let image = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:2,pixelsHigh:2,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
        let png = image.representation(using:.png,properties:[:])!
        let item = try ClipboardPayload.make("image", png).item()
        assert(item.data(forType:.png) == png)
        do { _ = try ClipboardPayload.make("image", Data("invalid".utf8)); assertionFailure("bad image accepted") } catch {}
        print("Clipboard Unicode, URL, image, stale-device, disconnect, empty and newer-copy preservation tests passed.")
    }
}
