package iportal;

import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Constructor;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** UI tree, element actions and screenshots through UiAutomation. */
final class Inspector {
  private static final int MAX_ELEMENTS = 4096;
  private UiAutomation automation;
  private HandlerThread thread;
  private long nextElement = 1;
  private final LinkedHashMap<String, AccessibilityNodeInfo> elements =
      new LinkedHashMap<String, AccessibilityNodeInfo>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, AccessibilityNodeInfo> eldest) {
          return size() > MAX_ELEMENTS;
        }
      };

  synchronized UiAutomation automation() throws Exception {
    if (automation != null) return automation;
    thread = new HandlerThread("iportal-automation");
    thread.start();
    Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
    Constructor<?> connectionConstructor =
        Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor();
    connectionConstructor.setAccessible(true);
    Object connection = connectionConstructor.newInstance();
    UiAutomation created = null;
    for (Constructor<?> constructor : UiAutomation.class.getDeclaredConstructors()) {
      Class<?>[] types = constructor.getParameterTypes();
      Object[] values = new Object[types.length];
      boolean usable = true;
      for (int i = 0; i < types.length; i++) {
        if (types[i] == Looper.class) values[i] = thread.getLooper();
        else if (types[i] == connectionType) values[i] = connection;
        else if (types[i] == int.class) values[i] = 0;
        else usable = false;
      }
      if (!usable) continue;
      constructor.setAccessible(true);
      created = (UiAutomation) constructor.newInstance(values);
      break;
    }
    if (created == null) throw new Failure("unsupported operation", "UI automation is unavailable");
    // 1 = FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: screen readers keep running.
    UiAutomation.class.getMethod("connect", int.class).invoke(created, 1);
    automation = created;
    return automation;
  }

  synchronized void close() {
    try {
      if (automation != null) automation.getClass().getMethod("disconnect").invoke(automation);
    } catch (Throwable ignored) {
      // The system releases the connection when the process exits.
    }
    automation = null;
    if (thread != null) thread.quitSafely();
  }

  AccessibilityNodeInfo root() throws Exception {
    UiAutomation current = automation();
    for (int attempt = 0; attempt < 40; attempt++) {
      AccessibilityNodeInfo root = current.getRootInActiveWindow();
      if (root != null) return root;
      Thread.sleep(25);
    }
    throw new Failure("timeout", "The screen's UI tree is unavailable");
  }

  // ---- element identity ----

  private synchronized String remember(AccessibilityNodeInfo node) {
    String id = "a" + nextElement++;
    elements.put(id, node);
    return id;
  }

  synchronized AccessibilityNodeInfo element(String id) throws Failure {
    AccessibilityNodeInfo node = elements.get(id);
    if (node == null) throw new Failure("no such element", "Unknown element");
    if (!node.refresh()) {
      elements.remove(id);
      throw new Failure("stale element reference", "The element is no longer on screen");
    }
    return node;
  }

  // ---- selectors ----

  private interface Match {
    boolean test(AccessibilityNodeInfo node);
  }

  private static String text(CharSequence value) {
    return value == null ? null : value.toString();
  }

  private static Match selector(String using, String value) throws Failure {
    switch (using) {
      case "accessibility id":
        return node -> value.equals(text(node.getContentDescription()));
      case "id":
        return node -> {
          String id = node.getViewIdResourceName();
          return id != null && (id.equals(value) || id.endsWith(":id/" + value));
        };
      case "name":
        return node -> value.equals(text(node.getText())) || value.equals(text(node.getContentDescription()));
      case "text":
        return node -> value.equals(text(node.getText()));
      case "class name":
        return node -> value.equals(text(node.getClassName()));
      default:
        throw new Failure("invalid selector", "Unsupported selector strategy: " + using);
    }
  }

  private static void collect(AccessibilityNodeInfo node, Match match, List<AccessibilityNodeInfo> found) {
    if (node == null || found.size() >= 2000) return;
    if (match.test(node)) found.add(node);
    for (int i = 0; i < node.getChildCount(); i++) collect(node.getChild(i), match, found);
  }

  // ---- xpath ----

  /**
   * Attribute names an XPath may test. They are the ones a uiautomator dump
   * uses, plus the names of iPortal's own attributes where those differ.
   */
  private static final Set<String> XPATH_ATTRIBUTES = new HashSet<>(Arrays.asList(
      "text", "content-desc", "resource-id", "class", "package", "index", "checkable", "checked", "clickable",
      "enabled", "focusable", "focused", "scrollable", "long-clickable", "password", "selected", "displayed",
      "visible", "label", "value"));

  private static String orEmpty(CharSequence value) {
    return value == null ? "" : value.toString();
  }

  private static final XPath.Tree<AccessibilityNodeInfo> XPATH_TREE = new XPath.Tree<AccessibilityNodeInfo>() {
    @Override
    public List<AccessibilityNodeInfo> children(AccessibilityNodeInfo node) {
      // The same children, in the same order, as the tree `source` returns:
      // the Mac accessibility bridge builds its paths by counting those.
      List<AccessibilityNodeInfo> children = new ArrayList<>();
      for (int i = 0; i < node.getChildCount(); i++) {
        AccessibilityNodeInfo child = node.getChild(i);
        if (child != null) children.add(child);
      }
      return children;
    }

    @Override
    public String name(AccessibilityNodeInfo node) {
      return orEmpty(node.getClassName());
    }

    @Override
    public String attribute(AccessibilityNodeInfo node, String name) {
      switch (name) {
        // A password's characters must not be recoverable by probing with contains().
        case "text": return node.isPassword() ? "" : orEmpty(node.getText());
        case "content-desc": return orEmpty(node.getContentDescription());
        case "resource-id": return orEmpty(node.getViewIdResourceName());
        case "class": return orEmpty(node.getClassName());
        case "package": return orEmpty(node.getPackageName());
        case "checkable": return String.valueOf(node.isCheckable());
        case "checked": return String.valueOf(node.isChecked());
        case "clickable": return String.valueOf(node.isClickable());
        case "enabled": return String.valueOf(node.isEnabled());
        case "focusable": return String.valueOf(node.isFocusable());
        case "focused": return String.valueOf(node.isFocused());
        case "scrollable": return String.valueOf(node.isScrollable());
        case "long-clickable": return String.valueOf(node.isLongClickable());
        case "password": return String.valueOf(node.isPassword());
        case "selected": return String.valueOf(node.isSelected());
        case "displayed":
        case "visible": return String.valueOf(node.isVisibleToUser());
        case "label": return label(node);
        case "value": {
          Object value = value(node);
          return value == JSONObject.NULL ? "" : String.valueOf(value);
        }
        default: return null;
      }
    }
  };

  JSONArray find(String using, String value) throws Exception {
    List<AccessibilityNodeInfo> found;
    if (using.equals("xpath")) {
      // Parse before touching the screen, so a malformed selector fails the same way every time.
      XPath path = XPath.parse(value, XPATH_ATTRIBUTES);
      found = path.select(XPATH_TREE, root(), 2000);
    } else {
      Match match = selector(using, value);
      found = new ArrayList<>();
      collect(root(), match, found);
    }
    JSONArray result = new JSONArray();
    int index = 0;
    for (AccessibilityNodeInfo node : found) {
      Rect bounds = bounds(node);
      JSONObject attributes = new JSONObject();
      for (String name : ATTRIBUTES) attributes.put(name, attribute(node, name));
      attributes.put("identifier", node.getViewIdResourceName() == null ? "" : node.getViewIdResourceName());
      attributes.put("x", bounds.left);
      attributes.put("y", bounds.top);
      // Off-screen nodes can report inverted bounds.
      attributes.put("width", Math.max(0, bounds.width()));
      attributes.put("height", Math.max(0, bounds.height()));
      attributes.put("index", Math.min(index++, 10000));
      result.put(new JSONObject().put("id", remember(node)).put("attributes", attributes));
    }
    return result;
  }

  // ---- attributes ----

  private static final String[] ATTRIBUTES = {
    "type", "name", "label", "value", "enabled", "visible", "selected", "hittable", "accessible", "rect"
  };

  private static Rect bounds(AccessibilityNodeInfo node) {
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    return bounds;
  }

  private static JSONObject rect(Rect bounds) throws Exception {
    return new JSONObject()
        .put("x", bounds.left)
        .put("y", bounds.top)
        .put("width", Math.max(0, bounds.width()))
        .put("height", Math.max(0, bounds.height()));
  }

  private static String label(AccessibilityNodeInfo node) {
    String description = text(node.getContentDescription());
    if (description != null && !description.isEmpty()) return description;
    String content = node.isPassword() ? null : text(node.getText());
    return content == null ? "" : content;
  }

  private static Object value(AccessibilityNodeInfo node) {
    AccessibilityNodeInfo.RangeInfo range = node.getRangeInfo();
    if (range != null) return (double) range.getCurrent();
    if (node.isCheckable()) return node.isChecked() ? "1" : "0";
    // A password's characters are never exported.
    if (node.isPassword() || node.isShowingHintText()) return JSONObject.NULL;
    String content = text(node.getText());
    return content == null ? JSONObject.NULL : content;
  }

  static Object attribute(AccessibilityNodeInfo node, String name) throws Exception {
    switch (name) {
      case "type": return text(node.getClassName()) == null ? "android.view.View" : text(node.getClassName());
      case "name":
        return node.getViewIdResourceName() == null ? JSONObject.NULL : node.getViewIdResourceName();
      case "label": return label(node);
      case "value": return value(node);
      case "enabled": return node.isEnabled();
      case "visible": return node.isVisibleToUser();
      case "selected": return node.isSelected() || node.isChecked();
      case "hittable": return node.isVisibleToUser() && node.isEnabled();
      case "accessible": return node.isImportantForAccessibility();
      case "rect": return rect(bounds(node));
      default: throw new Failure("invalid argument", "Unknown attribute");
    }
  }

  // ---- source ----

  private static String flag(boolean value) {
    return value ? "1" : "0";
  }

  private static String traits(AccessibilityNodeInfo node) {
    List<String> traits = new ArrayList<>();
    if (node.isClickable()) traits.add("clickable");
    if (node.isLongClickable()) traits.add("longClickable");
    if (node.isScrollable()) traits.add("scrollable");
    if (node.isEditable()) traits.add("editable");
    if (node.isCheckable()) traits.add("checkable");
    if (node.isPassword()) traits.add("password");
    if (node.isSelected()) traits.add("selected");
    if (node.isFocusable()) traits.add("focusable");
    return String.join(", ", traits);
  }

  private static JSONObject tree(AccessibilityNodeInfo node, int depth) throws Exception {
    Rect bounds = bounds(node);
    String frame =
        "{{" + bounds.left + ", " + bounds.top + "}, {" + bounds.width() + ", " + bounds.height() + "}}";
    JSONArray children = new JSONArray();
    if (depth < 100)
      for (int i = 0; i < node.getChildCount(); i++) {
        AccessibilityNodeInfo child = node.getChild(i);
        if (child != null) children.put(tree(child, depth + 1));
      }
    String label = label(node);
    return new JSONObject()
        .put("type", attribute(node, "type"))
        .put("label", label.isEmpty() ? JSONObject.NULL : label)
        .put("value", value(node))
        .put("name", attribute(node, "name"))
        .put("rawIdentifier", attribute(node, "name"))
        .put("frame", frame)
        .put("nativeFrame", frame)
        .put("rect", rect(bounds))
        .put("isEnabled", flag(node.isEnabled()))
        .put("isVisible", flag(node.isVisibleToUser()))
        .put("isAccessible", flag(node.isImportantForAccessibility()))
        .put("isNativeAccessibilityElement", "1")
        .put("isFocused", flag(node.isFocused() || node.isAccessibilityFocused()))
        .put("traits", traits(node))
        .put("customActions", new JSONArray())
        .put("children", children);
  }

  private static String escape(Object value) {
    return String.valueOf(value)
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replaceAll("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]", "");
  }

  private static void render(JSONObject node, boolean xml, int depth, StringBuilder out) throws Exception {
    String indent = "  ".repeat(Math.min(depth, 60));
    JSONObject rect = node.getJSONObject("rect");
    JSONArray children = node.getJSONArray("children");
    if (xml) {
      out.append(indent).append("<node class=\"").append(escape(node.get("type"))).append('"');
      for (String key : new String[] {"label", "value", "name", "traits"})
        if (!node.isNull(key) && !node.optString(key).isEmpty())
          out.append(' ').append(key).append("=\"").append(escape(node.get(key))).append('"');
      out.append(" enabled=\"").append("1".equals(node.getString("isEnabled"))).append('"');
      out.append(" visible=\"").append("1".equals(node.getString("isVisible"))).append('"');
      for (String key : new String[] {"x", "y", "width", "height"})
        out.append(' ').append(key).append("=\"").append(rect.getInt(key)).append('"');
      out.append(children.length() == 0 ? "/>\n" : ">\n");
    } else {
      out.append(indent).append(node.get("type"));
      if (!node.isNull("label")) out.append(" '").append(node.get("label")).append('\'');
      if (!node.isNull("value") && !String.valueOf(node.get("value")).equals(node.optString("label")))
        out.append(" value: ").append(node.get("value"));
      out.append(' ').append(node.getString("frame"));
      if (!node.getString("traits").isEmpty()) out.append(" [").append(node.getString("traits")).append(']');
      out.append('\n');
    }
    for (int i = 0; i < children.length(); i++) render(children.getJSONObject(i), xml, depth + 1, out);
    if (xml && children.length() > 0) out.append(indent).append("</node>\n");
  }

  Object source(String format) throws Exception {
    JSONObject tree = tree(root(), 0);
    if (format.equals("json")) return tree;
    StringBuilder out = new StringBuilder();
    boolean xml = format.equals("xml");
    if (xml) out.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<hierarchy>\n");
    render(tree, xml, xml ? 1 : 0, out);
    if (xml) out.append("</hierarchy>\n");
    return out.toString();
  }

  // ---- actions ----

  private static void perform(AccessibilityNodeInfo node, int action, Bundle arguments, String what)
      throws Failure {
    if (!node.performAction(action, arguments))
      throw new Failure("element not actionable", "The element did not accept " + what);
  }

  static float[] center(AccessibilityNodeInfo node) throws Failure {
    Rect bounds = bounds(node);
    if (bounds.isEmpty() || !node.isVisibleToUser())
      throw new Failure("element not actionable", "The element is not visible");
    return new float[] {bounds.exactCenterX(), bounds.exactCenterY()};
  }

  private static void requireEnabled(AccessibilityNodeInfo node) throws Failure {
    if (!node.isEnabled()) throw new Failure("element not actionable", "The element is disabled");
  }

  void tap(String id) throws Exception {
    AccessibilityNodeInfo node = element(id);
    requireEnabled(node);
    float[] point = center(node);
    Commands.tapAt(point[0], point[1], 60);
  }

  static void setText(AccessibilityNodeInfo node, String text) throws Failure {
    Bundle arguments = new Bundle();
    arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
    perform(node, AccessibilityNodeInfo.ACTION_SET_TEXT, arguments, "text");
  }

  /** Inserts at the cursor of the focused field, replacing any selection. */
  void insert(String text) throws Exception {
    // Ask the system, not one window's tree: the focused field can be in a
    // dialog or another window, and focus can lag a tap by a few frames.
    AccessibilityNodeInfo field = null;
    for (int attempt = 0; attempt < 12 && field == null; attempt++) {
      field = automation().findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
      if (field == null) Thread.sleep(25);
    }
    if (field != null && field.isEditable() && !field.isPassword()) {
      String current = field.isShowingHintText() || field.getText() == null ? "" : field.getText().toString();
      int start = field.getTextSelectionStart(), end = field.getTextSelectionEnd();
      if (start < 0 || end < 0 || start > current.length() || end > current.length())
        start = end = current.length();
      int from = Math.min(start, end), to = Math.max(start, end);
      setText(field, current.substring(0, from) + text + current.substring(to));
      Bundle selection = new Bundle();
      selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, from + text.length());
      selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, from + text.length());
      field.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
      return;
    }
    // Password fields hide their contents, and some surfaces expose no field at
    // all. Key events reach both, for characters the virtual keyboard has.
    if (!Device.typeKeys(text))
      throw new Failure("unsupported operation", "This field accepts only characters on a hardware keyboard");
  }

  void type(String id, String text) throws Exception {
    AccessibilityNodeInfo node = element(id);
    requireEnabled(node);
    if (!node.isFocused()) {
      if (!node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) {
        float[] point = center(node);
        Commands.tapAt(point[0], point[1], 60);
      }
      for (int attempt = 0; attempt < 20 && !(node.refresh() && node.isFocused()); attempt++) Thread.sleep(25);
    }
    insert(text);
  }

  void act(String id, JSONObject arguments) throws Exception {
    AccessibilityNodeInfo node = element(id);
    String action = arguments.getString("action");
    if (!action.equals("focus")) requireEnabled(node);
    switch (action) {
      case "focus":
        if (!node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
            && !node.performAction(AccessibilityNodeInfo.ACTION_FOCUS))
          throw new Failure("element not actionable", "The element cannot take focus");
        return;
      case "doubleTap": {
        float[] point = center(node);
        Commands.tapAt(point[0], point[1], 40);
        Thread.sleep(80);
        Commands.tapAt(point[0], point[1], 40);
        return;
      }
      case "longPress": {
        float[] point = center(node);
        Commands.tapAt(point[0], point[1], 700);
        return;
      }
      case "replaceText":
        if (!node.isEditable()) throw new Failure("invalid element state", "The element is not editable");
        setText(node, arguments.getString("text"));
        return;
      case "increment":
      case "decrement":
      case "adjust": {
        AccessibilityNodeInfo.RangeInfo range = node.getRangeInfo();
        if (range == null) {
          if (action.equals("adjust")) throw new Failure("invalid element state", "The element has no range");
          perform(node, action.equals("increment")
              ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
              : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, null, action);
          return;
        }
        float span = range.getMax() - range.getMin();
        float target = action.equals("adjust")
            ? range.getMin() + span * (float) arguments.getDouble("value")
            : range.getCurrent() + span * (action.equals("increment") ? 0.05f : -0.05f);
        target = Math.max(range.getMin(), Math.min(range.getMax(), target));
        if (range.getType() == AccessibilityNodeInfo.RangeInfo.RANGE_TYPE_INT) target = Math.round(target);
        Bundle progress = new Bundle();
        progress.putFloat(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE, target);
        perform(node, AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.getId(), progress, action);
        return;
      }
      default:
        throw new Failure("invalid argument", "Unknown element action");
    }
  }

  // ---- screenshot ----

  String screenshot(String id) throws Exception {
    Rect crop = id == null ? null : bounds(element(id));
    Bitmap screen = automation().takeScreenshot();
    if (screen == null) throw new Failure("unsupported operation", "The screen could not be captured");
    Bitmap image = screen;
    if (crop != null) {
      if (!crop.intersect(0, 0, screen.getWidth(), screen.getHeight()) || crop.isEmpty())
        throw new Failure("element not actionable", "The element is not on screen");
      image = Bitmap.createBitmap(screen, crop.left, crop.top, crop.width(), crop.height());
    }
    ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
    image.compress(Bitmap.CompressFormat.PNG, 100, out);
    if (image != screen) image.recycle();
    screen.recycle();
    return Base64.getEncoder().encodeToString(out.toByteArray());
  }

  synchronized void forget() {
    for (Iterator<AccessibilityNodeInfo> it = elements.values().iterator(); it.hasNext(); ) {
      it.next();
      it.remove();
    }
  }
}
