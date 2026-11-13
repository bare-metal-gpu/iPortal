package iportal;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The subset of XPath 1.0 that iPortal accepts as an element selector.
 *
 * <p>It covers the paths the Mac accessibility bridge builds from the UI tree
 * ({@code /*[1]/*[3]/*[2]}) and the forms a person writes by hand
 * ({@code //android.widget.Button[@text='OK']}). Anything else is refused with
 * {@code invalid selector}: an expression that is only half understood would
 * select the wrong element, and the caller would then act on it.
 *
 * <p>Supported: absolute paths of child ({@code /}) and descendant ({@code //})
 * steps; a class name, {@code *} or {@code node} as the name test; predicates
 * with a position ({@code [2]}, {@code [last()]}), attribute comparisons,
 * {@code contains()}, {@code starts-with()}, {@code text()}, {@code position()},
 * {@code not()}, {@code and}, {@code or}; and one parenthesized path with
 * predicates, as in {@code (//android.widget.Button)[2]}.
 *
 * <p>This class knows nothing about Android, so it can be exercised on any JVM.
 */
final class XPath {
  /** The tree a selector is evaluated against. */
  interface Tree<N> {
    /** Children in document order. */
    List<N> children(N node);

    /** The element name a name test is compared with. */
    String name(N node);

    /** An attribute's value, or null when the tree has no attribute of that name. */
    String attribute(N node, String name);
  }

  private static final int MAX_DEPTH = 100;
  private static final int MAX_VISITS = 50_000;
  private static final int MAX_NESTING = 32;

  private static Failure invalid(String message) {
    return new Failure("invalid selector", message);
  }

  // ---- syntax tree ----

  private static final class Step {
    boolean descendants;
    String name; // null matches any element
    final List<Expression> predicates = new ArrayList<>();
  }

  /** A predicate expression. Values are a String, a Double or a Boolean. */
  private interface Expression {
    Object value(Scope scope) throws Failure;
  }

  private interface Scope {
    String attribute(String name) throws Failure;

    int position();

    int last();
  }

  private final List<Step> steps = new ArrayList<>();
  /** Predicates of a parenthesized path: positions count the whole result. */
  private final List<Expression> whole = new ArrayList<>();
  private final Set<String> attributes;

  private XPath(Set<String> attributes) {
    this.attributes = attributes;
  }

  // ---- parsing ----

  private String source;
  private int at;
  private int nesting;

  /** @param attributes the attribute names the tree has; any other name is refused */
  static XPath parse(String source, Set<String> attributes) throws Failure {
    XPath path = new XPath(attributes);
    path.source = source;
    path.skipSpace();
    if (path.take('(')) {
      path.steps();
      path.expect(')');
      path.predicates(path.whole);
    } else path.steps();
    path.skipSpace();
    if (path.at != source.length()) throw invalid("Unsupported XPath at position " + (path.at + 1));
    path.source = null;
    return path;
  }

  private void skipSpace() {
    while (at < source.length() && Character.isWhitespace(source.charAt(at))) at++;
  }

  private boolean take(char expected) {
    skipSpace();
    if (at < source.length() && source.charAt(at) == expected) {
      at++;
      return true;
    }
    return false;
  }

  private boolean peek(String expected) {
    skipSpace();
    return source.startsWith(expected, at);
  }

  private void expect(char expected) throws Failure {
    if (!take(expected)) throw invalid("Expected '" + expected + "' at position " + (at + 1));
  }

  private static boolean nameStart(char c) {
    return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  }

  private String name() throws Failure {
    skipSpace();
    int start = at;
    if (at < source.length() && nameStart(source.charAt(at))) {
      at++;
      while (at < source.length()) {
        char c = source.charAt(at);
        if (!nameStart(c) && !(c >= '0' && c <= '9') && c != '.' && c != '$' && c != '-') break;
        at++;
      }
    }
    if (at == start) throw invalid("Expected a name at position " + (at + 1));
    return source.substring(start, at);
  }

  private void steps() throws Failure {
    skipSpace();
    if (!peek("/")) throw invalid("An XPath selector starts with / or //");
    while (peek("/")) {
      Step step = new Step();
      at++;
      if (take('/')) step.descendants = true;
      skipSpace();
      if (take('*')) step.name = null;
      else {
        String name = name();
        // An axis (parent::, following-sibling::) or a node test such as text().
        if (peek("::") || peek("(")) throw invalid("Unsupported XPath step: " + name);
        // uiautomator dumps name every element "node".
        step.name = name.equals("node") ? null : name;
      }
      predicates(step.predicates);
      steps.add(step);
    }
  }

  private void predicates(List<Expression> into) throws Failure {
    while (take('[')) {
      skipSpace();
      int start = at;
      Expression expression = or();
      // A bare number is a position, as in XPath: [2] means [position() = 2].
      if (expression instanceof Number) {
        double wanted = ((Number) expression).number;
        if (wanted != Math.rint(wanted) || wanted < 1)
          throw invalid("A position is a whole number from 1: " + source.substring(start, at).trim());
        expression = scope -> scope.position() == wanted;
      } else if (expression instanceof Last) expression = scope -> scope.position() == scope.last();
      else if (!(expression instanceof Test))
        throw invalid("A predicate must be a position or a comparison: " + source.substring(start, at).trim());
      expect(']');
      into.add(expression);
    }
  }

  /** Marker types let the parser tell what a predicate's top-level expression is. */
  private static final class Number implements Expression {
    final double number;

    Number(double number) {
      this.number = number;
    }

    @Override
    public Object value(Scope scope) {
      return number;
    }
  }

  private static final class Last implements Expression {
    @Override
    public Object value(Scope scope) {
      return (double) scope.last();
    }
  }

  /** An expression whose value is a Boolean. */
  private interface Test extends Expression {}

  private static boolean truth(Expression expression, Scope scope) throws Failure {
    return Boolean.TRUE.equals(expression.value(scope));
  }

  private Expression test(Expression expression, int start) throws Failure {
    if (!(expression instanceof Test))
      throw invalid("Compare the value with something: " + source.substring(start, at).trim());
    return expression;
  }

  private boolean keyword(String word) {
    skipSpace();
    if (!source.startsWith(word, at)) return false;
    int end = at + word.length();
    if (end < source.length()) {
      char next = source.charAt(end);
      if (nameStart(next) || (next >= '0' && next <= '9') || next == '-' || next == '.') return false;
    }
    at = end;
    return true;
  }

  private Expression or() throws Failure {
    if (++nesting > MAX_NESTING) throw invalid("The XPath is nested too deeply");
    int start = at;
    Expression left = and();
    while (keyword("or")) {
      Expression a = test(left, start), b = test(and(), start);
      left = (Test) scope -> truth(a, scope) || truth(b, scope);
    }
    nesting--;
    return left;
  }

  private Expression and() throws Failure {
    int start = at;
    Expression left = comparison();
    while (keyword("and")) {
      Expression a = test(left, start), b = test(comparison(), start);
      left = (Test) scope -> truth(a, scope) && truth(b, scope);
    }
    return left;
  }

  private static double number(Object value) {
    if (value instanceof Double) return (Double) value;
    if (value instanceof Boolean) return Double.NaN;
    try {
      return Double.parseDouble(((String) value).trim());
    } catch (NumberFormatException notNumeric) {
      return Double.NaN;
    }
  }

  private Expression comparison() throws Failure {
    skipSpace();
    int start = at;
    Expression left = operand();
    skipSpace();
    String operator = null;
    for (String candidate : new String[] {"!=", "<=", ">=", "=", "<", ">"})
      if (source.startsWith(candidate, at)) {
        operator = candidate;
        at += candidate.length();
        break;
      }
    if (operator == null) return left;
    Expression right = operand();
    if (left instanceof Test || right instanceof Test)
      throw invalid("Unsupported comparison: " + source.substring(start, at).trim());
    String op = operator;
    return (Test) scope -> {
      Object a = left.value(scope), b = right.value(scope);
      boolean equality = op.equals("=") || op.equals("!=");
      if (equality && a instanceof String && b instanceof String) return a.equals(b) == op.equals("=");
      double x = number(a), y = number(b);
      switch (op) {
        case "=": return x == y;
        case "!=": return x != y;
        case "<": return x < y;
        case "<=": return x <= y;
        case ">": return x > y;
        default: return x >= y;
      }
    };
  }

  private Expression attribute(String name) throws Failure {
    if (!attributes.contains(name)) throw invalid("Unknown attribute: @" + name);
    return scope -> scope.attribute(name);
  }

  private Expression operand() throws Failure {
    skipSpace();
    if (at >= source.length()) throw invalid("The XPath ends inside a predicate");
    char c = source.charAt(at);
    if (c == '(') {
      at++;
      int start = at;
      Expression inner = test(or(), start);
      expect(')');
      return inner;
    }
    if (c == '@') {
      at++;
      return attribute(name());
    }
    if (c == '\'' || c == '"') {
      int end = source.indexOf(c, at + 1);
      if (end < 0) throw invalid("Unterminated string in the XPath");
      String literal = source.substring(at + 1, end);
      at = end + 1;
      return scope -> literal;
    }
    if ((c >= '0' && c <= '9') || c == '.') {
      int start = at;
      while (at < source.length() && ((source.charAt(at) >= '0' && source.charAt(at) <= '9') || source.charAt(at) == '.'))
        at++;
      try {
        return new Number(Double.parseDouble(source.substring(start, at)));
      } catch (NumberFormatException malformed) {
        throw invalid("Malformed number in the XPath");
      }
    }
    int start = at;
    String function = name();
    if (!take('(')) throw invalid("Unsupported XPath expression: " + source.substring(start, at));
    switch (function) {
      case "text":
        expect(')');
        return attribute("text");
      case "position":
        expect(')');
        return scope -> (double) scope.position();
      case "last":
        expect(')');
        return new Last();
      case "not": {
        int inside = at;
        Expression inner = test(or(), inside);
        expect(')');
        return (Test) scope -> !truth(inner, scope);
      }
      case "contains":
      case "starts-with": {
        Expression text = string(), part;
        expect(',');
        part = string();
        expect(')');
        boolean prefix = function.equals("starts-with");
        return (Test) scope -> {
          String whole = (String) text.value(scope), piece = (String) part.value(scope);
          return prefix ? whole.startsWith(piece) : whole.contains(piece);
        };
      }
      default:
        throw invalid("Unsupported XPath function: " + function + "()");
    }
  }

  /** An operand that is certainly a string: an attribute, text() or a literal. */
  private Expression string() throws Failure {
    skipSpace();
    int start = at;
    boolean plain = at < source.length() && "@'\"t".indexOf(source.charAt(at)) >= 0;
    Expression operand = operand();
    if (!plain || operand instanceof Test || operand instanceof Number || operand instanceof Last)
      throw invalid("Expected an attribute or a string: " + source.substring(start, at).trim());
    return operand;
  }

  // ---- evaluation ----

  private static final class Item<N> {
    final N node;
    final int index;
    final int depth;

    Item(N node, int index, int depth) {
      this.node = node;
      this.index = index;
      this.depth = depth;
    }
  }

  private static final class Walk<N> {
    final Tree<N> tree;
    int visits;

    Walk(Tree<N> tree) {
      this.tree = tree;
    }

    List<Item<N>> children(Item<N> parent) throws Failure {
      List<Item<N>> items = new ArrayList<>();
      if (parent.depth >= MAX_DEPTH) return items;
      int index = 0;
      for (N child : tree.children(parent.node)) {
        if (++visits > MAX_VISITS) throw new Failure("timeout", "The UI tree is too large for this XPath");
        items.add(new Item<>(child, index++, parent.depth + 1));
      }
      return items;
    }
  }

  private static <N> List<Item<N>> filter(Tree<N> tree, List<Item<N>> candidates, List<Expression> predicates)
      throws Failure {
    for (Expression predicate : predicates) {
      List<Item<N>> kept = new ArrayList<>();
      int size = candidates.size();
      for (int i = 0; i < size; i++) {
        Item<N> item = candidates.get(i);
        int position = i + 1;
        Scope scope = new Scope() {
          @Override
          public String attribute(String name) throws Failure {
            // The position among the parent's children, as uiautomator numbers it.
            if (name.equals("index")) return Integer.toString(item.index);
            String value = tree.attribute(item.node, name);
            if (value == null) throw invalid("Unknown attribute: @" + name);
            return value;
          }

          @Override
          public int position() {
            return position;
          }

          @Override
          public int last() {
            return size;
          }
        };
        if (truth(predicate, scope)) kept.add(item);
      }
      candidates = kept;
    }
    return candidates;
  }

  private static <N> void descendants(Walk<N> walk, Item<N> from, List<Item<N>> into) throws Failure {
    into.add(from);
    for (Item<N> child : walk.children(from)) descendants(walk, child, into);
  }

  /** Matching nodes in document order, at most {@code limit} of them. */
  <N> List<N> select(Tree<N> tree, N root, int limit) throws Failure {
    Walk<N> walk = new Walk<>(tree);
    Item<N> top = new Item<>(root, 0, 0);
    // The document node above the root element: its only child is the root.
    List<Item<N>> context = null;
    boolean ordered = true;
    for (Step step : steps) {
      List<Item<N>> next = new ArrayList<>();
      Set<N> seen = new LinkedHashSet<>();
      List<List<Item<N>>> families = new ArrayList<>();
      if (context == null) {
        // From the document node.
        List<Item<N>> first = new ArrayList<>();
        first.add(top);
        families.add(first);
        if (step.descendants) {
          List<Item<N>> all = new ArrayList<>();
          descendants(walk, top, all);
          for (Item<N> item : all) families.add(walk.children(item));
        }
      } else {
        for (Item<N> item : context) {
          if (!step.descendants) families.add(walk.children(item));
          else {
            List<Item<N>> all = new ArrayList<>();
            descendants(walk, item, all);
            for (Item<N> inner : all) families.add(walk.children(inner));
          }
        }
      }
      // A position counts among one parent's matching children, as in XPath.
      for (List<Item<N>> family : families) {
        List<Item<N>> named = new ArrayList<>();
        for (Item<N> item : family)
          if (step.name == null || step.name.equals(tree.name(item.node))) named.add(item);
        for (Item<N> item : filter(tree, named, step.predicates)) if (seen.add(item.node)) next.add(item);
      }
      // Child steps keep document order. A descendant step gathers one parent's
      // children at a time, which is not document order.
      if (step.descendants) ordered = false;
      context = next;
      if (context.isEmpty()) break;
    }
    List<Item<N>> found = context == null ? new ArrayList<>() : context;
    if (!ordered && found.size() > 1) {
      Set<N> wanted = new LinkedHashSet<>();
      for (Item<N> item : found) wanted.add(item.node);
      List<Item<N>> all = new ArrayList<>();
      descendants(walk, top, all);
      found = new ArrayList<>();
      for (Item<N> item : all) if (wanted.contains(item.node)) found.add(item);
    }
    found = filter(tree, found, whole);
    List<N> result = new ArrayList<>();
    for (Item<N> item : found) {
      if (result.size() >= limit) break;
      result.add(item.node);
    }
    return result;
  }
}
