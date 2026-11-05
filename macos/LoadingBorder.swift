import Cocoa
import SwiftUI
import CoreImage

@MainActor
final class LoadingBorderState: ObservableObject {
    @Published var disconnectedSymbol = "cable.connector.slash"
    @Published var active = true
    @Published var radius: CGFloat = 42
    @Published var showMessage = true
    @Published var detail = ""
    @Published var phase = "connecting"
    @Published var snapshot: NSImage?
}

struct LoadingBorder: View {
    @ObservedObject var state: LoadingBorderState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if state.phase != "live" { MirrorBlurredSnapshot(snapshot: state.snapshot) }
            IPortalConnectionBorder(active: state.active, radius: state.radius)
            if state.showMessage {
                IPortalConnectionMessage(
                    title: state.phase == "locked" ? "Locked" : state.phase == "disconnected" ? "Disconnected"
                        : state.phase == "reconnecting" ? "Reconnecting…" : "Connecting…",
                    detail: state.detail,
                    symbol: state.phase == "locked" ? "lock.fill" : state.phase == "disconnected" ? state.disconnectedSymbol : nil,
                    orb: state.phase == "reconnecting" ? .solving : .connecting,
                    shimmer: state.phase != "locked" && state.phase != "disconnected")
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: state.showMessage)
        .allowsHitTesting(false)
    }
}

struct MirrorBlurredSnapshot: View {
    let snapshot: NSImage?
    var body: some View {
        GeometryReader { geometry in
            if let snapshot {
                ClampedSnapshot(snapshot: snapshot)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .overlay(IPortalStyle.Surface.snapshotShade)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct ClampedSnapshot: NSViewRepresentable {
    let snapshot: NSImage
    func makeNSView(context: Context) -> ClampedSnapshotView { ClampedSnapshotView() }
    func updateNSView(_ view: ClampedSnapshotView, context: Context) { view.setSnapshot(snapshot) }
}

// SwiftUI's blur samples transparent pixels outside the clipped image. Those
// translucent edges reveal the sharp video below. Extend the edge pixels first,
// then blur and crop, keeping the snapshot opaque all the way to the boundary.
private final class ClampedSnapshotView: NSView {
    private static let context = CIContext()
    private var snapshot: NSImage?
    private var source: CGImage?
    private var rendered: CGImage?
    private var renderedScale: CGFloat = 0

    func setSnapshot(_ image: NSImage) {
        guard snapshot !== image else { return }
        snapshot = image
        source = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        rendered = nil
        needsDisplay = true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let source, bounds.width > 0, bounds.height > 0,
              let graphics = NSGraphicsContext.current?.cgContext else { return }
        let scale = max(bounds.width / CGFloat(source.width), bounds.height / CGFloat(source.height))
        if rendered == nil || renderedScale != scale {
            let image = CIImage(cgImage: source)
            let blurred = image.clampedToExtent()
                .applyingGaussianBlur(sigma: IPortalStyle.Surface.snapshotBlur / scale)
                .cropped(to: image.extent)
            rendered = Self.context.createCGImage(blurred, from: image.extent)
            renderedScale = scale
        }
        guard let rendered else { return }
        let size = CGSize(width: CGFloat(source.width) * scale, height: CGFloat(source.height) * scale)
        let destination = CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                                 width: size.width, height: size.height)
        graphics.saveGState()
        graphics.clip(to: bounds)
        graphics.draw(rendered, in: destination)
        graphics.restoreGState()
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// The hosting view must never intercept the web view's gestures or hover events.
final class LoadingBorderHost: NSHostingView<LoadingBorder> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
