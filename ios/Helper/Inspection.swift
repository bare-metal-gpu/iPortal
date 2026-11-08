import Foundation
import UIKit
import XCTest

@MainActor final class HelperInspection {
  struct Node {
    let native: any XCUIElementSnapshot
    let bindingKey: String
    let path: [Int]
    let attributes: [String: JSONValue]
    let children: [Node]
    let sourceAttributes: [String: JSONValue]
    let xmlAttributes: [String: JSONValue]
    var flat: [Node] { SelectorIndex.preorder(self, children: \.children) }
    var type: String { attributes["type"]?.string ?? "XCUIElementTypeOther" }
    var identity: [JSONValue] {
      [
        attributes["type"] ?? .null, attributes["identifier"] ?? .null,
        attributes["label"] ?? .null,
      ]
    }
    var key: String { path.map(String.init).joined(separator: ".") }
    var json: JSONValue {
      .object(
        sourceAttributes.merging(["children": .array(children.map(\.json))]) { _, new in new
        })
    }
    func xml(internalIDs: Bool = false) -> String {
      func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(
          of: "<", with: "&lt;"
        ).replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(
          of: "\"", with: "&quot;"
        ).replacingOccurrences(of: "'", with: "&apos;")
      }
      let pairs = xmlAttributes.sorted { $0.key < $1.key }.compactMap {
        key, value -> String? in
        let string: String
        switch value {
        case .string(let v): string = v
        case .bool(let v): string = v ? "true" : "false"
        case .number(let v):
          string =
            v.rounded() == v && abs(v) < Double(Int64.max)
            ? String(Int64(v)) : String(v)
        default: return nil
        }
        return "\(key)=\"\(escaped(string))\""
      }
      return
        "<\(type) \(internalIDs ? "iportalId=\"\(key)\" " : "")\(pairs.joined(separator:" "))>\(children.map { $0.xml(internalIDs:internalIDs) }.joined())</\(type)>"
    }
  }
  struct Handle {
    let bundle: String
    let element: XCUIElement
    let key: String
    let identity: [JSONValue]
    let created: ContinuousClock.Instant
  }
  private var handles: [String: Handle] = [:]
  private var order: [String] = []
  private var handleKeys: [String: String] = [:]

  func snapshot(_ app: XCUIApplication, flags: Bool = true) throws -> Node {
    try withApple { try self.acquire(app, flags: flags) }
  }
  private func acquire(_ app: XCUIApplication, flags: Bool) throws -> Node {
    let basic = try app.snapshot()
    let root = flags ? try IPApple.snapshotAttributes(basic) : basic
    return try normalize(root, app: app)
  }
  private func normalize(_ root: any XCUIElementSnapshot, app: XCUIApplication) throws -> Node {
    var count = 0
    var textBytes = 0
    let screen = app.frame
    func node(_ snapshot: any XCUIElementSnapshot, path: [Int], depth: Int) throws -> Node {
      count += 1
      guard depth <= 50, count <= 10000 else {
        throw HelperFailure("snapshot limit", "UI tree exceeds inspection limits")
      }
      let raw = snapshot.frame
      let f = raw.integral
      textBytes +=
        snapshot.label.utf8.count + snapshot.identifier.utf8.count
        + String(describing: snapshot.value ?? "").utf8.count
      guard textBytes <= 8 * 1024 * 1024 else {
        throw HelperFailure("snapshot limit", "UI tree exceeds inspection limits")
      }
      let name = snapshot.identifier.isEmpty ? snapshot.label : snapshot.identifier
      let value: JSONValue = snapshot.value.flatMap { try? JSONValue.from($0) } ?? .null
      let visible =
        IPApple.snapshotFlag(snapshot, name: "isVisible")?.boolValue
        ?? (!f.isEmpty && f.intersects(screen))
      let attributes: [String: JSONValue] = [
        "type": .string(
          elementTypeNames[snapshot.elementType.rawValue] ?? "XCUIElementTypeOther"),
        "identifier": .string(snapshot.identifier),
        "name": name.isEmpty ? .null : .string(name), "label": .string(snapshot.label),
        "value": value,
        "enabled": .bool(snapshot.isEnabled), "selected": .bool(snapshot.isSelected),
        "visible": .bool(visible),
        "accessible": .bool(
          IPApple.snapshotFlag(snapshot, name: "isAccessibilityElement")?.boolValue
            ?? false),
        "rect": .object([
          "x": .number(f.minX), "y": .number(f.minY), "width": .number(f.width),
          "height": .number(f.height),
        ]),
        "x": .number(f.minX), "y": .number(f.minY), "width": .number(f.width),
        "height": .number(f.height), "index": .number(Double(path.last ?? 0)),
      ]
      let extras = IPApple.snapshotExtras(snapshot)
      let source: [String: JSONValue] = [
        "type": .string(
          String((attributes["type"]?.string ?? "XCUIElementTypeOther").dropFirst(15))),
        "label": snapshot.label.isEmpty ? .null : .string(snapshot.label), "value": value,
        "name": attributes["name"]!,
        "rawIdentifier": snapshot.identifier.isEmpty ? .null : .string(snapshot.identifier),
        "frame": .string(NSCoder.string(for: f)),
        "nativeFrame": .string(NSCoder.string(for: raw)), "rect": attributes["rect"]!,
        "isEnabled": .string(snapshot.isEnabled ? "1" : "0"),
        "isVisible": .string(visible ? "1" : "0"),
        "isAccessible": .string(attributes["accessible"]?.bool == true ? "1" : "0"),
        "isNativeAccessibilityElement": .string(
          attributes["accessible"]?.bool == true ? "1" : "0"),
        "isFocused": .string((extras["focused"] as? Bool) == true ? "1" : "0"),
        "traits": .string(extras["traits"] as? String ?? ""),
        "customActions": (try? JSONValue.from(extras["customActions"] ?? NSNull()))
          ?? .null,
      ]
      var xmlAttributes = attributes.filter {
        [
          "type", "value", "name", "label", "enabled", "visible", "accessible", "x", "y",
          "width", "height", "index",
        ].contains($0.key)
      }
      if snapshot.label.isEmpty
        && ![XCUIElement.ElementType.textField, .secureTextField, .textView].contains(
          snapshot.elementType)
      {
        xmlAttributes.removeValue(forKey: "label")
      }
      xmlAttributes["traits"] = source["traits"]
      if let placeholder = snapshot.placeholderValue, !placeholder.isEmpty {
        xmlAttributes["placeholderValue"] = .string(placeholder)
      }
      if snapshot.elementType == .application {
        let info = IPApple.applicationInfo(app)
        xmlAttributes["bundleId"] = (info["bundleId"] as? String).map(JSONValue.string)
        xmlAttributes["processId"] = (info["pid"] as? NSNumber).map {
          .number($0.doubleValue)
        }
      }
      return Node(
        native: snapshot, bindingKey: try IPApple.snapshotIdentity(snapshot),
        path: path, attributes: attributes,
        children: try snapshot.children.enumerated().map {
          try node($0.element, path: path + [$0.offset], depth: depth + 1)
        }, sourceAttributes: source, xmlAttributes: xmlAttributes)
    }
    return try node(root, path: [], depth: 0)
  }
  func find(_ selector: JSONValue, app: XCUIApplication) throws -> JSONValue {
    try selector.keys(["using", "value"], required: ["using", "value"])
    let strategy = try selector.text("using", max: 64)
    let value = try selector.text("value", max: 8192)
    // Keep enriched snapshots: every returned element carries visibility
    // and accessibility flags, and native queries do not share our name
    // fallback, root inclusion, duplicate ordering or XPath path identity.
    let root = try snapshot(app)
    var validatedPredicates = Set<String>()
    func evaluate(_ expression: String, _ node: Node) throws -> Bool {
      try predicate(expression, node: node, validated: &validatedPredicates)
    }
    let matches: [Node]
    switch strategy {
    case "id", "name", "accessibility id":
      matches = root.flat.filter { $0.attributes["name"]?.string == value }
    case "class name": matches = root.flat.filter { $0.type == value }
    case "predicate string": matches = try root.flat.filter { try evaluate(value, $0) }
    case "class chain":
      var current = [root]
      for step in try ClassChain.parse(value) {
        current = try current.flatMap { parent -> [Node] in
          var candidates =
            (step.descendants ? parent.children.flatMap(\.flat) : parent.children)
            .filter { step.type == "*" || $0.type == step.type }
          for filter in step.filters {
            switch filter {
            case .index(let index):
              let i = index > 0 ? index - 1 : candidates.count + index
              candidates = candidates.indices.contains(i) ? [candidates[i]] : []
            case .predicate(let expression, let descendants):
              candidates = try candidates.filter { node in
                if descendants {
                  return try node.children.flatMap(\.flat).contains {
                    try evaluate(expression, $0)
                  }
                }
                return try evaluate(expression, node)
              }
            }
          }
          return candidates
        }
        var seen = Set<String>()
        current = current.filter { seen.insert($0.key).inserted }
      }
      matches = current
    case "xpath":
      let ids: [String]
      do { ids = try IPApple.xpath(value, xml: root.xml(internalIDs: true)) } catch {
        throw HelperFailure("invalid selector", "Invalid XPath selector")
      }
      let nodes = try SelectorIndex.build(root.flat, key: \.key)
      matches = ids.compactMap { nodes[$0] }
    default: throw HelperFailure.invalid("Unsupported selector")
    }
    let bundle = app.bundleIdentifier
    return .array(
      try matches.map { node in
        let key = bundle + ":" + node.bindingKey + ":" + node.key
        let existing = handleKeys[key].flatMap {
          handles[$0]?.identity == node.identity ? $0 : nil
        }
        let id = existing ?? UUID().uuidString
        let element =
          try existing.flatMap { handles[$0]?.element }
          ?? IPApple.element(for: node.native, application: app)
        handles[id] = Handle(
          bundle: bundle, element: element, key: node.bindingKey, identity: node.identity,
          created: .now)
        if existing == nil {
          handleKeys[key] = id
          order.append(id)
        }
        while order.count > 2048 {
          let removed = order.removeFirst()
          handles.removeValue(forKey: removed)
          handleKeys = handleKeys.filter { $0.value != removed }
        }
        return .object(["id": .string(id), "attributes": .object(node.attributes)])
      })
  }
  private func predicate(_ source: String, node: Node, validated: inout Set<String>) throws -> Bool
  {
    // Foundation predicates only inspect normalized scalar data. Reject
    // object construction/function dispatch, which is not a UI selector.
    if validated.insert(source).inserted { try PredicateSyntax.validate(source) }
    do {
      return try IPApple.predicate(source, matches: node.attributes.mapValues(\.foundation))
        .boolValue
    } catch { throw HelperFailure("invalid selector", "Invalid predicate selector") }
  }
  func resolve(_ id: String, app: XCUIApplication, flags: Bool = false) throws -> (
    XCUIElement, Node
  ) {
    try withApple { try self.resolveUnsafe(id, app: app, flags: flags) }
  }
  private func resolveUnsafe(_ id: String, app: XCUIApplication, flags: Bool) throws -> (
    XCUIElement, Node
  ) {
    guard let handle = handles[id], handle.bundle == app.bundleIdentifier,
      handle.created.duration(to: .now) < .seconds(60)
    else { throw HelperFailure("stale element reference", "Element handle expired") }
    let element = handle.element
    guard element.exists else {
      throw HelperFailure("stale element reference", "Element no longer exists")
    }
    let basic = try element.snapshot()
    let native = flags ? try IPApple.snapshotAttributes(basic) : basic
    let node = try normalize(native, app: app)
    guard node.identity == handle.identity, node.bindingKey == handle.key else {
      throw HelperFailure("stale element reference", "Element changed")
    }
    return (element, node)
  }
  func attribute(_ id: String, name: String, app: XCUIApplication) throws -> JSONValue {
    let (element, node) = try resolve(
      id, app: app, flags: name == "visible" || name == "accessible")
    if name == "hittable" { return try withApple { .bool(element.isHittable) } }
    guard let value = node.attributes[name] else {
      throw HelperFailure.invalid("Unsupported attribute")
    }
    return value
  }
}
