import Foundation
import Network

// This file is shared by the runner and host-side native contract tests.
enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])
  init(from decoder: Decoder) throws {
    guard decoder.codingPath.count <= 64 else {
      throw HelperFailure.invalid("JSON nesting exceeds limit")
    }
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self), v.isFinite {
      self = .number(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }
  var object: [String: JSONValue]? {
    if case .object(let v) = self { return v }
    return nil
  }
  var array: [JSONValue]? {
    if case .array(let v) = self { return v }
    return nil
  }
  var string: String? {
    if case .string(let v) = self { return v }
    return nil
  }
  var number: Double? {
    if case .number(let v) = self { return v }
    return nil
  }
  var bool: Bool? {
    if case .bool(let v) = self { return v }
    return nil
  }
  subscript(_ key: String) -> JSONValue { object?[key] ?? .null }
  static func from(_ value: Any) throws -> JSONValue {
    try JSONDecoder().decode(
      JSONValue.self,
      from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
  }
  var foundation: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let v): return v
    case .number(let v): return v
    case .string(let v): return v
    case .array(let v): return v.map(\.foundation)
    case .object(let v): return v.mapValues(\.foundation)
    }
  }
}

struct HelperFailure: Error, Codable, Equatable, Sendable {
  let code: String
  let message: String
  let outcome: String
  init(_ code: String, _ message: String, outcome: String = "notExecuted") {
    self.code = code
    self.message = message
    self.outcome = outcome
  }
  static func invalid(_ message: String) -> Self { .init("invalid argument", message) }
}

enum Operation: String, Codable, CaseIterable, Sendable {
  case touch, text, key, home, button, lock, unlock, launch, openURL, siri, keepAlive
  case state, app, orientation, geometry, elements, attribute, tapElement, typeElement, source,
    screenshot
  case clipboardPrepare, clipboardRead, clipboardWrite, clipboardStatus, clipboardRestore,
    clipboardCancel
  case presence, portal, quality, shutdown
  var guarded: Bool {
    [
      .touch, .text, .key, .tapElement, .typeElement, .home, .button, .lock, .unlock, .launch,
      .openURL, .siri,
    ].contains(self)
  }
  var mutates: Bool {
    switch self {
    case .state, .app, .orientation, .geometry, .elements, .attribute, .source, .screenshot,
      .clipboardStatus, .portal, .presence, .quality:
      return false
    default: return true
    }
  }
}

struct HelperCommand: Codable, Sendable {
  let id: String
  let generation: String
  let budgetMs: Int
  let operation: Operation
  let arguments: JSONValue

  static func decode(_ data: Data) throws -> Self {
    guard data.count <= 6 * 1024 * 1024 else {
      throw HelperFailure.invalid("Request too large")
    }
    let raw = try JSONDecoder().decode(JSONValue.self, from: data)
    guard let obj = raw.object,
      Set(obj.keys) == ["id", "generation", "budgetMs", "operation", "arguments"]
    else {
      throw HelperFailure.invalid("Invalid command envelope")
    }
    let command = try JSONDecoder().decode(Self.self, from: data)
    guard (1...128).contains(command.id.utf8.count),
      UUID(uuidString: command.generation) != nil,
      (1...60000).contains(command.budgetMs), command.arguments.object != nil
    else {
      throw HelperFailure.invalid("Invalid command identity or budget")
    }
    try command.operation.validate(command.arguments)
    return command
  }
}

struct HelperReply: Codable, Sendable {
  let id: String
  let generation: String
  let result: JSONValue?
  let error: HelperFailure?
}

enum HelperProtocol {
  static let version = 1
  static var build: String {
    #if os(iOS)
      return Bundle(for: HelperBundleMarker.self).object(
        forInfoDictionaryKey: "IPortalHelperBuildID") as? String ?? "native-1"
    #else
      return "native-1"
    #endif
  }
  static func authorized(_ headers: [(String, String)], token: String) -> Bool {
    guard token.count == 64, token.allSatisfy({ "0123456789abcdef".contains($0) }) else {
      return false
    }
    let names = headers.map { $0.0.lowercased() }
    guard !names.contains("origin"), !names.contains("sec-fetch-site"),
      names.filter({ $0 == "authorization" }).count == 1
    else { return false }
    let expected = Array("Bearer \(token)".utf8)
    let actual = Array((headers.first { $0.0.lowercased() == "authorization" }?.1 ?? "").utf8)
    guard expected.count == actual.count else { return false }
    return zip(expected, actual).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
  }
}

extension JSONValue {
  var withoutInputGuards: JSONValue {
    .object(
      (object ?? [:]).filter { !["expectedBundleId", "expectedOrientation"].contains($0.key) })
  }
  func keys(_ allowed: Set<String>, required: Set<String> = []) throws {
    guard let obj = object, Set(obj.keys).isSubset(of: allowed),
      required.isSubset(of: Set(obj.keys))
    else { throw HelperFailure.invalid("Unexpected or missing arguments") }
  }
  func text(_ key: String, max: Int = 10000, empty: Bool = false) throws -> String {
    guard let v = self[key].string, v.utf16.count <= max, empty || !v.isEmpty else {
      throw HelperFailure.invalid("Invalid \(key)")
    }
    return v
  }
}

