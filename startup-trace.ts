import { observability } from "./observability.ts";

// Callback boundary for native/process startup milestones. Effect owns the log
// level, structured output and bounded diagnostic history.
export function startupTrace(
  event: string,
  fields: Record<string, string | number | boolean> = {},
) {
  observability.event(event, fields);
}
