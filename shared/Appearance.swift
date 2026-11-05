import SwiftUI
import CoreText

// App-owned typography and colors. Native menus, alerts, switches and SF
// Symbols retain their platform rendering. Web equivalents live in index.html.
enum IPortalStyle {
    enum Typography {
        static func text(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
            .custom("InterVariable", size: size).weight(weight)
        }
        static let status = text(18, weight: .medium)
        static let label = text(14, weight: .medium)
        static let compactLabel = text(13, weight: .medium)
        static let body = text(13)
        static let caption = text(12)
        static let badge = text(11, weight: .medium)
    }

    enum Palette {
        static let background = Color.black
        static let primary = Color.white.opacity(0.9)
        static let secondary = Color.white.opacity(0.65)
        static let disabled = Color.white.opacity(0.3)
        static let subtleFill = Color.white.opacity(0.08)
        static let border = Color.white.opacity(0.12)
        static let shimmer = [Color.white.opacity(0.6), .white, Color.white.opacity(0.6)]

        // Match BorderBeamKit's colorful palette on the custom notched path.
        static let accent = Color(red: 30 / 255, green: 185 / 255, blue: 170 / 255)
        static let beam = [Color.clear, .clear, accent.opacity(0.9),
                           Color(red: 100 / 255, green: 70 / 255, blue: 1),
                           Color(red: 240 / 255, green: 50 / 255, blue: 180 / 255).opacity(0.9),
                           Color(red: 1, green: 120 / 255, blue: 40 / 255).opacity(0.65), .clear]
    }

    enum Surface {
        static let snapshotBlur: CGFloat = 18
        static let snapshotShade = Color.black.opacity(0.25)
        static let settingsShade = Color.black.opacity(0.16)
    }

    static func registerFonts(in bundle: Bundle) {
        guard let url = bundle.url(forResource: "InterVariable", withExtension: "ttf", subdirectory: "Fonts") else {
            NSLog("iPortal: bundled Inter font is missing from %@", bundle.bundlePath)
            return
        }
        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error), let error = error?.takeRetainedValue(),
           CFErrorGetCode(error) != CTFontManagerError.alreadyRegistered.rawValue {
            NSLog("iPortal: could not register Inter: %@", error as Error as NSError)
        }
    }
}

#if os(macOS)
// The same restrained symbol is used in the window and device list. It carries
// connection information only; it is not another button or setup flow.
struct IPortalWiFiIndicator: View {
    let visible: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Image(systemName: "wifi").font(.system(size: 13, weight: .regular))
            .foregroundStyle(IPortalStyle.Palette.secondary)
            .symbolEffect(.pulse, options: .repeating, isActive: visible && !reduceMotion)
            .opacity(visible ? 1 : 0)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: visible)
            .frame(width: 22, height: 16)
            .allowsHitTesting(false)
            .accessibilityLabel("Wi-Fi")
            .accessibilityHidden(!visible)
    }
}
#endif