private final class HelperBundleMarker: NSObject {}

// Wire validation is independent of XCTest and runs before queue admission.
// The same corpus is decoded by Effect on the Mac and this native boundary.
extension Operation {
  private enum Field {
    case string(Int, Bool)
    case oneOf(Set<String>)
    case number(Double, Double, Bool)
    case boolean
    func validate(_ value: JSONValue) -> Bool {
      switch self {
      case .string(let max, let empty):
        guard let text = value.string else { return false }
        return text.utf16.count <= max && (empty || !text.isEmpty)
      case .oneOf(let values): return value.string.map(values.contains) ?? false
      case .number(let min, let max, let integral):
        guard let n = value.number else { return false }
        return n.isFinite && n >= min && n <= max && (!integral || n.rounded() == n)
      case .boolean: return value.bool != nil
      }
    }
  }
  func validate(_ input: JSONValue) throws {
    if guarded { try InputGuard.validateShape(input) }
    let args = guarded && self != .touch ? input.withoutInputGuards : input
    let id = Field.string(256, false)
    let text = Field.string(10000, true)
    var required: [String: Field] = [:]
    var optional: [String: Field] = [:]
    switch self {
    case .home, .lock, .unlock, .keepAlive, .state, .app, .orientation, .geometry, .shutdown,
      .clipboardPrepare, .clipboardStatus, .portal:
      break
    case .text: required = ["text": text]
    case .siri: required = ["text": .string(10000, false)]
    case .button: required = ["name": .oneOf(["home", "volumeUp", "volumeDown"])]
    case .launch: required = ["bundleId": id]
    case .openURL: required = ["url": .string(8192, false)]
    case .elements:
      required = [
        "using": .oneOf([
          "id", "name", "accessibility id", "class name", "predicate string",
          "class chain", "xpath",
        ]), "value": .string(8192, false),
      ]
    case .attribute:
      required = [
        "id": id,
        "name": .oneOf([
          "type", "name", "label", "value", "enabled", "visible", "selected", "hittable",
          "accessible", "rect",
        ]),
      ]
    case .tapElement: required = ["id": id]
    case .typeElement: required = ["id": id, "text": text]
    case .source: required = ["format": .oneOf(["json", "xml", "description"])]
    case .screenshot: optional = ["id": id]
    case .clipboardRead, .clipboardRestore, .clipboardCancel: required = ["lease": id]
    case .clipboardWrite:
      required = [
        "lease": id, "format": .oneOf(["text", "url", "image"]),
        "content": .string(5_592_408, true),
      ]
    case .presence: required = ["ready": .boolean, "keepAwakeMs": .number(0, 7_200_000, true)]
    case .quality: required = ["preset": .oneOf(["low", "balanced", "high"])]
    case .key:
      try args.keys(["key", "modifiers"], required: ["key", "modifiers"])
      let key = try args.text("key", max: 64)
      guard let raw = args["modifiers"].array, raw.count <= 4 else {
        throw HelperFailure.invalid("Invalid modifiers")
      }
      let mods = raw.compactMap(\.string)
      guard mods.count == raw.count, Set(mods).count == mods.count,
        Set(mods).isSubset(of: ["command", "control", "option", "shift"])
      else { throw HelperFailure.invalid("Invalid modifiers") }
      let special = [
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Enter",
        "Tab", "Escape", "Home", "End", "PageUp", "PageDown",
      ]
      let printable =
        key.unicodeScalars.count == 1 && key.unicodeScalars.first!.value >= 32
        && key.unicodeScalars.first!.value != 127
      guard
        special.contains(key)
          || (mods.isEmpty ? printable : key.utf8.count == 1 && ("a"..."z").contains(key))
      else { throw HelperFailure.invalid("Unsupported key") }
      return
    case .touch:
      try args.keys(
        ["points", "fingers", "end", "expectedBundleId", "expectedOrientation"],
        required: ["end"])
      guard let end = args["end"].number, end >= 0, end <= 10000 else {
        throw HelperFailure.invalid("Invalid duration")
      }
      let fingers: [JSONValue]
      if let points = args.object?["points"], args.object?["fingers"] == nil {
        fingers = [points]
      } else if let paths = args["fingers"].array, paths.count == 2,
        args.object?["points"] == nil
      {
        fingers = paths
      } else {
        throw HelperFailure.invalid("Provide one or two paths")
      }
      for finger in fingers {
        guard let points = finger.array, (1...256).contains(points.count) else {
          throw HelperFailure.invalid("Invalid path")
        }
        var previous = 0.0
        for (index, point) in points.enumerated() {
          guard let p = point.array, p.count == 3, let x = p[0].number,
            let y = p[1].number, let ms = p[2].number, (0...1).contains(x),
            (0...1).contains(y), ms >= previous, ms <= end, index != 0 || ms == 0
          else { throw HelperFailure.invalid("Invalid point") }
          previous = ms
        }
      }
      if let value = args.object?["expectedBundleId"], !id.validate(value) {
        throw HelperFailure.invalid("Invalid bundle")
      }
      if let value = args.object?["expectedOrientation"],
        !Field.oneOf([
          "PORTRAIT", "LANDSCAPE", "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
          "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
        ]).validate(value)
      {
        throw HelperFailure.invalid("Invalid orientation")
      }
      return
    }
    try args.keys(Set(required.keys).union(optional.keys), required: Set(required.keys))
    for (key, rule) in required {
      guard rule.validate(args[key]) else { throw HelperFailure.invalid("Invalid \(key)") }
    }
    for (key, rule) in optional {
      if let value = args.object?[key], !rule.validate(value) {
        throw HelperFailure.invalid("Invalid \(key)")
      }
    }
    if self == .openURL { _ = try WebURL.parse(args.text("url", max: 8192)) }
  }
}

