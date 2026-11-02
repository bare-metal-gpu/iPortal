// Explicit real-phone opt-in. Requires prototype runner + USB-only WDA bridge.
// Opens only the runner's dedicated recorder surface; changes no phone settings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.argv[2]??'http://127.0.0.1:18100';
const output=process.argv[3]??'streaming-report.json';
const report={recordedAt:new Date().toISOString(),samples:[],passed:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function post(path,body={}){
 const started=performance.now(); const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const json=await response.json();report.samples.push({path,body,elapsedMs:Math.round(performance.now()-started),status:response.status,result:json.value});
 if(!response.ok||json.value?.error)throw Error(JSON.stringify(json.value));return json.value;
}
let token;
try{
 const probe=await post('/wda/mirror/probe',{action:'show'});
 const session=await post('/session',{capabilities:{alwaysMatch:{shouldWaitForQuiescence:false},firstMatch:[{}]}});
 const sid=session.sessionId;
 await post(`/session/${sid}/wda/apps/activate`,{bundleId:probe.bundleId});await sleep(400);
 await post('/wda/mirror/probe',{action:'reset'});
 await post('/wda/mirror/touch',{points:[[.35,.5,0],[.65,.5,200]],end:220,expectedBundleId:probe.bundleId});
 const calibration=await post('/wda/mirror/probe');
 assert.equal(calibration.events.filter(e=>e.phase==='began').length,1,'Recorder must see ordinary down');
 assert.equal(calibration.events.filter(e=>e.phase==='ended').length,1,'Recorder must see ordinary up');
 assert.equal(calibration.activeCount,0);
 report.calibrationPassed=true;
 await post('/wda/mirror/probe',{action:'reset'});
 const down=await post('/wda/mirror/stream',{phase:'begin',x:.35,y:.5});token=down.token;
 await sleep(350);
 let state=await post('/wda/mirror/probe');
 assert.equal(state.activeCount,1,'Down-only chunk must preserve one active UIKit touch');
 const identity=state.events.find(e=>e.phase==='began')?.id;assert.ok(identity);
 for(const [x,y] of [[.5,.55],[.65,.6]]){
  await post('/wda/mirror/stream',{phase:'move',token,x,y});await sleep(150);
  state=await post('/wda/mirror/probe');assert.equal(state.activeCount,1);assert.equal(state.events.filter(e=>e.phase==='began').length,1);
  assert.ok(state.events.filter(e=>e.phase==='moved').some(e=>e.id===identity),'Move must reach same touch');
 }
 await post('/wda/mirror/stream',{phase:'end',token});token=null;
 state=await post('/wda/mirror/probe');assert.equal(state.activeCount,0);assert.equal(state.events.filter(e=>e.phase==='ended').length,1);
 assert.ok(state.events.every(e=>e.id===identity));report.continuousContactPassed=true;report.continuousEvents=state.events;
 await post('/wda/mirror/probe',{action:'reset'});
 const stale=await post('/wda/mirror/stream',{phase:'begin',x:.35,y:.65});token=stale.token;
 await sleep(4200);state=await post('/wda/mirror/probe');
 const status=await post('/wda/mirror/stream',{phase:'status'});
 assert.equal(state.activeCount,0,'Watchdog must physically release');assert.equal(state.events.filter(e=>e.phase==='ended').length,1);assert.equal(status.active,false);
 report.watchdogPassed=true;report.watchdogEvents=state.events;token=null;report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 try{const status=await post('/wda/mirror/stream',{phase:'status'});if(status.active)await post('/wda/mirror/stream',{phase:'cancel',token:status.token});report.finalProbe=await post('/wda/mirror/probe');}catch(error){report.cleanupError=error.message;}
 await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,error:report.error,calibration:report.calibrationPassed,continuous:report.continuousContactPassed,watchdog:report.watchdogPassed,activeContacts:report.finalProbe?.activeCount},null,2));
}
