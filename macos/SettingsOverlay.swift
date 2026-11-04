import Cocoa
import SwiftUI

@MainActor
final class SettingsOverlayState: ObservableObject {
    @Published var snapshot: NSImage?
}

struct SettingsOverlay: View {
    @ObservedObject var state: SettingsOverlayState
    @ObservedObject var permissions: CapturePermissions
    let close: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            MirrorBlurredSnapshot(snapshot: state.snapshot)
            IPortalStyle.Surface.settingsShade
            GeometryReader { geometry in
                let compact = geometry.size.width < 280
                // Keep the first row inside the rounded corner's tangent. At
                // normal phone size this gives ~36pt of breathing room, rather
                // than measuring 24pt from an invisible rectangular corner.
                let inset: CGFloat = compact ? 16 : min(40, max(28, min(geometry.size.width, geometry.size.height) * 0.09))
                ScrollView {
                    VStack(spacing: 12) {
                        permissionRow(.camera, compact: compact)
                        permissionRow(.microphone, compact: compact)
                    }
                    .padding(inset)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: close)
        .environment(\.colorScheme, .dark)
        .onExitCommand(perform: close)
    }

    private func permissionRow(_ permission: CapturePermission, compact: Bool) -> some View {
        let status = permissions.snapshot[permission]
        return HStack(spacing: compact ? 8 : 12) {
            if !compact {
                Image(systemName: permission.symbol)
                    .font(.system(size: 15))
                    .foregroundStyle(IPortalStyle.Palette.secondary)
                    .frame(width: 20)
            }
            Text(permission.title).font(compact ? IPortalStyle.Typography.compactLabel : IPortalStyle.Typography.label)
                .foregroundStyle(IPortalStyle.Palette.primary)
                .lineLimit(1)
            Spacer(minLength: compact ? 8 : 16)
            Toggle(permission.title, isOn: Binding(
                get: { permissions.snapshot[permission] == .authorized },
                set: { enabled in Task { await permissions.setEnabled(enabled, for: permission) } }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .fixedSize()
            .disabled(permissions.requesting.contains(permission) || status == .restricted || status == .unavailable)
            .accessibilityValue(status.title)
            .help(status == .notDetermined ? "Allow \(permission.title)" : status == .restricted || status == .unavailable ? status.title : "Change in System Settings")
        }
        .frame(maxWidth: .infinity, minHeight: 36)
        .contentShape(Rectangle())
        .onTapGesture { } // Row clicks stay local; only blank space dismisses.
    }
}

final class SettingsOverlayHost: NSHostingView<SettingsOverlay> {
    override var acceptsFirstResponder: Bool { true }
    override func cancelOperation(_ sender: Any?) { rootView.close() }
    // Consume clicks in the blurred space as well as on the controls.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, bounds.contains(convert(point, from: superview)) else { return nil }
        return super.hitTest(point) ?? self
    }
}
