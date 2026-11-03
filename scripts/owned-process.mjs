#!/usr/bin/env node
// stdin is the owning mirror's lifetime pipe. EOF also arrives after SIGKILL or
// a crash, so its test launcher cannot outlive it and interfere with a reopen.
import { spawn } from "node:child_process";

const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error("Missing owned command");
const child = spawn(executable, args, { stdio: ["ignore", "inherit", "inherit"] });
let stopping = false,
  escalation;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill();
  escalation = setTimeout(() => child.kill("SIGKILL"), 1500);
}
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code) => {
  clearTimeout(escalation);
  process.exit(stopping ? 0 : (code ?? 1));
});
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
