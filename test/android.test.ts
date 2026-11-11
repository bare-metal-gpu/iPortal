import { expect, test } from "bun:test";
import net from "node:net";
import { Schema } from "effect";
import {
  createAdb,
  locateAdb,
  parseDevices,
  parseMdns,
  serialFromTransport,
} from "../android/adb.mjs";
import { attachmentProblem, selectAndroidDevice } from "../android/devices.mjs";
import {
  AndroidRequestSchemas,
  androidHelperProtocol,
  androidOperations,
  parseAndroidRequest,
  validateAndroidResponse,
} from "../android/protocol.ts";
import { RequestSchemas } from "../schemas.ts";
import { helperOperations, iosHelperProtocol } from "../helper-protocol.ts";
import { validatePublicResponse } from "../responses.ts";

const listing =
  "25271JEGR16740         device usb:1048576X product:bluejay model:Pixel_6a device:bluejay transport_id:18\n" +
  "192.168.2.72:41811     device product:bluejay model:Pixel_6a device:bluejay transport_id:19\n" +
  "ABC123                 unauthorized usb:1048577X transport_id:20\n";

test("parses the adb device list", () => {
  expect(parseDevices(listing)).toEqual([
    { id: "25271JEGR16740", state: "device", usb: true, model: "Pixel 6a" },
    { id: "192.168.2.72:41811", state: "device", usb: false, model: "Pixel 6a" },
    { id: "ABC123", state: "unauthorized", usb: true, model: null },
  ]);
  expect(parseDevices("")).toEqual([]);
});

test("reads a hardware serial only from transports that carry one", () => {
  expect(serialFromTransport("25271JEGR16740", true)).toBe("25271JEGR16740");
  expect(serialFromTransport("adb-25271JEGR16740-ctLGh8._adb-tls-connect._tcp", false)).toBe(
    "25271JEGR16740",
  );
  expect(serialFromTransport("192.168.2.72:41811", false)).toBeNull();
  expect(serialFromTransport("emulator-5554", false)).toBeNull();
});

test("parses advertised wireless debugging services", () => {
  const output =
    "List of discovered mdns services\n" +
    "adb-25271JEGR16740-ctLGh8\t_adb-tls-connect._tcp\t192.168.2.72:41811\n" +
    "adb-OTHER-xyz\t_adb-tls-pairing._tcp\t192.168.2.80:40000\n";
  expect(parseMdns(output)).toEqual([{ serial: "25271JEGR16740", address: "192.168.2.72:41811" }]);
});

test("locates adb from the environment before well-known folders", () => {
  const exists = (file: string) => file === "/sdk/platform-tools/adb" || file === "/custom/adb";
  expect(locateAdb({ PATH: "/usr/bin", ANDROID_HOME: "/sdk" }, exists)).toBe(
    "/sdk/platform-tools/adb",
  );
  expect(locateAdb({ ADB: "/custom/adb", ANDROID_HOME: "/sdk" }, exists)).toBe("/custom/adb");
  expect(locateAdb({ PATH: "" }, () => false)).toBeNull();
});

const usb = {
  id: "25271JEGR16740",
  udid: "25271JEGR16740",
  connection: "USB",
  transport: "usb",
  model: "Pixel 6a",
} as const;
const wifi = {
  ...usb,
  id: "192.168.2.72:41811",
  connection: "Network",
  transport: "wifi",
} as const;
const other = { ...usb, id: "OTHER", udid: "OTHER" } as const;

test("one phone on two transports is one device, preferring USB", () => {
  expect(selectAndroidDevice([wifi, usb], null)).toBe(usb);
  expect(selectAndroidDevice([wifi], "25271JEGR16740")).toBe(wifi);
  // Losing the pinned phone never selects another one.
  expect(selectAndroidDevice([other], "25271JEGR16740")).toBeNull();
  expect(selectAndroidDevice([], null)).toBeNull();
});

test("explains an attached device that cannot be used yet", () => {
  expect(attachmentProblem(parseDevices(listing))).toContain("Allow");
  expect(attachmentProblem([{ id: "x", state: "offline", usb: true, model: null }])).toContain(
    "Reconnect",
  );
  expect(attachmentProblem([])).toBeNull();
});

