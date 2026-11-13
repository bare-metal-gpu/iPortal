package iportal;

import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Surface;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Native media for the Mac window: the default display mirrored into a
 * hardware video encoder, plus the device's playback sound, as one stream of
 * records. Each record is four big-endian 32-bit words (kind, flags, time,
 * size) and a payload: the framing the Mac already reads from the iPhone
 * transport. Kinds 1, 2, 7 and 8 mean what they mean there; 9 and 10 are
 * Android's own.
 *
 * <p>Nothing here has an iPhone counterpart to share code with, and all of it
 * depends on what one device's codecs and audio policy accept. Every step that
 * can be refused has a fallback, and a refusal ends this stream only: the Mac
 * then uses basic video.
 */
final class Media {
  /** One access unit, NAL units each behind a 4-byte length. Flag 1 marks a keyframe. Time is 90 kHz. */
  static final int KIND_FRAME = 1;
  /** HEVC VPS, SPS and PPS, each behind a 4-byte length. Replaces the decoder. */
  static final int KIND_HEVC_PARAMETERS = 2;
  /** JSON {control, video, audio}: what this stream turned out to carry. */
  static final int KIND_CAPABILITIES = 7;
  /** The frame with this time is still what the screen shows. */
  static final int KIND_UNCHANGED = 8;
  /** 480 frames of 48 kHz stereo signed 16-bit little-endian PCM. Time counts sample frames. */
  static final int KIND_PCM = 9;
  /** H.264 SPS and PPS, each behind a 4-byte length. Replaces the decoder. */
  static final int KIND_H264_PARAMETERS = 10;

  private static final int SAMPLE_RATE = 48000;
  private static final int PACKET_FRAMES = 480;
  private static final int PACKET_BYTES = PACKET_FRAMES * 4;
  /** One capture at a time: a replacement stream waits for its predecessor to let go. */
  private static final Object AUDIO = new Object();

  private Session current;

  /**
   * Serves one client until it leaves, the helper stops, or capture fails.
   * Without {@code sound} the device's audio is left alone and keeps playing
   * on the phone.
   */
  void stream(OutputStream out, boolean sound, BooleanSupplier ending) throws Exception {
    Session session = new Session(out, sound);
    synchronized (this) {
      // The Mac opens a new stream before it has finished closing the old one.
      // Two sessions would compete for the same audio capture.
      if (current != null) current.stop();
      current = session;
    }
    try {
      session.run(ending);
    } finally {
      session.stop();
      synchronized (this) {
        if (current == session) current = null;
      }
    }
  }

  // ---- video encoder ----

  private static final class Encoder {
    final MediaCodec codec;
    final Surface surface;
    final boolean hevc;
    final int width, height;
    /** VPS, SPS, PPS for HEVC; SPS, PPS for H.264. */
    final byte[][] parameters;
    boolean parametersChanged;
    boolean parametersSent;
    boolean produced;

    private Encoder(MediaCodec codec, Surface surface, boolean hevc, int width, int height) {
      this.codec = codec;
      this.surface = surface;
      this.hevc = hevc;
      this.width = width;
      this.height = height;
      parameters = new byte[hevc ? 3 : 2][];
    }

