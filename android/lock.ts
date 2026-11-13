// What a locked Android phone admits. Android mirrors its lock screen and
// accepts injected input on it, so the owner can unlock the phone from the Mac.
// The iPhone path is different and unchanged: a locked iPhone admits nothing.
//
// Three things follow from "the lock screen is usable":
//
// - Lifecycle. `locked` is always reported truthfully. `lifecycle` is `ready`
//   while the keyguard is showing with the screen on, and `locked` only while
//   the screen is off, when there is nothing to see or touch until it is woken.
//   This needs no new lifecycle value, so the shared schemas, the page and the
//   Mac app's lifecycle handling are untouched.
// - Admission. Touch, typing and keys are let through. Reading the lock screen
//   through the API (tree, elements, screenshots, observations), acting on its
//   elements, starting apps, opening links and the clipboard stay refused.
// - Secrets. What is typed or drawn on a lock screen is a PIN, a password or a
//   pattern. Its content must not be recoverable from anything iPortal keeps.
import { apiError } from "../errors.mjs";
import type { createCommands } from "../commands.ts";

/** Requests refused while the keyguard is showing, whatever the screen state. */
const refusedWhileLocked = new Set([
  "launch",
  "open-url",
  "tap",
  "element-action",
  "elements",
  "element",
  "source",
  "screenshot",
  "observe",
  "wait",
  "clipboard-read",
  "clipboard-write",
]);

/** Whether a request may run while the keyguard is showing. */
export function admittedWhileLocked(name: string, body: unknown): boolean {
  if (refusedWhileLocked.has(name)) return false;
  if (!body || typeof body !== "object") return true;
  // Typing into a chosen element first reads the lock screen to find it, and a
  // postcondition reads it afterwards.
  if (name === "type" && ("id" in body || "selector" in body)) return false;
  return !("waitFor" in body) && !("observationId" in body);
}

export const lockedError = () => apiError("Unlock your Android device", 409, "device locked");

/**
 * @param locked whether the keyguard is showing; null when unknown
 * @param interactive whether the screen is on; null when unknown
 */
export function androidLifecycle({
  device,
  up,
  locked,
  interactive,
}: {
  device: boolean;
  up: boolean;
  locked: boolean | null;
  interactive: boolean | null;
}): "ready" | "locked" | "connecting" | "disconnected" {
  if (!device) return "disconnected";
  if (!up || locked === null) return "connecting";
  if (!locked) return "ready";
  // An unknown screen state is treated as off: showing "locked" when the lock
  // screen was in fact usable costs a click on Wake, not a wrong tap.
  return interactive === true ? "ready" : "locked";
}

/** Input whose payload is the secret itself when it is sent to a lock screen. */
const secretInput = new Set(["type", "key", "gesture", "pinch"]);

type Ledger = Pick<ReturnType<typeof createCommands>, "execute" | "get">;

/**
 * A command ledger that keeps no trace of what was sent to a lock screen.
 *
 * A receipt stores a hash of the request so that a retried request ID can be
 * told from a reused one. A hash protects a long text; it does not protect a
 * four-digit PIN, which is found by hashing ten thousand candidates. So for
 * input sent while the phone is locked, or while its lock state is not known,
 * the payload is left out of the hash altogether. The receipt still records
 * the request ID and outcome, and still refuses to run the same ID twice.
 *
 * @param locked asks the device now; a cached answer could be a moment old
 */
export function privateLedger(ledger: Ledger, locked: () => Promise<boolean | null>): Ledger {
  return {
    get: ledger.get,
    async execute(id, input, run) {
      const name = input && typeof input === "object" && "name" in input ? String(input.name) : "";
      if (!secretInput.has(name)) return ledger.execute(id, input, run);
      const state = await locked().catch(() => null);
      return ledger.execute(id, state === false ? input : { name, locked: true }, run);
    },
  };
}
