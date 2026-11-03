/** @param {string} message */
export function apiError(message, status = 400, code = "invalid argument") {
  return Object.assign(new Error(message), { status, code });
}
