// Two simultaneous normalized paths in the current interface orientation.
// Keep the requested scale ratio even when the cursor is near a screen edge.
export function pinchPaths({ x, y, scale, durationMs = 240 }) {
  const radius = 0.25;
  const cx = Math.max(radius + 0.005, Math.min(0.995 - radius, x));
  const cy = Math.max(0.005, Math.min(0.995, y));
  const start = scale >= 1 ? radius / scale : radius;
  const end = scale >= 1 ? radius : radius * scale;
  const steps = 8;
  const fingers = [-1, 1].map(direction => [
    [cx + direction * start, cy, 0], [cx + direction * start, cy, 40],
    ...Array.from({ length: steps }, (_, i) => [
      cx + direction * (start + (end - start) * (i + 1) / steps), cy, 40 + Math.round((i + 1) * durationMs / steps),
    ]),
  ]);
  return { fingers, end: durationMs + 40 };
}

export function pinchActions(body, { width, height }) {
  if (![width, height].every(n => Number.isFinite(n) && n >= 40)) throw new Error("Invalid screen dimensions");
  const at = ([x, y]) => ({ x: Math.round(x * (width - 1)), y: Math.round(y * (height - 1)) });
  return pinchPaths(body).fingers.map((points, index) => ({
    type: "pointer", id: `pinch-finger-${index + 1}`, parameters: { pointerType: "touch" },
    actions: [
      { type: "pointerMove", duration: 0, origin: "viewport", ...at(points[0]) },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 40 },
      ...points.slice(2).map((point, i) => ({
        type: "pointerMove", origin: "viewport",
        duration: point[2] - points[i + 1][2], ...at(point),
      })),
      { type: "pointerUp", button: 0 },
    ],
  }));
}
