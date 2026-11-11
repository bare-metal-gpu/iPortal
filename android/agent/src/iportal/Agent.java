package iportal;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Looper;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * iPortal's Android helper. It is started over adb as the shell user with
 * app_process; nothing is installed on the device. It serves the same
 * authenticated contract as the iPhone helper (status, commands, events, basic
 * video) on a device-local socket that the Mac reaches through adb.
 */
public final class Agent {
  static final int PROTOCOL = 1;
  static final String BUILD = "android-1";
  private static final long IDLE_EXIT_MS = 45_000;
  private static final int MAX_BODY = 8 * 1024 * 1024;

  private final String generation = UUID.randomUUID().toString();
  private final byte[] credential;
  private final Inspector inspector = new Inspector();
  private final Video video = new Video();
  private final Commands commands = new Commands(this, inspector, video);
  private final Object commandLock = new Object();
  private final AtomicInteger streams = new AtomicInteger();
  private volatile String activeOperation;
  private volatile long lastContact = System.currentTimeMillis();
  private volatile boolean viewerReady;
  private volatile long keepAwakeUntil;
  private volatile boolean stopping;

  static void log(String message) {
    System.err.println("iportal-agent: " + message);
  }

  public static void main(String[] args) throws Exception {
    String socket = null;
    for (int i = 0; i + 1 < args.length; i += 2) if (args[i].equals("--socket")) socket = args[i + 1];
    String token = System.getenv("IPORTAL_HELPER_TOKEN");
    if (socket == null || !socket.matches("[A-Za-z0-9_.-]{1,64}") || token == null
        || !token.matches("[a-f0-9]{64}")) {
      log("usage: IPORTAL_HELPER_TOKEN=<64 hex> app_process / iportal.Agent --socket <name>");
      System.exit(64);
    }
    Looper.prepareMainLooper();
    new Agent(token).serve(socket);
  }

  private Agent(String token) {
    credential = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
  }

  private void serve(String name) throws IOException {
    LocalServerSocket server = new LocalServerSocket(name);
    Thread watchdog = new Thread(this::watch, "iportal-watchdog");
    watchdog.setDaemon(true);
    watchdog.start();
    Thread warm = new Thread(() -> {
      try {
        Device.clipChanges();
        inspector.automation();
      } catch (Throwable error) {
        log("UI automation unavailable: " + Device.unwrap(error));
      }
    }, "iportal-warm");
    warm.setDaemon(true);
    warm.start();
    log("ready " + BUILD + " generation " + generation);
    while (!stopping) {
      LocalSocket client = server.accept();
      Thread thread = new Thread(() -> connection(client), "iportal-http");
      thread.setDaemon(true);
      thread.start();
    }
  }

  /** The Mac side owns this process. Without it there is nothing to serve. */
  private void watch() {
    for (;;) {
      try {
        Thread.sleep(5000);
      } catch (InterruptedException interrupted) {
        return;
      }
      if (streams.get() > 0) lastContact = System.currentTimeMillis();
      if (System.currentTimeMillis() - lastContact > IDLE_EXIT_MS) {
        log("no client; exiting");
        exit();
      }
    }
  }

  void shutdownSoon() {
    stopping = true;
    Thread thread = new Thread(() -> {
      try {
        Thread.sleep(150);
      } catch (InterruptedException ignored) {
        // Exit regardless.
      }
      exit();
    });
    thread.start();
  }

  private void exit() {
    inspector.close();
    System.exit(0);
  }

  // ---- status ----

  JSONObject status() throws Exception {
    boolean locked = Device.locked();
    Device.Screen screen = Device.screen();
    return new JSONObject()
        .put("protocol", PROTOCOL)
        .put("build", BUILD)
        .put("generation", generation)
        .put("phase", stopping ? "stopping" : locked ? "locked" : "ready")
        .put("automationReady", true)
        .put("locked", locked)
        .put("activeOperation", activeOperation == null ? JSONObject.NULL : activeOperation)
        .put("displayPixels", new JSONObject().put("width", screen.width).put("height", screen.height))
        .put("capabilities", new JSONObject()
            .put("touch", true)
            .put("multiTouch", true)
            .put("keyboard", true)
            .put("inspection", true)
            .put("clipboard", true)
            .put("video", true));
  }

  void presence(boolean ready, long keepAwakeMs) {
    viewerReady = ready;
    keepAwakeUntil = keepAwakeMs > 0 ? System.currentTimeMillis() + keepAwakeMs : 0;
  }

  JSONObject portal() throws Exception {
    Device.Screen screen = Device.screen();
    return new JSONObject()
        .put("phase", viewerReady ? "connected" : "waiting")
        .put("message", viewerReady ? "Connected" : "Waiting")
        .put("detail", "")
        .put("keepAwakeRemainingMs",
            Math.max(0, Math.min(7_200_000, keepAwakeUntil - System.currentTimeMillis())))
        .put("screenInstalled", false)
        .put("width", screen.width)
        .put("height", screen.height)
        .put("foreground", false)
        .put("usbEvents", new JSONArray())
        .put("phaseEvents", new JSONArray());
  }

  // ---- commands ----

