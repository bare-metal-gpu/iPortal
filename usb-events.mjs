import net from 'node:net';

const value = (xml, key) => xml.match(new RegExp(`<key>${key}</key>\\s*<(?:integer|string)>([^<]*)<`))?.[1];

// Listen is usbmuxd's persistent attach/detach channel. ListDevices is used
// only to seed/reconcile the cache, or while the subscription is unavailable.
export function createUSBMonitor({ address, list, onChange, retryMs = 1000, reconcileMs = 30000 }) {
  let socket, retry, watchdog, stopped = false, listening = false, seeded = false;
  let revision = 0, devices = [], refreshing;
  function replace(next) {
    const changed = JSON.stringify(next) !== JSON.stringify(devices);
    devices = next;
    if (changed) onChange(devices);
  }
  function refresh() {
    return refreshing ??= (async () => {
      const before = revision;
      const next = await list();
      if (!stopped && before === revision) { seeded = true; replace(next); }
      return devices;
    })().finally(() => { refreshing = undefined; });
  }
  function connect() {
    if (stopped) return;
    let buffer = Buffer.alloc(0);
    const s = socket = net.connect(address);
    const handshake = setTimeout(() => s.destroy(), 2000);
    handshake.unref?.();
    s.on('connect', () => {
      const body = Buffer.from('<plist version="1.0"><dict><key>MessageType</key><string>Listen</string><key>ProgName</key><string>iphone-mirror</string><key>ClientVersionString</key><string>iphone-mirror</string></dict></plist>');
      const header = Buffer.alloc(16);
      header.writeUInt32LE(body.length + 16); header.writeUInt32LE(1, 4); header.writeUInt32LE(8, 8); header.writeUInt32LE(1, 12);
      s.write(Buffer.concat([header, body]));
    });
    s.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 16) {
        const length = buffer.readUInt32LE(0);
        if (length < 16 || length > 1024 * 1024) return s.destroy();
        if (buffer.length < length) return;
        const xml = buffer.subarray(16, length).toString();
        buffer = buffer.subarray(length);
        const type = value(xml, 'MessageType');
        if (type === 'Result') {
          if (value(xml, 'Number') !== '0') return s.destroy();
          clearTimeout(handshake); listening = true;
          void refresh().catch(() => {});
        } else if (type === 'Attached' || type === 'Detached') {
          const id = Number(value(xml, 'DeviceID'));
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          revision++;
          const next = devices.filter(d => d.id !== id);
          if (type === 'Attached') {
            const udid = value(xml, 'SerialNumber'), connection = value(xml, 'ConnectionType');
            if (!udid || !connection) continue;
            next.push({ id, udid, connection });
          }
          replace(next);
        }
      }
    });
    s.on('error', () => {});
    s.on('close', () => {
      clearTimeout(handshake); listening = false; seeded = false; revision++;
      if (stopped) return;
      void refresh().catch(() => replace([]));
      retry = setTimeout(connect, retryMs); retry.unref?.();
    });
  }
  connect();
  watchdog = setInterval(() => { void refresh().catch(() => { if (!listening) replace([]); }); }, reconcileMs);
  watchdog.unref?.();
  return {
    async devices() { return listening && seeded ? devices : refresh(); },
    stop() { stopped = true; clearTimeout(retry); clearInterval(watchdog); socket?.destroy(); },
  };
}
