import UIKit
import SwiftUI
import CoreText
import ThinkingOrbsKit

@MainActor
private final class IPortalScreenState: ObservableObject {
    @Published var phase = "waiting"
    @Published var title = "Waiting for your Mac"
    @Published var detail = "Connect by USB and open iPortal on your Mac."
    @Published var keepAwakeSeconds = 0
    @Published var visible = false
}

private struct IPortalScreen: View {
    @ObservedObject var state: IPortalScreenState
    var body: some View {
        let connecting = state.phase == "connecting" || state.phase == "reconnecting"
        let orb: OrbState = state.phase == "reconnecting" ? .solving : state.phase == "connected" ? .searching : .connecting
        ZStack {
            Color.black
            IPortalConnectionBorder(active: connecting && state.visible)
            IPortalConnectionMessage(title: state.title, detail: state.detail, keepAwakeSeconds: state.keepAwakeSeconds,
                                    orb: orb, isVisible: state.visible, shimmer: connecting)
        }
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
    }
}

@objc(IPortalViewController)
public final class IPortalViewController: UIViewController {
    private let state = IPortalScreenState()
    private var observers: [NSObjectProtocol] = []
    public override func viewDidLoad() {
        super.viewDidLoad()
        view.tag = 4102
        view.backgroundColor = .black
        if let font = Bundle(for: Self.self).url(forResource: "InterVariable", withExtension: "ttf", subdirectory: "Fonts") {
            CTFontManagerRegisterFontsForURL(font as CFURL, .process, nil)
        }
        let host = UIHostingController(rootView: IPortalScreen(state: state))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor), host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        observers.append(NotificationCenter.default.addObserver(forName: NSNotification.Name("IPortalStatusChanged"), object: nil, queue: .main) { [weak self] note in
            guard let self, let info = note.userInfo else { return }
            let phase = info["phase"] as? String ?? "waiting"
            let title = info["message"] as? String ?? "Waiting for your Mac"
            let detail = info["detail"] as? String ?? ""
            let seconds = max(0, Int(ceil((info["keepAwakeRemainingMs"] as? Double ?? 0) / 1000)))
            if self.state.phase != phase { self.state.phase = phase }
            if self.state.title != title { self.state.title = title }
            if self.state.detail != detail { self.state.detail = detail }
            if self.state.keepAwakeSeconds != seconds { self.state.keepAwakeSeconds = seconds }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.state.visible = false
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.state.visible = self.view.window != nil
        })
    }
    public override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); state.visible = true }
    public override func viewWillDisappear(_ animated: Bool) { state.visible = false; super.viewWillDisappear(animated) }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}
