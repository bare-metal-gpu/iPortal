import SwiftUI
import WebKit

@main struct FixtureApp: App {
  var body: some Scene {
    WindowGroup {
      FixtureView().onAppear {
        // Keep controlled tests awake across helper rebuilds without changing
        // the user's Auto-Lock preference. Leaving this fixture restores it.
        UIApplication.shared.isIdleTimerDisabled = true
      }
    }
  }
}
struct FixtureView: View {
  @State private var text = "Hello 👋 café 世界"
  @State private var taps = 0
  @State private var alert = false
  @State private var keyboardDismissals = 0
  @State private var focusLosses = 0
  @State private var keyboardEvents: [String] = []
  @FocusState private var inputFocused: Bool
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 20) {
          Text("iPortal Fixture").accessibilityIdentifier("fixture.title")
            .accessibilityValue("\(keyboardDismissals):\(focusLosses)")
          TextField("Input", text: $text).textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("fixture.input").focused($inputFocused)
          Text("Taps: \(taps)").accessibilityIdentifier("fixture.counter")
          Button {
            taps += 1
          } label: {
            Text("Tap").frame(maxWidth: .infinity).frame(height: 140).background(
              taps.isMultiple(of: 2) ? Color.blue : Color.orange
            ).foregroundStyle(.white)
          }.accessibilityIdentifier("fixture.tap")
          Button("Disabled") {}.disabled(true).accessibilityIdentifier("fixture.disabled")
          Button("Alert") { alert = true }.accessibilityIdentifier("fixture.alert")
          HStack {
            Button("Duplicate one") {}.accessibilityIdentifier("fixture.duplicate")
            Button("Duplicate two") {}.accessibilityIdentifier("fixture.duplicate")
          }.accessibilityElement(children: .contain)
          ForEach(0..<60) { i in
            Text("Row \(i)").frame(maxWidth: .infinity).padding()
              .accessibilityIdentifier("fixture.row.\(i)")
          }
          Text(keyboardEvents.joined(separator: " | "))
            .accessibilityIdentifier("fixture.keyboardTrace")
        }.padding()
      }.onChange(of: inputFocused) { _, focused in
        if !focused { focusLosses += 1 }
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification))
      { note in
        recordKeyboard("willHide", note)
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification))
      { note in
        recordKeyboard("willShow", note)
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification))
      { note in
        keyboardDismissals += 1
        recordKeyboard("hide", note)
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification))
      { note in
        recordKeyboard("show", note)
      }
      .alert("Fixture alert", isPresented: $alert) { Button("Close", role: .cancel) {} }
      .toolbar {
        NavigationLink("Editors") { EditorFixtureView() }.accessibilityIdentifier("fixture.editors")
        NavigationLink("Controls") { ControlFixtureView() }.accessibilityIdentifier("fixture.controls")
      }
    }
  }
  private func recordKeyboard(_ event: String, _ note: Notification) {
    let frame =
      (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
    // Test-only diagnostic: distinguish input-device attachment from loss of
    // field focus. Missing private diagnostics remain unknown on older runtimes.
    var hardware = "unknown"
    if let type = NSClassFromString("UIKeyboardImpl") as? NSObject.Type,
      type.responds(to: NSSelectorFromString("sharedInstance")),
      let keyboard = type.perform(NSSelectorFromString("sharedInstance"))?.takeUnretainedValue() as? NSObject,
      keyboard.responds(to: NSSelectorFromString("isHardwareKeyboardAttachedNow")),
      let attached = keyboard.value(forKey: "hardwareKeyboardAttachedNow") as? Bool {
      hardware = attached ? "attached" : "detached"
    }
    keyboardEvents.append(
      "\(event):\(Int(frame.minY)),\(Int(frame.height)),hardware:\(hardware)@\(Int(CACurrentMediaTime() * 1000))")
    if keyboardEvents.count > 32 { keyboardEvents.removeFirst() }
  }
}

private struct ControlFixtureView: View {
  @State private var text = "Initial value"
  @State private var level = 0.5
  @State private var enabled = false
  @State private var changes = 0
  var body: some View {
    VStack(spacing: 24) {
      TextField("Replacement input", text: $text).textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("fixture.replace")
      Text("Value:\(text)").accessibilityIdentifier("fixture.replacedValue")
      Slider(value: $level, in: 0...1).accessibilityLabel("Level")
        .accessibilityIdentifier("fixture.slider")
      Toggle("Enabled", isOn: $enabled).accessibilityIdentifier("fixture.toggle")
      Button("Delayed update") {
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(700))
          changes += 1
        }
      }.accessibilityIdentifier("fixture.delayed")
      Text("Changes: \(changes)").accessibilityIdentifier("fixture.changes")
      Spacer()
    }.padding().navigationTitle("Controls")
  }
}

private struct EditorFixtureView: View {
  @State private var secure = ""
  @State private var multiline = ""
  @State private var web = ""
  @State private var dismissals = 0
  @State private var webSecure = ""
  @State private var secureFocusLosses = 0
  @FocusState private var secureFocused: Bool
  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        Text("Editors").accessibilityIdentifier("fixture.editorStatus")
          .accessibilityValue("\(dismissals):\(secureFocusLosses)")
        SecureField("Secure input", text: $secure).textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("fixture.secure").focused($secureFocused)
        Text(secure).accessibilityIdentifier("fixture.secureValue")
        TextEditor(text: $multiline).frame(height: 90)
          .accessibilityIdentifier("fixture.multiline")
        Text(multiline).accessibilityIdentifier("fixture.multilineValue")
        WebEditorFixture(value: $web, secure: $webSecure).frame(height: 240)
        Text(web).accessibilityIdentifier("fixture.webValue")
        Text(webSecure).accessibilityIdentifier("fixture.webSecureValue")
      }.padding()
    }.onChange(of: secureFocused) { _, focused in
      if !focused { secureFocusLosses += 1 }
    }.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
      dismissals += 1
    }
  }
}

private struct WebEditorFixture: UIViewRepresentable {
  @Binding var value: String
  @Binding var secure: String
  final class Coordinator: NSObject, WKScriptMessageHandler {
    var value: Binding<String>
    var secure: Binding<String>
    init(_ value: Binding<String>, _ secure: Binding<String>) {
      self.value = value
      self.secure = secure
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      guard let update = message.body as? [String: String], let text = update["text"] else { return }
      if update["field"] == "secure" { secure.wrappedValue = text }
      else { value.wrappedValue = text }
    }
  }
  func makeCoordinator() -> Coordinator { Coordinator($value, $secure) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(context.coordinator, name: "edited")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.loadHTMLString("""
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <textarea aria-label="Web input" style="font-size:20px;width:90%;height:100px"
        oninput="webkit.messageHandlers.edited.postMessage({field:'text',text:this.value})"></textarea>
      <input type="password" aria-label="Web password" style="font-size:20px;width:90%;height:40px"
        oninput="webkit.messageHandlers.edited.postMessage({field:'secure',text:this.value})">
      """, baseURL: nil)
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {}
}
