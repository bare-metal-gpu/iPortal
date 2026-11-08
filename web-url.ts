// Restrict navigation to web links. Reject parser repairs (whitespace,
// backslashes, malformed escapes) and embedded credentials on both boundaries.
// Unicode links remain usable through their standard percent/IDNA encoding.
export function validWebURL(value: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes("\\") || /%(?![\da-f]{2})/i.test(value))
    return false;
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || !/^(?:\[[\da-f:.]+\]|[a-z\d._-]+)(?::\d+)?$/i.test(authority)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password &&
      (!url.port || (Number(url.port) >= 1 && Number(url.port) <= 65535))
    );
  } catch {
    return false;
  }
}
