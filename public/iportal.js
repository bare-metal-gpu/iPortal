/** @typedef {{screen: HTMLCanvasElement, "keyboard-input": HTMLTextAreaElement, app: HTMLSelectElement, quality: HTMLSelectElement, [id: string]: HTMLElement}} IPortalElements */
/** @template {keyof IPortalElements & string} K @param {K} id @returns {IPortalElements[K]} */
const $ = (id) => /** @type {IPortalElements[K]} */ (document.getElementById(id));
const screen = $("screen");
const phone = $("phone");
const keyboardInput = $("keyboard-input");
const bridgeId = crypto.randomUUID();
let connected = false;
/** @type {import("../public-contracts.ts").PublicStatus["lifecycle"]} */
let lifecycle = "connecting";
let inputEpoch = 0;
let nativeReady = false;
let videoEpoch = 0;
let statusRevision = 0;
let deviceUdid = "";
let usbConnectionID = "";
let singleUsbDevice = false;
let usbDevicePresent = false;
/** @type {import("../public-contracts.ts").PublicStatus["orientation"]} */
let deviceOrientation = null;
/** @type {import("../public-contracts.ts").PublicStatus["displayPixels"]} */
let displayPixels = null;
let serverInstance = /** @type {HTMLMetaElement} */ (
  document.querySelector('meta[name="iportal-instance"]')
).content;
const controlOnly = new Set(["ensure", "quality", "lock", "unlock"]);
function canInteract() {
  return (
    !nativeSettingsVisible &&
    lifecycle === "ready" &&
    connected &&
    (nativeVideo ? nativeReady : streamReady)
  );
}
/** @param {boolean} ready @param {number} epoch @param {string} documentId */
function setNativeVideoReady(ready, epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId) return;
  if (nativeReady && !ready) invalidateInput();
  nativeReady = ready && lifecycle === "ready";
  if (nativeReady) document.body.classList.remove("preserve-stream-frame");
  reportLoading();
}
function invalidateInput() {
  inputEpoch++;
  touch = null;
  wheel = null;
  pinch = null;
  typed = "";
  keyboardInput.value = "";
  clearTimeout(wheelTimer);
  wheelTimer = undefined;
}
let nativeSettingsVisible = false;
/** @param {boolean} visible @param {number} epoch @param {string} documentId */
function setNativeSettingsVisible(visible, epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId) return;
  nativeSettingsVisible = Boolean(visible);
  if (nativeSettingsVisible) invalidateInput();
}
/** @param {number} [epoch] @param {string} [documentId] */
function nativeGeometryChanged(epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId) return;
  invalidateInput();
}
/** @param {import("../public-contracts.ts").PublicStatus["lifecycle"]} next */
function setLifecycle(
  next,
  identity = deviceUdid,
  instance = serverInstance,
  connectionID = usbConnectionID,
) {
  if (!["ready", "locked", "connecting", "disconnected"].includes(next)) next = "connecting";
  identity = typeof identity === "string" ? identity : "";
  const changedIdentity = identity !== deviceUdid || instance !== serverInstance;
  const reattached =
    (lifecycle === "disconnected" && next !== "disconnected") || connectionID !== usbConnectionID;
  if (next === lifecycle && !changedIdentity && !reattached) return;
  lifecycle = next;
  deviceUdid = identity;
  serverInstance = instance;
  usbConnectionID = connectionID;
  videoEpoch++;
  nativeReady = false;
  stopStream();
  invalidateInput();
  if (reattached || changedIdentity) {
    streamRetryAt = 0;
    streamFailures = 0;
  }
  if (changedIdentity) {
    /** @type {CanvasRenderingContext2D} */ (screen.getContext("2d")).clearRect(
      0,
      0,
      screen.width,
      screen.height,
    );
    hasStreamFrame = false;
    document.body.classList.remove("preserve-stream-frame");
  }
}

