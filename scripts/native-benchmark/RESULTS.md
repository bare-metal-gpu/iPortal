# Physical native-mirror measurements, 3 November 2026

Production input behavior based on `09ff0b9`, with opt-in instrumentation only.
Fifty-six measured inputs plus one separate startup calibration; every measured
command had verified UIKit touch delivery and a matching native USB video marker.
No correlation failures or command errors. All gestures targeted the harmless
foreground recorder. p95 is nearest rank and these small samples are exploratory.

| Condition | Inputs | Median input to USB frame | p95 | Median command HTTP time |
| --- | ---: | ---: | ---: | ---: |
| Isolated clicks | 12 | 121.7 ms | 141.7 ms | 306.5 ms |
| Rapid click burst | 12 | 1291.6 ms | 2540.3 ms | 306.5 ms |
| Clicks during state inspection | 12 | 132.1 ms | 191.1 ms | 325.5 ms |
| Clicks with keep-awake enabled | 12 | 122.7 ms | 146.5 ms | 306.0 ms |
| Isolated wheel input | 8 | 203.8 ms | 280.6 ms | 397.0 ms |

Input means Mac mouse-up for clicks and the last native wheel event for scrolling.
This excludes the user's hold/gesture collection time and physical Mac display
presentation. The video timestamp is the existing native USB sample-buffer callback,
not MJPEG. Phone and Mac monotonic clocks were never directly subtracted.

The isolated native guard cost was 25.2 ms median; daemon invocation to UIKit
touch-down was 29.5 ms. The callback followed touch-up by 189.0 ms. The remaining
62.7 ms includes host/USB request transport, scheduling and video return, and cannot
be assigned entirely to video with this instrumentation.

Rapid inputs waited in the browser queue for 1165 ms median / 2415 ms p95. Once
dispatched, their HTTP cost was unchanged. This is accumulated completion latency,
not progressively slower touch delivery or video. The 180 state inspections over
22 seconds all succeeded; server queueing rose from 2 to 21 ms median under that
load. An initial keep-awake pulse took 652 ms, but activity postponed further pulses
throughout the click run: pulse count remained one. This does not measure a click
arriving during an already-running pulse.

Wheel input spent 83.3 ms median before enqueue, consistent with the 80 ms idle
timer. This was unphased wheel input supplied through native automation; native
trackpad gestures have explicit phases and do not use that timer. Reducing it
without testing burst boundaries risks splitting one intended scroll into several.

The next high-value experiment is to synthesize two or more complete, nonoverlapping
touches in one event record, using only clicks already waiting in the queue. Test
whether this shares one completion tail, preserves every began/ended pair, and
still works across real UI transitions before considering production batching.
Do not delay the first click, drop queued clicks, combine commands with different
guards/postconditions, or overlap daemon playback. Even if the recorder passes,
earlier delivery during an app animation can change which element receives a tap.

For single clicks, next separate the roughly 63 ms unallocated host/video interval
before changing capture settings. Consolidating inspection requests is a smaller,
independent opportunity for reducing input contention under automation load.

Validation: normal regression suite, benchmark correlation/rejection tests, all
256 marker codes plus shifted/invalid markers, signed helper build, native app
build, repeat installation and exact source restoration. The recorder was hidden
with zero contacts and its idle assertion released. The original installed app and
normal helper build were restored, and the benchmark route returned 404.

Grouped numeric results: [phone-results.json](phone-results.json).
