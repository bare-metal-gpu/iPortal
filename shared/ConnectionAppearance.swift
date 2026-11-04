import SwiftUI
import BorderBeamKit
import ThinkingOrbsKit

// Shared by the Mac overlay and the iPhone host; one layout and one animation.
struct IPortalConnectionMessage: View {
    let title: String
    var detail = ""
    var keepAwakeSeconds = 0
    var symbol: String? = nil
    var orb: OrbState = .connecting
    var isVisible = true
    var shimmer = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            let orbSize: Double = geometry.size.width < 260 ? 40 : 64
            let rowHeight = orbSize + 20
            ZStack {
                HStack(spacing: 12) {
                    if let symbol {
                        Image(systemName: symbol)
                            .font(.system(size: 24, weight: .medium))
                            .foregroundStyle(IPortalStyle.Palette.primary)
                            .accessibilityHidden(true)
                    } else {
                        ThinkingOrb(state: orb, size: .px64, theme: .dark,
                                    paused: !isVisible, displaySize: orbSize)
                            .accessibilityHidden(true)
                    }
                    IPortalStatusLabel(text: title, animated: shimmer && isVisible)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 10)
                .frame(maxWidth: min(260, geometry.size.width - 32))
                .id(title + orb.rawValue)
                .transition(.opacity)
            }
            .frame(width: min(260, geometry.size.width - 32), height: rowHeight)
            // Overlays don't participate in sizing: hints and the timer can
            // appear/disappear without moving the centered orb/status row.
            .overlay(alignment: .top) {
                VStack(spacing: 10) {
                    if !detail.isEmpty { hint(detail).transition(.opacity) }
                    if keepAwakeSeconds > 0 {
                        keepAwakeBadge.transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }
                }
                .frame(width: min(300, geometry.size.width - 32))
                .offset(y: rowHeight + 14)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(transitionAnimation, value: title)
            .animation(transitionAnimation, value: orb)
            .animation(transitionAnimation, value: detail)
            .animation(transitionAnimation, value: keepAwakeSeconds > 0)
        }
    }

    private var transitionAnimation: Animation? { reduceMotion ? nil : .easeInOut(duration: 0.3) }

    private var keepAwakeBadge: some View {
        let minutes = keepAwakeSeconds / 60
        let seconds = keepAwakeSeconds % 60
        return Label("Awake · \(minutes):\(String(format: "%02d", seconds))", systemImage: "timer")
            .font(IPortalStyle.Typography.badge)
            .monospacedDigit()
            .foregroundStyle(IPortalStyle.Palette.secondary)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(IPortalStyle.Palette.subtleFill, in: Capsule())
            .overlay(Capsule().strokeBorder(IPortalStyle.Palette.border, lineWidth: 0.5))
            .accessibilityLabel("Keep awake: \(minutes) minutes, \(seconds) seconds remaining")
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(IPortalStyle.Typography.caption)
            .foregroundStyle(IPortalStyle.Palette.secondary).multilineTextAlignment(.center)
            .padding(.horizontal, 24).frame(maxWidth: 300)
    }
}

struct IPortalConnectionBorder: View {
    let active: Bool
    var radius: CGFloat = 42
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(IPortalStyle.Palette.accent.opacity(active ? 0.8 : 0), lineWidth: 2)
            } else {
                BorderBeam(colorVariant: .colorful, active: active,
                           borderRadius: Double(radius), strength: 0.8) { Color.clear }
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true).padding(2)
    }
}

private struct IPortalStatusLabel: View {
    let text: String
    let animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var label: some View {
        Text(text).font(IPortalStyle.Typography.status)
            .lineLimit(1).minimumScaleFactor(0.75)
    }
    var body: some View {
        if reduceMotion || !animated {
            label.foregroundStyle(IPortalStyle.Palette.primary)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                let center = phase * 2 - 0.5
                label.foregroundStyle(LinearGradient(
                    colors: IPortalStyle.Palette.shimmer,
                    startPoint: UnitPoint(x: center - 0.35, y: 0), endPoint: UnitPoint(x: center + 0.35, y: 0)))
            }
        }
    }
}
