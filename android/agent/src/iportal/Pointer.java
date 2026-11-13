package iportal;

import android.os.SystemClock;
import android.view.MotionEvent;
import org.json.JSONArray;

/**
 * One live touch stroke. Its events arrive one at a time from the Mac, so
 * unlike a recorded gesture nothing here knows when the stroke will end. The
 * rule that follows: a finger is never left down. If events stop arriving, if
 * another input begins, or if the session closes, the stroke is cancelled.
 *
 * <p>A stroke that ends this way is cancelled rather than lifted. A lift is a
 * tap or the end of a drag where the finger happens to be; a cancel tells the
 * app to forget the touch.
 */
final class Pointer {
  /** How long a stroke may go without an event. The Mac repeats the position of a finger held still. */
  static final long IDLE_MS = 2000;

  private static final int SECOND = 1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT;

  private String stroke;
  private long downTime;
  private int rotation;
  /** Where the fingers were last put, in pixels, two values per finger. */
  private float[] xy;
  private long deadline;
  private Thread watchdog;

  private static float[] pixels(JSONArray points, Device.Screen screen) throws Exception {
    int count = points.length();
    if (count < 1 || count > 2) throw new Failure("invalid argument", "A stroke has one or two fingers");
    float[] xy = new float[count * 2];
    for (int i = 0; i < count; i++) {
      JSONArray point = points.getJSONArray(i);
      double x = point.getDouble(0), y = point.getDouble(1);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
        throw new Failure("invalid argument", "Coordinates are from 0 to 1");
      xy[2 * i] = (float) (x * (screen.width - 1));
      xy[2 * i + 1] = (float) (y * (screen.height - 1));
    }
    return xy;
  }

  private static Failure ended() {
    return new Failure("stroke ended", "The finger was already lifted");
  }

  private void require(String id) throws Failure {
    if (stroke == null || !stroke.equals(id)) throw ended();
  }

  private void alive() {
    deadline = SystemClock.uptimeMillis() + IDLE_MS;
    if (watchdog == null) {
      watchdog = new Thread(this::watch, "iportal-stroke");
      watchdog.setDaemon(true);
      watchdog.start();
    }
    notifyAll();
  }

  private synchronized void watch() {
    for (;;) {
      try {
        if (stroke == null) wait();
        else {
          long left = deadline - SystemClock.uptimeMillis();
          if (left > 0) wait(left);
          else {
            Agent.log("stroke went silent; lifting the finger");
            release();
          }
        }
      } catch (InterruptedException interrupted) {
        return;
      }
    }
  }

  /** Puts the fingers at {@code next}, adding or lifting the second finger to match. */
  private void place(float[] next) throws Exception {
    if (next.length > xy.length) {
      Device.touch(MotionEvent.ACTION_POINTER_DOWN | SECOND, downTime, Device.INJECT_ASYNC, next);
    } else if (next.length < xy.length) {
      Device.touch(MotionEvent.ACTION_POINTER_UP | SECOND, downTime, Device.INJECT_ASYNC,
          next[0], next[1], xy[2], xy[3]);
    } else if (!java.util.Arrays.equals(next, xy)) {
      Device.touch(MotionEvent.ACTION_MOVE, downTime, Device.INJECT_ASYNC, next);
    }
    // A repeated position is the Mac saying the finger is still held; it needs no event.
    xy = next;
  }

  /** The caller has already checked the lock, application and orientation guards. */
  synchronized void down(String id, JSONArray points, Device.Screen screen) throws Exception {
    release();
    float[] first = pixels(points, screen);
    long now = SystemClock.uptimeMillis();
    Device.touch(MotionEvent.ACTION_DOWN, now, Device.INJECT_WAIT_FOR_FINISH, first[0], first[1]);
    stroke = id;
    downTime = now;
    rotation = screen.rotation;
    xy = new float[] {first[0], first[1]};
    alive();
    try {
      place(first);
    } catch (Throwable failed) {
      release();
      throw failed;
    }
  }

  synchronized void move(String id, JSONArray points, Device.Screen screen) throws Exception {
    require(id);
    // Normalized coordinates mean something else once the screen has turned.
    if (screen.rotation != rotation) {
      release();
      throw new Failure("orientation changed", "Screen orientation changed");
    }
    try {
      place(pixels(points, screen));
    } catch (Throwable failed) {
      release();
      throw failed;
    }
    alive();
  }

  /** Lifts the fingers, at {@code points} when given and the screen has not turned. */
  synchronized void up(String id, JSONArray points, Device.Screen screen) throws Exception {
    require(id);
    try {
      if (points != null && screen.rotation == rotation) place(pixels(points, screen));
      if (xy.length == 4) place(new float[] {xy[0], xy[1]});
      Device.touch(MotionEvent.ACTION_UP, downTime, Device.INJECT_WAIT_FOR_FINISH, xy);
      stroke = null;
    } finally {
      // A lift that failed part-way must not leave the finger down.
      release();
    }
  }

  /** Cancels the named stroke. One that has already ended needs nothing. */
  synchronized void cancel(String id) {
    if (stroke != null && stroke.equals(id)) release();
  }

  /** Cancels whatever stroke is in progress. */
  synchronized void release() {
    if (stroke == null) return;
    stroke = null;
    try {
      Device.touch(MotionEvent.ACTION_CANCEL, downTime, Device.INJECT_ASYNC, xy);
    } catch (Throwable rejected) {
      Agent.log("could not cancel a stroke: " + Device.unwrap(rejected));
    }
  }

  synchronized boolean active() {
    return stroke != null;
  }
}