    /**
     * The first encoder that accepts the screen. Hardware HEVC, then hardware
     * H.264, then whatever H.264 the device has: a software HEVC encoder cannot
     * keep up with a phone screen.
     */
    static Encoder open(Device.Screen screen, boolean allowHevc) throws Exception {
      List<Object[]> candidates = new ArrayList<>();
      MediaCodecInfo[] all = new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos();
      for (String mime : new String[] {MediaFormat.MIMETYPE_VIDEO_HEVC, MediaFormat.MIMETYPE_VIDEO_AVC}) {
        if (!allowHevc && mime.equals(MediaFormat.MIMETYPE_VIDEO_HEVC)) continue;
        for (MediaCodecInfo info : all)
          if (info.isEncoder() && info.isHardwareAccelerated() && Arrays.asList(info.getSupportedTypes()).contains(mime))
            candidates.add(new Object[] {mime, info});
      }
      for (MediaCodecInfo info : all)
        if (info.isEncoder() && !info.isHardwareAccelerated()
            && Arrays.asList(info.getSupportedTypes()).contains(MediaFormat.MIMETYPE_VIDEO_AVC))
          candidates.add(new Object[] {MediaFormat.MIMETYPE_VIDEO_AVC, info});
      Throwable last = new Failure("unsupported operation", "No video encoder");
      for (Object[] candidate : candidates) {
        String mime = (String) candidate[0];
        MediaCodecInfo info = (MediaCodecInfo) candidate[1];
        MediaCodec codec = null;
        try {
          MediaCodecInfo.VideoCapabilities limits = info.getCapabilitiesForType(mime).getVideoCapabilities();
          int[] size = size(screen, limits);
          MediaFormat format = MediaFormat.createVideoFormat(mime, size[0], size[1]);
          format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
          format.setInteger(MediaFormat.KEY_BIT_RATE, limits.getBitrateRange().clamp(8_000_000));
          format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);
          // The stream is reliable and each one starts on a keyframe, so later
          // keyframes only cost bitrate.
          format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);
          // A mirrored display produces a frame only when the screen changes.
          // Repeating the last one lets the encoder finish refining a still
          // picture, and delivers the first frame of a screen that never moves.
          format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
          // The Mac decodes in arrival order with no reordering delay.
          format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
          format.setInteger(MediaFormat.KEY_PRIORITY, 0);
          // Declared SDR lets the Mac keep the decoder's native pixel format.
          format.setInteger(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.COLOR_STANDARD_BT709);
          format.setInteger(MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.COLOR_TRANSFER_SDR_VIDEO);
          format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);
          codec = MediaCodec.createByCodecName(info.getName());
          codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
          Surface surface = codec.createInputSurface();
          codec.start();
          try {
            Bundle sync = new Bundle();
            sync.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            codec.setParameters(sync);
          } catch (Throwable ignored) {
            // A new encoder starts on a keyframe anyway.
          }
          Agent.log("media encoder " + info.getName() + " " + size[0] + "x" + size[1]);
          return new Encoder(codec, surface, mime.equals(MediaFormat.MIMETYPE_VIDEO_HEVC), size[0], size[1]);
        } catch (Throwable error) {
          last = Device.unwrap(error);
          Agent.log("media encoder " + info.getName() + " refused: " + last);
          if (codec != null) codec.release();
        }
      }
      throw last instanceof Exception ? (Exception) last : new RuntimeException(last);
    }

    /** The screen's own size where the encoder takes it, otherwise the largest smaller one it does. */
    private static int[] size(Device.Screen screen, MediaCodecInfo.VideoCapabilities limits) {
      int longSide = Math.max(screen.width, screen.height);
      int[] size = null;
      for (int limit : new int[] {longSide, 1920, 1280, 960}) {
        if (limit > longSide) continue;
        float scale = limit / (float) longSide;
        for (int[] alignment : new int[][] {{2, 2}, {limits.getWidthAlignment(), limits.getHeightAlignment()}}) {
          int width = Math.round(screen.width * scale), height = Math.round(screen.height * scale);
          size = new int[] {
            Math.max(alignment[0], width - width % Math.max(2, alignment[0])),
            Math.max(alignment[1], height - height % Math.max(2, alignment[1]))
          };
          if (limits.isSizeSupported(size[0], size[1])) return size;
        }
      }
      return size;
    }

    void close() {
      try {
        codec.stop();
      } catch (Throwable ignored) {
        // Already failed; release below is what frees it.
      }
      codec.release();
      surface.release();
    }
  }

  // ---- one client ----

  private static final class Session {
    private final OutputStream out;
    private final boolean sound;
    private final byte[] header = new byte[16];
    private volatile boolean stopped;
    private volatile AudioRecord recording;
    private byte[] input = new byte[256 * 1024];
    private byte[] frame = new byte[256 * 1024];
    private int frameLength;
    private long firstPresentationUs = -1;

    Session(OutputStream out, boolean sound) {
      this.out = out;
      this.sound = sound;
    }

    void stop() {
      stopped = true;
      AudioRecord active = recording;
      if (active != null) {
        try {
          // Ends a blocked read. The audio thread releases the record itself.
          active.stop();
        } catch (Throwable ignored) {
          // Already released.
        }
      }
    }

    private void send(int kind, int flags, int time, byte[] data, int length) throws IOException {
      synchronized (header) {
        word(0, kind);
        word(4, flags);
        word(8, time);
        word(12, length);
        out.write(header);
        if (length > 0) out.write(data, 0, length);
        out.flush();
      }
    }

    private void word(int offset, int value) {
      header[offset] = (byte) (value >>> 24);
      header[offset + 1] = (byte) (value >>> 16);
      header[offset + 2] = (byte) (value >>> 8);
      header[offset + 3] = (byte) value;
    }

    private void capabilities(String audio) throws IOException {
      byte[] json = ("{\"control\":\"eligible\",\"video\":\"supported\",\"audio\":\"" + audio + "\"}")
          .getBytes(java.nio.charset.StandardCharsets.UTF_8);
      send(KIND_CAPABILITIES, 0, 0, json, json.length);
    }

    void run(BooleanSupplier ending) throws Exception {
      if (sound) {
        Thread audio = new Thread(this::audio, "iportal-media-audio");
        audio.setDaemon(true);
        audio.start();
      } else capabilities("eligible"); // Not asked for, which is not the same as refused.
      VirtualDisplay display = null;
      boolean allowHevc = true;
      try {
        while (!stopped && !ending.getAsBoolean()) {
          Device.Screen screen = Device.screen();
          Encoder encoder = Encoder.open(screen, allowHevc);
          try {
            // A rotation is a new encoder at the new size on the same display.
            // Its parameter sets differ, which is what makes the Mac replace
            // its decoder, and its first frame is a keyframe.
            if (display == null)
              display = Video.mirror("iportal-media", encoder.width, encoder.height, encoder.surface);
            else {
              display.resize(encoder.width, encoder.height, 160);
              display.setSurface(encoder.surface);
            }
            pump(encoder, display, screen, ending);
          } catch (IllegalStateException failure) {
            // An HEVC encoder that starts but never delivers is treated like
            // one that is absent. Any other failure ends the stream.
            if (!encoder.hevc || encoder.produced) throw failure;
            Agent.log("media HEVC failed before its first frame: " + failure);
            allowHevc = false;
          } finally {
            if (display != null) display.setSurface(null);
            encoder.close();
          }
        }
      } finally {
        if (display != null) display.release();
      }
    }

    /** Forwards encoder output until the screen changes size or the stream ends. */
    private void pump(Encoder encoder, VirtualDisplay display, Device.Screen screen, BooleanSupplier ending)
        throws Exception {
      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
      long now = SystemClock.uptimeMillis();
      long lastFrameAt = now, lastIdleAt = now, lastScreenAt = now, lastRefreshAt = now;
      int lastTime = 0;
      boolean sent = false;
      while (!stopped && !ending.getAsBoolean()) {
        int index = encoder.codec.dequeueOutputBuffer(info, 100_000);
        now = SystemClock.uptimeMillis();
        if (index >= 0) {
          try {
            if (info.size > 0) {
              ByteBuffer buffer = encoder.codec.getOutputBuffer(index);
              if (input.length < info.size) input = new byte[info.size + info.size / 2];
              buffer.position(info.offset);
              buffer.get(input, 0, info.size);
              boolean sync = parse(encoder, input, info.size) | (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
              if (frameLength > 0 && ready(encoder)) {
                if (firstPresentationUs < 0) firstPresentationUs = info.presentationTimeUs;
                lastTime = (int) ((info.presentationTimeUs - firstPresentationUs) * 9 / 100);
                send(KIND_FRAME, sync ? 1 : 0, lastTime, frame, frameLength);
                encoder.produced = true;
                sent = true;
                lastFrameAt = now;
              }
            }
          } finally {
            encoder.codec.releaseOutputBuffer(index, false);
          }
          if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
        // A still screen sends nothing, which the Mac cannot tell from a stalled
        // stream. Say that the last frame is current, as the iPhone transport
        // does from its sender reports. It also keeps the proxy's idle deadline.
        if (sent && now - lastFrameAt >= 500 && now - lastIdleAt >= 500) {
          send(KIND_UNCHANGED, 0, lastTime, null, 0);
          lastIdleAt = now;
        }
        // After a reconnect or an unlock the Mac waits for a frame newer than
        // that event before it accepts input, and a still screen never sends
        // one. Attaching the surface again makes the system draw the display
        // into it once, as it did for the very first frame.
        if (sent && now - lastFrameAt >= 2000 && now - lastRefreshAt >= 2000) {
          lastRefreshAt = now;
          display.setSurface(null);
          display.setSurface(encoder.surface);
        }
        if (now - lastScreenAt >= 200) {
          lastScreenAt = now;
          Device.Screen current = Device.screen();
          if (current.width != screen.width || current.height != screen.height) return;
        }
      }
    }

    /** True once the parameter sets this frame needs have been sent. */
    private boolean ready(Encoder encoder) throws IOException {
      if (!encoder.parametersChanged) return encoder.parametersSent;
      int length = 0;
      for (byte[] set : encoder.parameters) {
        if (set == null) return false;
        length += 4 + set.length;
      }
      byte[] body = new byte[length];
      int offset = 0;
      for (byte[] set : encoder.parameters) {
        body[offset] = (byte) (set.length >>> 24);
        body[offset + 1] = (byte) (set.length >>> 16);
        body[offset + 2] = (byte) (set.length >>> 8);
        body[offset + 3] = (byte) set.length;
        System.arraycopy(set, 0, body, offset + 4, set.length);
        offset += 4 + set.length;
      }
      send(encoder.hevc ? KIND_HEVC_PARAMETERS : KIND_H264_PARAMETERS, 0, 0, body, length);
      encoder.parametersChanged = false;
      encoder.parametersSent = true;
      return true;
    }

    /**
     * Rewrites the encoder's start-code stream as length-prefixed NAL units in
     * {@code frame}, keeping parameter sets aside. Returns whether a keyframe
     * slice was seen.
     */
    private boolean parse(Encoder encoder, byte[] data, int length) {
      frameLength = 0;
      boolean sync = false;
      int start = -1;
      for (int at = 0; ; ) {
        int next = startCode(data, at, length);
        if (start < 0 && next < 0) start = 0; // No start code at all: one bare NAL unit.
        if (start >= 0) {
          int end = next < 0 ? length : next;
          // Zero bytes before a start code belong to it, not to the unit.
          while (end > start && data[end - 1] == 0) end--;
          if (end > start) sync |= unit(encoder, data, start, end - start);
        }
        if (next < 0) break;
        start = at = next + 3;
      }
      return sync;
    }

    private static int startCode(byte[] data, int from, int length) {
      for (int i = from; i + 2 < length; i++) {
        if ((data[i + 2] & 0xff) > 1) i += 2; // Cannot be the end of 00 00 01.
        else if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) return i;
      }
      return -1;
    }

    private boolean unit(Encoder encoder, byte[] data, int offset, int length) {
      int type = encoder.hevc ? (data[offset] >> 1) & 63 : data[offset] & 31;
      int parameter = encoder.hevc ? type - 32 : type - 7;
      if (parameter >= 0 && parameter < encoder.parameters.length) {
        byte[] set = Arrays.copyOfRange(data, offset, offset + length);
        if (!Arrays.equals(set, encoder.parameters[parameter])) {
          encoder.parameters[parameter] = set;
          encoder.parametersChanged = true;
        }
        return false;
      }
      // Access unit delimiters and filler carry nothing the decoder needs.
      if (encoder.hevc ? type == 35 || type == 38 : type == 9 || type == 12) return false;
      if (frame.length < frameLength + 4 + length)
        frame = Arrays.copyOf(frame, Math.max(frame.length * 2, frameLength + 4 + length));
      frame[frameLength] = (byte) (length >>> 24);
      frame[frameLength + 1] = (byte) (length >>> 16);
      frame[frameLength + 2] = (byte) (length >>> 8);
      frame[frameLength + 3] = (byte) length;
      System.arraycopy(data, offset, frame, frameLength + 4, length);
      frameLength += 4 + length;
      return encoder.hevc ? type >= 16 && type <= 23 : type == 5;
    }

    // ---- audio ----

    /**
     * Sound is optional: whatever goes wrong here is reported as "no audio"
     * and the picture carries on.
     */
    private void audio() {
      synchronized (AUDIO) {
        AudioRecord record = null;
        Object policy = null;
        String source = "none";
        try {
          if (stopped) return;
          // `adb shell setprop debug.iportal.audio submix|playback|off` picks
          // one capture path, to compare them on a device.
          String wanted = property("debug.iportal.audio", "auto");
          if (!wanted.equals("off") && !wanted.equals("playback")) {
            try {
              record = submixCapture();
              source = "submix";
            } catch (Throwable error) {
              Agent.log("media audio: submix capture unavailable: " + Device.unwrap(error));
            }
          }
          if (record == null && !wanted.equals("off") && !wanted.equals("submix") && Build.VERSION.SDK_INT >= 33) {
            try {
              Object[] capture = playbackCapture();
              record = (AudioRecord) capture[0];
              policy = capture[1];
              source = "playback";
            } catch (Throwable error) {
              Agent.log("media audio: playback capture unavailable: " + Device.unwrap(error));
            }
          }
          if (record != null) {
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
              Agent.log("media audio: " + source + " capture did not start");
              record.release();
              record = null;
            }
          }
          if (record == null) {
            capabilities("unavailable");
            return;
          }
          recording = record;
          Agent.log("media audio: capturing from " + source);
          capabilities("supported");
          capture(record, source);
        } catch (Throwable error) {
          if (!stopped) Agent.log("media audio ended: " + Device.unwrap(error));
        } finally {
          recording = null;
          if (record != null) record.release();
          if (policy != null) {
            try {
              Method unregister = AudioManager.class.getDeclaredMethod(
                  "unregisterAudioPolicyAsyncStatic", Class.forName("android.media.audiopolicy.AudioPolicy"));
              unregister.setAccessible(true);
              unregister.invoke(null, policy);
            } catch (Throwable ignored) {
              // The registration also ends with this process.
            }
          }
        }
      }
    }

    private void capture(AudioRecord record, String source) throws IOException {
      byte[] packet = new byte[PACKET_BYTES];
      // Sample frames since the capture began, including those not sent.
      int position = 0;
      int quiet = 0, peak = 0, reports = 0;
      long reportAt = SystemClock.uptimeMillis() + 5000;
      while (!stopped) {
        long before = System.nanoTime();
        int read = record.read(packet, 0, PACKET_BYTES, AudioRecord.READ_BLOCKING);
        if (read != PACKET_BYTES) {
          if (!stopped) Agent.log("media audio: read returned " + read);
          return;
        }
        // Some capture paths deliver nothing while nothing plays. Move the
        // clock across the gap so the Mac starts afresh instead of playing
        // what follows as if it were continuous.
        long blockedMs = (System.nanoTime() - before) / 1_000_000;
        if (blockedMs > 100) position += (int) (blockedMs * SAMPLE_RATE / 1000 / PACKET_FRAMES) * PACKET_FRAMES;
        boolean silent = true;
        for (int i = 0; i < PACKET_BYTES; i += 2) {
          int sample = Math.abs((short) ((packet[i] & 0xff) | (packet[i + 1] << 8)));
          if (sample > peak) peak = sample;
          if (sample != 0) silent = false;
        }
        quiet = silent ? quiet + 1 : 0;
        // Uncompressed silence is 1.5 Mbit/s of nothing. Send half a second of
        // it so a sound can die away, then wait for the next one. The skipped
        // time stays in the clock, which the Mac reads as a new start.
        if (quiet <= 50) send(KIND_PCM, 0, position, packet, PACKET_BYTES);
        position += PACKET_FRAMES;
        long now = SystemClock.uptimeMillis();
        if (now >= reportAt) {
          // Levels are the evidence for the "captured sound is too quiet"
          // question; a few lines are enough.
          if (peak > 0 && reports++ < 12) Agent.log("media audio: " + source + " peak " + peak + " of 32767");
          peak = 0;
          reportAt = now + 5000;
        }
      }
    }

    private static AudioFormat format(int channels) {
      return new AudioFormat.Builder()
          .setSampleRate(SAMPLE_RATE)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setChannelMask(channels)
          .build();
    }

    private static int bufferBytes() {
      int minimum = AudioRecord.getMinBufferSize(
          SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
      return Math.max(4 * PACKET_BYTES, 2 * Math.max(0, minimum));
    }

    /**
     * Everything the device plays, taken from the remote submix as a wireless
     * display would take it. While this runs the phone itself is silent.
     *
     * <p>The submix follows the media volume unless the record asks for a
     * fixed full volume, which the framework's own submix sinks do with the
     * "fixedVolume" tag. A plain REMOTE_SUBMIX record does not carry it, which
     * is the likely reason the feasibility probe captured its tone far too
     * quietly.
     */
    private static AudioRecord submixCapture() throws Exception {
      try {
        AudioAttributes.Builder attributes = new AudioAttributes.Builder();
        AudioAttributes.Builder.class.getMethod("setInternalCapturePreset", int.class)
            .invoke(attributes, MediaRecorder.AudioSource.REMOTE_SUBMIX);
        AudioAttributes.Builder.class.getMethod("addTag", String.class).invoke(attributes, "fixedVolume");
        AudioRecord.Builder builder = new AudioRecord.Builder()
            .setContext(new ShellContext())
            .setAudioFormat(format(AudioFormat.CHANNEL_IN_STEREO))
            .setBufferSizeInBytes(bufferBytes());
        AudioRecord.Builder.class.getMethod("setAudioAttributes", AudioAttributes.class)
            .invoke(builder, attributes.build());
        return builder.build();
      } catch (Throwable error) {
        Agent.log("media audio: fixed-volume submix refused, using the plain source: " + Device.unwrap(error));
        return new AudioRecord.Builder()
            .setContext(new ShellContext())
            .setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
            .setAudioFormat(format(AudioFormat.CHANNEL_IN_STEREO))
            .setBufferSizeInBytes(bufferBytes())
            .build();
      }
    }

    /**
     * Media and game sound only, through a loop-back audio policy mix. The
     * policy's own sink is a fixed-volume record. Android 13 and later accept
     * this from the shell user. Returns the record and the registered policy.
     */
    private static Object[] playbackCapture() throws Exception {
      Class<?> ruleType = Class.forName("android.media.audiopolicy.AudioMixingRule");
      Class<?> ruleBuilderType = Class.forName("android.media.audiopolicy.AudioMixingRule$Builder");
      Object ruleBuilder = ruleBuilderType.getConstructor().newInstance();
      ruleBuilderType.getMethod("setTargetMixRole", int.class)
          .invoke(ruleBuilder, ruleType.getField("MIX_ROLE_PLAYERS").getInt(null));
      int byUsage = ruleType.getField("RULE_MATCH_ATTRIBUTE_USAGE").getInt(null);
      Method addMixRule = ruleBuilderType.getMethod("addMixRule", int.class, Object.class);
      for (int usage : new int[] {AudioAttributes.USAGE_MEDIA, AudioAttributes.USAGE_GAME, AudioAttributes.USAGE_UNKNOWN})
        addMixRule.invoke(ruleBuilder, byUsage, new AudioAttributes.Builder().setUsage(usage).build());
      Object rule = ruleBuilderType.getMethod("build").invoke(ruleBuilder);

      Class<?> mixType = Class.forName("android.media.audiopolicy.AudioMix");
      Class<?> mixBuilderType = Class.forName("android.media.audiopolicy.AudioMix$Builder");
      Object mixBuilder = mixBuilderType.getConstructor(ruleType).newInstance(rule);
      mixBuilderType.getMethod("setFormat", AudioFormat.class)
          .invoke(mixBuilder, format(AudioFormat.CHANNEL_OUT_STEREO));
      // Loop back without rendering: the sound goes to the Mac instead of the
      // phone's speaker, as it does with the submix.
      mixBuilderType.getMethod("setRouteFlags", int.class)
          .invoke(mixBuilder, mixType.getField("ROUTE_FLAG_LOOP_BACK").getInt(null));
      Object mix = mixBuilderType.getMethod("build").invoke(mixBuilder);

      Class<?> policyType = Class.forName("android.media.audiopolicy.AudioPolicy");
      Class<?> policyBuilderType = Class.forName("android.media.audiopolicy.AudioPolicy$Builder");
      Object policyBuilder = policyBuilderType.getConstructor(Context.class).newInstance(new ShellContext());
      policyBuilderType.getMethod("addMix", mixType).invoke(policyBuilder, mix);
      Object policy = policyBuilderType.getMethod("build").invoke(policyBuilder);
      Method register = AudioManager.class.getDeclaredMethod("registerAudioPolicyStatic", policyType);
      register.setAccessible(true);
      int result = (Integer) register.invoke(null, policy);
      if (result != 0) throw new IllegalStateException("audio policy registration returned " + result);
      try {
        AudioRecord record = (AudioRecord) policyType.getMethod("createAudioRecordSink", mixType).invoke(policy, mix);
        return new Object[] {record, policy};
      } catch (Throwable error) {
        try {
          Method unregister = AudioManager.class.getDeclaredMethod("unregisterAudioPolicyAsyncStatic", policyType);
          unregister.setAccessible(true);
          unregister.invoke(null, policy);
        } catch (Throwable ignored) {
          // The registration also ends with this process.
        }
        throw error;
      }
    }

    private static String property(String name, String fallback) {
      try {
        return (String) Class.forName("android.os.SystemProperties")
            .getMethod("get", String.class, String.class)
            .invoke(null, name, fallback);
      } catch (Throwable error) {
        return fallback;
      }
    }
  }

  /**
   * The audio framework asks a context who is recording. This process has no
   * application, so it answers as the shell package, which is what it runs as.
   */
  private static final class ShellContext extends ContextWrapper {
    ShellContext() {
      super(null);
    }

    @Override
    public String getPackageName() {
      return Device.SHELL_PACKAGE;
    }

    @Override
    public String getOpPackageName() {
      return Device.SHELL_PACKAGE;
    }

    @Override
    public String getAttributionTag() {
      return null;
    }

    @Override
    public AttributionSource getAttributionSource() {
      return new AttributionSource.Builder(android.os.Process.myUid()).setPackageName(Device.SHELL_PACKAGE).build();
    }

    @Override
    public int getDeviceId() {
      return 0;
    }

    @Override
    public Context getApplicationContext() {
      return this;
    }

    @Override
    public Object getSystemService(String name) {
      return null;
    }
  }
}
