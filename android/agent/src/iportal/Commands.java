package iportal;

import android.content.ClipData;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** The helper contract's operations, implemented with Android mechanisms. */
final class Commands {
  private final Agent agent;
  private final Inspector inspector;
  private final Video video;
  private String pidPackage;
  private int pid = 1;
  private long pidAt;

  Commands(Agent agent, Inspector inspector, Video video) {
    this.agent = agent;
    this.inspector = inspector;
    this.video = video;
  }

  Object run(String operation, JSONObject a) throws Exception {
    switch (operation) {
      case "touch": guard(a, true); return touch(a);
      case "text": guard(a, true); type(a.getString("text")); return JSONObject.NULL;
      case "key": guard(a, true); key(a); return JSONObject.NULL;
      case "home": guard(a, true); Device.key(KeyEvent.KEYCODE_HOME, 0); return JSONObject.NULL;
      case "button": guard(a, false); button(a.getString("name")); return JSONObject.NULL;
      case "lock":
        guard(a, false);
        if (Device.interactive()) Device.key(KeyEvent.KEYCODE_SLEEP, 0);
        return JSONObject.NULL;
      case "unlock":
        guard(a, false);
        Device.key(KeyEvent.KEYCODE_WAKEUP, 0);
        try {
          Device.dismissKeyguard();
        } catch (Throwable secure) {
          // A secure keyguard stays; the owner unlocks it.
        }
        return JSONObject.NULL;
      case "launch": guard(a, true); launch(a.getString("bundleId")); return JSONObject.NULL;
      case "openURL": guard(a, true); openURL(a.getString("url")); return JSONObject.NULL;
      case "keepAlive": Device.userActivity(); return new JSONObject().put("completed", true);
      case "state": {
        Device.Screen screen = Device.screen();
        return new JSONObject()
            .put("locked", Device.locked())
            .put("app", app())
            .put("orientation", screen.orientation())
            .put("screen", geometry(screen));
      }
      case "app": return app();
      case "orientation": return Device.screen().orientation();
      case "geometry": return geometry(Device.screen());
      case "elements": return inspector.find(a.getString("using"), a.getString("value"));
      case "attribute": return Inspector.attribute(inspector.element(a.getString("id")), a.getString("name"));
      case "tapElement": guard(a, true); inspector.tap(a.getString("id")); return JSONObject.NULL;
      case "typeElement":
        guard(a, true);
        inspector.type(a.getString("id"), a.getString("text"));
        return JSONObject.NULL;
      case "elementAction": guard(a, true); inspector.act(a.getString("id"), a); return JSONObject.NULL;
      case "source": return inspector.source(a.getString("format"));
      case "screenshot": return inspector.screenshot(a.has("id") ? a.getString("id") : null);
      case "clipboardPrepare":
        return new JSONObject()
            .put("lease", UUID.randomUUID().toString())
            .put("helperBundleId", Device.SHELL_PACKAGE)
            .put("restoreBundleId", JSONObject.NULL);
      case "clipboardStatus": return new JSONObject().put("changeCount", clipboardStamp());
      case "clipboardRead": return clipboardRead();
      case "clipboardWrite": return clipboardWrite(a);
      case "clipboardRestore":
      case "clipboardCancel": return new JSONObject().put("cancelled", true);
      case "presence":
        agent.presence(a.getBoolean("ready"), a.getLong("keepAwakeMs"));
        return agent.portal();
      case "portal": return agent.portal();
      case "quality": video.preset(a.getString("preset")); return JSONObject.NULL;
      case "shutdown": agent.shutdownSoon(); return JSONObject.NULL;
      default: throw new Failure("unsupported operation", "Unsupported on Android: " + operation);
    }
  }

  // ---- guards ----

