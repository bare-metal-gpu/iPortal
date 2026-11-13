package iportal;

import android.content.ClipData;
import android.content.ClipDescription;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.io.ByteArrayOutputStream;
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
  private final Pointer pointer = new Pointer();
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
      case "touch": guard(a, AWAKE); return touch(a);
      case "pointer": return pointer(a);
      case "text": guard(a, AWAKE); type(a.getString("text")); return JSONObject.NULL;
      case "key": guard(a, AWAKE); key(a); return JSONObject.NULL;
      case "home": guard(a, AWAKE); Device.key(KeyEvent.KEYCODE_HOME, 0); return JSONObject.NULL;
      case "button": guard(a, ANY); button(a.getString("name")); return JSONObject.NULL;
      case "lock":
        guard(a, ANY);
        if (Device.interactive()) Device.key(KeyEvent.KEYCODE_SLEEP, 0);
        return JSONObject.NULL;
      case "unlock":
        guard(a, ANY);
        Device.key(KeyEvent.KEYCODE_WAKEUP, 0);
        try {
          Device.dismissKeyguard();
        } catch (Throwable secure) {
          // A secure keyguard stays; the owner unlocks it.
        }
        return JSONObject.NULL;
      case "launch": guard(a, UNLOCKED); launch(a.getString("bundleId")); return JSONObject.NULL;
      case "openURL": guard(a, UNLOCKED); openURL(a.getString("url")); return JSONObject.NULL;
      case "keepAlive": Device.userActivity(); return new JSONObject().put("completed", true);
      case "state": {
        Device.Screen screen = Device.screen();
        return new JSONObject()
            .put("locked", Device.locked())
            .put("app", app())
            .put("orientation", screen.orientation())
            .put("screen", geometry(screen));
      }
      case "power": return new JSONObject().put("interactive", Device.interactive());
      case "app": return app();
      case "orientation": return Device.screen().orientation();
      case "geometry": return geometry(Device.screen());
      case "elements": unlocked(); return inspector.find(a.getString("using"), a.getString("value"));
      case "attribute":
        unlocked();
        return Inspector.attribute(inspector.element(a.getString("id")), a.getString("name"));
      case "tapElement": guard(a, UNLOCKED); inspector.tap(a.getString("id")); return JSONObject.NULL;
      case "typeElement":
        guard(a, UNLOCKED);
        inspector.type(a.getString("id"), a.getString("text"));
        return JSONObject.NULL;
      case "elementAction": guard(a, UNLOCKED); inspector.act(a.getString("id"), a); return JSONObject.NULL;
      case "source": unlocked(); return inspector.source(a.getString("format"));
      case "screenshot": unlocked(); return inspector.screenshot(a.has("id") ? a.getString("id") : null);
      case "clipboardPrepare":
        unlocked();
        return new JSONObject()
            .put("lease", UUID.randomUUID().toString())
            .put("helperBundleId", Device.SHELL_PACKAGE)
            .put("restoreBundleId", JSONObject.NULL);
      case "clipboardStatus": return new JSONObject().put("changeCount", clipboardStamp());
      case "clipboardRead": unlocked(); return transfer(a.getString("lease"), Commands::clipboardRead);
      case "clipboardWrite": unlocked(); return transfer(a.getString("lease"), () -> clipboardWrite(a));
      case "clipboardRestore":
      case "clipboardCancel":
        transfer = null;
        return new JSONObject().put("cancelled", true);
      case "presence":
        agent.presence(a.getBoolean("ready"), a.getLong("keepAwakeMs"));
        return agent.portal();
      case "portal": return agent.portal();
      case "quality": video.preset(a.getString("preset")); return JSONObject.NULL;
      case "shutdown": pointer.release(); agent.shutdownSoon(); return JSONObject.NULL;
      default: throw new Failure("unsupported operation", "Unsupported on Android: " + operation);
    }
  }

  // ---- guards ----

  // What an operation needs from the lock screen. Android mirrors its keyguard
  // and accepts input on it, so the owner can unlock the phone from the Mac.
  // Reading the keyguard's tree or pixels, and anything that acts inside an
  // app, still needs the phone unlocked.
  private static final int ANY = 0;
  /** The screen is on: either unlocked, or showing the keyguard. */
  private static final int AWAKE = 1;
  private static final int UNLOCKED = 2;

  private static void unlocked() throws Exception {
    if (Device.locked()) throw new Failure("device locked", "Unlock the device");
  }

  private static void awake() throws Exception {
    // With the screen off there is nothing to aim at, and input would be dropped.
    if (Device.locked() && !Device.interactive()) throw new Failure("device locked", "Wake the device");
  }

  private void guard(JSONObject a, int needs) throws Exception {
    // Two touch streams must not interleave: any other input ends a live stroke.
    pointer.release();
    if (needs == UNLOCKED) unlocked();
    else if (needs == AWAKE) awake();
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

  // ---- live touch ----

  private Object pointer(JSONObject a) throws Exception {
    String phase = a.getString("phase"), id = a.getString("stroke");
    switch (phase) {
      case "down":
        // The guards are checked once, where the finger lands, as for a recorded gesture.
        guard(a, AWAKE);
        pointer.down(id, a.getJSONArray("points"), Device.screen());
        break;
      case "move":
        // A drag may change the foreground app, but it must not carry on into
        // a screen that has since turned off.
        if (Device.locked() && !Device.interactive()) {
          pointer.release();
          throw new Failure("device locked", "Wake the device");
        }
        pointer.move(id, a.getJSONArray("points"), Device.screen());
        break;
      case "up": pointer.up(id, a.optJSONArray("points"), Device.screen()); break;
      case "cancel": pointer.cancel(id); break;
      default: throw new Failure("invalid argument", "Unknown pointer phase");
    }
    return JSONObject.NULL;
  }

  // ---- keyboard ----

  private void type(String text) throws Exception {
    if (text.isEmpty()) return;
    // Key events behave like a real keyboard and reach every surface. Text the
    // virtual keyboard cannot produce is placed through the focused field instead.
    if (Device.typeKeys(text)) return;
    // That second route reads the focused field. On the lock screen the field
    // holds the PIN or password, which iPortal does not inspect.
    if (Device.locked())
      throw new Failure("unsupported operation", "The lock screen accepts only characters on a hardware keyboard");
    inspector.insert(text);
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

  private interface Work {
    JSONObject run() throws Exception;
  }

  /** One clipboard transfer, which may outlast the command that started it. */
  private static final class Transfer {
    final String lease;
    JSONObject result;
    Throwable error;
    boolean done;

    Transfer(String lease) {
      this.lease = lease;
    }
  }

  private Transfer transfer;

  /**
   * Runs a transfer once per lease. Storing or converting an image can take
   * longer than one command may. The contract's "pending" reply lets the Mac
   * ask again with the same lease, and the work is not started twice.
   */
  private JSONObject transfer(String lease, Work work) throws Exception {
    Transfer current = transfer;
    if (current == null || !current.lease.equals(lease)) {
      Transfer started = new Transfer(lease);
      Thread thread = new Thread(() -> {
        JSONObject result = null;
        Throwable error = null;
        try {
          result = work.run();
        } catch (Throwable failed) {
          error = failed;
        }
        synchronized (started) {
          started.result = result;
          started.error = error;
          started.done = true;
          started.notifyAll();
        }
      }, "iportal-clipboard");
      thread.setDaemon(true);
      thread.start();
      transfer = current = started;
    }
    synchronized (current) {
      if (!current.done) current.wait(1500);
      if (!current.done) return new JSONObject().put("pending", true);
    }
    transfer = null;
    if (current.error instanceof Exception) throw (Exception) current.error;
    if (current.error != null) throw new RuntimeException(current.error);
    return current.result;
  }

  private static final int IMAGE_LIMIT = 4 * 1024 * 1024;
  private static final long PIXEL_LIMIT = 20_000_000;
  /** Names the pictures iPortal stores for the clipboard, so it removes its own and no others. */
  private static final String IMAGE_PREFIX = "iportal-clipboard-";

  private static JSONObject payload(String format, byte[] bytes) throws Exception {
    return new JSONObject().put("format", format).put("content", Base64.getEncoder().encodeToString(bytes));
  }

  private static boolean png(byte[] bytes) {
    return bytes.length > 8 && (bytes[0] & 0xff) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G';
  }

  /** The image behind a clipboard URI as PNG within the transfer limits, or null if it is not an image. */
  private static JSONObject image(Uri uri) throws Exception {
    byte[] raw;
    try {
      // Reading the clipboard granted the shell user access to this URI.
      raw = Device.readContent(uri, 32 * 1024 * 1024);
    } catch (Failure failure) {
      throw failure;
    } catch (Exception refused) {
      Agent.log("clipboard image unreadable: " + refused.getClass().getSimpleName());
      throw new Failure("unsupported operation", "The app that copied this image does not let iPortal read it");
    }
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(raw, 0, raw.length, options);
    if (options.outWidth <= 0 || options.outHeight <= 0) return null;
    long pixels = (long) options.outWidth * options.outHeight;
    if (png(raw) && raw.length <= IMAGE_LIMIT && pixels <= PIXEL_LIMIT) return payload("image", raw);
    // The Mac takes PNG. A photograph is far larger as PNG than as JPEG, so it
    // starts smaller. Either way the picture is halved until it fits.
    long budget = png(raw) ? PIXEL_LIMIT : 3_000_000;
    options.inJustDecodeBounds = false;
    for (int sample = 1; sample <= 64; sample *= 2) {
      if (pixels / ((long) sample * sample) > budget) continue;
      options.inSampleSize = sample;
      Bitmap bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.length, options);
      if (bitmap == null) return null;
      ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
      bitmap.recycle();
      if (out.size() <= IMAGE_LIMIT) return payload("image", out.toByteArray());
    }
    throw new Failure("unsupported operation", "The copied image is too large to transfer");
  }

  private static JSONObject clipboardRead() throws Exception {
    ClipData clip = Device.readClip();
    if (clip == null || clip.getItemCount() == 0) return new JSONObject().put("empty", true);
    ClipData.Item item = clip.getItemAt(0);
    Uri uri = item.getUri();
    // One representation is transferred, preferring an image, as on iPhone.
    if (uri != null && "content".equals(uri.getScheme())
        && (clip.getDescription().hasMimeType("image/*") || clip.getDescription().hasMimeType("text/uri-list"))) {
      JSONObject image = image(uri);
      if (image != null) return image;
    }
    CharSequence text = item.getText();
    if (text == null && uri != null && !"content".equals(uri.getScheme())) text = uri.toString();
    if (text == null || text.length() == 0) return new JSONObject().put("empty", true);
    String value = text.toString();
    boolean link = value.matches("(?i)https?://\\S+");
    return payload(link ? "url" : "text", value.getBytes(StandardCharsets.UTF_8));
  }

  private static JSONObject clipboardWrite(JSONObject a) throws Exception {
    String format = a.getString("format");
    byte[] bytes = Base64.getDecoder().decode(a.getString("content"));
    if (!format.equals("image")) {
      Device.writeClip(ClipData.newPlainText("iPortal", new String(bytes, StandardCharsets.UTF_8)));
      return new JSONObject().put("format", format).put("bytes", bytes.length);
    }
    boolean jpeg = bytes.length > 3 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xd8;
    if (!png(bytes) && !jpeg) throw new Failure("invalid argument", "Send the image as PNG or JPEG");
    String type = jpeg ? "image/jpeg" : "image/png";
    // The helper is not an installed app and has no content provider of its
    // own. An image on the clipboard must be a content URI that another app
    // can open, so the picture goes into the phone's media store and the
    // clipboard points there. Only the latest one is kept.
    Uri stored;
    try {
      Device.deleteImages(IMAGE_PREFIX);
      stored = Device.insertImage(IMAGE_PREFIX + UUID.randomUUID() + (jpeg ? ".jpg" : ".png"), type, bytes);
    } catch (Failure failure) {
      throw failure;
    } catch (Exception refused) {
      Agent.log("clipboard image not stored: " + refused.getClass().getSimpleName());
      throw new Failure("unsupported operation", "This device did not let iPortal store an image for its clipboard");
    }
    try {
      Device.writeClip(new ClipData(new ClipDescription("iPortal", new String[] {type}), new ClipData.Item(stored)));
    } catch (Exception refused) {
      Agent.log("clipboard image not placed: " + refused.getClass().getSimpleName());
      Device.deleteImages(IMAGE_PREFIX);
      throw new Failure("unsupported operation", "This device did not let iPortal put an image on its clipboard");
    }
    return new JSONObject().put("format", format).put("bytes", bytes.length);
  }
}
