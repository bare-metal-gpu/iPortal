import UIKit

struct InputObservation: Codable {
    let phase: String
    let timestamp: Double
    let contact: Int?
    let x: Double
    let y: Double
}

@MainActor final class InputProbeController: UIViewController {
    private let recorder = ContactRecorder()
    private let status = UILabel()
    private var observations: [InputObservation] = []
    private var idleTimerBeforeAppearance = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.accessibilityIdentifier = "probe.input.status"
        status.isAccessibilityElement = true
        status.text = "Touch and indirect-input recorder"
        status.numberOfLines = 0
        let reset = UIButton(type: .system)
        reset.setTitle("Reset recorder", for: .normal)
        reset.accessibilityIdentifier = "probe.input.reset"
        reset.addAction(UIAction { [weak self] _ in
            guard let self, self.recorder.activeCount == 0 else { return }
            self.observations.removeAll()
            self.recorder.reset()
            self.update()
        }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [status, reset, recorder])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            recorder.heightAnchor.constraint(greaterThanOrEqualToConstant: 200)
        ])
        recorder.observed = { [weak self] observation in
            guard let self else { return }
            self.observations.append(observation)
            if self.observations.count > 512 { self.observations.removeFirst() }
            self.update()
        }
        update()
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        idleTimerBeforeAppearance = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = idleTimerBeforeAppearance
    }
    private func update() {
        let snapshot = InputSnapshot(active: recorder.activeCount, events: observations)
        status.accessibilityValue = (try? JSONEncoder().encode(snapshot)).flatMap { String(data: $0, encoding: .utf8) }
    }
}

struct InputSnapshot: Codable {
    let active: Int
    let events: [InputObservation]
}

@MainActor private final class ContactRecorder: UIView, UIGestureRecognizerDelegate {
    var observed: ((InputObservation) -> Void)?
    private var contacts: [ObjectIdentifier: Int] = [:]
    private var sequence = 0
    var activeCount: Int { contacts.count }
    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "probe.input.surface"
        isAccessibilityElement = true
        isMultipleTouchEnabled = true
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 20
        let pan = UIPanGestureRecognizer(target: self, action: #selector(scroll(_:)))
        pan.allowedScrollTypesMask = .all
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(transform(_:)))
        let rotation = UIRotationGestureRecognizer(target: self, action: #selector(rotate(_:)))
        for gesture in [pan, pinch, rotation] {
            gesture.cancelsTouchesInView = false
            gesture.delegate = self
            addGestureRecognizer(gesture)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    func reset() { precondition(contacts.isEmpty); sequence = 0 }
    func gestureRecognizer(_ first: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith second: UIGestureRecognizer) -> Bool { true }
    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
        // Apple's indirect events do not carry ordinary UITouch samples.
        // Filter the event type explicitly, rather than disabling all touch
        // types and risking an artificial negative recorder result.
        recognizer is UIPanGestureRecognizer ? event.type == .scroll : event.type == .transform
    }
    @objc private func scroll(_ gesture: UIPanGestureRecognizer) {
        let delta = gesture.translation(in: self)
        observed?(InputObservation(phase: "scroll.\(gesture.state.rawValue)", timestamp: CACurrentMediaTime(),
                                   contact: nil, x: delta.x, y: delta.y))
    }
    @objc private func transform(_ gesture: UIPinchGestureRecognizer) {
        observed?(InputObservation(phase: "pinch.\(gesture.state.rawValue)", timestamp: CACurrentMediaTime(),
                                   contact: nil, x: gesture.scale, y: gesture.velocity))
    }
    @objc private func rotate(_ gesture: UIRotationGestureRecognizer) {
        observed?(InputObservation(phase: "rotate.\(gesture.state.rawValue)", timestamp: CACurrentMediaTime(),
                                   contact: nil, x: gesture.rotation, y: gesture.velocity))
    }
    private func record(_ touches: Set<UITouch>, phase: String, ended: Bool = false) {
        for touch in touches {
            let key = ObjectIdentifier(touch)
            if contacts[key] == nil { sequence += 1; contacts[key] = sequence }
            let id = contacts[key]
            if ended { contacts.removeValue(forKey: key) }
            let point = touch.location(in: self)
            observed?(InputObservation(phase: phase, timestamp: touch.timestamp,
                                       contact: id, x: point.x, y: point.y))
        }
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) { record(touches, phase: "began") }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { record(touches, phase: "moved") }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { record(touches, phase: "ended", ended: true) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { record(touches, phase: "cancelled", ended: true) }
}