  private void guard(JSONObject a, boolean needsUnlocked) throws Exception {
    if (needsUnlocked && Device.locked()) throw new Failure("device locked", "Unlock the device");
    if (a.has("expectedBundleId") && !a.getString("expectedBundleId").equals(foreground()))
      throw new Failure("app changed", "Foreground app changed");
    if (a.has("expectedOrientation")
        && !a.getString("expectedOrientation").equals(Device.screen().orientation()))
      throw new Failure("orientation changed", "Screen orientation changed");
  }

  private String foreground() throws Exception {
    String name = Device.foregroundPackage();
    if (name != null) return name;
    CharSequence fromTree = inspector.root().getPackageName();
    return fromTree == null ? "android" : fromTree.toString();
  }

  private JSONObject app() throws Exception {
    String name = foreground();
    long now = SystemClock.uptimeMillis();
    if (!name.equals(pidPackage) || now - pidAt > 2000) {
      pid = 1;
      try {
        String first = Device.run("pidof", name).trim().split("\\s+")[0];
        if (!first.isEmpty()) pid = Math.max(1, Integer.parseInt(first));
      } catch (Throwable unknown) {
        // The package may have no process of its own name.
      }
      pidPackage = name;
      pidAt = now;
    }
    return new JSONObject().put("pid", pid).put("bundleId", name).put("name", name);
  }

  private static JSONObject geometry(Device.Screen screen) throws Exception {
    return new JSONObject().put("width", screen.width).put("height", screen.height);
  }

  // ---- touch ----

  private static void sleepUntil(long uptime) throws InterruptedException {
    long wait = uptime - SystemClock.uptimeMillis();
    if (wait > 0) Thread.sleep(wait);
  }

  static void tapAt(float x, float y, long holdMs) throws Exception {
    long down = SystemClock.uptimeMillis();
    Device.touch(MotionEvent.ACTION_DOWN, down, Device.INJECT_WAIT_FOR_FINISH, x, y);
    try {
      sleepUntil(down + holdMs);
    } finally {
      Device.touch(MotionEvent.ACTION_UP, down, Device.INJECT_WAIT_FOR_FINISH, x, y);
    }
  }

  /** Position on one normalized path at {@code ms}, in pixels. */
  private static void position(JSONArray path, double ms, Device.Screen screen, float[] out, int at)
      throws Exception {
    int last = path.length() - 1, i = 0;
    while (i < last && path.getJSONArray(i + 1).getDouble(2) <= ms) i++;
    JSONArray from = path.getJSONArray(i), to = path.getJSONArray(Math.min(i + 1, last));
    double span = to.getDouble(2) - from.getDouble(2);
    double t = span <= 0 ? 0 : Math.max(0, Math.min(1, (ms - from.getDouble(2)) / span));
    out[at] = (float) ((from.getDouble(0) + (to.getDouble(0) - from.getDouble(0)) * t) * (screen.width - 1));
    out[at + 1] =
        (float) ((from.getDouble(1) + (to.getDouble(1) - from.getDouble(1)) * t) * (screen.height - 1));
  }

