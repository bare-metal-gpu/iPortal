import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,"../..");
const folder=await mkdtemp(resolve(root,"vendor/indirect-install-test-"));
try {
  const files=["WebDriverAgentLib/Commands/FBTouchActionCommands.m","Scripts/embed-runner-icon.sh"];
  const baseline=await Promise.all(files.map(f=>readFile(resolve(root,"vendor/WebDriverAgent",f),"utf8")));
  for(let i=0;i<files.length;i++) {
    await mkdir(resolve(folder,files[i],".."),{recursive:true});
    await writeFile(resolve(folder,files[i]),baseline[i]);
  }
  const run=(...args)=>execFileSync(process.execPath,[resolve(root,"scripts/indirect-prototype/install.mjs"),folder,...args],{stdio:"pipe"});
  run(); const first=await Promise.all(files.map(f=>readFile(resolve(folder,f),"utf8")));
  run(); assert.deepEqual(await Promise.all(files.map(f=>readFile(resolve(folder,f),"utf8"))),first);
  run("--remove"); run("--remove");
  assert.deepEqual(await Promise.all(files.map(f=>readFile(resolve(folder,f),"utf8"))),baseline);
  const incompatible=baseline[1].replace("# Re-codesign since we modified the bundle after Xcode signed it.","changed upstream anchor");
  await writeFile(resolve(folder,files[1]),incompatible);
  assert.throws(()=>run());
  assert.equal(await readFile(resolve(folder,files[0]),"utf8"),baseline[0]);
  console.log("Repeated install/remove restores exact source; incompatible script is rejected before mutation.");
} finally { await rm(folder,{recursive:true,force:true}); }