let streamReady = false;
let pendingActions = 0;
let loadingDetail = "";
let lastPresenceAt = -Infinity;
/** @type {boolean | undefined} */
let lastPresenceReady;
function reportPresence() {
  const ready = canInteract();
  if (ready === lastPresenceReady && performance.now() - lastPresenceAt < 2000) return;
  lastPresenceReady = ready;
  lastPresenceAt = performance.now();
  void requestJSON(
    "/api/presence",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iportal-instance": /** @type {HTMLMetaElement} */ (
          document.querySelector('meta[name="iportal-instance"]')
        ).content,
      },
      body: JSON.stringify({ clientId: bridgeId, ready }),
    },
    1500,
  ).catch(() => {
    lastPresenceAt = -Infinity;
  });
}
function reportLoading() {
  reportPresence();
  const waitingForVideo =
    lifecycle !== "ready" || !connected || (nativeVideo ? !nativeReady : !streamReady);
  document.body.classList.toggle("loading", waitingForVideo);
  document.body.classList.toggle("unavailable", waitingForVideo);
  window.webkit?.messageHandlers?.native?.postMessage({
    loading: waitingForVideo || pendingActions > 0,
    waitingForVideo,
    loadingDetail: waitingForVideo ? loadingDetail : "",
    lifecycle,
    deviceUdid,
    usbConnectionID,
    singleUsbDevice,
    usbDevicePresent,
    deviceOrientation,
    displayPixels,
    serverInstance,
    videoEpoch,
    statusRevision,
    bridgeId,
    videoMode: nativeVideo ? "native" : "stream",
  });
}
const params = new URLSearchParams(location.search);
// The Android server marks its page. Without the mark this is an iPhone or iPad.
const platform =
  /** @type {HTMLMetaElement | null} */ (document.querySelector('meta[name="iportal-platform"]'))
    ?.content === "android"
    ? "android"
    : "ios";
const deviceKind =
  platform === "android" ? "Android device" : params.get("kind") === "iPad" ? "iPad" : "iPhone";
// Controls that exist on one platform only carry data-platform.
for (const element of /** @type {NodeListOf<HTMLElement>} */ (
  document.querySelectorAll("[data-platform]")
))
  if (element.dataset?.platform) element.hidden = element.dataset.platform !== platform;
if (platform === "android") {
  for (const [selector, label] of [
    ['[data-shortcut="control"]', "Quick Settings"],
    ['[data-shortcut="switcher"]', "Recents"],
  ]) {
    const node = document.querySelector(selector)?.firstChild;
    if (node) node.textContent = `${label} `;
  }
  // Application IDs differ by manufacturer; these are Google's. "Another app" takes any.
  const apps = [
    ["com.android.chrome", "Chrome"],
    ["com.google.android.apps.messaging", "Messages"],
    ["com.google.android.dialer", "Phone"],
    ["com.google.android.GoogleCamera", "Camera"],
    ["com.google.android.apps.photos", "Photos"],
    ["com.android.settings", "Settings"],
    ["com.google.android.apps.maps", "Maps"],
    ["com.android.vending", "Play Store"],
    ["custom", "Another app…"],
  ];
  $("app").replaceChildren(
    ...apps.map(([value, label]) =>
      Object.assign(document.createElement("option"), { value, label, textContent: label }),
    ),
  );
}
if (deviceKind !== "iPhone") {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!["SCRIPT", "STYLE"].includes(walker.currentNode.parentElement?.tagName ?? ""))
      walker.currentNode.textContent = (walker.currentNode.textContent ?? "").replaceAll(
        /iPhone/g,
        deviceKind,
      );
  }
  $("screen").setAttribute("aria-label", `${deviceKind} screen`);
}
if (params.has("app")) document.body.classList.add("app");
if (params.has("app") && window.webkit?.messageHandlers?.native)
  document.body.classList.add("native-loading-ui");
let nativeVideo = params.get("video") === "native";
document.body.classList.toggle("native-video", nativeVideo);

/** @param {number} [epoch] @param {string} [documentId] */
function useNativeVideo(epoch, documentId) {
  if (epoch !== undefined && (epoch !== videoEpoch || documentId !== bridgeId)) return;
  stopStream();
  if (!nativeVideo) {
    invalidateInput();
    document.body.classList.toggle("preserve-stream-frame", hasStreamFrame);
  }
  nativeVideo = true;
  nativeReady = false;
  document.body.classList.add("native-video");
  reportLoading();
}

