import type { HelperCommandCall } from "../helper-client.ts";
import { decodeHelper, helperOperations } from "../helper-protocol.ts";
// This function is compile-only: errors must remain errors as contracts evolve.
export async function checkHelperTypes(command: HelperCommandCall) {
  // @ts-expect-error Unknown operation.
  await command("not-an-operation");
  // @ts-expect-error Text must be a string.
  await command("text", { text: 42 });
  // @ts-expect-error Required arguments cannot be omitted.
  await command("text");
  // @ts-expect-error Wrong result type.
  const locked: boolean = await command("state");
  // @ts-expect-error Runtime decoders must preserve result types.
  const decoded: boolean = decodeHelper(helperOperations.state.result, {});
  // @ts-expect-error Attribute result depends on the requested name.
  const enabled: string = await command("attribute", { id: "a", name: "enabled" });
  // @ts-expect-error JSON source is a normalized tree, not a string.
  const source: string = await command("source", { format: "json" });
  return { locked, decoded, enabled, source };
}
