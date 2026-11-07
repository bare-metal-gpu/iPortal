import type { HelperCommandCall } from "../helper-client.ts";
import type { HelperOperation } from "../helper-protocol.ts";
// Test-only escape hatch for deliberately incomplete or malformed helper data.
// Production calls always cross the typed client and its runtime decoders.
export function stubCommand(
  implementation: (operation: HelperOperation, args?: unknown) => Promise<unknown>,
): HelperCommandCall {
  return implementation as HelperCommandCall;
}
