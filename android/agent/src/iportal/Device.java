package iportal;

import android.content.AttributionSource;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Framework access for a process running as the adb shell user. There is no
 * application context here, so system services are reached through their binder
 * interfaces. Signatures differ between Android releases; lookups go by name
 * and fill the arguments each release expects.
 */
final class Device {
  static final String SHELL_PACKAGE = "com.android.shell";
  static final int INJECT_ASYNC = 0;
  static final int INJECT_WAIT_FOR_FINISH = 2;

  private static Object inputManager;
  private static Method injectInputEvent;
  private static Object displayManager;
  private static Object windowManager;
  private static Object powerManager;
  private static Object clipboard;
  private static Object activityTasks;

  private Device() {}

  static Object service(String name, String stub) throws Exception {
    Object binder =
        Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, name);
    if (binder == null) throw new Failure("unsupported operation", "System service unavailable: " + name);
    return Class.forName(stub).getMethod("asInterface", IBinder.class).invoke(null, binder);
  }

  static Throwable unwrap(Throwable error) {
    return error instanceof InvocationTargetException && error.getCause() != null ? error.getCause() : error;
  }

  /** Calls the first overload of {@code name} whose leading parameters accept {@code given}. */
  static Object call(Object target, String name, Object... given) throws Exception {
    Exception last = new NoSuchMethodException(name);
    for (Method method : target.getClass().getMethods()) {
      if (!method.getName().equals(name)) continue;
      Class<?>[] types = method.getParameterTypes();
      Object[] values = new Object[types.length];
      int used = 0;
      boolean packageGiven = false;
      for (int i = 0; i < types.length; i++) {
        if (used < given.length && accepts(types[i], given[used])) values[i] = given[used++];
        else if (types[i] == String.class) {
          values[i] = packageGiven ? null : SHELL_PACKAGE;
          packageGiven = true;
        } else if (types[i] == int.class) values[i] = 0;
        else if (types[i] == long.class) values[i] = 0L;
        else if (types[i] == boolean.class) values[i] = false;
        else if (types[i] == float.class) values[i] = 0f;
        // Content providers identify their caller this way since Android 12.
        else if (types[i] == AttributionSource.class) values[i] = attribution();
      }
      if (used != given.length) continue;
      try {
        // Binder proxies are public methods of classes that are not public.
        method.setAccessible(true);
      } catch (RuntimeException inaccessible) {
        // Invoke it as it is.
      }
      try {
        return method.invoke(target, values);
      } catch (InvocationTargetException error) {
        Throwable cause = unwrap(error);
        last = cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
      }
    }
    throw last;
  }

  private static boolean accepts(Class<?> type, Object value) {
    if (value == null) return !type.isPrimitive();
    if (type == int.class) return value instanceof Integer;
    if (type == long.class) return value instanceof Long;
    if (type == boolean.class) return value instanceof Boolean;
    if (type == float.class) return value instanceof Float;
    return type.isInstance(value);
  }

  // ---- display ----

  static final class Screen {
    final int width, height, rotation;

    Screen(int width, int height, int rotation) {
      this.width = width;
      this.height = height;
      this.rotation = rotation;
    }

    String orientation() {
      switch (rotation) {
        case 1: return "LANDSCAPE";
        case 2: return "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN";
        case 3: return "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT";
        default: return "PORTRAIT";
      }
    }
  }

  /** Size of the default display as currently rotated, in pixels. */
  static Screen screen() throws Exception {
    if (displayManager == null)
      displayManager =
          Class.forName("android.hardware.display.DisplayManagerGlobal").getMethod("getInstance").invoke(null);
    Object info = displayManager.getClass().getMethod("getDisplayInfo", int.class).invoke(displayManager, 0);
    Class<?> type = info.getClass();
    return new Screen(
        type.getField("logicalWidth").getInt(info),
        type.getField("logicalHeight").getInt(info),
        type.getField("rotation").getInt(info));
  }

  // ---- input ----

  private static void initInput() throws Exception {
    if (injectInputEvent != null) return;
    Class<?> type;
    try {
      type = Class.forName("android.hardware.input.InputManagerGlobal");
    } catch (ClassNotFoundException older) {
      type = Class.forName("android.hardware.input.InputManager");
    }
    inputManager = type.getDeclaredMethod("getInstance").invoke(null);
    injectInputEvent = inputManager.getClass().getMethod("injectInputEvent", InputEvent.class, int.class);
  }

  static boolean inject(InputEvent event, int mode) throws Exception {
    initInput();
    return (Boolean) injectInputEvent.invoke(inputManager, event, mode);
  }

  /** {@code xy} holds pixel coordinates, two per pointer. */
  static void touch(int action, long downTime, int mode, float... xy) throws Exception {
    int count = xy.length / 2;
    MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
    for (int i = 0; i < count; i++) {
      properties[i] = new MotionEvent.PointerProperties();
      properties[i].id = i;
      properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[i] = new MotionEvent.PointerCoords();
      coords[i].x = xy[2 * i];
      coords[i].y = xy[2 * i + 1];
      coords[i].pressure = 1;
      coords[i].size = 1;
    }
    MotionEvent event =
        MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, count, properties, coords, 0, 0, 1, 1,
            0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    try {
      if (!inject(event, mode)) throw new Failure("unknown", "upstream error", "Touch event was rejected");
    } finally {
      event.recycle();
    }
  }

  static void key(int code, int meta) throws Exception {
    long now = SystemClock.uptimeMillis();
    for (int action : new int[] {KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP}) {
      KeyEvent event =
          new KeyEvent(now, SystemClock.uptimeMillis(), action, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD,
              0, 0, InputDevice.SOURCE_KEYBOARD);
      if (!inject(event, INJECT_WAIT_FOR_FINISH))
        throw new Failure("unknown", "upstream error", "Key event was rejected");
    }
  }

  /** Types characters the virtual keyboard can produce. Returns false, sending nothing, otherwise. */
  static boolean typeKeys(String text) throws Exception {
    KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
    if (events == null) return false;
    for (KeyEvent event : events) {
      KeyEvent timed = KeyEvent.changeTimeRepeat(event, SystemClock.uptimeMillis(), 0);
      if (!inject(timed, INJECT_WAIT_FOR_FINISH))
        throw new Failure("unknown", "upstream error", "Key event was rejected");
    }
    return true;
  }

  // ---- power and keyguard ----

  private static Object windows() throws Exception {
    if (windowManager == null) windowManager = service("window", "android.view.IWindowManager$Stub");
    return windowManager;
  }

  private static Object power() throws Exception {
    if (powerManager == null) powerManager = service("power", "android.os.IPowerManager$Stub");
    return powerManager;
  }

  static boolean locked() throws Exception {
    return (Boolean) call(windows(), "isKeyguardLocked");
  }

  static boolean interactive() throws Exception {
    return (Boolean) call(power(), "isInteractive");
  }

  /** Asks the keyguard to go away. Only an insecure keyguard complies. */
  static void dismissKeyguard() throws Exception {
    call(windows(), "dismissKeyguard", (Object) null, (Object) null);
  }

  /** Resets the screen-off timer the way a touch would, without sending input. */
  static void userActivity() throws Exception {
    long now = SystemClock.uptimeMillis();
    Object manager = power();
    for (Method method : manager.getClass().getMethods()) {
      if (!method.getName().equals("userActivity")) continue;
      Class<?>[] types = method.getParameterTypes();
      Object[] values = new Object[types.length];
      boolean timeGiven = false;
      for (int i = 0; i < types.length; i++) {
        if (types[i] == long.class && !timeGiven) {
          values[i] = now;
          timeGiven = true;
        } else values[i] = 0; // display 0, USER_ACTIVITY_EVENT_OTHER, no flags
      }
      try {
        method.invoke(manager, values);
        return;
      } catch (InvocationTargetException error) {
        throw new Failure("unsupported operation", String.valueOf(unwrap(error).getMessage()));
      }
    }
    throw new Failure("unsupported operation", "userActivity is unavailable");
  }

  // ---- foreground application ----

  static String foregroundPackage() {
    try {
      if (activityTasks == null)
        activityTasks = service("activity_task", "android.app.IActivityTaskManager$Stub");
      Object task = call(activityTasks, "getFocusedRootTaskInfo");
      if (task == null) return null;
      Field field = task.getClass().getField("topActivity");
      ComponentName top = (ComponentName) field.get(task);
      return top == null ? null : top.getPackageName();
    } catch (Throwable unavailable) {
      return null;
    }
  }

  // ---- clipboard ----

  private static Object clipboardService() throws Exception {
    if (clipboard == null) clipboard = service("clipboard", "android.content.IClipboard$Stub");
    return clipboard;
  }

  /** Counts clipboard changes as the system reports them, without reading the clipboard. */
  private static final class ClipListener extends android.os.Binder {
    volatile long changes = 1;

    ClipListener() {
      attachInterface(null, "android.content.IOnPrimaryClipChangedListener");
    }

    @Override
    protected boolean onTransact(int code, android.os.Parcel data, android.os.Parcel reply, int flags)
        throws android.os.RemoteException {
      if (code >= FIRST_CALL_TRANSACTION && code <= LAST_CALL_TRANSACTION) {
        changes++;
        return true;
      }
      return super.onTransact(code, data, reply, flags);
    }
  }

  private static ClipListener clipListener;
  private static boolean clipListenerTried;

  /**
   * A number that changes when the clipboard does, or -1 when the system would
   * not register a listener. Android shows the owner a notice each time the
   * clipboard is read, so change detection must not read it.
   */
  static synchronized long clipChanges() {
    if (!clipListenerTried) {
      clipListenerTried = true;
      try {
        ClipListener listener = new ClipListener();
        Object proxy = Class.forName("android.content.IOnPrimaryClipChangedListener$Stub")
            .getMethod("asInterface", IBinder.class).invoke(null, listener);
        call(clipboardService(), "addPrimaryClipChangedListener", proxy);
        clipListener = listener;
      } catch (Throwable unavailable) {
        Agent.log("clipboard listener unavailable: " + unwrap(unavailable));
      }
    }
    return clipListener == null ? -1 : clipListener.changes;
  }

  static ClipData readClip() throws Exception {
    return (ClipData) call(clipboardService(), "getPrimaryClip");
  }

  static void writeClip(ClipData clip) throws Exception {
    call(clipboardService(), "setPrimaryClip", clip);
  }

  // ---- content providers ----

  private static Object activityManager;

  private static AttributionSource attribution() {
    return new AttributionSource.Builder(android.os.Process.myUid()).setPackageName(SHELL_PACKAGE).build();
  }

  private static int currentUser() {
    try {
      return (Integer) Class.forName("android.app.ActivityManager").getMethod("getCurrentUser").invoke(null);
    } catch (Throwable unavailable) {
      return 0;
    }
  }

  private interface ProviderUse<T> {
    T with(Object provider) throws Exception;
  }

  /**
   * Reaches a content provider the way the {@code content} shell command does.
   * The helper has no application context, so it has no ContentResolver; the
   * activity manager hands the shell user a provider's binder directly.
   */
  private static <T> T provider(String authority, int user, ProviderUse<T> use) throws Exception {
    if (activityManager == null) activityManager = service("activity", "android.app.IActivityManager$Stub");
    IBinder token = new Binder();
    Object holder = call(activityManager, "getContentProviderExternal", authority, user, token, "iportal");
    Object provider = holder == null ? null : holder.getClass().getField("provider").get(holder);
    if (provider == null) throw new Failure("unsupported operation", "Content provider unavailable: " + authority);
    try {
      return use.with(provider);
    } finally {
      try {
        call(activityManager, "removeContentProviderExternalAsUser", authority, token, user);
      } catch (Throwable renamed) {
        try {
          call(activityManager, "removeContentProviderExternal", authority, token);
        } catch (Throwable ignored) {
          // The reference is dropped with the token when this process exits.
        }
      }
    }
  }

  /** A URI can name another user's provider as {@code content://10@authority/…}. */
  private static int userOf(Uri uri) {
    try {
      return uri.getUserInfo() == null ? currentUser() : Integer.parseInt(uri.getUserInfo());
    } catch (NumberFormatException unusual) {
      return currentUser();
    }
  }

  /** Reads what a content URI names, refusing more than {@code limit} bytes. */
  static byte[] readContent(Uri uri, int limit) throws Exception {
    String authority = uri.getHost();
    if (authority == null) throw new Failure("unsupported operation", "Unreadable content address");
    Uri plain = uri.buildUpon().encodedAuthority(authority).build();
    return provider(authority, userOf(uri), provider -> {
      Object opened;
      try {
        opened = call(provider, "openFile", plain, "r");
      } catch (Exception first) {
        // Some providers serve streams only by type.
        try {
          opened = call(provider, "openTypedAssetFile", plain, "image/*");
        } catch (Exception second) {
          throw first;
        }
      }
      if (opened == null) throw new Failure("unsupported operation", "The content could not be opened");
      try (InputStream in = opened instanceof ParcelFileDescriptor
          ? new ParcelFileDescriptor.AutoCloseInputStream((ParcelFileDescriptor) opened)
          : ((AssetFileDescriptor) opened).createInputStream()) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 16);
        byte[] buffer = new byte[65536];
        for (int read; (read = in.read(buffer)) > 0; ) {
          if (out.size() + read > limit) throw new Failure("unsupported operation", "The content is too large");
          out.write(buffer, 0, read);
        }
        return out.toByteArray();
      }
    });
  }

  private static final Uri IMAGES = Uri.parse("content://media/external/images/media");

  /** Stores a picture in the media store and returns its content URI. */
  static Uri insertImage(String name, String type, byte[] bytes) throws Exception {
    return provider("media", currentUser(), provider -> {
      ContentValues values = new ContentValues();
      values.put("_display_name", name);
      values.put("mime_type", type);
      values.put("relative_path", "Pictures/iPortal");
      Uri item = (Uri) call(provider, "insert", IMAGES, values);
      if (item == null) throw new Failure("unsupported operation", "The media store refused the image");
      try {
        ParcelFileDescriptor file = (ParcelFileDescriptor) call(provider, "openFile", item, "w");
        try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(file)) {
          out.write(bytes);
        }
      } catch (Exception failed) {
        // Do not leave an empty picture in the owner's gallery.
        try {
          call(provider, "delete", item);
        } catch (Throwable ignored) {
          // Nothing more can be done from here.
        }
        throw failed;
      }
      return item;
    });
  }

  /** Removes the pictures whose file names begin with {@code prefix}. Failing to is not an error. */
  static void deleteImages(String prefix) {
    try {
      provider("media", currentUser(), provider -> {
        Bundle where = new Bundle();
        where.putString("android:query-arg-sql-selection", "_display_name LIKE ?");
        where.putStringArray("android:query-arg-sql-selection-args", new String[] {prefix + "%"});
        return call(provider, "delete", IMAGES, where);
      });
    } catch (Throwable unavailable) {
      Agent.log("could not remove stored clipboard images: " + unwrap(unavailable).getClass().getSimpleName());
    }
  }

  // ---- shell tools ----

  static String run(String... command) throws Exception {
    Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    try (InputStream stream = process.getInputStream()) {
      byte[] buffer = new byte[4096];
      for (int read; (read = stream.read(buffer)) > 0 && output.size() < 65536; ) output.write(buffer, 0, read);
    }
    if (!process.waitFor(10, TimeUnit.SECONDS)) {
      process.destroyForcibly();
      throw new Failure("unknown", "timeout", command[0] + " did not finish");
    }
    return output.toString("UTF-8");
  }

  static String join(List<String> parts) {
    return String.join(" ", parts);
  }
}
