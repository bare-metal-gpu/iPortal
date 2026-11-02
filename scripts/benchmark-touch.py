#!/usr/bin/env python3
"""Opt-in real-phone benchmark. Opens Settings, navigates and scrolls; changes no settings.
Requires Pillow. Usage: python benchmark-touch.py /absolute/path/report.json
Video timings are host-observed MJPEG changes, not direct panel/input timestamps.
"""
import io
import json
import statistics
import sys
import threading
import time
import urllib.request
from PIL import Image, ImageChops, ImageStat

BASE = "http://127.0.0.1:7100/api/"


def post(name, body=None):
    request = urllib.request.Request(BASE + name, json.dumps(body or {}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=65) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError(result)
    return result


frames = []
mutex = threading.Lock()
ready = threading.Event()
failure = []


def video():
    try:
        with urllib.request.urlopen("http://127.0.0.1:9100", timeout=10) as stream:
            while True:
                line = stream.readline()
                if not line:
                    raise RuntimeError("MJPEG stream closed")
                if not line.lower().startswith(b"content-length:"):
                    continue
                length = int(line.split(b":")[1])
                while stream.readline().strip():
                    pass
                raw = stream.read(length)
                received = time.perf_counter()
                image = Image.open(io.BytesIO(raw)).convert("RGB")
                w, h = image.size
                # Exclude clock/automation banner, bottom home indicator and screen edges.
                image = image.crop((w * .1, h * .18, w * .9, h * .8)).resize((64, 96))
                with mutex:
                    frames.append((received, image))
                    del frames[:-300]
                ready.set()
    except Exception as error:
        failure.append(str(error))
        ready.set()


def measure(label, body):
    # Require a quiet video interval; fixed sleeps can mistake residual scroll inertia
    # from the previous sample for a response to the next input.
    deadline, quiet_since, previous = time.perf_counter() + 6, None, None
    while time.perf_counter() < deadline:
        time.sleep(.05)
        with mutex:
            latest = frames[-1]
        if previous and latest[0] > previous[0]:
            difference = statistics.mean(ImageStat.Stat(ImageChops.difference(previous[1], latest[1])).mean)
            quiet_since = (quiet_since or time.perf_counter()) if difference < .7 else None
            if quiet_since and time.perf_counter() - quiet_since > .4:
                break
        previous = latest
    else:
        raise RuntimeError("Video never settled before sample")
    with mutex:
        before_time, before = frames[-1]
    start = time.perf_counter()
    if start - before_time > .5:
        raise RuntimeError("No fresh video frames")
    result = post("gesture", body)
    completed = time.perf_counter()
    visible = None
    while time.perf_counter() - start < 4:
        with mutex:
            candidates = [(t, im) for t, im in frames if t >= start]
        for t, im in candidates:
            if statistics.mean(ImageStat.Stat(ImageChops.difference(before, im)).mean) > 3:
                visible = t
                break
        if visible:
            break
        time.sleep(.01)
    sample = {"kind": label, "httpMs": round((completed-start)*1000, 1),
              "firstChangedVideoFrameMs": round((visible-start)*1000, 1) if visible else None,
              "videoBaselineAgeMs": round((start-before_time)*1000, 1),
              "gestureDurationMs": body["end"], "timing": result.get("timing")}
    print(json.dumps(sample), flush=True)
    return sample


post("keep-awake", {"enabled": True, "durationMs": 1800000})
assert not post("state")["value"]["locked"], "Unlock the phone first"
post("launch", {"bundleId": "com.apple.Preferences"})
nav = {"using": "class name", "value": "XCUIElementTypeNavigationBar"}
state = post("state")["value"]
assert state["orientation"] == "PORTRAIT", "Benchmark expects portrait Settings"
# Return to Settings root if this benchmark previously left a nested page open.
for _ in range(6):
    back = post("elements", {"selector": {"using": "accessibility id", "value": "BackButton"}})["value"]
    if not back:
        break
    post("tap", {"id": back[0]["id"], "expectedApp": "com.apple.Preferences"})
threading.Thread(target=video, daemon=True).start()
ready.wait(10)
if failure or not frames:
    raise RuntimeError(failure or "No MJPEG frames")
samples = []
display = {"using": "accessibility id", "value": "com.apple.settings.displayAndBrightness"}
# Normalize a previous scroll position before seeking the benchmark row.
account = {"using": "accessibility id", "value": "com.apple.settings.primaryAppleAccount"}
for _ in range(6):
    matches = post("elements", {"selector": account})["value"]
    if matches and post("element", {"id": matches[0]["id"], "attributes": ["hittable"]})["value"]["hittable"]:
        break
    post("gesture", {"points": [[.5, .38, 0], [.5, .72, 180]], "end": 180, "expectedApp": "com.apple.Preferences"})
    time.sleep(.8)
for _ in range(5):
    matches = post("elements", {"selector": display})["value"]
    if matches and post("element", {"id": matches[0]["id"], "attributes": ["hittable"]})["value"]["hittable"]:
        break
    post("gesture", {"points": [[.5, .72, 0], [.5, .38, 180]], "end": 180, "expectedApp": "com.apple.Preferences"})
    time.sleep(.8)
else:
    raise RuntimeError("Could not reveal Display & Brightness in Settings")
for i in range(6):
    selector = {"using": "accessibility id", "value": "com.apple.settings.displayAndBrightness" if i % 2 == 0 else "BackButton"}
    post("wait", {"selector": selector, "condition": "attribute", "attribute": "hittable", "equals": True, "stableForMs": 100, "timeoutMs": 5000})
    element = post("element", {"selector": selector})["value"]
    assert element["hittable"], "Display & Brightness must be visible in Settings"
    rect = element["rect"]
    x = (rect["x"] + rect["width"] / 2) / state["screen"]["width"]
    y = (rect["y"] + rect["height"] / 2) / state["screen"]["height"]
    samples.append(measure("tap", {"points": [[x, y, 0]], "end": 60, "expectedApp": "com.apple.Preferences", "expectedOrientation": "PORTRAIT"}))
    post("wait", {"selector": nav, "timeoutMs": 5000})
for i in range(4):
    start, end = (.65, .4) if i % 2 == 0 else (.4, .65)
    samples.append(measure("swipe", {"points": [[.5, start, 0], [.5, end, 150]], "end": 250, "expectedApp": "com.apple.Preferences", "expectedOrientation": "PORTRAIT"}))
summary = {}
for kind in ["tap", "swipe"]:
    group = [s for s in samples if s["kind"] == kind]
    summary[kind] = {"samples": len(group), "medianHttpMs": statistics.median(s["httpMs"] for s in group),
                     "medianFirstChangedVideoFrameMs": statistics.median(s["firstChangedVideoFrameMs"] for s in group if s["firstChangedVideoFrameMs"] is not None),
                     "allVisibleChangesDetected": all(s["firstChangedVideoFrameMs"] is not None for s in group)}
report = {"recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "samples": samples, "summary": summary,
          "method": "Host monotonic clock; API POST to first changed central-region MJPEG frame. Includes video capture/transport, excludes mouse gesture recording. Threshold mean RGB difference >3. No direct display-panel timestamps.",
          "settingsChanged": False}
with open(sys.argv[1], "w") as output:
    json.dump(report, output, indent=2)
print(json.dumps(summary, indent=2))
