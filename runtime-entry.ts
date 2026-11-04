// Explicit subcommands keep compiled executables from relaunching the server
// when they need the child-process lifetime supervisor.
if (process.argv[2] === "--runtime-info") {
  console.log(JSON.stringify({ runtime: "bun", version: Bun.version }));
} else if (process.argv[2] === "--owned-command") {
  const { runOwnedCommand } = await import("./scripts/owned-process.mjs");
  runOwnedCommand(process.argv.slice(3));
} else if (process.argv[2] === "--run-device-helper") {
  const { helperCommand } = await import("./helper-launch.mjs");
  const { runOwnedCommand } = await import("./scripts/owned-process.mjs");
  runOwnedCommand(helperCommand(process.env.UDID), false);
} else {
  await import("./iportal.mjs");
}
