import Cocoa
import SwiftUI
import ServiceManagement

@MainActor
final class SettingsOverlayState: ObservableObject {
    @Published var snapshot: NSImage?
    @Published var visible = false
}

struct SettingsOverlay: View {
    @ObservedObject var state: SettingsOverlayState
    @ObservedObject var permissions: CapturePermissions
    @ObservedObject var clipboard: ClipboardBridge
    let close: () -> Void
    @State private var watcherRunning = false
    @State private var watcherLogin = SMAppService.Status.notRegistered

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
                            Divider().overlay(Color.white.opacity(0.08))
                            watcherRow
                            Divider().overlay(Color.white.opacity(0.08))
                            clipboardRow
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
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in refreshWatcher() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in refreshWatcher() }
        .onReceive(DistributedNotificationCenter.default().publisher(for: IPortalWatcher.settingsChanged)) { _ in refreshWatcher() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in refreshWatcher() }
        .task(id: state.visible) {
            // SMAppService has no status-change notification. Refresh on events;
            // this fallback exists only while Settings is actually visible.
            while state.visible && !Task.isCancelled {
                refreshWatcher()
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }

    private func refreshWatcher() {
        guard state.visible else { return }
        let status = IPortalWatcherService.currentStatus
        watcherRunning = status.running; watcherLogin = status.login
    }

    private var watcherRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Menu-bar watcher", systemImage: "menubar.rectangle")
                .font(.system(size: 15, weight: .medium))
            HStack {
                Text(watcherRunning ? "Running" : "Stopped")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                compactButton("Manage") { IPortalWatcherService.openSettings() }
            }
            Text(watcherLogin == .enabled ? "Starts at login."
                 : watcherLogin == .requiresApproval ? "Allow in Login Items to start at login."
                 : watcherLogin == .notFound ? "Reopen iPortal to restore the watcher."
                 : "Doesn’t start at login.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    private var clipboardRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Clipboard", systemImage: "doc.on.clipboard").font(.system(size: 15, weight: .medium))
                Spacer()
                if clipboard.busy { ProgressView().controlSize(.small) }
            }
            Text(clipboard.message).font(.system(size: 12)).foregroundStyle(.secondary)
            HStack {
                compactButton("To Mac") { clipboard.transfer(toDevice: false) }
                compactButton("To Device") { clipboard.transfer(toDevice: true) }
            }.disabled(clipboard.busy || !clipboard.available)
        }
    }

    private func compactButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.white.opacity(0.9))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain)
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
