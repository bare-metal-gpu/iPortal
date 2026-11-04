// Explicit subcommands keep compiled executables from relaunching the server
// when they need the child-process lifetime supervisor.
if (process.argv[2] === "--runtime-info") {
  console.log(JSON.stringify({ runtime: "bun", version: Bun.version }));
} else if (process.argv[2] === "--owned-command") {
  const { runOwnedCommand } = await import("./scripts/owned-process.mjs");
  runOwnedCommand(process.argv.slice(3));
} else if (process.argv[2] === "--run-device-helper") {
  const { helperCommand } = await import("./helper-launch.mjs");
  const { createHelperAuthentication } = await import("./helper-auth.mjs");
  const { runOwnedCommand } = await import("./scripts/owned-process.mjs");
  // This developer-only entry point must share a credential with its server.
  // The normal app provisions both ends automatically in maybeStartWda.
  if (!process.env.IPORTAL_HELPER_TOKEN)
    throw new Error("Set IPORTAL_HELPER_TOKEN in both the helper and server environments.");
  Object.assign(process.env, createHelperAuthentication().runnerEnvironment);
  runOwnedCommand(helperCommand(process.env.UDID), false);
} else {
  await import("./iportal.mjs");
}