  private JSONObject touch(JSONObject a) throws Exception {
    long entered = System.nanoTime();
    JSONArray fingers = a.optJSONArray("fingers");
    if (fingers == null) fingers = new JSONArray().put(a.getJSONArray("points"));
    int count = fingers.length();
    double end = a.getDouble("end"), lastMove = 0;
    for (int f = 0; f < count; f++) {
      JSONArray path = fingers.getJSONArray(f);
      lastMove = Math.max(lastMove, path.getJSONArray(path.length() - 1).getDouble(2));
    }
    Device.Screen screen = Device.screen();
    float[] xy = new float[count * 2];
    float[] first = new float[2];
    int second = 1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT;
    for (int f = 0; f < count; f++) position(fingers.getJSONArray(f), 0, screen, xy, f * 2);
    first[0] = xy[0];
    first[1] = xy[1];
    double guardMs = (System.nanoTime() - entered) / 1e6;
    long played = System.nanoTime();
    long down = SystemClock.uptimeMillis();
    Device.touch(MotionEvent.ACTION_DOWN, down, Device.INJECT_WAIT_FOR_FINISH, first);
    boolean secondDown = false;
    try {
      if (count == 2) {
        Device.touch(MotionEvent.ACTION_POINTER_DOWN | second, down, Device.INJECT_ASYNC, xy);
        secondDown = true;
      }
      // Recorded points can be sparse. Interpolating every frame keeps velocity
      // smooth, which decides how far a fling travels.
      for (double ms = 8; ; ms += 8) {
        double at = Math.min(ms, lastMove);
        if (lastMove <= 0) break;
        sleepUntil(down + (long) at);
        for (int f = 0; f < count; f++) position(fingers.getJSONArray(f), at, screen, xy, f * 2);
        Device.touch(MotionEvent.ACTION_MOVE, down, Device.INJECT_ASYNC, xy);
        if (ms >= lastMove) break;
      }
      sleepUntil(down + (long) end);
    } finally {
      // Always lift, so an interrupted gesture cannot leave a finger down.
      if (secondDown) Device.touch(MotionEvent.ACTION_POINTER_UP | second, down, Device.INJECT_ASYNC, xy);
      first[0] = xy[0];
      first[1] = xy[1];
      Device.touch(MotionEvent.ACTION_UP, down, Device.INJECT_WAIT_FOR_FINISH, first);
    }
    return new JSONObject()
        .put("completed", true)
        .put("timing", new JSONObject()
            .put("guardMs", guardMs)
            .put("confirmationMs", 0)
            .put("playbackMs", (System.nanoTime() - played) / 1e6));
  }

  // ---- keyboard ----

  private void type(String text) throws Exception {
    if (text.isEmpty()) return;
    // Key events behave like a real keyboard and reach every surface. Text the
    // virtual keyboard cannot produce is placed through the focused field instead.
    if (!Device.typeKeys(text)) inspector.insert(text);
  }

  private void key(JSONObject a) throws Exception {
    String key = a.getString("key");
    JSONArray modifiers = a.getJSONArray("modifiers");
    int meta = 0;
    for (int i = 0; i < modifiers.length(); i++) {
      switch (modifiers.getString(i)) {
        case "shift": meta |= KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON; break;
        case "option": meta |= KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON; break;
        // Android's editing shortcuts use Control where the Mac uses Command.
        default: meta |= KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON;
      }
    }
    int code;
    switch (key) {
      case "ArrowLeft": code = KeyEvent.KEYCODE_DPAD_LEFT; break;
      case "ArrowRight": code = KeyEvent.KEYCODE_DPAD_RIGHT; break;
      case "ArrowUp": code = KeyEvent.KEYCODE_DPAD_UP; break;
      case "ArrowDown": code = KeyEvent.KEYCODE_DPAD_DOWN; break;
      case "Backspace": code = KeyEvent.KEYCODE_DEL; break;
      case "Delete": code = KeyEvent.KEYCODE_FORWARD_DEL; break;
      case "Enter": code = KeyEvent.KEYCODE_ENTER; break;
      case "Tab": code = KeyEvent.KEYCODE_TAB; break;
      case "Escape": code = KeyEvent.KEYCODE_ESCAPE; break;
      case "Home": code = KeyEvent.KEYCODE_MOVE_HOME; break;
      case "End": code = KeyEvent.KEYCODE_MOVE_END; break;
      case "PageUp": code = KeyEvent.KEYCODE_PAGE_UP; break;
      case "PageDown": code = KeyEvent.KEYCODE_PAGE_DOWN; break;
      default:
        if (meta == 0) {
          type(key);
          return;
        }
        if (key.length() != 1 || key.charAt(0) < 'a' || key.charAt(0) > 'z')
          throw new Failure("invalid argument", "Unsupported key");
        code = KeyEvent.KEYCODE_A + (key.charAt(0) - 'a');
    }
    Device.key(code, meta);
  }

