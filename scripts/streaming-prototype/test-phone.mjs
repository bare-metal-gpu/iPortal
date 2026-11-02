// Explicit real-phone opt-in. Requires prototype runner + USB-only WDA bridge.
// Opens only the runner's dedicated recorder surface; changes no phone settings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const base=process.argv[2]??'http://127.0.0.1:18100';
const output=process.argv[3]??'streaming-report.json';
const report={recordedAt:new Date().toISOString(),samples:[],passed:false,assessment:'incomplete',watchdogAssessment:'not-run'};
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
 if(probe.applicationState!==0){
  assert.ok(process.env.UDID,'Set UDID to foreground the runner externally');
  execFileSync('xcrun',['devicectl','device','process','launch','--device',process.env.UDID,probe.bundleId],{timeout:15000,stdio:'pipe'});
  await sleep(400);
 }
 let foreground;for(let i=0;i<30;i++){foreground=await post('/wda/mirror/probe');if(foreground.applicationState===0&&foreground.idleTimerHeld)break;await sleep(100)}
 assert.equal(foreground.applicationState,0);assert.equal(foreground.idleTimerHeld,true);
 await post('/wda/mirror/probe',{action:'reset'});
 await post('/wda/mirror/touch',{points:[[.35,.5,0],[.65,.5,200]],end:220,expectedBundleId:probe.bundleId});
 const calibration=await post('/wda/mirror/probe');
 assert.equal(calibration.events.filter(e=>e.phase==='began').length,1,'Recorder must see ordinary down');
 assert.equal(calibration.events.filter(e=>e.phase==='ended').length,1,'Recorder must see ordinary up');
 assert.equal(calibration.activeCount,0);
 report.calibrationPassed=true;
 await post('/wda/mirror/probe',{action:'reset'});
 let config;
 const candidates=[];
 for(const senderMode of ['display','generic'])for(const frameMode of ['physical','logical','unit'])for(const pointMode of ['logical','physical'])for(const screenScale of [3,1])candidates.push({frameMode,pointMode,screenScale,senderMode});
 const unavailableSenders=new Set();
 for(const candidate of candidates){
  if(unavailableSenders.has(candidate.senderMode))continue;
  await post('/wda/mirror/probe',{action:'reset'});
  try{await post('/wda/mirror/stream',{phase:'tap',x:.5,y:.5,...candidate});}catch(error){if(error.message.includes('Display-specific sender unavailable')){unavailableSenders.add(candidate.senderMode);continue;}throw error;}
  const raw=await post('/wda/mirror/probe');
  assert.equal(raw.activeCount,0,'Full raw tap must not leave a contact active');
  const rawBegan=raw.events.filter(e=>e.phase==='began'),rawEnded=raw.events.filter(e=>e.phase==='ended');
  if(rawBegan.length===1 && rawEnded.length===1 && rawBegan[0].id===rawEnded[0].id && !raw.events.some(e=>e.phase==='cancelled') && Math.abs(rawBegan[0].x-raw.width/2)<2 && Math.abs(rawBegan[0].y-raw.height/2)<2){config=candidate;break;}
 }
 assert.ok(config,'No raw Recap full-tap calibration reached recorder; split contact not assessed');
 report.rawCalibrationPassed=true;report.config=config;
 await post('/wda/mirror/probe',{action:'reset'});
 const down=await post('/wda/mirror/stream',{phase:'begin',x:.35,y:.5,...config});token=down.token;
 await sleep(350);
 let state=await post('/wda/mirror/probe');
 const began=state.events.filter(e=>e.phase==='began'),cancelled=state.events.filter(e=>e.phase==='cancelled');
 if(state.activeCount===0 && began.length===1 && cancelled.length===1 && began[0].id===cancelled[0].id){
  report.assessment='serialized-delta-contact-not-supported';report.continuousContactPassed=false;report.continuousEvents=state.events;report.cancelAfterTouchMs=(cancelled[0].timestamp-began[0].timestamp)*1000;
  throw Error(`Down-only contact was cancelled after ${report.cancelAfterTouchMs.toFixed(1)} ms, before the next serialized chunk; continuous contact unsupported by this tested path`);
 }
 assert.equal(state.activeCount,1,'Down-only chunk must preserve one active UIKit touch');
 const identity=state.events.find(e=>e.phase==='began')?.id;assert.ok(identity);
 for(const [x,y] of [[.5,.55],[.65,.6]]){
  const previous=state.events.at(-1);
  const priorMoved=state.events.filter(e=>e.phase==='moved').length;
  await post('/wda/mirror/stream',{phase:'move',token,x,y});await sleep(150);
  state=await post('/wda/mirror/probe');assert.equal(state.activeCount,1);assert.equal(state.events.filter(e=>e.phase==='began').length,1);
  const moves=state.events.filter(e=>e.phase==='moved');
  assert.ok(moves.length>priorMoved,'Each move chunk must produce new UIKit movement');
  const fresh=moves.slice(priorMoved),last=fresh.at(-1);
  assert.ok(fresh.every(e=>e.id===identity),'Each new move must use the original touch');
  assert.ok(last.timestamp>previous.timestamp && last.receivedUptime>previous.receivedUptime,'Movement timestamps must advance for each chunk');
  assert.ok(last.x>previous.x+2 && last.y>previous.y+2,'Each chunk must move right/down toward its new target');
 }
 await post('/wda/mirror/stream',{phase:'end',token});token=null;
 state=await post('/wda/mirror/probe');assert.equal(state.activeCount,0);assert.equal(state.events.filter(e=>e.phase==='ended').length,1);
 assert.ok(state.events.every(e=>e.id===identity));report.continuousContactPassed=true;report.continuousEvents=state.events;
 await post('/wda/mirror/probe',{action:'reset'});
 const stale=await post('/wda/mirror/stream',{phase:'begin',x:.35,y:.65,...config});token=stale.token;
 await sleep(4200);state=await post('/wda/mirror/probe');
 const status=await post('/wda/mirror/stream',{phase:'status'});
 assert.equal(state.activeCount,0,'Watchdog must physically release');assert.equal(state.events.filter(e=>e.phase==='ended').length,1);assert.equal(status.active,false);
 report.watchdogPassed=true;report.watchdogAssessment='verified';report.assessment='continuous-contact-and-watchdog-verified';report.watchdogEvents=state.events;token=null;report.passed=true;
}catch(error){report.error=error.message;if(report.assessment==='incomplete')report.assessment='test-error';process.exitCode=report.assessment==='serialized-delta-contact-not-supported'?2:1;}
finally{
 try{const status=await post('/wda/mirror/stream',{phase:'status'});if(status.active)await post('/wda/mirror/stream',{phase:'cancel',token:status.token});report.finalProbe=await post('/wda/mirror/probe');if(!report.finalProbe.activeCount)report.hiddenProbe=await post('/wda/mirror/probe',{action:'hide'});}catch(error){report.cleanupError=error.message;}
 await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,assessment:report.assessment,error:report.error,calibration:report.calibrationPassed,continuous:report.continuousContactPassed,watchdog:report.watchdogPassed,activeContacts:report.finalProbe?.activeCount},null,2));
}
