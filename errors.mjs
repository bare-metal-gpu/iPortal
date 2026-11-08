/** @param {string} message */
export function apiError(message, status = 400, code = "invalid argument") {
  return Object.assign(new Error(message), { status, code });
}

/** Normalize unknown failures without trusting arbitrary metadata types.
 * @param {unknown} value */
export function errorInfo(value) {
  const object = value !== null && typeof value === "object" ? value : {};
  const message =
    "message" in object && typeof object.message === "string" ? object.message : String(value);
  return {
    message,
    name: "name" in object && typeof object.name === "string" ? object.name : "Error",
    code: "code" in object && typeof object.code === "string" ? object.code : undefined,
    status:
      "status" in object &&
      typeof object.status === "number" &&
      Number.isInteger(object.status) &&
      object.status >= 400 &&
      object.status <= 599
        ? object.status
        : undefined,
    outcome:
      "outcome" in object && ["notExecuted", "unknown"].includes(String(object.outcome))
        ? String(object.outcome)
        : undefined,
    details: "details" in object ? object.details : undefined,
    _tag: "_tag" in object && typeof object._tag === "string" ? object._tag : undefined,
  };
}
