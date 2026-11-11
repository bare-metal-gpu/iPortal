package iportal;

import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Basic video: the default display mirrored into JPEG frames, for the browser
 * client and for the Mac window's fallback path. It runs only while a client is
 * connected. Native H.264/HEVC for the Mac window is a separate, later stream.
 */
final class Video {
  private HandlerThread thread;
  private Handler handler;
  private VirtualDisplay display;
  private ImageReader reader;
  private Bitmap bitmap;
  private int clients;
  private int sourceWidth, sourceHeight, width, height;
  private int longSide = 1280, quality = 70, intervalMs = 33;
  private long lastEncoded;
  private boolean pending;
  private byte[] frame;
  private long sequence;

  synchronized void preset(String name) {
    switch (name) {
      case "low": longSide = 800; quality = 55; intervalMs = 50; break;
      case "high": longSide = 1920; quality = 82; intervalMs = 33; break;
      default: longSide = 1280; quality = 70; intervalMs = 33;
    }
    if (handler != null) handler.post(this::configure);
  }

  synchronized void acquire() {
    if (clients++ > 0) return;
    thread = new HandlerThread("iportal-video");
    thread.start();
    handler = new Handler(thread.getLooper());
    handler.post(this::configure);
  }

  synchronized void release() {
    if (--clients > 0) return;
    Handler stopping = handler;
    HandlerThread stopped = thread;
    handler = null;
    thread = null;
    stopping.post(() -> {
      teardown();
      stopped.quitSafely();
    });
  }

  /** Blocks for a frame newer than {@code after}, or returns the current one after {@code waitMs}. */
  synchronized Object[] next(long after, long waitMs) throws InterruptedException {
    long deadline = System.currentTimeMillis() + waitMs;
    while (sequence == after || frame == null) {
      long left = deadline - System.currentTimeMillis();
      if (left <= 0) break;
      wait(left);
    }
    return frame == null ? null : new Object[] {frame, sequence};
  }

  private void teardown() {
    if (display != null) display.release();
    if (reader != null) reader.close();
    if (bitmap != null) bitmap.recycle();
    display = null;
    reader = null;
    bitmap = null;
  }

  private void configure() {
    try {
      Device.Screen screen = Device.screen();
      int side;
      synchronized (this) {
        side = longSide;
      }
      float scale = Math.min(1f, side / (float) Math.max(screen.width, screen.height));
      int nextWidth = Math.max(2, Math.round(screen.width * scale) & ~1);
      int nextHeight = Math.max(2, Math.round(screen.height * scale) & ~1);
      if (display != null && nextWidth == width && nextHeight == height) return;
      ImageReader next = ImageReader.newInstance(nextWidth, nextHeight, PixelFormat.RGBA_8888, 2);
      next.setOnImageAvailableListener(ignored -> capture(), handler);
      if (display == null) {
        display = (VirtualDisplay) Class.forName("android.hardware.display.DisplayManager")
            .getMethod("createVirtualDisplay", String.class, int.class, int.class, int.class, Surface.class)
            .invoke(null, "iportal", nextWidth, nextHeight, 0, next.getSurface());
      } else {
        display.resize(nextWidth, nextHeight, 160);
        display.setSurface(next.getSurface());
      }
      if (reader != null) reader.close();
      if (bitmap != null) bitmap.recycle();
      bitmap = null;
      reader = next;
      width = nextWidth;
      height = nextHeight;
      sourceWidth = screen.width;
      sourceHeight = screen.height;
    } catch (Throwable error) {
      Agent.log("video configuration failed: " + Device.unwrap(error));
    }
  }

  private void capture() {
    if (reader == null) return;
    long wait = lastEncoded + intervalMs - System.currentTimeMillis();
    if (wait > 0) {
      // Never drop the newest image: encode it when the rate limit allows, so
      // the last change before the screen goes still is always delivered.
      if (!pending) {
        pending = true;
        handler.postDelayed(() -> {
          pending = false;
          capture();
        }, wait);
      }
      return;
    }
    try (Image image = reader.acquireLatestImage()) {
      if (image == null) return;
      Image.Plane plane = image.getPlanes()[0];
      ByteBuffer pixels = plane.getBuffer();
      int stride = plane.getRowStride() / plane.getPixelStride();
      if (bitmap == null || bitmap.getWidth() != stride || bitmap.getHeight() != height)
        bitmap = Bitmap.createBitmap(stride, height, Bitmap.Config.ARGB_8888);
      bitmap.copyPixelsFromBuffer(pixels);
      Bitmap visible = stride == width ? bitmap : Bitmap.createBitmap(bitmap, 0, 0, width, height);
      ByteArrayOutputStream out = new ByteArrayOutputStream(256 * 1024);
      int level;
      synchronized (this) {
        level = quality;
      }
      visible.compress(Bitmap.CompressFormat.JPEG, level, out);
      if (visible != bitmap) visible.recycle();
      lastEncoded = System.currentTimeMillis();
      synchronized (this) {
        frame = out.toByteArray();
        sequence++;
        notifyAll();
      }
    } catch (Throwable error) {
      Agent.log("video capture failed: " + error);
    }
    try {
      Device.Screen screen = Device.screen();
      if (screen.width != sourceWidth || screen.height != sourceHeight) configure();
    } catch (Throwable ignored) {
      // The next frame checks again.
    }
  }
}
