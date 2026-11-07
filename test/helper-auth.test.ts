import { test, expect } from "bun:test";
import { createHelperAuthentication, createSecretRedactor } from "../helper-auth.mjs";

test("helper credentials are private, unique, validated and never silently downgraded", () => {
  const first = createHelperAuthentication(),
    second = createHelperAuthentication();
  expect(first.headers.authorization).not.toBe(second.headers.authorization);
  expect(first.headers.authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
  expect(first.verified).toBe(false);
  expect(() => createHelperAuthentication("")).toThrow();
  expect(() => createHelperAuthentication("bad\ncredential")).toThrow();
  expect(() => first.verify(new Response("{}"))).toThrow();
  expect(() =>
    first.verify(new Response("", { status: 401, headers: { "x-iportal-helper-auth": "1" } })),
  ).toThrow();
  first.verify(new Response("{}", { headers: { "x-iportal-helper-auth": "1" } }));
  expect(first.verified).toBe(true);
  first.reset();
  expect(first.verified).toBe(false);
});

test("helper launch logging redacts credentials across every chunk boundary", () => {
  const token = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");
  const source = Buffer.from(`launch café 🙂\nTOKEN=${token}\nTOKEN=${token}`);
  for (let split = 0; split <= source.length; split++) {
    const redactor = createSecretRedactor(token);
    const output =
      redactor.write(source.subarray(0, split)) +
      redactor.write(source.subarray(split)) +
      redactor.end();
    expect(output).toBe("launch café 🙂\nTOKEN=[redacted]\nTOKEN=[redacted]");
  }
});
