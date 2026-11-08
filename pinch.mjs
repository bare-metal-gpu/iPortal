// Two simultaneous normalized paths in the current interface orientation.
// Keep the requested scale ratio even when the cursor is near a screen edge.
/** @param {{x:number,y:number,scale:number,durationMs?:number}} input
 * @returns {{fingers:[number,number,number][][],end:number}} */
export function pinchPaths({ x, y, scale, durationMs = 240 }) {
  const radius = 0.25;
  const cx = Math.max(radius + 0.005, Math.min(0.995 - radius, x));
  const cy = Math.max(0.005, Math.min(0.995, y));
  const start = scale >= 1 ? radius / scale : radius;
  const end = scale >= 1 ? radius : radius * scale;
  const steps = 8;
  const fingers = [-1, 1].map(
    (direction) =>
      /** @type {[number,number,number][]} */ ([
        [cx + direction * start, cy, 0],
        [cx + direction * start, cy, 40],
        ...Array.from({ length: steps }, (_, i) => [
          cx + direction * (start + ((end - start) * (i + 1)) / steps),
          cy,
          40 + Math.round(((i + 1) * durationMs) / steps),
        ]),
      ]),
  );
  return { fingers, end: durationMs + 40 };
}