  private JSONObject command(JSONObject request) throws Exception {
    String id = request.getString("id");
    JSONObject reply = new JSONObject().put("id", id).put("generation", generation);
    try {
      if (!generation.equals(request.optString("generation")))
        throw new Failure("stale generation", "The helper restarted");
      String operation = request.getString("operation");
      JSONObject arguments = request.optJSONObject("arguments");
      Object result;
      synchronized (commandLock) {
        activeOperation = id;
        try {
          result = commands.run(operation, arguments == null ? new JSONObject() : arguments);
        } finally {
          activeOperation = null;
        }
      }
      reply.put("result", result);
    } catch (Throwable thrown) {
      Throwable error = Device.unwrap(thrown);
      Failure failure = error instanceof Failure
          ? (Failure) error
          : error instanceof org.json.JSONException
              ? new Failure("invalid argument", String.valueOf(error.getMessage()))
              : new Failure("unknown", "upstream error", error.getClass().getSimpleName() + ": " + error.getMessage());
      String message = String.valueOf(failure.getMessage());
      reply.put("error", new JSONObject()
          .put("code", failure.code)
          .put("message", message.length() > 2000 ? message.substring(0, 2000) : message)
          .put("outcome", failure.outcome));
    }
    return reply;
  }

  // ---- HTTP ----

  private static String line(InputStream in) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(128);
    for (int value; (value = in.read()) >= 0; ) {
      if (value == '\n') {
        String text = bytes.toString("ISO-8859-1");
        return text.endsWith("\r") ? text.substring(0, text.length() - 1) : text;
      }
      if (bytes.size() > 8192) throw new IOException("header too long");
      bytes.write(value);
    }
    return null;
  }

  private static void head(OutputStream out, int status, String type, long length, boolean authenticated)
      throws IOException {
    StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(status == 200 ? " OK" : " Error");
    head.append("\r\ncontent-type: ").append(type).append("\r\ncache-control: no-store");
    if (authenticated) head.append("\r\nx-iportal-helper-auth: 1");
    if (length >= 0) head.append("\r\ncontent-length: ").append(length);
    else head.append("\r\nconnection: close");
    out.write(head.append("\r\n\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
  }

  private static void json(OutputStream out, int status, Object body, boolean authenticated) throws IOException {
    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
    head(out, status, "application/json", bytes.length, authenticated);
    out.write(bytes);
    out.flush();
  }

  private void connection(LocalSocket client) {
    try (LocalSocket socket = client) {
      InputStream in = new BufferedInputStream(socket.getInputStream(), 16384);
      OutputStream out = socket.getOutputStream();
      for (;;) {
        String request = line(in);
        if (request == null || request.isEmpty()) return;
        String[] parts = request.split(" ");
        if (parts.length < 2) return;
        Map<String, String> headers = new HashMap<>();
        for (String header; (header = line(in)) != null && !header.isEmpty(); ) {
          int colon = header.indexOf(':');
          if (colon > 0)
            headers.put(header.substring(0, colon).trim().toLowerCase(Locale.ROOT), header.substring(colon + 1).trim());
        }
        int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
        if (length < 0 || length > MAX_BODY) return;
        byte[] body = new byte[length];
        for (int read = 0; read < length; ) {
          int count = in.read(body, read, length - read);
          if (count < 0) return;
          read += count;
        }
        byte[] offered = headers.getOrDefault("authorization", "").getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(offered, credential)) {
          json(out, 401, new JSONObject().put("error", "unauthorized"), false);
          return;
        }
        lastContact = System.currentTimeMillis();
        String method = parts[0], path = parts[1];
        if (method.equals("GET") && path.equals("/v1/status")) json(out, 200, status(), true);
        else if (method.equals("POST") && path.equals("/v1/commands"))
          json(out, 200, command(new JSONObject(new String(body, StandardCharsets.UTF_8))), true);
        else if (method.equals("GET") && path.equals("/v1/events")) {
          events(out);
          return;
        } else if (method.equals("GET") && path.equals("/v1/video")) {
          video(out);
          return;
        } else json(out, 404, new JSONObject().put("error", "not found"), true);
      }
    } catch (Throwable closed) {
      // A dropped connection ends its own request only.
    }
  }

  private void events(OutputStream out) throws Exception {
    head(out, 200, "text/event-stream", -1, true);
    streams.incrementAndGet();
    try {
      String sent = null;
      long sentAt = 0;
      while (!stopping) {
        String current = status().toString();
        long now = System.currentTimeMillis();
        if (!current.equals(sent) || now - sentAt >= 2000) {
          out.write(("event: status\ndata: " + current + "\n\n").getBytes(StandardCharsets.UTF_8));
          out.flush();
          sent = current;
          sentAt = now;
        }
        Thread.sleep(200);
      }
    } finally {
      streams.decrementAndGet();
    }
  }

  private void video(OutputStream out) throws Exception {
    head(out, 200, "multipart/x-mixed-replace; boundary=frame", -1, true);
    streams.incrementAndGet();
    video.acquire();
    try {
      long sequence = -1;
      while (!stopping) {
        // A still screen produces no new frame. Repeating the last one keeps the
        // stream inside the Mac side's stall deadline.
        Object[] next = video.next(sequence, 1000);
        if (next == null) continue;
        byte[] frame = (byte[]) next[0];
        sequence = (Long) next[1];
        out.write(("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + frame.length + "\r\n\r\n")
            .getBytes(StandardCharsets.ISO_8859_1));
        out.write(frame);
        out.write('\r');
        out.write('\n');
        out.flush();
      }
    } finally {
      video.release();
      streams.decrementAndGet();
    }
  }
}
