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
        ZStack {
            MirrorBlurredSnapshot(snapshot: state.snapshot)
            Color.black.opacity(0.16)
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        HStack {
                            Text("Settings").font(.system(size: 23, weight: .semibold))
                            Spacer()
                            Button(action: close) { Image(systemName: "xmark").padding(6) }
                                .buttonStyle(.plain).accessibilityLabel("Close Settings")
                        }
                        VStack(spacing: 20) {
                            permissionRow(.camera)
                            Divider().overlay(Color.white.opacity(0.08))
                            permissionRow(.microphone)
                        }
                        Text("Permissions apply to all your devices.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    .padding(24)
                    .frame(maxWidth: 360)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .contentShape(Rectangle())
        .environment(\.colorScheme, .dark)
        .onExitCommand(perform: close)
    }

    private func permissionRow(_ permission: CapturePermission) -> some View {
        let status = permissions.snapshot[permission]
        let requesting = permissions.requesting.contains(permission)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: permission.symbol).frame(width: 20)
                Text(permission.title).font(.system(size: 15, weight: .medium))
                Spacer(minLength: 4)
                if requesting { ProgressView().controlSize(.small) }
            }
            Text(permission == .camera ? "For smoother video over USB." : "For your device’s sound.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                Text(status.title).font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Button {
                    if status == .notDetermined { Task { await permissions.request(permission) } }
                    else { permissions.openSettings(permission) }
                } label: {
                    Text(status == .notDetermined ? "Allow" : "Manage")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.white.opacity(0.9))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .disabled(requesting)
                .accessibilityLabel((status == .notDetermined ? "Allow " : "Manage ") + permission.title + " permission")
            }
            if permission == .camera, permissions.snapshot.blocksNativeCapture {
                Text("Mirroring continues with basic video and no sound.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            } else if permission == .microphone, status == .denied || status == .restricted {
                Text("Video works without sound.").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
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
