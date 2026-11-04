import Cocoa
import QuartzCore

@main
struct CornerResizeTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        for kind in [IPortalDeviceKind.iPhone, .iPad] {
            for size in [NSSize(width: 185, height: 400), NSSize(width: 402, height: 874),
                         NSSize(width: 874, height: 402), NSSize(width: 768, height: 1024)] {
                let radius = kind.radius(width: size.width, height: size.height)
                let root = NSView(frame: NSRect(origin: .zero, size: NSSize(width: size.width + 24, height: size.height + 32)))
                let phone = NSView(frame: NSRect(origin: NSPoint(x: 12, y: 16), size: size))
                let input = NSView(frame: phone.bounds)
                phone.addSubview(input)
                root.addSubview(phone)

                // Render the actual continuous Core Animation corner used by
                // the app. No assumptions about its curve/Bezier approximation.
                let layer = CALayer()
                layer.frame = phone.bounds
                layer.backgroundColor = NSColor.white.cgColor
                layer.cornerRadius = radius
                layer.cornerCurve = .continuous
                layer.masksToBounds = true
                let width = Int(size.width), height = Int(size.height)
                let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)!
                layer.render(in: context)
                let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
                let grabSize = CornerResizeHandle.grabSize(radius: radius)
                for corner in ResizeCorner.allCases {
                    let handle = CornerResizeHandle(corner: corner)
                    handle.frame = NSRect(x: corner.left ? phone.frame.minX : phone.frame.maxX - grabSize,
                                          y: corner.bottom ? phone.frame.minY : phone.frame.maxY - grabSize,
                                          width: grabSize, height: grabSize)
                    root.addSubview(handle)
                    var grabbed = 0, displayPoints = 0
                    // Covers the old 56-point obstruction and the curved edge.
                    for y in 0..<60 {
                        for x in 0..<60 {
                            let p = NSPoint(x: corner.left ? CGFloat(x) + 0.5 : size.width - CGFloat(x) - 0.5,
                                            y: corner.bottom ? CGFloat(y) + 0.5 : size.height - CGFloat(y) - 0.5)
                            let global = NSPoint(x: p.x + phone.frame.minX, y: p.y + phone.frame.minY)
                            let target = root.hitTest(global)
                            let alpha = pixels[(Int(p.y) * width + Int(p.x)) * 4 + 3]
                            if alpha > 0 {
                                displayPoints += 1
                                assert(target === input, "visible screen must receive input: \(kind) \(size) \(corner) \(p)")
                            }
                            if target === handle {
                                grabbed += 1
                                assert(alpha == 0, "resize cannot overlap a visible display pixel")
                            }
                        }
                    }
                    assert(grabbed > 0 && displayPoints > 0, "both resize and phone input remain reachable")
                    handle.updateTrackingAreas()
                    let originalTrackingArea = handle.trackingAreas.first
                    handle.updateTrackingAreas()
                    assert(handle.trackingAreas.count == 1, "layout cannot accumulate overlapping cursor areas")
                    assert(handle.trackingAreas.first === originalTrackingArea, "layout preserves active tracking")
                    handle.isHidden = true
                    assert(handle.hitTest(handle.frame.origin) == nil, "hidden handles cannot intercept input")
                    handle.removeFromSuperview()
                }
            }
        }
        if ProcessInfo.processInfo.environment["IPORTAL_TEST_WINDOW_SERVER"] == "1" {
            // Opt-in local integration check: WindowServer, before NSView,
            // ignores fully transparent pixels. This caught the first fix's
            // unreachable resize area despite its passing view-level tests.
            let visible = NSScreen.main!.visibleFrame
            let window = MirrorWindow(contentRect: NSRect(x: visible.minX + 24, y: visible.minY + 24, width: 64, height: 64),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            window.isReleasedWhenClosed = false
            window.level = .floating
            defer { window.orderOut(nil) }
            for corner in ResizeCorner.allCases {
                let handle = CornerResizeHandle(corner: corner)
                window.contentView = handle
                window.orderFrontRegardless()
                window.display()
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                let local = NSPoint(x: corner.left ? 3 : 61, y: corner.bottom ? 3 : 61)
                let screen = window.convertPoint(toScreen: local)
                assert(NSWindow.windowNumber(at: screen, belowWindowWithWindowNumber: 0) == window.windowNumber,
                       "WindowServer must deliver corner mouse events")
                let middle = window.convertPoint(toScreen: NSPoint(x: 32, y: 32))
                assert(NSWindow.windowNumber(at: middle, belowWindowWithWindowNumber: 0) != window.windowNumber,
                       "the resize view must not paint/hit the phone area")

                // Move across fractional coordinates and former strip edges.
                // Every grabbable point must immediately have the same cursor.
                var expected: NSCursor?
                for distance in stride(from: 0.5, through: 56.5, by: 0.25) {
                    let p = NSPoint(x: corner.left ? 3 : 61,
                                    y: corner.bottom ? distance : 64 - distance)
                    guard handle.containsGrabPoint(p) else { continue }
                    let event = NSEvent.mouseEvent(with: .mouseMoved, location: p, modifierFlags: [], timestamp: 0,
                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
                    NSCursor.arrow.set()
                    handle.cursorUpdate(with: event)
                    if expected == nil { expected = NSCursor.current }
                    assert(NSCursor.current != .arrow && NSCursor.current == expected,
                           "cursor must cover every grabbable fractional position")
                    handle.mouseMoved(with: event)
                    assert(NSCursor.current == expected, "movement must not reset the resize cursor")
                    window.cursorUpdate(with: event)
                    assert(NSCursor.current == expected, "overlapping view fallback must preserve the corner cursor")
                }
                let screenEvent = NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: 32, y: 32),
                    modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                    eventNumber: 0, clickCount: 0, pressure: 0)!
                handle.mouseMoved(with: screenEvent)
                assert(NSCursor.current == .arrow, "crossing onto the phone must release the resize cursor")
                let down = NSEvent.mouseEvent(with: .leftMouseDown, location: local, modifierFlags: [], timestamp: 0,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
                var resized = false
                handle.onResize = { target, _, _ in
                    assert(target == corner, "drag keeps the original corner")
                    resized = true
                }
                handle.mouseDown(with: down)
                handle.mouseDragged(with: screenEvent)
                assert(resized && NSCursor.current == expected, "drag stays captured beyond the corner")
                handle.mouseUp(with: screenEvent)
                assert(NSCursor.current == .arrow, "ending the drag releases the resize cursor")
            }
            NSCursor.arrow.set()
            print("WindowServer hit testing reaches all four resize corners and excludes the screen area.")
        }
        print("Corner input: all visible pixels pass through, empty corners resize, and cursor regions match across device sizes/orientations.")
    }
}
