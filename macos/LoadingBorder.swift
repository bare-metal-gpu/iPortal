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
            border.accessibilityHidden(true)
            if state.showMessage {
                GeometryReader { geometry in
                    VStack(spacing: 14) {
                        HStack(spacing: 12) {
                            if state.phase == "locked" || state.phase == "disconnected" {
                                Image(systemName: state.phase == "locked" ? "lock.fill" : "cable.connector.slash")
                                    .font(.system(size: 24, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.85))
                                    .accessibilityHidden(true)
                                Text(state.phase == "locked" ? "Locked" : "Disconnected")
                                    .font(.custom("InterVariable", size: 18).weight(.medium))
                                    .foregroundStyle(.white.opacity(0.85))
                            } else {
                                ThinkingOrb(state: .connecting, size: .px64, theme: .dark,
                                        displaySize: geometry.size.width < 260 ? 40 : 64)
                                .accessibilityHidden(true)
                                ConnectingLabel()
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .frame(maxWidth: min(260, geometry.size.width - 32))
                        if !state.detail.isEmpty {
                            Text(state.detail)
                                .font(.custom("InterVariable", size: 12))
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

private struct ConnectingLabel: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var label: some View {
        Text("Connecting…")
            .font(.custom("InterVariable", size: 18).weight(.medium))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
    }

    var body: some View {
        if reduceMotion {
            label.foregroundStyle(.white.opacity(0.85))
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 2.4) / 2.4
                let center = phase * 2 - 0.5
                label.foregroundStyle(LinearGradient(
                    colors: [.white.opacity(0.6), .white, .white.opacity(0.6)],
                    startPoint: UnitPoint(x: center - 0.35, y: 0),
                    endPoint: UnitPoint(x: center + 0.35, y: 0)
                ))
            }
        }
    }
}

// The hosting view must never intercept the web view's gestures or hover events.
final class LoadingBorderHost: NSHostingView<LoadingBorder> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