// Decode complete MJPEG parts ourselves: <img>.load cannot report frame
// freshness, and a live <img> cannot preserve a fixed last frame on lock.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
class MjpegFrames {
  buffer = new Uint8Array(0);
  /** @type {number | null} */
  needed = null;
  /** @param {Uint8Array} chunk */
  push(chunk) {
    if (this.buffer.length + chunk.length > MAX_FRAME_BYTES + 65536)
      throw new Error("Oversized video frame");
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const frames = [];
    while (true) {
      if (this.needed === null) {
        // Some multipart encoders separate parts with two CRLFs. They may themselves arrive in
        // separate reads; do not mistake the empty separator for a header.
        let padding = 0;
        while (this.buffer[padding] === 13 && this.buffer[padding + 1] === 10) padding += 2;
        if (padding) this.buffer = this.buffer.subarray(padding);
        let end = -1;
        for (let i = 0; i + 3 < this.buffer.length; i++) {
          if (
            this.buffer[i] === 13 &&
            this.buffer[i + 1] === 10 &&
            this.buffer[i + 2] === 13 &&
            this.buffer[i + 3] === 10
          ) {
            end = i;
            break;
          }
        }
        if (end < 0) {
          if (this.buffer.length > 16384) throw new Error("Invalid video header");
          break;
        }
        const header = new TextDecoder().decode(this.buffer.subarray(0, end));
        const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i)?.[1]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_FRAME_BYTES)
          throw new Error("Invalid video frame size");
        this.needed = length;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.needed) break;
      frames.push(this.buffer.slice(0, this.needed));
      this.buffer = this.buffer.slice(this.needed);
      this.needed = null;
    }
    return frames;
  }
}
let hasStreamFrame = false;
let accessibilityUntil = 0;
let accessibilityFrameHash = 0;
/** @type {HTMLCanvasElement | undefined} */
let accessibilityCanvas;
/** @param {boolean} active @param {number} epoch @param {string} documentId */
function setNativeAccessibilityActive(active, epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId) return;
  accessibilityUntil = active ? performance.now() + 12000 : 0;
}
/** @param {ImageBitmap} frame */
function accessibilityFrameChanged(frame) {
  if (performance.now() >= accessibilityUntil) return false;
  if (!accessibilityCanvas) {
    accessibilityCanvas = document.createElement("canvas");
    accessibilityCanvas.width = 96;
    accessibilityCanvas.height = 128;
  }
  const context = accessibilityCanvas.getContext("2d");
  if (!context) return false;
  context.drawImage(frame, 0, 0, 96, 128);
  const pixels = context.getImageData(0, 0, 96, 128).data;
  let hash = frame.width ^ frame.height;
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = (pixels[i] + 2 * pixels[i + 1] + pixels[i + 2]) / 4;
    hash = Math.imul(hash ^ (luminance >> 4), 16777619);
  }
  const changed = hash !== accessibilityFrameHash;
  accessibilityFrameHash = hash;
  return changed;
}
/** @type {AbortController | null} */
let streamController = null;
let streamGeneration = 0;
/** @type {number | undefined} */
let streamWatchdog;
let streamRetryAt = 0;
let streamFailures = 0;
let streamStableSince = 0;
function stopStream() {
  streamGeneration++;
  streamController?.abort();
  streamController = null;
  clearTimeout(streamWatchdog);
  streamWatchdog = undefined;
  streamReady = false;
}
/** @param {ImageBitmap} frame @param {number} generation */
function presentStreamFrame(frame, generation) {
  if (generation !== streamGeneration || nativeVideo || lifecycle !== "ready" || !connected)
    return false;
  const firstFrame = !streamReady;
  const resized = screen.width !== frame.width || screen.height !== frame.height;
  if (resized) {
    invalidateInput();
    screen.width = frame.width;
    screen.height = frame.height;
  }
  /** @type {CanvasRenderingContext2D} */ (screen.getContext("2d")).drawImage(frame, 0, 0);
  streamReady = true;
  hasStreamFrame = true;
  $("overlay").hidden = true;
  if (firstFrame) reportLoading();
  const accessibilityChanged = accessibilityFrameChanged(frame);
  if (firstFrame || resized || accessibilityChanged)
    window.webkit?.messageHandlers?.native?.postMessage({
      w: frame.width,
      h: frame.height,
      videoEpoch,
      bridgeId,
      accessibilityChanged,
    });
  return true;
}
async function connectStream() {
  if (
    streamController ||
    nativeVideo ||
    lifecycle !== "ready" ||
    !connected ||
    performance.now() < streamRetryAt
  )
    return;
  const controller = new AbortController();
  streamController = controller;
  const generation = ++streamGeneration;
  const parser = new MjpegFrames();
  let decoding = false;
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let pending = null;
  streamStableSince = 0;
  const armWatchdog = () => {
    clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(() => controller.abort(), 3000);
  };
  const decodePending = async () => {
    if (decoding || !pending) return;
    decoding = true;
    try {
      while (pending && generation === streamGeneration && !controller.signal.aborted) {
        const bytes = pending;
        pending = null;
        const frame = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        try {
          if (!controller.signal.aborted && presentStreamFrame(frame, generation)) {
            armWatchdog();
            streamStableSince ||= performance.now();
            if (performance.now() - streamStableSince >= 10000) streamFailures = 0;
          }
        } finally {
          frame.close();
        }
      }
    } catch {
      controller.abort();
    } finally {
      decoding = false;
    }
  };
  armWatchdog();
  try {
    const response = await fetch(`/stream?raw=1&t=${Date.now()}`, { signal: controller.signal });
    if (
      !response.ok ||
      !response.body ||
      !/^application\/octet-stream\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("Video stream unavailable");
    const reader = response.body.getReader();
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        const frames = parser.push(value);
        if (frames.length) {
          pending = frames.at(-1) ?? null;
          void decodePending();
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    /* The next status tick retries; input stays disabled until a frame arrives. */
  } finally {
    if (generation === streamGeneration) {
      controller.abort();
      streamController = null;
      clearTimeout(streamWatchdog);
      streamWatchdog = undefined;
      streamReady = false;
      invalidateInput();
      streamRetryAt = performance.now() + Math.min(5000, 500 * 2 ** Math.min(streamFailures++, 4));
      $("overlay").hidden = false;
      /** @type {HTMLElement} */ ($("overlay").querySelector("b")).textContent = "Connecting…";
      reportLoading();
    }
  }
}

// Called by the Mac app when direct USB capture is unavailable.
/** @param {number} [epoch] @param {string} [documentId] */
function startStream(epoch, documentId) {
  if (epoch !== undefined && (epoch !== videoEpoch || documentId !== bridgeId)) return;
  stopStream();
  nativeVideo = false;
  nativeReady = false;
  invalidateInput();
  document.body.classList.remove("native-video", "preserve-stream-frame");
  streamRetryAt = 0;
  reportLoading();
  void connectStream();
}

/** @param {string} url @param {RequestInit} [options] @returns {Promise<import("../public-contracts.ts").ActionResponse>} */
async function requestJSON(url, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }).then((response) => response.json()),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @type {number | undefined} */
let toastTimer;
/** @param {string} msg */
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
}