  private static void button(String name) throws Exception {
    switch (name) {
      case "home": Device.key(KeyEvent.KEYCODE_HOME, 0); return;
      case "volumeUp": Device.key(KeyEvent.KEYCODE_VOLUME_UP, 0); return;
      case "volumeDown": Device.key(KeyEvent.KEYCODE_VOLUME_DOWN, 0); return;
      case "back": Device.key(KeyEvent.KEYCODE_BACK, 0); return;
      case "appSwitch": Device.key(KeyEvent.KEYCODE_APP_SWITCH, 0); return;
      case "notifications": Device.run("cmd", "statusbar", "expand-notifications"); return;
      case "quickSettings": Device.run("cmd", "statusbar", "expand-settings"); return;
      case "search": Device.key(KeyEvent.KEYCODE_SEARCH, 0); return;
      default: throw new Failure("invalid argument", "Unknown button");
    }
  }

  // ---- applications ----

  private static void launch(String name) throws Exception {
    if (!name.matches("[A-Za-z0-9_.]{1,255}")) throw new Failure("invalid argument", "Invalid application ID");
    String resolved =
        Device.run("cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", name);
    String[] lines = resolved.trim().split("\n");
    String component = lines[lines.length - 1].trim();
    if (!component.startsWith(name + "/"))
      throw new Failure("invalid argument", "No launchable application named " + name);
    started(Device.run("am", "start", "-n", component, "-a", "android.intent.action.MAIN", "-c",
        "android.intent.category.LAUNCHER"));
  }

  private static void openURL(String url) throws Exception {
    started(Device.run("am", "start", "-a", "android.intent.action.VIEW", "-d", url));
  }

  private static void started(String output) throws Failure {
    if (output.contains("Error") || output.contains("Exception"))
      throw new Failure("unknown", "upstream error", "The device could not open it");
  }

  // ---- clipboard ----

  /**
   * A value that differs whenever the clipboard's content does. The system's
   * change notifications are preferred. The fallback reads the clipboard, which
   * shows a notice on the device; a clip's timestamp alone was seen to stay the
   * same across copies, so content is mixed in.
   */
  private static long clipboardStamp() throws Exception {
    long changes = Device.clipChanges();
    if (changes >= 0) return changes;
    ClipData clip = Device.readClip();
    if (clip == null) return 0;
    long stamp = clip.getDescription().getTimestamp();
    for (int i = 0; i < clip.getItemCount(); i++) {
      ClipData.Item item = clip.getItemAt(i);
      stamp = stamp * 31 + (item.getText() == null ? 0 : item.getText().toString().hashCode());
      stamp = stamp * 31 + (item.getUri() == null ? 0 : item.getUri().hashCode());
    }
    return 1 + (stamp & 0xFFFFFFFFFFFFL);
  }

  private static JSONObject clipboardRead() throws Exception {
    ClipData clip = Device.readClip();
    CharSequence text = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
    if (text == null && clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getUri() != null
        && !"content".equals(clip.getItemAt(0).getUri().getScheme()))
      text = clip.getItemAt(0).getUri().toString();
    if (text == null || text.length() == 0) return new JSONObject().put("empty", true);
    String value = text.toString();
    boolean link = value.matches("(?i)https?://\\S+");
    return new JSONObject()
        .put("format", link ? "url" : "text")
        .put("content", Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
  }

  private static JSONObject clipboardWrite(JSONObject a) throws Exception {
    String format = a.getString("format");
    if (format.equals("image"))
      throw new Failure("unsupported operation", "Images cannot be sent to this device's clipboard yet");
    byte[] bytes = Base64.getDecoder().decode(a.getString("content"));
    Device.writeClip(ClipData.newPlainText("iPortal", new String(bytes, StandardCharsets.UTF_8)));
    return new JSONObject().put("format", format).put("bytes", bytes.length);
  }
}
