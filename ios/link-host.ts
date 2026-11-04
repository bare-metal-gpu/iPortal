/** Add the embedded UI dependency using only unused Mach-O header padding. */
export function linkHost(input: Uint8Array, library: string): Buffer {
  const data = Buffer.from(input);
  if (data.length >= 28 && data.readUInt32BE(0) === 0xcafebabe) {
    const count = data.readUInt32BE(4),
      cpu = data.readUInt32BE(8);
    const offset = data.readUInt32BE(16),
      size = data.readUInt32BE(20);
    if (count !== 1 || cpu !== 0x100000c || offset < 28 || offset + size > data.length)
      throw new Error("Expected a single arm64 slice in the universal host");
    linkHost(data.subarray(offset, offset + size), library).copy(data, offset);
    return data;
  }
  if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error("Expected a thin 64-bit Mach-O host");
  if (data.readUInt32LE(4) !== 0x100000c || data.readUInt32LE(12) !== 2)
    throw new Error("Expected an arm64 executable host");
  const count = data.readUInt32LE(16),
    size = data.readUInt32LE(20),
    end = 32 + size;
  if (end > data.length) throw new Error("Invalid load-command size");
  let offset = 32,
    firstSection = data.length;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error("Invalid load command");
    const command = data.readUInt32LE(offset),
      length = data.readUInt32LE(offset + 4);
    if (length < 8 || length % 8 || offset + length > end) throw new Error("Invalid load command");
    if (command === 0xc) {
      if (length < 24) throw new Error("Invalid library command");
      const nameOffset = data.readUInt32LE(offset + 8);
      if (nameOffset < 24 || nameOffset >= length) throw new Error("Invalid library name");
      if (
        data
          .subarray(offset + nameOffset, offset + length)
          .toString()
          .split("\0")[0] === library
      )
        return data;
    }
    if (command === 0x19) {
      if (length < 72) throw new Error("Invalid segment");
      const sections = data.readUInt32LE(offset + 64);
      if (72 + sections * 80 > length) throw new Error("Invalid segment");
      for (let section = 0; section < sections; section++) {
        const fileOffset = data.readUInt32LE(offset + 72 + section * 80 + 48);
        if (fileOffset) firstSection = Math.min(firstSection, fileOffset);
      }
    }
    offset += length;
  }
  if (offset !== end) throw new Error("Load-command count mismatch");
  const name = Buffer.from(library + "\0"),
    length = Math.ceil((24 + name.length) / 8) * 8;
  if (end + length > firstSection || data.subarray(end, end + length).some((byte) => byte !== 0))
    throw new Error("No unused header padding for iPortal UI; unsupported Xcode host");
  const command = Buffer.alloc(length);
  [0xc, length, 24, 0, 0x10000, 0x10000].forEach((value, index) =>
    command.writeUInt32LE(value, index * 4),
  );
  name.copy(command, 24);
  command.copy(data, end);
  data.writeUInt32LE(count + 1, 16);
  data.writeUInt32LE(size + length, 20);
  return data;
}

if (import.meta.main) {
  const host = process.argv[2];
  if (!host) throw new Error("Usage: link-host.ts <executable>");
  await Bun.write(
    host,
    linkHost(
      await Bun.file(host).bytes(),
      "@executable_path/Frameworks/iPortalUI.framework/iPortalUI",
    ),
  );
}