// Keep implementation details in API responses, not in the app's messages.
/** @param {import("../public-contracts.ts").ActionResponse} response */
function actionMessage(response) {
  if (response.outcome === "unknown") return `Check your ${deviceKind} before trying again.`;
  if (response.outcome === "executed") return `Action sent. Check your ${deviceKind}.`;
  /** @type {Record<string,string>} */
  const messages = {
    "device locked": `Unlock your ${deviceKind}.`,
    "app changed": "The app changed. Try again.",
    "orientation changed": `Your ${deviceKind} rotated. Try again.`,
    "stale observation": "The screen changed. Try again.",
    "no such element": "Couldn't find that item.",
    "stale element reference": "That item changed. Try again.",
    "instance changed": "Reconnecting…",
    "unknown command": "This action isn't available.",
    "unsupported operation": "This action isn't available.",
    timeout: "That took too long. Try again.",
    cancelled: "Cancelled.",
  };
  return Object.hasOwn(messages, response.code ?? "")
    ? messages[response.code ?? ""]
    : "Couldn't complete that action.";
}

let outbound = Promise.resolve();
/** @param {string | undefined} name @param {Record<string,unknown>} [body] */
function api(name, body = {}, fromGesture = false) {
  if (!name) return Promise.resolve();
  if (!controlOnly.has(name) && !canInteract()) return Promise.resolve();
  const epoch = inputEpoch;
  if (!fromGesture) {
    flushWheel();
    flushPinch();
  } // Keep earlier gestures ahead of later input.
  if (name !== "type") flush(true); // keep typed text in order with other actions
  const requestId = crypto.randomUUID();
  pendingActions++;
  reportLoading();
  const task = outbound.then(async () => {
    try {
      if (!name) return Promise.resolve();
      if (!controlOnly.has(name) && (epoch !== inputEpoch || !canInteract())) return;
      const json = await requestJSON(`/api/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-iportal-instance": /** @type {HTMLMetaElement} */ (
            document.querySelector('meta[name="iportal-instance"]')
          ).content,
        },
        body: JSON.stringify({ ...body, requestId }),
      });
      if (!json.ok) toast(actionMessage(json));
      return json;
    } catch {
      // Recover the receipt rather than sending the action again after a lost reply.
      try {
        const receipt = await requestJSON(`/api/commands/${requestId}`, {}, 3000);
        if (receipt.value?.response?.body?.ok) return;
      } catch {}
      toast(`Connection lost. Check your ${deviceKind} before trying again.`);
    } finally {
      pendingActions--;
      reportLoading();
    }
  });
  outbound = task.then(
    () => {},
    () => {},
  );
  return task;
}

// ---------- Connection ----------

let pollInFlight = false;
/** @type {number | undefined} */
let pollTimer;
let usbRevision = 0;
/** @type {AbortController | undefined} */
let pollController;
let refreshPending = false;
let lastServerEventAt = -Infinity,
  lastServerSequence = -1,
  usbEventAt = 0;
/** @param {import("../public-contracts.ts").PublicStatus} s @param {string} [documentId] */
function receiveServerStatus(s, documentId) {
  if (documentId !== undefined && documentId !== bridgeId) return;
  if (s.service !== "iportal" || s.apiVersion !== 2) return;
  if (
    s.instanceId === serverInstance &&
    s.eventSequence !== undefined &&
    s.eventSequence <= lastServerSequence
  )
    return;
  if (s.observedAt < usbEventAt) return;
  lastServerEventAt = performance.now();
  lastServerSequence = s.eventSequence ?? lastServerSequence;
  applyServerStatus(s);
  statusRevision++;
  reportLoading();
}
/** @param {boolean} attached @param {number} epoch @param {string} documentId */
function usbConnectionChanged(attached, epoch, documentId) {
  // Hardware events remain relevant across video epochs in the same document.
  if (documentId !== bridgeId) return;
  usbRevision++;
  usbEventAt = Date.now();
  usbDevicePresent = false;
  connected = false;
  setLifecycle(attached ? "connecting" : "disconnected");
  loadingDetail = attached ? "" : `Connect your ${deviceKind}`;
  statusRevision++;
  reportLoading();
  // Discard a pre-event response; it cannot resurrect the detached transport.
  if (pollInFlight) {
    refreshPending = true;
    pollController?.abort();
  } else void poll();
}
// Native refreshes also wake an occluded WKWebView. Share one request/timer so
// native and browser scheduling cannot overlap or multiply polling loops.
function pollFallback() {
  if (performance.now() - lastServerEventAt < 12000) {
    pollTimer = setTimeout(pollFallback, 2000);
    return;
  }
  void poll();
}
async function poll() {
  if (pollInFlight) return;
  clearTimeout(pollTimer);
  pollInFlight = true;
  try {
    await pollConnection();
  } finally {
    pollInFlight = false;
    const again = refreshPending;
    const delay = again
      ? 0
      : performance.now() - lastServerEventAt < 12000
        ? 10000
        : lifecycle === "ready"
          ? 1000
          : 500;
    refreshPending = false;
    pollTimer = setTimeout(again ? poll : pollFallback, delay);
  }
}
async function pollConnection() {
  const revision = usbRevision;
  const controller = new AbortController();
  pollController = controller;
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const s = await (await fetch("/api/status", { signal: controller.signal })).json();
    if (revision !== usbRevision) return;
    if (s.observedAt < usbEventAt) {
      refreshPending = true;
      return;
    }
    if (
      s.instanceId === serverInstance &&
      s.eventSequence !== undefined &&
      s.eventSequence <= lastServerSequence
    )
      return;
    lastServerSequence = s.eventSequence ?? lastServerSequence;
    applyServerStatus(s);
  } catch {
    if (revision !== usbRevision) return;
    setLifecycle("connecting");
    connected = false;
    streamReady = false;
    $("overlay").hidden = false;
    $("dot").classList.remove("on");
    /** @type {HTMLElement} */ ($("overlay").querySelector("b")).textContent = "Reconnecting…";
    $("overlayText").textContent = "";
    loadingDetail = "";
  } finally {
    clearTimeout(timeout);
  }
  statusRevision++;
  reportLoading();
}
/** @param {import("../public-contracts.ts").PublicStatus} s */
function applyServerStatus(s) {
  if (s.service !== "iportal" || s.apiVersion !== 2) throw new Error("Unexpected server");
  const fingerprint = /** @type {HTMLMetaElement} */ (
    document.querySelector('meta[name="iportal-instance"]')
  );
  if (fingerprint.content !== s.instanceId) {
    connected = false;
    setLifecycle("connecting", "", s.instanceId);
    statusRevision++;
    reportLoading();
    location.reload();
    return;
  }
  $("dot").classList.toggle("on", s.ok);
  $("device").textContent =
    s.device || s.ok ? `${deviceKind} connected` : `No ${deviceKind} connected`;
  $("quality").value = s.quality;
  singleUsbDevice = s.captureIdentity?.singleUsbDevice === true;
  usbDevicePresent = Boolean(s.device);
  deviceOrientation = s.orientation ?? null;
  displayPixels = s.displayPixels ?? null;
  setLifecycle(
    s.lifecycle,
    s.device?.udid ?? s.pinnedUdid ?? "",
    s.instanceId,
    s.device ? String(s.device.id ?? "") : usbConnectionID,
  );
  loadingDetail =
    lifecycle === "locked" ? `Unlock your ${deviceKind}.` : !s.ok ? (s.error ?? "") : "";
  if (lifecycle === "ready" && !connected) {
    connected = true;
    if (nativeVideo) $("overlay").hidden = true;
    else void connectStream();
  }
  if (!nativeVideo && lifecycle === "ready") void connectStream();
  if (lifecycle !== "ready") {
    connected = false;
    streamReady = false;
    // Preserve the last frame under the locked/disconnected overlay.
    document.body.classList.add("unavailable");
    $("overlay").hidden = false;
    /** @type {HTMLElement} */ ($("overlay").querySelector("b")).textContent =
      lifecycle === "locked"
        ? "Locked"
        : lifecycle === "disconnected"
          ? "Disconnected"
          : "Connecting…";
    $("overlayText").textContent = loadingDetail;
  }
}
// The native app owns its subscription so occluded WebKit pages still wake.
// Standalone browsers use the same stream and retain poll() as their fallback.
if (!window.webkit?.messageHandlers?.native && typeof EventSource !== "undefined") {
  const events = new EventSource("/api/events");
  events.onmessage = (event) => {
    try {
      receiveServerStatus(JSON.parse(event.data));
    } catch {}
  };
  events.onerror = () => {
    lastServerEventAt = -Infinity;
    void poll();
  };
}

void poll();
queueMicrotask(() => {
  void api("ensure");
}); // wait for keyboard buffers to initialize

// ---------- Touch: click, long press, drag ----------

/** @param {{clientX:number,clientY:number}} e @returns {[number,number]} */
const rel = (e) => {
  const r = screen.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  ];
};

/** @param {{clientX:number,clientY:number}} e */
function ripple(e) {
  const r = phone.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "ripple";
  el.style.left = `${e.clientX - r.left}px`;
  el.style.top = `${e.clientY - r.top}px`;
  phone.append(el);
  setTimeout(() => el.remove(), 400);
}

/** @type {{t0: number, last: number, points: number[][]} | null} */
let touch = null;

screen.addEventListener("pointerdown", (e) => {
  if (canInteract()) keyboardInput.focus?.({ preventScroll: true });
  if (e.button !== 0 || !canInteract() || pinch) return;
  e.preventDefault();
  screen.setPointerCapture(e.pointerId);
  touch = { t0: performance.now(), last: 0, points: [[...rel(e), 0]] };
  ripple(e);
});

screen.addEventListener("pointermove", (e) => {
  if (!touch) return;
  const t = Math.min(10000, performance.now() - touch.t0);
  if (t - touch.last < 16) return;
  touch.last = t;
  touch.points.push([...rel(e), t]);
});

screen.addEventListener("pointerup", (e) => {
  if (!touch) return;
  const end = Math.min(10000, performance.now() - touch.t0);
  let points = [...touch.points, [...rel(e), end]];
  const [x0, y0] = points[0];
  const moved = points.some(([x, y]) => Math.hypot(x - x0, y - y0) > 0.012);
  if (!moved) points = [points[0]];
  else if (points.length > 40) {
    const step = (points.length - 1) / 39;
    points = Array.from({ length: 40 }, (_, i) => points[Math.round(i * step)]);
  }
  touch = null;
  void api("gesture", { points, end: moved ? points[points.length - 1][2] : end < 250 ? 40 : end });
});

screen.addEventListener("pointercancel", () => (touch = null));
screen.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- Scrolling: one physical scroll gesture becomes one phone swipe ----------

/** @type {{x: number, y: number, dx: number, dy: number, sent: boolean, phased: boolean, zoom: boolean} | null} */
let wheel = null;
/** @type {number | undefined} */
let wheelTimer;
// Desktop wheel events have no gesture phases. End a burst after a short pause;
// the Mac app supplies explicit trackpad phases and suppresses momentum events.
const wheelIdleMs = 80;
function flushWheel() {
  if (!wheel || wheel.sent) return;
  const pending = wheel;
  pending.sent = true;
  if (pending.zoom) {
    sendPinch(pending.x, pending.y, Math.exp(-pending.dy * 4));
    return;
  }
  /** @param {number} v */
  const lim = (v) => Math.max(-0.5, Math.min(0.5, -v));
  const dx = lim(pending.dx),
    dy = lim(pending.dy);
  /** @param {number} v @param {number} d */
  const fit = (v, d) => Math.max(0.05 - Math.min(0, d), Math.min(0.95 - Math.max(0, d), v));
  const x = fit(pending.x, dx),
    y = fit(pending.y, dy);
  if (Math.abs(dx) + Math.abs(dy) < 0.01) return;
  void api(
    "gesture",
    {
      points: [
        [x, y, 0],
        [x + dx * 0.5, y + dy * 0.5, 60],
        [x + dx, y + dy, 120],
      ],
      end: 120,
    },
    true,
  );
}
function finishWheel() {
  clearTimeout(wheelTimer);
  wheelTimer = undefined;
  flushWheel();
  wheel = null;
}
/** @param {number} x @param {number} y @param {number} dx @param {number} dy */
function accumulateWheel(x, y, dx, dy, phased = false, zoom = false) {
  if (!canInteract() || touch || pinch) return;
  // A modifier change starts a new mouse burst. For trackpads, keep the mode
  // chosen at finger-down even if Command is released before finger-up.
  if (!phased && wheel && wheel.zoom !== zoom) finishWheel();
  wheel ??= { x, y, dx: 0, dy: 0, sent: false, phased, zoom };
  // A later click/typing action may already have flushed this gesture.
  if (!wheel.sent) {
    wheel.dx += dx;
    wheel.dy += dy;
  }
  if (!phased) {
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(finishWheel, wheelIdleMs);
  }
}
/** @param {import("../public-contracts.ts").NativeScroll} event @param {number} epoch @param {string} documentId */
function nativeScroll(event, epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId || !canInteract() || pinch) return;
  if (event.phase === "momentum") return;
  if (event.phase === "cancelled") {
    clearTimeout(wheelTimer);
    wheelTimer = undefined;
    wheel = null;
    return;
  }
  if (event.phase === "began") {
    // A missing end/cancel must not replay an abandoned trackpad gesture.
    if (wheel?.phased) {
      clearTimeout(wheelTimer);
      wheelTimer = undefined;
      wheel = null;
    } else finishWheel();
    wheel = {
      x: event.x,
      y: event.y,
      dx: 0,
      dy: 0,
      sent: false,
      phased: true,
      zoom: Boolean(event.zoom),
    };
  }
  // A changed/ended event without a begin belongs to a gesture interrupted by
  // lock/reconnect or one that began outside this window. Never replay its tail.
  if (event.phase !== "none" && !wheel?.phased) return;
  accumulateWheel(
    event.x,
    event.y,
    event.dx,
    event.dy,
    event.phase !== "none",
    Boolean(event.zoom),
  );
  if (event.phase === "ended") finishWheel();
}
screen.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = screen.getBoundingClientRect();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    accumulateWheel(
      ...rel(e),
      (e.deltaX * scale) / r.width,
      (e.deltaY * scale) / r.height,
      false,
      Boolean(e.metaKey || e.ctrlKey),
    );
  },
  { passive: false },
);

// ---------- Pinch: one two-finger zoom per complete gesture ----------

/** @type {{x: number, y: number, scale: number, sent: boolean, source: string} | null} */
let pinch = null;
/** @param {number} x @param {number} y @param {number} scale */
function sendPinch(x, y, scale) {
  scale = Math.max(0.25, Math.min(4, scale));
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 0.02) return;
  void api("pinch", { x, y, scale, durationMs: 240 }, true);
}
function flushPinch() {
  if (!pinch || pinch.sent) return;
  pinch.sent = true;
  sendPinch(pinch.x, pinch.y, pinch.scale);
}
/** @param {import("../public-contracts.ts").NativePinch} event @param {string} source */
function updatePinch(event, source) {
  if (!canInteract()) return;
  if (event.phase === "began") {
    // macOS can switch from scrolling to magnifying without lifting fingers.
    // Discard that unfinished scroll so pinching cannot also swipe the photo.
    if (wheel?.phased) {
      clearTimeout(wheelTimer);
      wheelTimer = undefined;
      wheel = null;
    } else finishWheel();
    touch = null;
    pinch = { x: event.x, y: event.y, scale: 1, sent: false, source };
  }
  if (!pinch || pinch.source !== source) return;
  if (event.phase === "cancelled") {
    pinch = null;
    return;
  }
  if (!pinch.sent) {
    if (typeof event.scale === "number" && Number.isFinite(event.scale)) pinch.scale = event.scale; // Safari's cumulative scale
    else if (typeof event.delta === "number" && Number.isFinite(event.delta))
      pinch.scale += event.delta; // AppKit's incremental delta
  }
  if (event.phase === "ended") {
    flushPinch();
    pinch = null;
  }
}
/** @param {import("../public-contracts.ts").NativePinch} event @param {number} epoch @param {string} documentId */
function nativePinch(event, epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId) return;
  updatePinch(event, "native");
}
// Safari uses gesture events; Chromium reports trackpad pinches as Ctrl-wheel.
for (const [name, phase] of [
  ["gesturestart", "began"],
  ["gesturechange", "changed"],
  ["gestureend", "ended"],
]) {
  screen.addEventListener(
    name,
    (e) => {
      e.preventDefault();
      const [x, y] = rel(/** @type {Event & {clientX:number,clientY:number}} */ (e));
      updatePinch(
        { phase, x, y, scale: /** @type {Event & {scale: number}} */ (e).scale },
        "safari",
      );
    },
    { passive: false },
  );
}

// ---------- Keyboard ----------

const inField = () =>
  document.activeElement !== keyboardInput &&
  ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "");
// iOS takes ~300 ms per typing request no matter how many characters it carries. So the first key goes out
// right away, and keys typed while a request is in flight pile up and go out together when it returns.
// force: send now anyway, so pending text stays ahead of a tap or other action that follows it.
let typed = "";
let typing = false;
function flush(force = false) {
  if (!canInteract()) {
    typed = "";
    return;
  }
  if (!typed || (typing && !force)) return;
  const text = typed;
  typed = "";
  typing = true;
  void api("type", { text }).finally(() => {
    typing = false;
    flush();
  });
}

/** @param {KeyboardEvent} e */
function editingKeyRequest(e) {
  if (e.isComposing || e.key === "Dead" || e.key === "Process" || e.getModifierState?.("AltGraph"))
    return null;
  const special = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Backspace",
    "Delete",
    "Enter",
    "Tab",
    "Escape",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];
  const shortcut =
    (e.metaKey && /^[acvxyz]$/i.test(e.key)) || (e.ctrlKey && /^[a-z]$/i.test(e.key));
  if (!special.includes(e.key) && !shortcut) return null;
  const modifiers = [];
  if (e.metaKey) modifiers.push("command");
  if (e.ctrlKey) modifiers.push("control");
  if (e.altKey) modifiers.push("option");
  if (e.shiftKey) modifiers.push("shift");
  return { key: shortcut ? e.key.toLowerCase() : e.key, modifiers };
}
function focusKeyboard() {
  if (canInteract() && !inField()) keyboardInput.focus?.({ preventScroll: true });
}
function consumeComposition() {
  const text = keyboardInput.value;
  keyboardInput.value = "";
  if (!canInteract() || !text) return;
  typed += text;
  flush();
}
keyboardInput.addEventListener("input", (event) => {
  if (!event.isComposing) consumeComposition();
});
keyboardInput.addEventListener("compositionend", () => setTimeout(consumeComposition, 0));
window.addEventListener("focus", focusKeyboard);
window.addEventListener("keydown", (e) => {
  if (inField() || !canInteract() || e.isComposing || e.keyCode === 229) return;
  // Preserve browser-only navigation shortcuts when no phone text input is active.
  if (document.activeElement !== keyboardInput && e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.code === "KeyH") return (e.preventDefault(), void api("home"));
    if (e.code === "KeyJ") return (e.preventDefault(), void api("shortcut", { name: "switcher" }));
  }
  const key = editingKeyRequest(e);
  // Browser paste carries the Mac clipboard through the paste event. The native
  // app's Edit menu owns its own Paste command; never inject it a second time.
  if (key && !(e.key.toLowerCase() === "v" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    void api("key", key);
    return;
  }
  if (document.activeElement === keyboardInput) return; // committed text/IME arrives via input
  if (e.metaKey || e.ctrlKey || e.altKey || e.key === "Dead") return;
  if (Array.from(e.key).length !== 1) return;
  e.preventDefault();
  typed += e.key;
  flush();
});
/** @param {string} key @param {string[]} modifiers @param {number} epoch @param {string} documentId */
function nativeKey(key, modifiers, epoch, documentId) {
  if (epoch !== videoEpoch || documentId !== bridgeId || !canInteract())
    return Promise.resolve(null);
  return api("key", { key, modifiers });
}

window.addEventListener("paste", (e) => {
  if (inField() || !canInteract()) return;
  const text = e.clipboardData?.getData("text/plain");
  if (text) {
    e.preventDefault();
    typed += text;
    flush();
  }
});

// ---------- Sidebar ----------

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-action]")).forEach((b) =>
  b.addEventListener("click", () => {
    void api(b.dataset.action);
  }),
);
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-shortcut]")).forEach((b) =>
  b.addEventListener("click", () => {
    void api("shortcut", { name: b.dataset.shortcut });
  }),
);
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-button]")).forEach((b) =>
  b.addEventListener("click", () => {
    void api("button", { name: b.dataset.button });
  }),
);

$("siriBtn").addEventListener("click", () => {
  const text = prompt("Ask Siri:");
  if (text) void api("siri", { text });
});

$("launchBtn").addEventListener("click", () => {
  /** @type {string | null} */
  let bundleId = $("app").value;
  if (bundleId === "custom")
    bundleId = prompt(
      `App identifier (for example, ${platform === "android" ? "com.android.settings" : "com.apple.Maps"}):`,
    );
  if (bundleId) void api("launch", { bundleId });
});

$("quality").addEventListener("change", (e) => {
  void api("quality", { level: /** @type {HTMLSelectElement} */ (e.target).value }).then(() => {
    if (!nativeVideo) startStream(); // reconnect so the new scale applies right away
  });
});

// Buttons shouldn't keep focus, otherwise Space/Enter would re-trigger them instead of typing.
document.querySelectorAll("button").forEach((b) => b.addEventListener("mouseup", () => b.blur()));

// Explicit entry points called by WKWebView, kept as classic-script globals.
Object.assign(window, {
  setNativeAccessibilityActive,
  setNativeSettingsVisible,
  nativeGeometryChanged,
  setNativeVideoReady,
  useNativeVideo,
  startStream,
  receiveServerStatus,
  usbConnectionChanged,
  nativeScroll,
  nativePinch,
  nativeKey,
});