test("Android keeps its own vocabulary and the iPhone's is unchanged", () => {
  const decode = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  // Android: resource IDs and text, class names as types, a Back button, no Siri.
  expect(() =>
    decode(androidOperations.elements.request, { using: "text", value: "OK" }),
  ).not.toThrow();
  expect(() =>
    decode(androidOperations.elements.request, { using: "predicate string", value: "x" }),
  ).toThrow();
  expect(() => decode(androidOperations.button.request, { name: "back" })).not.toThrow();
  expect("siri" in androidOperations).toBe(false);
  expect(Object.hasOwn(AndroidRequestSchemas, "siri")).toBe(false);
  expect(() => parseAndroidRequest("button", { name: "back" })).not.toThrow();
  expect(() => parseAndroidRequest("siri", { text: "hello" })).toThrow();
  expect(
    androidHelperProtocol.decodeResult(
      "attribute",
      { id: "a1", name: "type" },
      "android.widget.Button",
    ),
  ).toBe("android.widget.Button");
  expect(() =>
    androidHelperProtocol.decodeResult("attribute", { id: "a1", name: "type" }, "not a class"),
  ).toThrow();

  // iPhone: exactly as before.
  expect(() =>
    decode(helperOperations.elements.request, { using: "predicate string", value: "x" }),
  ).not.toThrow();
  expect(() => decode(helperOperations.elements.request, { using: "text", value: "OK" })).toThrow();
  expect(() => decode(helperOperations.button.request, { name: "back" })).toThrow();
  expect(() => decode(RequestSchemas.button, { name: "back" })).toThrow();
  expect(Object.hasOwn(RequestSchemas, "siri")).toBe(true);
  expect(() =>
    iosHelperProtocol.decodeResult(
      "attribute",
      { id: "e1", name: "type" },
      "android.widget.Button",
    ),
  ).toThrow();
  expect(
    iosHelperProtocol.decodeResult(
      "attribute",
      { id: "e1", name: "type" },
      "XCUIElementTypeButton",
    ),
  ).toBe("XCUIElementTypeButton");
});

test("public responses are validated against the platform that produced them", () => {
  const element = (type: string) => ({ ok: true, value: { id: "1", type } });
  expect(() => validateAndroidResponse("element", element("android.widget.Button"))).not.toThrow();
  expect(() => validatePublicResponse("element", element("android.widget.Button"))).toThrow();
  expect(() => validatePublicResponse("element", element("XCUIElementTypeButton"))).not.toThrow();
});

// A stand-in for the adb server's local socket protocol.
async function fakeAdb(handle: (service: string, socket: net.Socket) => void) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = parseInt(buffer.subarray(0, 4).toString(), 16);
        if (Number.isNaN(length) || buffer.length < 4 + length) return;
        const service = buffer.subarray(4, 4 + length).toString();
        buffer = buffer.subarray(4 + length);
        handle(service, socket);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => server.close() };
}
const framed = (payload: string) => payload.length.toString(16).padStart(4, "0") + payload;

test("talks to the adb server: list, track and tunnel", async () => {
  const seen: string[] = [];
  const server = await fakeAdb((service, socket) => {
    seen.push(service);
    if (service === "host:devices-l") socket.end("OKAY" + framed(listing));
    else if (service === "host:track-devices-l") socket.write("OKAY" + framed(listing));
    else if (service === "host:transport:25271JEGR16740") socket.write("OKAY");
    else if (service === "localabstract:iportal_test") socket.write("OKAYhello from the device");
    else socket.end("FAIL" + framed("device offline"));
  });
  try {
    const adb = createAdb({ executable: null, port: server.port });
    expect(adb.available).toBe(false);
    expect((await adb.devices()).map((device) => device.id)).toEqual([
      "25271JEGR16740",
      "192.168.2.72:41811",
      "ABC123",
    ]);

    const tracked = await new Promise<number>((resolve) => {
      const stop = adb.track(
        (devices) => {
          stop();
          resolve(devices.length);
        },
        () => {},
      );
    });
    expect(tracked).toBe(3);

    // Bytes after the handshake belong to the tunnel, not to the handshake.
    const tunnel = await adb.connect("25271JEGR16740", "localabstract:iportal_test");
    const received = await new Promise<string>((resolve) => {
      let text = "";
      tunnel.on("data", (chunk) => {
        text += chunk;
        if (text.length >= "hello from the device".length) resolve(text);
      });
      tunnel.resume();
    });
    tunnel.destroy();
    expect(received).toBe("hello from the device");
    const refused = await adb.connect("MISSING", "localabstract:iportal_test").then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused).toBe("device offline");
    expect(seen).toContain("host:transport:25271JEGR16740");
  } finally {
    server.close();
  }
});
