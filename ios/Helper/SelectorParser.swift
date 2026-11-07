import Foundation

// Snapshot paths are unique even when Apple reuses an accessibility identifier.
// Malformed snapshots must become API errors, never Dictionary precondition traps.
enum SelectorIndex {
  // Iterative preorder preserves the existing accessibility order and root
  // inclusion without allocating a flattened array at every ancestor.
  static func preorder<Element>(_ root: Element, children: (Element) -> [Element]) -> [Element] {
    var pending = [root]
    var result: [Element] = []
    while let element = pending.popLast() {
      result.append(element)
      pending.append(contentsOf: children(element).reversed())
    }
    return result
  }
  static func build<Element>(_ elements: [Element], key: (Element) -> String) throws -> [String:
    Element]
  {
    var result: [String: Element] = [:]
    for element in elements {
      guard result.updateValue(element, forKey: key(element)) == nil else {
        throw HelperFailure("invalid snapshot", "Snapshot contains duplicate paths")
      }
    }
    return result
  }
}

struct ChainStep: Equatable, Sendable {
  enum Filter: Equatable, Sendable {
    case index(Int)
    case predicate(String, descendants: Bool)
  }
  let descendants: Bool
  let type: String
  let filters: [Filter]
}

// A bounded parser, rather than splitting on slash/bracket characters that can
// also occur inside a quoted predicate. Indexes are one-based; negatives count
// from the end of the current parent's matching children.
enum ClassChain {
  static func parse(_ source: String) throws -> [ChainStep] {
    guard !source.isEmpty, source.utf16.count <= 8192 else {
      throw HelperFailure("invalid selector", "Invalid class chain")
    }
    let text = Array(source)
    var i = 0
    var result: [ChainStep] = []
    func fail() -> HelperFailure { .init("invalid selector", "Malformed class chain") }
    while i < text.count {
      var descendants = false
      if i + 2 < text.count, String(text[i...i + 2]) == "**/" {
        descendants = true
        i += 3
      }
      let start = i
      while i < text.count, text[i] != "[", text[i] != "/" { i += 1 }
      let type = String(text[start..<i])
      guard
        type == "*"
          || type.hasPrefix("XCUIElementType")
            && type.dropFirst(15).allSatisfy({ $0.isLetter || $0.isNumber }),
        !type.isEmpty
      else { throw fail() }
      var filters: [ChainStep.Filter] = []
      while i < text.count, text[i] == "[" {
        i += 1
        guard i < text.count else { throw fail() }
        if text[i] == "`" || text[i] == "$" {
          let marker = text[i]
          i += 1
          var predicate = ""
          var closed = false
          while i < text.count {
            if text[i] == marker {
              if i + 1 < text.count, text[i + 1] == marker {
                predicate.append(marker)
                i += 2
                continue
              }
              i += 1
              closed = true
              break
            }
            predicate.append(text[i])
            i += 1
          }
          guard closed, !predicate.isEmpty, i < text.count, text[i] == "]" else {
            throw fail()
          }
          filters.append(.predicate(predicate, descendants: marker == "$"))
          i += 1
        } else {
          let start = i
          while i < text.count, text[i] != "]" { i += 1 }
          guard i < text.count, let index = Int(String(text[start..<i])), index != 0
          else { throw fail() }
          filters.append(.index(index))
          i += 1
        }
        guard filters.count <= 16 else { throw fail() }
      }
      result.append(ChainStep(descendants: descendants, type: type, filters: filters))
      guard result.count <= 64 else { throw fail() }
      if i < text.count {
        guard text[i] == "/", i + 1 < text.count else { throw fail() }
        i += 1
      }
    }
    return result
  }
}

// Strip quoted literals before checking dispatch-capable predicate syntax.
// A visible label such as "FUNCTION(" remains a valid literal match.
enum PredicateSyntax {
  static func validate(_ source: String) throws {
    let chars = Array(source)
    var i = 0
    var unquoted = ""
    var quote: Character?
    while i < chars.count {
      let c = chars[i]
      if let marker = quote {
        if c == "\\" {
          i += 2
          continue
        }
        if c == marker {
          if i + 1 < chars.count, chars[i + 1] == marker {
            i += 2
            continue
          }
          quote = nil
        }
        unquoted.append(" ")
      } else if c == "'" || c == "\"" {
        quote = c
        unquoted.append(" ")
      } else {
        unquoted.append(c)
      }
      i += 1
    }
    if unquoted.range(
      of: "\\b(FUNCTION|CAST)\\s*\\(", options: [.regularExpression, .caseInsensitive]) != nil
    {
      throw HelperFailure("invalid selector", "Predicate functions are not supported")
    }
  }
}
