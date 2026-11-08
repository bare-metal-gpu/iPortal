import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { apiError } from "./errors.mjs";

export function createHelperAuthentication(
  token = process.env.IPORTAL_HELPER_TOKEN ?? randomBytes(32).toString("hex"),
) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid helper credential configuration");
  let verified = false;
  return {
    headers: { authorization: `Bearer ${token}` },
    runnerEnvironment: { TEST_RUNNER_IPORTAL_HELPER_TOKEN: token },
    get verified() {
      return verified;
    },
    reset() {
      verified = false;
    },
    /** @param {Pick<Response, 'status'|'headers'>} response */
    verify(response) {
      if (response.status === 401 || response.headers.get("x-iportal-helper-auth") !== "1") {
        verified = false;
        throw apiError(
          "Helper connection is not authenticated",
          503,
          "helper authentication failed",
        );
      }
      verified = true;
    },
    redactor: () => createSecretRedactor(token),
  };
}

// Xcode can echo launch environment variables. Redact before persistence,
// including when a credential or UTF-8 character is split across pipe chunks.
/** @param {string} secret */
export function createSecretRedactor(secret) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  /** @param {boolean} final */
  const take = (final) => {
    buffer = buffer.replaceAll(secret, "[redacted]");
    const count = final
      ? buffer.length
      : Math.max(buffer.lastIndexOf("\n") + 1, buffer.length - secret.length + 1, 0);
    const text = buffer.slice(0, count);
    buffer = buffer.slice(count);
    return text;
  };
  return {
    /** @param {Buffer|string} chunk */
    write(chunk) {
      buffer += decoder.write(chunk);
      return take(false);
    },
    end() {
      buffer += decoder.end();
      return take(true);
    },
  };
}
