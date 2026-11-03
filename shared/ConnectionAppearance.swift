import SwiftUI
import BorderBeamKit
import ThinkingOrbsKit

// Shared by the Mac overlay and the iPhone host; one layout and one animation.
struct PortalConnectionMessage: View {
    let title: String
    var detail = ""
    var footnote = ""
    var symbol: String? = nil
    var animated = true
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 14) {
                HStack(spacing: 12) {
                    if let symbol {
                        Image(systemName: symbol)
                            .font(.system(size: 24, weight: .medium))
                            .foregroundStyle(.white.opacity(0.85))
                            .accessibilityHidden(true)
                    } else {
                        ThinkingOrb(state: .connecting, size: .px64, theme: .dark,
                                    paused: !animated, displaySize: geometry.size.width < 260 ? 40 : 64)
                            .accessibilityHidden(true)
                    }
                    PortalStatusLabel(text: title, animated: animated)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 10)
                .frame(maxWidth: min(260, geometry.size.width - 32))
                if !detail.isEmpty { hint(detail) }
                if !footnote.isEmpty { hint(footnote) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.custom("InterVariable", size: 12))
            .foregroundStyle(.white.opacity(0.85)).multilineTextAlignment(.center)
            .padding(.horizontal, 24).frame(maxWidth: 300)
    }
}

struct PortalConnectionBorder: View {
    let active: Bool
    var radius: CGFloat = 42
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(.cyan.opacity(active ? 0.8 : 0), lineWidth: 2)
            } else {
                BorderBeam(colorVariant: .colorful, active: active,
                           borderRadius: Double(radius), strength: 0.8) { Color.clear }
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true).padding(2)
    }
}

private struct PortalStatusLabel: View {
    let text: String
    let animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var label: some View {
        Text(text).font(.custom("InterVariable", size: 18).weight(.medium))
            .lineLimit(1).minimumScaleFactor(0.75)
    }
    var body: some View {
        if reduceMotion || !animated {
            label.foregroundStyle(.white.opacity(0.85))
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                let center = phase * 2 - 0.5
                label.foregroundStyle(LinearGradient(
                    colors: [.white.opacity(0.6), .white, .white.opacity(0.6)],
                    startPoint: UnitPoint(x: center - 0.35, y: 0), endPoint: UnitPoint(x: center + 0.35, y: 0)))
            }
        }
    }
}
