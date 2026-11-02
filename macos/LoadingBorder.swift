import Cocoa
import SwiftUI
import BorderBeamKit
import ThinkingOrbsKit

@MainActor
final class LoadingBorderState: ObservableObject {
    @Published var active = true
    @Published var radius: CGFloat = 42
    @Published var showMessage = true
    @Published var detail = ""
}

struct LoadingBorder: View {
    @ObservedObject var state: LoadingBorderState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            border.accessibilityHidden(true)
            if state.showMessage {
                GeometryReader { geometry in
                    VStack(spacing: 14) {
                        HStack(spacing: 12) {
                            ThinkingOrb(state: .connecting, size: .px64, theme: .dark,
                                        displaySize: geometry.size.width < 260 ? 40 : 64)
                                .accessibilityHidden(true)
                            Text("Connecting…")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .frame(maxWidth: min(260, geometry.size.width - 32))
                        .background(.black.opacity(0.42), in: Capsule())
                        .overlay(Capsule().strokeBorder(.white.opacity(0.06), lineWidth: 1))
                        if !state.detail.isEmpty {
                            Text(state.detail)
                                .font(.system(size: 12))
                                .foregroundStyle(.white.opacity(0.85))
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 24)
                                .frame(maxWidth: 300)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: state.showMessage)
        .allowsHitTesting(false)
    }

    private var border: some View {
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
