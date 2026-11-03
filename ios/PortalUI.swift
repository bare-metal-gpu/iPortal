import UIKit
import SwiftUI
import CoreText

@MainActor
private final class PortalScreenState: ObservableObject {
    @Published var phase = "waiting"
    @Published var title = "Waiting for your Mac"
    @Published var detail = "Connect by USB and open iPhone Portal on your Mac."
    @Published var footnote = ""
    @Published var visible = false
}

private struct PortalScreen: View {
    @ObservedObject var state: PortalScreenState
    var body: some View {
        let connecting = state.phase == "connecting" || state.phase == "reconnecting"
        ZStack {
            Color.black
            PortalConnectionBorder(active: connecting && state.visible)
            PortalConnectionMessage(title: state.title, detail: state.detail, footnote: state.footnote,
                                    animated: connecting && state.visible)
        }
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
    }
}

@objc(PortalViewController)
public final class PortalViewController: UIViewController {
    private let state = PortalScreenState()
    private var observer: NSObjectProtocol?
    public override func viewDidLoad() {
        super.viewDidLoad()
        view.tag = 4102
        view.backgroundColor = .black
        if let font = Bundle(for: Self.self).url(forResource: "InterVariable", withExtension: "ttf", subdirectory: "Fonts") {
            CTFontManagerRegisterFontsForURL(font as CFURL, .process, nil)
        }
        let host = UIHostingController(rootView: PortalScreen(state: state))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor), host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        observer = NotificationCenter.default.addObserver(forName: NSNotification.Name("PortalStatusChanged"), object: nil, queue: .main) { [weak self] note in
            guard let self, let info = note.userInfo else { return }
            let phase = info["phase"] as? String ?? "waiting"
            let title = info["message"] as? String ?? "Waiting for your Mac"
            let detail = info["detail"] as? String ?? ""
            let footnote = info["awake"] as? String ?? ""
            if self.state.phase != phase { self.state.phase = phase }
            if self.state.title != title { self.state.title = title }
            if self.state.detail != detail { self.state.detail = detail }
            if self.state.footnote != footnote { self.state.footnote = footnote }
        }
    }
    public override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); state.visible = true }
    public override func viewWillDisappear(_ animated: Bool) { state.visible = false; super.viewWillDisappear(animated) }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}
