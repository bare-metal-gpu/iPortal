import assert from "node:assert/strict";
import { analyze, summarize } from "./analyze.mjs";

const rows = [
  {event:"mac-input", type:2, eventMs:100, hostMs:102},
  {event:"browser", stage:"pointerup", hostMs:103, collectionMs:40, moved:false},
  {event:"browser", stage:"enqueue", hostMs:104, requestId:"a"},
  {event:"usb-marker", sequence:1, hostMs:220},
  // Later repeats must not inflate the latency.
  {event:"usb-marker", sequence:1, hostMs:240},
  {event:"browser", stage:"reply", name:"gesture", hostMs:400, requestId:"a", ok:true,
    browserQueueMs:0, httpMs:290, timing:{queueMs:1, preflightMs:2, native:{guardMs:30,
      benchmark:{deliveryVerified:true, sequence:1, invokeToTouchMs:25, touchMs:40, endToCallbackMs:190}}}},
];
const result = analyze(rows, [{name:"idle",afterSequence:0,throughSequence:1}]);
assert.equal(result.samples[0].inputToUSBFrameMs, 120);
assert.equal(result.samples[0].condition, "idle");
assert.equal(result.rejected.length, 0);
assert.equal(analyze(rows.filter(r => r.event !== "usb-marker")).samples.length, 0);
assert.equal(analyze(rows.filter(r => r.event !== "mac-input")).rejected.length, 1);
assert.equal(analyze([...rows, {...rows.at(-1), requestId:"other"}]).rejected.length, 1);
const wheel = rows.filter(r => r.stage !== "pointerup").map(r => r.event === "mac-input" ? {...r, type:22} : r);
assert.equal(analyze(wheel).samples[0].inputKind, "wheel");
assert.equal(analyze(wheel).samples[0].gestureCollectionMs, null);
assert.equal(analyze(rows.map(r => r.event === "mac-input" ? {...r, eventMs:0} : r)).samples.length, 0);
assert.deepEqual(summarize([10,30,20,40]), {n:4,median:25,p95:40,min:10,max:40});
console.log("Benchmark correlation, missing-evidence rejection, and quantiles passed.");
