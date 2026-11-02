import Cocoa
import SwiftUI
import BorderBeamKit

@MainActor
final class LoadingBorderState: ObservableObject {
    @Published var active = true
    @Published var radius: CGFloat = 42
}

struct LoadingBorder: View {
    @ObservedObject var state: LoadingBorderState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                RoundedRectangle(cornerRadius: state.radius, style: .continuous)
                    .strokeBorder(.cyan.opacity(state.active ? 0.8 : 0), lineWidth: 2)
            } else {
                BorderBeam(colorVariant: .colorful, active: state.active,
                           borderRadius: Double(state.radius), strength: 0.8) {
                    Color.clear
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .padding(2)
    }
}

// The hosting view must never intercept the web view's gestures or hover events.
final class LoadingBorderHost: NSHostingView<LoadingBorder> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
