#!/usr/bin/env node
// Uses only the foreground harmless recorder. No XCTest self-activation.
import fs from "node:fs";
const [base="http://127.0.0.1:8100", output, variant] = process.argv.slice(2);
if (!output || (variant && variant !== "--raw")) throw Error("Usage: node measure.mjs WDA_BASE OUTPUT.json [--raw]");
const report={recordedAt:new Date().toISOString(),samples:[],notes:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");
async function call(body) {
  const start=performance.now();
  const response=await fetch(base+"/wda/mirror/indirect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(9000)});
  return {status:response.status,httpMs:performance.now()-start,response:await response.json()};
}
async function sample(body, reset=true) {
  if (reset) {
    const r=await call({mode:"reset"});
    if(r.status!==200 || r.response.value?.error) throw Error("Cannot reset idle probe");
  }
  const result=await call(body), v=result.response.value;
  const expectedKind=body.mode.includes("scale") || body.mode==="pinch-baseline" ? "zoom"
    : body.mode.endsWith("move") ? "hover" : "scroll";
  const changes=v?.events?.filter(e=>e.kind===expectedKind) ?? [];
  const item={request:body,...result,deliveryObserved:changes.length>0,
    timing:changes.length?{firstChangeMs:(changes[0].uptime-v.invokedUptime)*1000,
      lastChangeMs:(changes.at(-1).uptime-v.invokedUptime)*1000,
      callbackAfterLastChangeMs:(v.callbackUptime-changes.at(-1).uptime)*1000}:null};
  report.samples.push(item); save();
  console.log(JSON.stringify({request:body,status:result.status,nativeMs:v?.nativeMs,observed:changes.length,
    deltaY:v?.offsetAfter-v?.offsetBefore,error:v?.error,message:v?.message,timing:item.timing}));
  if(result.status!==200 || v?.error || v?.completed!==true)
    throw Error(`Prototype command failed; not negative delivery evidence: ${v?.message ?? result.status}`);
  return item;
}
try {
  let state;
  for(let i=0;i<30;i++) {
    state=await call({mode:"state"});
    if(state.response.value?.foreground) break;
    await new Promise(r=>setTimeout(r,100));
  }
  report.initialState=state.response.value;
  if(!state.response.value?.foreground || !state.response.value?.visible || !state.response.value?.indirectInputEnabled)
    throw Error("Foreground the runner with the visible recorder and indirect-input Info.plist key first");
  report.runtime=(await call({mode:"runtime"})).response.value; save();
  const baseline=await sample({mode:"touch",durationMs:200});
  if(!baseline.deliveryObserved) throw Error("Touch scroll calibration failed; indirect results would be ambiguous");
  let winner;
  if(variant === "--raw") {
    const raw=await sample({mode:"raw-touch",durationMs:200});
    if(!raw.deliveryObserved) throw Error("Raw touch calibration failed; raw indirect results would be ambiguous");
    const pinch=await sample({mode:"pinch-baseline",durationMs:250});
    report.directPinchCalibration=pinch.deliveryObserved;
    for(const sender of ["trackpad","mouse"]) {
      for(const units of ["points","normalized","view","pixels"]) {
        const scroll=await sample({mode:"raw-scroll",sender,units,dy:160,durationMs:200});
        if(scroll.deliveryObserved) { winner={sender,units}; break; }
      }
      if(winner) break;
    }
    if(winner) {
      report.workingRawConfiguration=winner;
      await sample({mode:"raw-scroll",...winner,dy:300,durationMs:1500});
      await call({mode:"reset"}); const start=performance.now();
      for(let i=0;i<12;i++) await sample({mode:"raw-scroll",...winner,dy:i<6?40:-40,durationMs:16},false);
      report.sequentialUpdatesPerSecond=12000/(performance.now()-start);
      await sample({mode:"raw-scale",...winner,scale:.25,durationMs:250});
    } else {
      // Check discrete reports and transform delivery independently. Direct-touch zoom is the control.
      for(const sender of ["trackpad","mouse"]) {
        await sample({mode:"raw-scroll",sender,units:"points",style:"discrete",dy:5,durationMs:16});
        for(const units of ["points","normalized","view"])
          await sample({mode:"raw-scale",sender,units,scale:.25,durationMs:250});
      }
    }
    report.verdict=winner?"Raw indirect scroll delivery observed; assess cadence and pinch evidence.":"Calibrated raw touch delivery, but no observed indirect scrolling through tested senders/coordinates.";
  } else {
  for (const units of ["points","pixels","normalized"]) {
    await sample({mode:"move",units,durationMs:0});
    const phased=await sample({mode:"scroll",units,dy:160,durationMs:200});
    if(phased.deliveryObserved) { winner=units; break; }
  }
  if(!winner) {
    for(const units of ["points","pixels","normalized"]) {
      const discrete=await sample({mode:"scroll",units,style:"discrete",dy:5,durationMs:0});
      if(discrete.deliveryObserved) report.notes.push(`Discrete scroll delivered with ${units}; phased scroll still unverified.`);
    }
    report.verdict="No observed continuous indirect scrolling through tested mouse-path variants.";
  } else {
    report.workingUnits=winner;
    await sample({mode:"scroll",units:winner,dy:300,durationMs:1500});
    await call({mode:"reset"});
    const start=performance.now();
    for(let i=0;i<12;i++) await sample({mode:"scroll",units:winner,dy:i<6?40:-40,durationMs:16},false);
    report.sequentialUpdatesPerSecond=12000/(performance.now()-start);
    report.verdict="Indirect delivery observed; inspect cadence, reversal and phase continuity before any live integration.";
    // Calibrate zoom recognition only. This is explicitly direct-touch, not indirect pinch proof.
    await sample({mode:"pinch-baseline",durationMs:250});
  }
  }
  report.continuousScrollDeliveryObserved=Boolean(winner);
  // Delivery alone cannot establish live finger-following interaction.
  report.realtimeInteractionVerified=false;
  report.finalState=(await call({mode:"state"})).response.value;
} catch(error) {
  report.failure=String(error); process.exitCode=1;
} finally {
  // No held-contact chunk is ever sent. Caller restores the normal helper after inspecting evidence.
  save();
}
console.log(JSON.stringify({verdict:report.verdict,failure:report.failure,updatesPerSecond:report.sequentialUpdatesPerSecond}));