enum WebURL {
  static func parse(_ value: String) throws -> URL {
    // Match the Effect boundary; do not let Foundation repair a different
    // URL before handing it to the system (or accept a custom/action scheme).
    guard !value.isEmpty, value.utf16.count <= 8192,
      value.unicodeScalars.allSatisfy({ (33...126).contains($0.value) }),
      !value.contains("\\"),
      value.range(of: "%(?![0-9a-fA-F]{2})", options: .regularExpression) == nil,
      let prefix = value.range(of: "^https?://", options: [.regularExpression, .caseInsensitive])
    else {
      throw HelperFailure.invalid("Provide an absolute HTTP or HTTPS URL without credentials")
    }
    let authority = value[prefix.upperBound...].prefix { !"/?#".contains($0) }
    guard
      authority.range(
        of: "^(?:\\[[0-9a-fA-F:.]+\\]|[a-zA-Z0-9._-]+)(?::[0-9]+)?$", options: .regularExpression)
        != nil
    else { throw HelperFailure.invalid("Invalid web URL host or port") }
    if authority.first == "[" {
      guard let end = authority.firstIndex(of: "]"),
        IPv6Address(String(authority[authority.index(after: authority.startIndex)..<end])) != nil
      else { throw HelperFailure.invalid("Invalid IPv6 address") }
    }
    if let colon = authority.lastIndex(of: ":"), authority.last != "]" {
      guard let port = Int(authority[authority.index(after: colon)...]), (1...65535).contains(port)
      else { throw HelperFailure.invalid("Invalid web URL port") }
    }
    guard
      let components = URLComponents(string: value),
      let host = components.host, !host.isEmpty,
      components.user == nil, components.password == nil,
      components.port.map({ (1...65535).contains($0) }) ?? true,
      let url = components.url
    else {
      throw HelperFailure.invalid("Provide an absolute HTTP or HTTPS URL without credentials")
    }
    // WHATWG parses number-ending hosts as IPv4, while Foundation accepts
    // malformed numeric hosts as DNS names. Match that distinction before
    // dispatch, including conventional shortened/hexadecimal IPv4 forms.
    let numericHost = host.hasSuffix(".") ? String(host.dropLast()) : host
    let last = numericHost.split(separator: ".", omittingEmptySubsequences: false).last ?? ""
    let numberEnding =
      !last.isEmpty
      && (last.allSatisfy(\.isNumber)
        || (last.lowercased().hasPrefix("0x") && last.dropFirst(2).allSatisfy(\.isHexDigit)))
    if authority.first != "[", numberEnding {
      let parts = numericHost.split(separator: ".", omittingEmptySubsequences: false)
      guard (1...4).contains(parts.count) else {
        throw HelperFailure.invalid("Invalid IPv4 address")
      }
      for (index, part) in parts.enumerated() {
        var digits = part
        var radix = 10
        if part.lowercased().hasPrefix("0x") {
          digits = part.dropFirst(2)
          radix = 16
        } else if part.count > 1, part.first == "0" {
          digits = part.dropFirst()
          radix = 8
        }
        let number = digits.isEmpty ? 0 : UInt64(digits, radix: radix)
        let limit: UInt64 = index == parts.count - 1 ? (1 << (8 * (5 - parts.count))) : 256
        guard !part.isEmpty, let number, number < limit else {
          throw HelperFailure.invalid("Invalid IPv4 address")
        }
      }
    }
    return url
  }
}

enum InputGuard {
  static let orientations: Set<String> = [
    "PORTRAIT", "LANDSCAPE",
    "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT", "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
  ]
  static func validateShape(_ args: JSONValue) throws {
    if args.object?["expectedBundleId"] != nil { _ = try args.text("expectedBundleId", max: 256) }
    if args.object?["expectedOrientation"] != nil {
      guard let value = args["expectedOrientation"].string, orientations.contains(value) else {
        throw HelperFailure.invalid("Invalid expected orientation")
      }
    }
  }
  static func check(_ args: JSONValue, bundle: String, orientation: String) throws {
    if let expected = args["expectedBundleId"].string, expected != bundle {
      throw HelperFailure("app changed", "Foreground application changed")
    }
    if let expected = args["expectedOrientation"].string, expected != orientation {
      throw HelperFailure("orientation changed", "Orientation changed")
    }
  }
}
