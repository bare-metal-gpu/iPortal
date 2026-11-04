import Cocoa
import SwiftUI

@MainActor
final class LoadingBorderState: ObservableObject {
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
            if state.phase != "live", let snapshot = state.snapshot {
                GeometryReader { geometry in
                    Image(nsImage: snapshot)
                        .resizable()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .blur(radius: 18)
                        .overlay(Color.black.opacity(0.25))
                }
                .accessibilityHidden(true)
            }
            IPortalConnectionBorder(active: state.active, radius: state.radius)
            if state.showMessage {
                IPortalConnectionMessage(
                    title: state.phase == "locked" ? "Locked" : state.phase == "disconnected" ? "Disconnected"
                        : state.phase == "reconnecting" ? "Reconnecting…" : "Connecting…",
                    detail: state.detail,
                    symbol: state.phase == "locked" ? "lock.fill" : state.phase == "disconnected" ? "cable.connector.slash" : nil,
                    orb: state.phase == "reconnecting" ? .solving : .connecting,
                    shimmer: state.phase != "locked" && state.phase != "disconnected")
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: state.showMessage)
        .allowsHitTesting(false)
    }
}

// The hosting view must never intercept the web view's gestures or hover events.
final class LoadingBorderHost: NSHostingView<LoadingBorder> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
