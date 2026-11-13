package iportal;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Checks the XPath subset on a plain JVM, without a device. Run by
 * test/android.test.ts; prints one line per failure and exits non-zero.
 */
public final class XPathCheck {
  private static final class Node {
    final String tag, type;
    String text = "", description = "", id = "";
    final List<Node> children = new ArrayList<>();

    Node(String tag, String type) {
      this.tag = tag;
      this.type = type;
    }

    Node add(Node... nodes) {
      children.addAll(Arrays.asList(nodes));
      return this;
    }

    Node text(String value) {
      text = value;
      return this;
    }

    Node description(String value) {
      description = value;
      return this;
    }

    Node id(String value) {
      id = value;
      return this;
    }
  }

  private static final XPath.Tree<Node> TREE = new XPath.Tree<Node>() {
    @Override
    public List<Node> children(Node node) {
      return node.children;
    }

    @Override
    public String name(Node node) {
      return node.type;
    }

    @Override
    public String attribute(Node node, String name) {
      switch (name) {
        case "text": return node.text;
        case "content-desc": return node.description;
        case "resource-id": return node.id;
        case "class": return node.type;
        default: return null;
      }
    }
  };
  private static final Set<String> ATTRIBUTES =
      new HashSet<>(Arrays.asList("text", "content-desc", "resource-id", "class", "index"));

  private static Node root;
  private static int failures;

  private static String select(String path) {
    try {
      StringBuilder tags = new StringBuilder();
      for (Node node : XPath.parse(path, ATTRIBUTES).select(TREE, root, 2000)) tags.append(node.tag).append(' ');
      return tags.toString().trim();
    } catch (Failure failure) {
      return "!" + failure.code;
    }
  }

  private static void expect(String path, String wanted) {
    String found = select(path);
    if (found.equals(wanted)) return;
    failures++;
    System.out.println("FAIL " + path + " selected [" + found + "], expected [" + wanted + "]");
  }

  public static void main(String[] args) {
    String button = "android.widget.Button", layout = "android.widget.LinearLayout";
    root = new Node("r", "android.widget.FrameLayout").add(
        new Node("a", layout).add(
            new Node("a1", button).text("OK").id("com.x:id/ok"),
            new Node("a2", "android.widget.TextView").text("Hello world").description("greeting"),
            new Node("a3", button).text("Cancel")),
        new Node("b", layout).add(
            new Node("b1", button).text("It's"),
            new Node("b2", layout).add(new Node("b21", button).text("OK"))));

    // The paths the Mac accessibility bridge builds.
    expect("/*[1]", "r");
    expect("/*[1]/*[1]", "a");
    expect("/*[1]/*[2]/*[2]/*[1]", "b21");
    expect("/*[1]/*[3]", "");
    expect("/*[2]", "");

    // The forms a person writes.
    expect("//android.widget.Button[@text='OK']", "a1 b21");
    expect("//android.widget.Button", "a1 a3 b1 b21");
    expect("//*[@resource-id='com.x:id/ok']", "a1");
    expect("//*[@content-desc=\"greeting\"]", "a2");
    expect("//*[contains(@text,'world')]", "a2");
    expect("//*[starts-with(@text, 'Hel')]", "a2");
    expect("//*[text()=\"It's\"]", "b1");
    expect("//*[@text='OK' or @text='Cancel']", "a1 a3 b21");
    expect("//*[not(@text='') and not(contains(@text,'O'))]", "a2 a3 b1");
    expect("//*[@text!='OK'][@text!='']", "a2 a3 b1");
    expect("/ * [ 1 ] / * [ 2 ]", "b");

    // A position counts among one parent's matching children; parentheses count the whole result.
    expect("//android.widget.Button[2]", "a3");
    expect("//android.widget.Button[1]", "a1 b1 b21");
    expect("(//android.widget.Button)[2]", "a3");
    expect("(//android.widget.Button)[last()]", "b21");
    expect("//android.widget.LinearLayout/android.widget.Button[last()]", "a3 b1 b21");
    expect("//*[@text='OK' and @class='android.widget.Button'][1]", "a1 b21");
    expect("//*[position()>1 and position()<3]", "a2 b b2");
    expect("/android.widget.FrameLayout/android.widget.LinearLayout[2]/*[position()=last()]", "b2");
    expect("//node[@index=2]", "a3");
    expect("//*[@index='0']", "r a a1 b1 b21");

    // Results are in document order and never repeated.
    expect("//android.widget.LinearLayout//android.widget.Button", "a1 a3 b1 b21");
    expect("//*", "r a a1 a2 a3 b b1 b2 b21");

    // Anything outside the subset is refused, never guessed at.
    for (String path : new String[] {
      "", "foo", "a/b", "..", "./a", "//", "//*[", "//*[@text]", "//*[@bogus='x']", "//*[0]", "//*[1.5]", "//*[-1]",
      "//a/..", "//a/parent::b", "//a | //b", "//*[@text='x'", "//*[@text='unterminated]", "//*[text()]", "//*['x']",
      "//*[last()-1]", "//*[string-length(@text)=2]", "//a/text()", "/*[1]junk", "//*[@text=contains(@text,'a')]",
      "//*[contains(1,'a')]", "//*[position()]", "//*[@text='a' and 2]", "(//a)[1]/b",
    }) expect(path, "!invalid selector");

    if (failures > 0) System.exit(1);
    System.out.println("ok");
  }
}
