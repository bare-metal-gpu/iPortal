// Throwaway feasibility probe. Runs as the adb shell user through app_process;
// it is not an app, installs nothing, and is not part of iPortal.
import android.app.UiAutomation;
import android.content.AttributionSource;
import android.content.ClipData;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.display.VirtualDisplay;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class Probe {
  static final String SHELL = "com.android.shell";
  static int width = 1080, height = 2400;

  static void log(String key, Object value) {
    System.out.println(key + ": " + value);
  }

  static double ms(long nanos) {
    return Math.round((System.nanoTime() - nanos) / 10000.0) / 100.0;
  }

  public static void main(String[] args) {
    Looper.prepareMainLooper();
    String[] steps = args.length > 0 ? args : new String[] {"input", "clipboard", "video", "tree", "audio"};
    for (String step : steps) {
      try {
        switch (step) {
          case "input": input(); break;
          case "clipboard": clipboard(); break;
          case "video": video("video/avc"); break;
          case "hevc": video("video/hevc"); break;
          case "tree": tree(); break;
          case "audio": audio(); break;
          default: log(step, "unknown step");
        }
      } catch (Throwable error) {
        Throwable cause = error instanceof InvocationTargetException ? error.getCause() : error;
        log(step + ".error", cause);
        StackTraceElement[] trace = cause.getStackTrace();
        for (int i = 0; i < Math.min(4, trace.length); i++) log(step + ".at", trace[i]);
      }
    }
    System.exit(0);
  }

  // ---- input: InputManager injection, the mechanism scrcpy uses ----
  static Object inputManager;
  static Method inject;

  static void initInput() throws Exception {
    if (inject != null) return;
    Class<?> type;
    try {
      type = Class.forName("android.hardware.input.InputManagerGlobal");
    } catch (ClassNotFoundException missing) {
      type = Class.forName("android.hardware.input.InputManager");
    }
    inputManager = type.getDeclaredMethod("getInstance").invoke(null);
    inject = inputManager.getClass().getMethod("injectInputEvent", InputEvent.class, int.class);
    log("input.manager", type.getName());
  }

  static boolean send(int action, long down, int mode, float... xy) throws Exception {
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
    MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, count,
        properties, coords, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
    boolean ok = (Boolean) inject.invoke(inputManager, event, mode);
    event.recycle();
    return ok;
  }

  static void input() throws Exception {
    initInput();
    float x = width / 2f, y = height / 2f;
    // A downward drag at the top of a list: overscroll only, activates nothing.
    for (int mode : new int[] {0, 2}) {
      List<Double> samples = new ArrayList<>();
      boolean ok = true;
      for (int i = 0; i < 5; i++) {
        long down = SystemClock.uptimeMillis();
        long start = System.nanoTime();
        ok &= send(MotionEvent.ACTION_DOWN, down, mode, x, y);
        samples.add(ms(start));
        for (int step = 1; step <= 8; step++) {
          Thread.sleep(8);
          ok &= send(MotionEvent.ACTION_MOVE, down, mode, x, y + step * 30);
        }
        ok &= send(MotionEvent.ACTION_UP, down, mode, x, y + 240);
        Thread.sleep(250);
      }
      log("input.single.mode" + mode, "accepted=" + ok + " downInjectMs=" + samples);
    }
    // Continuous two-finger contact (pinch out), which iPortal can only play back as a whole gesture.
    long down = SystemClock.uptimeMillis();
    int second = 1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT;
    boolean ok = send(MotionEvent.ACTION_DOWN, down, 2, x - 60, y);
    ok &= send(MotionEvent.ACTION_POINTER_DOWN | second, down, 2, x - 60, y, x + 60, y);
    for (int step = 1; step <= 10; step++) {
      Thread.sleep(12);
      ok &= send(MotionEvent.ACTION_MOVE, down, 2, x - 60 - step * 20, y, x + 60 + step * 20, y);
    }
    ok &= send(MotionEvent.ACTION_POINTER_UP | second, down, 2, x - 260, y, x + 260, y);
    ok &= send(MotionEvent.ACTION_UP, down, 2, x - 260, y);
    log("input.twoFinger", "accepted=" + ok);
  }

  // ---- clipboard: IClipboard as com.android.shell ----
  static Object call(Object target, String name, Object... given) throws Exception {
    for (Method method : target.getClass().getMethods()) {
      if (!method.getName().equals(name)) continue;
      Class<?>[] types = method.getParameterTypes();
      Object[] values = new Object[types.length];
      int used = 0;
      boolean packageSet = false;
      for (int i = 0; i < types.length; i++) {
        if (used < given.length && types[i].isInstance(given[used])) values[i] = given[used++];
        else if (types[i] == String.class) { values[i] = packageSet ? null : SHELL; packageSet = true; }
        else if (types[i] == int.class) values[i] = 0;
        else if (types[i] == boolean.class) values[i] = false;
      }
      if (used != given.length) continue;
      log("clipboard.signature", name + Arrays.toString(types));
      return method.invoke(target, values);
    }
    throw new NoSuchMethodException(name);
  }

  static void clipboard() throws Exception {
    Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, "clipboard");
    Object service = Class.forName("android.content.IClipboard$Stub").getMethod("asInterface", IBinder.class).invoke(null, binder);
    long start = System.nanoTime();
    ClipData original = (ClipData) call(service, "getPrimaryClip");
    log("clipboard.read", "ms=" + ms(start) + " hadClip=" + (original != null)
        + (original == null ? "" : " mime=" + original.getDescription().getMimeType(0)));
    String marker = "iportal-probe-héllo-👋-" + SystemClock.uptimeMillis();
    start = System.nanoTime();
    call(service, "setPrimaryClip", ClipData.newPlainText("iportal", marker));
    log("clipboard.write", "ms=" + ms(start));
    ClipData back = (ClipData) call(service, "getPrimaryClip");
    log("clipboard.roundTrip", back != null && marker.contentEquals(back.getItemAt(0).getText()));
    if (original != null) call(service, "setPrimaryClip", original);
    else call(service, "clearPrimaryClip");
    log("clipboard.restored", true);
  }

  // ---- video: mirror display 0 into a MediaCodec surface ----
  static void video(String mime) throws Exception {
    initInput();
    MediaFormat format = MediaFormat.createVideoFormat(mime, width, height);
    format.setInteger(MediaFormat.KEY_BIT_RATE, 8_000_000);
    format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    long start = System.nanoTime();
    MediaCodec codec = MediaCodec.createEncoderByType(mime);
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
    Surface surface = codec.createInputSurface();
    Method create = Class.forName("android.hardware.display.DisplayManager").getMethod(
        "createVirtualDisplay", String.class, int.class, int.class, int.class, Surface.class);
    VirtualDisplay display = (VirtualDisplay) create.invoke(null, "iportal-probe", width, height, 0, surface);
    codec.start();
    log(mime + ".encoder", codec.getName() + " setupMs=" + ms(start));

    MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    FileOutputStream out = new FileOutputStream("/data/local/tmp/iportal-probe." + (mime.endsWith("avc") ? "h264" : "h265"));
    int frames = 0;
    long bytes = 0;
    double first = -1;
    long idleSince = System.nanoTime();
    List<Double> latency = new ArrayList<>();
    long injectedAt = 0;
    long gestureDown = 0;
    int moves = 0;
    boolean sampled = false;
    float x = width / 2f, y = height / 2f;
    long deadline = System.nanoTime() + 14_000_000_000L;
    while (System.nanoTime() < deadline && latency.size() < 8) {
      int index = codec.dequeueOutputBuffer(info, 5_000);
      if (index >= 0) {
        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
          frames++;
          if (first < 0) first = ms(start);
          if (injectedAt != 0 && !sampled) {
            latency.add(ms(injectedAt));
            sampled = true;
          }
          idleSince = System.nanoTime();
        }
        ByteBuffer buffer = codec.getOutputBuffer(index);
        byte[] chunk = new byte[info.size];
        buffer.position(info.offset);
        buffer.get(chunk);
        out.write(chunk);
        bytes += info.size;
        codec.releaseOutputBuffer(index, false);
      }
      if (injectedAt != 0) {
        // Keep the finger moving so frames keep flowing, then lift after ~40 moves.
        if (moves < 40) send(MotionEvent.ACTION_MOVE, gestureDown, 0, x, y + 60 + ++moves * 6);
        else if (sampled || moves++ > 200) {
          send(MotionEvent.ACTION_UP, gestureDown, 0, x, y + 300);
          injectedAt = 0;
          idleSince = System.nanoTime();
        }
      } else if (frames > 0 && System.nanoTime() - idleSince > 700_000_000L) {
        // Screen is static: start a drag and time until the encoder emits a frame.
        gestureDown = SystemClock.uptimeMillis();
        moves = 0;
        sampled = false;
        send(MotionEvent.ACTION_DOWN, gestureDown, 0, x, y);
        injectedAt = System.nanoTime();
        send(MotionEvent.ACTION_MOVE, gestureDown, 0, x, y + 60);
      }
    }
    out.close();
    log(mime + ".stream", "frames=" + frames + " bytes=" + bytes + " firstFrameMs=" + first);
    log(mime + ".injectToEncodedFrameMs", latency);
    display.release();
    codec.stop();
    codec.release();
  }

  // ---- UI tree and element actions: UiAutomation, as the uiautomator shell tool does ----
  static int walk(AccessibilityNodeInfo node, Rect bounds, StringBuilder sample) {
    if (node == null) return 0;
    node.getBoundsInScreen(bounds);
    CharSequence text = node.getText();
    if (text != null && sample.length() < 160) sample.append(text).append(" | ");
    int count = 1;
    for (int i = 0; i < node.getChildCount(); i++) count += walk(node.getChild(i), bounds, sample);
    return count;
  }

  static AccessibilityNodeInfo find(AccessibilityNodeInfo node, String needle) {
    if (node == null) return null;
    CharSequence text = node.getText();
    if (text != null && text.toString().toLowerCase().contains(needle)) return node;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo found = find(node.getChild(i), needle);
      if (found != null) return found;
    }
    return null;
  }

  static void tree() throws Exception {
    HandlerThread thread = new HandlerThread("iportal-probe");
    thread.start();
    Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
    Constructor<?> connectionConstructor = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor();
    connectionConstructor.setAccessible(true);
    Object connection = connectionConstructor.newInstance();
    UiAutomation automation = null;
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
      automation = (UiAutomation) constructor.newInstance(values);
      log("tree.constructor", Arrays.toString(types));
      break;
    }
    long start = System.nanoTime();
    // 1 = FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES, so TalkBack and similar keep running.
    UiAutomation.class.getMethod("connect", int.class).invoke(automation, 1);
    log("tree.connectMs", ms(start));
    try {
      start = System.nanoTime();
      while (automation.getRootInActiveWindow() == null && ms(start) < 3000) Thread.sleep(20);
      log("tree.firstWindowMs", ms(start));
      for (int i = 0; i < 3; i++) {
        start = System.nanoTime();
        StringBuilder sample = new StringBuilder();
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        int nodes = walk(root, new Rect(), sample);
        log("tree.walk", "ms=" + ms(start) + " nodes=" + nodes + " package=" + (root == null ? null : root.getPackageName())
            + (i == 0 ? " sample=" + sample : ""));
      }
      start = System.nanoTime();
      Bitmap bitmap = automation.takeScreenshot();
      double captured = ms(start);
      ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
      bitmap.compress(Bitmap.CompressFormat.JPEG, 85, jpeg);
      log("tree.screenshot", "captureMs=" + captured + " withJpegMs=" + ms(start) + " " + bitmap.getWidth() + "x"
          + bitmap.getHeight() + " jpegBytes=" + jpeg.size());

      // Element action plus Unicode text replacement, against the Settings search field.
      AccessibilityNodeInfo search = find(automation.getRootInActiveWindow(), "search");
      if (search == null) { log("tree.action", "no search field on screen; skipped"); return; }
      AccessibilityNodeInfo clickable = search;
      while (clickable != null && !clickable.isClickable()) clickable = clickable.getParent();
      start = System.nanoTime();
      boolean clicked = clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
      log("tree.click", "accepted=" + clicked + " ms=" + ms(start));
      AccessibilityNodeInfo field = null;
      for (int i = 0; i < 30 && field == null; i++) {
        Thread.sleep(100);
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field != null && !field.isEditable()) field = null;
      }
      if (field == null) { log("tree.setText", "no focused editable field appeared"); return; }
      String text = "héllo 👋 日本語";
      Bundle arguments = new Bundle();
      arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
      start = System.nanoTime();
      boolean set = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
      double took = ms(start);
      Thread.sleep(300);
      field.refresh();
      log("tree.setText", "accepted=" + set + " ms=" + took + " readBackMatches=" + text.contentEquals(String.valueOf(field.getText())));
      arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "");
      field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    } finally {
      automation.getClass().getMethod("disconnect").invoke(automation);
      thread.quitSafely();
    }
  }

  // ---- audio: REMOTE_SUBMIX capture of device playback, as scrcpy does on Android 12+ ----
  static final class ShellContext extends ContextWrapper {
    ShellContext() { super(null); }
    @Override public String getPackageName() { return SHELL; }
    @Override public String getOpPackageName() { return SHELL; }
    @Override public String getAttributionTag() { return null; }
    @Override public AttributionSource getAttributionSource() {
      return new AttributionSource.Builder(android.os.Process.myUid()).setPackageName(SHELL).build();
    }
    @Override public int getDeviceId() { return 0; }
    @Override public Context getApplicationContext() { return this; }
    @Override public Object getSystemService(String name) { return null; }
  }

  static void audio() throws Exception {
    int rate = 48000;
    AudioFormat format = new AudioFormat.Builder().setSampleRate(rate)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
    long start = System.nanoTime();
    AudioRecord record = new AudioRecord.Builder().setContext(new ShellContext())
        .setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX).setAudioFormat(format)
        .setBufferSizeInBytes(4 * AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT))
        .build();
    record.startRecording();
    if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
      log("audio.capture", "did not start");
      return;
    }
    log("audio.capture", "started ms=" + ms(start));
    // Only now play a tone: with the submix active it is routed to the capture, not the speaker.
    Thread tone = new Thread(() -> {
      try {
        short[] samples = new short[rate];
        for (int i = 0; i < samples.length; i++) samples[i] = (short) (Math.sin(2 * Math.PI * 440 * i / rate) * 2000);
        AudioTrack track = new AudioTrack.Builder()
            .setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(samples.length * 2).setTransferMode(AudioTrack.MODE_STATIC).build();
        track.write(samples, 0, samples.length);
        track.play();
        log("audio.tone", "playState=" + track.getPlayState());
        Thread.sleep(1100);
        track.release();
      } catch (Throwable error) {
        log("audio.tone.error", error);
      }
    });
    Thread.sleep(400);
    tone.start();
    short[] buffer = new short[4096];
    java.io.DataOutputStream pcm = new java.io.DataOutputStream(new java.io.BufferedOutputStream(new FileOutputStream("/data/local/tmp/iportal-probe.pcm")));
    long total = 0;
    int peak = 0;
    long until = System.nanoTime() + 1_500_000_000L;
    while (System.nanoTime() < until) {
      int read = record.read(buffer, 0, buffer.length);
      if (read <= 0) break;
      total += read;
      for (int i = 0; i < read; i++) { peak = Math.max(peak, Math.abs(buffer[i])); pcm.writeShort(buffer[i]); }
    }
    tone.join();
    pcm.close();
    record.stop();
    record.release();
    log("audio.result", "stereoSamples=" + total / 2 + " peak=" + peak + " (tone amplitude 2000; 0 means silence only)");
  }
}
