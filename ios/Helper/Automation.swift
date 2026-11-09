import Foundation
import UIKit
import XCTest

@MainActor final class HelperAutomation {
  let status: HelperStatus
  let inspection = HelperInspection()
  let media: HelperMedia
  lazy var clipboard = HelperClipboard { try self.foreground() }
  init(status: HelperStatus, media: HelperMedia) {
    self.status = status
    self.media = media
  }
  func foreground() throws -> XCUIApplication {
    let app = try IPApple.foreground()
    status.update(.authorization(true))
    return app
  }
  func orientation(_ app: XCUIApplication) throws -> (Int, String) {
    let value = IPApple.orientation(app)
    let names = [
      1: "PORTRAIT", 2: "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", 3: "LANDSCAPE",
      4: "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
    ]
    guard let name = names[value] else {
      throw HelperFailure("unsupported operation", "Interface orientation unavailable")
    }
    return (value, name)
  }
  func geometry(_ orientation: Int) throws -> CGSize {
    var error: NSError?
    let size = IPApple.screenSize(&error)
    if let error { throw HelperFailure("unsupported operation", error.localizedDescription) }
    let short = min(size.width, size.height)
    let long = max(size.width, size.height)
    return orientation == 3 || orientation == 4
      ? CGSize(width: long, height: short) : CGSize(width: short, height: long)
  }
  func appInfo(_ app: XCUIApplication) -> JSONValue {
    (try? JSONValue.from(IPApple.applicationInfo(app))) ?? .null
  }
  func unlocked() throws {
    guard let locked = IPApple.locked() else {
      throw HelperFailure("automation unavailable", "Lock state unavailable")
    }
    if locked.boolValue { throw HelperFailure("device locked", "Device is locked") }
  }
  func playback(_ call: (@escaping @Sendable (Error?) -> Void) -> Void) async throws {
    let cached = status
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, Error>) in
      let once = CallbackOnce()
      call { error in
        once.run {
          if let error {
            if (error as NSError).code == 41 {
              cached.update(.authorization(false))
              continuation.resume(
                throwing: HelperFailure(
                  "automation denied", "Automation authorization required",
                  outcome: "unknown"))
              return
            }
            let unsupported =
              (error as NSError).domain == "iPortal.Apple"
              && (error as NSError).code == 2
            continuation.resume(
              throwing: HelperFailure(
                unsupported ? "unsupported operation" : "unknown error",
                error.localizedDescription,
                outcome: unsupported ? "notExecuted" : "unknown"))
          } else {
            continuation.resume()
          }
        }
      }
    }
  }
  func checkInputGuard(_ args: JSONValue) throws {
    if args["expectedBundleId"] == .null && args["expectedOrientation"] == .null { return }
    let app = try foreground()
    try InputGuard.check(args, bundle: app.bundleIdentifier, orientation: orientation(app).1)
  }
  func keyboard(
    _ text: String, key: Bool = false, modifiers: [String] = [], guards: JSONValue = .object([:])
  ) async throws {
    try unlocked()
    if text.isEmpty { return }
    try checkInputGuard(guards)
    try await playback {
      IPApple.keyboard(text, key: key, modifiers: modifiers, completion: $0)
    }
  }
  func touch(_ args: JSONValue) async throws -> JSONValue {
    let admitted = ContinuousClock.now
    try args.keys(
      ["points", "fingers", "end", "expectedBundleId", "expectedOrientation"],
      required: ["end"])
    if args["expectedBundleId"] != .null { _ = try args.text("expectedBundleId", max: 256) }
    if args["expectedOrientation"] != .null {
      let expected = try args.text("expectedOrientation", max: 64)
      guard
        [
          "PORTRAIT", "LANDSCAPE", "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
          "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
        ].contains(expected)
      else { throw HelperFailure.invalid("Invalid expected orientation") }
    }
    guard let end = args["end"].number, end >= 0, end <= 10000 else {
      throw HelperFailure.invalid("Invalid gesture duration")
    }
    let fingers: [JSONValue]
    if let list = args["fingers"].array, args["points"] == .null, list.count == 2 {
      fingers = list
    } else if let points = args["points"].array, args["fingers"] == .null {
      fingers = [.array(points)]
    } else {
      throw HelperFailure.invalid("Provide one or two touch paths")
    }
    var paths = [[[NSNumber]]]()
    for finger in fingers {
      guard let points = finger.array, (1...256).contains(points.count) else {
        throw HelperFailure.invalid("Invalid touch path")
      }
      var time = 0.0
      var path = [[NSNumber]]()
      for (i, point) in points.enumerated() {
        guard let p = point.array, p.count == 3, let x = p[0].number, let y = p[1].number,
          let ms = p[2].number, (0...1).contains(x), (0...1).contains(y), ms >= time,
          ms <= end, i != 0 || ms == 0
        else { throw HelperFailure.invalid("Invalid touch point") }
        path.append([NSNumber(value: x), NSNumber(value: y), NSNumber(value: ms)])
        time = ms
      }
      paths.append(path)
    }
    try unlocked()
    let app = try foreground()
    let (value, name) = try orientation(app)
    let size = try geometry(value)
    try InputGuard.check(args, bundle: app.bundleIdentifier, orientation: name)
    try unlocked()
    let started = ContinuousClock.now
    try await playback {
      IPApple.touch(paths, end: end, size: size, orientation: value, completion: $0)
    }
    return .object([
      "completed": .bool(true),
      "timing": .object([
        "guardMs": .number(milliseconds(admitted.duration(to: started))),
        "confirmationMs": .number(50),
        "playbackMs": .number(
          milliseconds(started.duration(to: .now))),
      ]),
    ])
  }
  func execute(_ command: HelperCommand) async throws -> JSONValue {
    let a =
      command.operation.guarded && command.operation != .touch
      ? command.arguments.withoutInputGuards : command.arguments
    if command.operation.guarded && ![.text, .key, .touch].contains(command.operation) {
      try checkInputGuard(command.arguments)
    }
    switch command.operation {
    case .shutdown: return .null  // Handled by the executor before MainActor dispatch.
    case .touch: return try await touch(a)
    case .text:
      try a.keys(["text"], required: ["text"])
      try await keyboard(a.text("text", empty: true), guards: command.arguments)
      return .null
    case .key:
      try a.keys(["key", "modifiers"], required: ["key", "modifiers"])
      let key = try a.text("key", max: 64)
      guard let raw = a["modifiers"].array, raw.count <= 4,
        raw.allSatisfy({ $0.string != nil })
      else { throw HelperFailure.invalid("Invalid key modifiers") }
      let mods = raw.compactMap(\.string)
      guard Set(mods).count == mods.count,
        Set(mods).isSubset(of: ["control", "shift", "option", "command"])
      else { throw HelperFailure.invalid("Invalid key modifiers") }
      let special = [
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Enter",
        "Tab", "Escape", "Home", "End", "PageUp", "PageDown",
      ]
      guard
        special.contains(key)
          || (mods.isEmpty
            ? key.unicodeScalars.count == 1 && key.unicodeScalars.first!.value >= 32
              && key.unicodeScalars.first!.value != 127
            : key.utf8.count == 1 && ("a"..."z").contains(key))
      else { throw HelperFailure.invalid("Unsupported key") }
      try await keyboard(key, key: true, modifiers: mods, guards: command.arguments)
      return .null
    case .home:
      try a.keys([])
      try unlocked()
      _ = try IPApple.protect {
        XCUIDevice.shared.press(.home)
        return true
      }
      return .null
    case .button:
      try a.keys(["name"], required: ["name"])
      try unlocked()
      let name = try a.text("name", max: 32)
      let button: XCUIDevice.Button
      switch name {
      case "home": button = .home
      #if targetEnvironment(simulator)
        case "volumeUp", "volumeDown":
          throw HelperFailure(
            "unsupported operation", "Volume buttons require a physical device")
      #else
        case "volumeUp": button = .volumeUp
        case "volumeDown": button = .volumeDown
      #endif
      default: throw HelperFailure.invalid("Unknown button")
      }
      _ = try IPApple.protect {
        XCUIDevice.shared.press(button)
        return true
      }
      return .null
    case .lock, .unlock:
      try a.keys([])
      let wanted = command.operation == .lock
      guard let current = IPApple.locked()?.boolValue else {
        throw HelperFailure("automation unavailable", "Lock state unavailable")
      }
      if current != wanted {
        if wanted {
          try await playback { IPApple.consumer(0x30, duration: 0.2, completion: $0) }
        } else {
          _ = try IPApple.protect {
            XCUIDevice.shared.press(.home)
            return true
          }
        }
        let until = ContinuousClock.now.advanced(by: .seconds(3))
        while IPApple.locked()?.boolValue != wanted, ContinuousClock.now < until {
          try await Task.sleep(for: .milliseconds(50))
        }
        guard IPApple.locked()?.boolValue == wanted else {
          throw HelperFailure(
            "invalid element state",
            wanted ? "Lock was not confirmed" : "Unlock requires device authentication",
            outcome: "unknown")
        }
      }
      return .null
    case .keepAlive:
      try a.keys([])
      try unlocked()
      try await playback { IPApple.consumer(0x2b0, duration: 0.01, completion: $0) }
      return .object(["completed": .bool(true)])
    case .launch:
      try a.keys(["bundleId"], required: ["bundleId"])
      try unlocked()
      let id = try a.text("bundleId", max: 256)
      try IPApple.activate(XCUIApplication(bundleIdentifier: id))
      return .null
    case .siri:
      try a.keys(["text"], required: ["text"])
      try unlocked()
      let text = try a.text("text")
      _ = try IPApple.protect {
        XCUIDevice.shared.siriService.activate(voiceRecognitionText: text)
        return true
      }
      return .null
    case .openURL:
      try a.keys(["url"], required: ["url"])
      let url = try WebURL.parse(a.text("url", max: 8192))
      try unlocked()
      _ = try IPApple.protect {
        XCUIDevice.shared.system.open(url)
        return true
      }
      return .null
    case .state, .app, .orientation, .geometry:
      try a.keys([])
      let app = try foreground()
      let (value, name) = try orientation(app)
      let size = try geometry(value)
      let screen = JSONValue.object([
        "width": .number(size.width), "height": .number(size.height),
      ])
      switch command.operation {
      case .app: return appInfo(app)
      case .orientation: return .string(name)
      case .geometry: return screen
      default:
        return .object([
          "locked": IPApple.locked().map { .bool($0.boolValue) } ?? .null,
          "app": appInfo(app), "orientation": .string(name), "screen": screen,
        ])
      }
    case .elements:
      try a.keys(["using", "value"], required: ["using", "value"])
      try unlocked()
      return try inspection.find(a, app: foreground())
    case .attribute:
      try a.keys(["id", "name"], required: ["id", "name"])
      try unlocked()
      return try inspection.attribute(
        a.text("id", max: 256), name: a.text("name", max: 64), app: foreground())
    case .elementAction:
      try unlocked()
      let app = try foreground()
      let (element, _) = try inspection.resolve(a.text("id", max: 256), app: app)
      let action = try a.text("action", max: 32)
      let editorTypes: [XCUIElement.ElementType] = [.textField, .secureTextField, .textView, .searchField]
      let editable = editorTypes.contains(element.elementType)
      guard try withApple({ element.isEnabled && element.isHittable }) else {
        throw HelperFailure("element not actionable", "Element is not currently actionable")
      }
      if ["focus", "replaceText"].contains(action), !editable {
        throw HelperFailure("unsupported operation", "Element is not an editable text field")
      }
      if ["adjust", "increment", "decrement"].contains(action), element.elementType != .slider {
        throw HelperFailure("unsupported operation", "Element is not a slider")
      }
      // Password insertion keeps its existing specialized keyboard path. Do
      // not claim generic replacement semantics for masked/secure values.
      if action == "replaceText", element.elementType == .secureTextField {
        throw HelperFailure("unsupported operation", "Use keyboard input for password fields")
      }
      var dispatched = false
      do {
        var guards = command.arguments.object ?? [:]
        guards["expectedBundleId"] = .string(app.bundleIdentifier)
        func validateTarget() throws {
          try self.unlocked()
          try self.checkInputGuard(.object(guards))
        }
        try validateTarget()
        switch action {
        case "focus", "replaceText":
          if try !IPApple.keyboardFocused(element).boolValue {
            dispatched = true
            try withApple { element.tap() }
          }
          if action == "replaceText" {
            let text = try a.text("text", empty: true)
            try validateTarget()
            dispatched = true
            try await playback {
              IPApple.keyboard("a", key: true, modifiers: ["command"], element: element, completion: $0)
            }
            try validateTarget()
            try await playback {
              IPApple.keyboard(text.isEmpty ? "Backspace" : text, key: text.isEmpty,
                modifiers: [], element: element, completion: $0)
            }
          }
        case "adjust", "increment", "decrement":
          let value = action == "adjust" ? a["value"].number!
            : try SliderAdjustment.relativePosition(
              Double(try withApple { element.normalizedSliderPosition }), increment: action == "increment")
          dispatched = true
          try withApple { element.adjust(toNormalizedSliderPosition: CGFloat(min(1, max(0, value)))) }
        case "doubleTap":
          dispatched = true
          try withApple { element.doubleTap() }
        case "longPress":
          dispatched = true
          try withApple { element.press(forDuration: 0.6) }
        default: throw HelperFailure.invalid("Unknown element action")
        }
      } catch let error as HelperFailure {
        throw HelperFailure(error.code, error.message, outcome: dispatched ? "unknown" : error.outcome)
      } catch {
        throw HelperFailure("unknown error", "Element action could not be confirmed", outcome: dispatched ? "unknown" : "notExecuted")
      }
      return .null
    case .tapElement, .typeElement:
      try a.keys(
        command.operation == .typeElement ? ["id", "text"] : ["id"],
        required: command.operation == .typeElement ? ["id", "text"] : ["id"])
      try unlocked()
      let app = try foreground()
      let (element, _) = try inspection.resolve(a.text("id", max: 256), app: app)
      guard try withApple({ element.isEnabled && element.isHittable }) else {
        throw HelperFailure("element not actionable", "Element is not currently actionable")
      }
      // XCTest chooses a reachable hit point for partially occluded
      // elements. A frame-center tap is not equivalent to an element action.
      guard try foreground().bundleIdentifier == app.bundleIdentifier else {
        throw HelperFailure("app changed", "Foreground application changed")
      }
      try withApple { element.tap() }
      if command.operation == .typeElement {
        do {
          var guards = command.arguments.object ?? [:]
          guards["expectedBundleId"] = .string(app.bundleIdentifier)
          try await keyboard(a.text("text", empty: true), guards: .object(guards))
        } catch let error as HelperFailure {
          // The tap is already a side effect even if text validation fails.
          throw HelperFailure(error.code, error.message, outcome: "unknown")
        } catch {
          throw HelperFailure(
            "unknown error", "Typing failed after focusing the element", outcome: "unknown")
        }
      }
      return .null
    case .source:
      try a.keys(["format"], required: ["format"])
      try unlocked()
      let app = try foreground()
      let format = try a.text("format", max: 32)
      switch format {
      case "description": return try withApple { .string(app.debugDescription) }
      case "json": return try inspection.snapshot(app).json
      case "xml":
        return .string(
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + (try inspection.snapshot(app).xml()))
      default: throw HelperFailure.invalid("Unknown source format")
      }
    case .screenshot:
      try a.keys(["id"])
      try unlocked()
      let data: Data
      if a["id"] != .null {
        let element = try inspection.resolve(a.text("id", max: 256), app: foreground()).0
        data = try withApple { element.screenshot().pngRepresentation }
      } else {
        data = try withApple { XCUIScreen.main.screenshot().pngRepresentation }
      }
      return .string(data.base64EncodedString())
    case .clipboardPrepare:
      try a.keys([])
      return try withApple { try self.clipboard.prepare() }
    case .clipboardRead, .clipboardWrite, .clipboardStatus, .clipboardRestore, .clipboardCancel:
      return try withApple { try self.clipboard.transfer(command.operation, args: a) }
    case .portal:
      try a.keys([])
      guard let snapshot = IPPortalStatus.shared().snapshot() else {
        throw HelperFailure("helper unavailable", "Status unavailable")
      }
      return try JSONValue.from(snapshot)
    case .presence:
      try a.keys(["ready", "keepAwakeMs"], required: ["ready", "keepAwakeMs"])
      guard let ready = a["ready"].bool, let ms = a["keepAwakeMs"].number,
        (0...7_200_000).contains(ms)
      else { throw HelperFailure.invalid("Invalid presence") }
      guard let snapshot = IPPortalStatus.shared().updateReady(ready, keepAwakeMs: ms) else {
        throw HelperFailure("helper unavailable", "Status unavailable")
      }
      return try JSONValue.from(snapshot)
    case .quality:
      try a.keys(["preset"], required: ["preset"])
      try media.configure(a.text("preset", max: 16))
      return .null
    }
  }
}

@MainActor extension XCUIApplication {
  var bundleIdentifier: String { IPApple.bundleIdentifier(self) }
}

@MainActor func withApple<T>(_ body: @escaping () throws -> T) throws -> T {
  var result: Result<T, Error>?
  _ = try IPApple.protect {
    result = Result { try body() }
    return true
  }
  guard let result else {
    throw HelperFailure("unknown error", "Apple operation returned no result")
  }
  return try result.get()
}

private func milliseconds(_ value: Duration) -> Double {
  Double(value.components.seconds) * 1000 + Double(value.components.attoseconds) / 1e15
}
