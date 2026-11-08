// The "liquid" feel: soft pane corners, springy movement, edges that wobble like water
// for a moment when panes split or close, and a little splash when images land.
//
// Everything here can be switched off (board menu → Liquid motion), and it's off by
// default for anyone whose computer asks for reduced motion.

const KEY = 'refboard.motion';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function motionOn() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  return saved ? saved === 'on' : !reduced();
}

export function setMotion(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
  document.body.dataset.motion = on ? 'on' : 'off';
}
document.body.dataset.motion = motionOn() ? 'on' : 'off';

// A spring from one number to another: it overshoots a little and settles, like
// something with weight. onUpdate(value) runs every frame; onDone() at the end.
// Returns a function that stops it.
export function spring(from, to, onUpdate, { onDone = () => {}, stiffness = 340, damping = 22 } = {}) {
  if (!motionOn()) { onUpdate(to); onDone(); return () => {}; }
  let x = from, v = 0, last = performance.now(), raf = 0, stopped = false;
  const step = (now) => {
    if (stopped) return;
    // Small steps, so it takes the same time even when frames are slow.
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    while (dt > 0) {
      const h = Math.min(dt, 0.008);
      v += (-stiffness * (x - to) - damping * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(x - to) < 0.0006 && Math.abs(v) < 0.01) { onUpdate(to); onDone(); return; }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

// ---------- Pane outlines ----------

export const CORNER = 14;   // how round pane corners are (pixels)

// The outline of a pane as an SVG path: a rounded rectangle with smooth corners.
// `wave(edge, u)` pushes the edge in or out (pixels) at u (0 to 1 along the edge),
// for the water wobble; it's 0 when everything is still.
export function paneOutline({ x, y, w, h }, wave = null) {
  const R = Math.min(CORNER, w / 2, h / 2);
  const k = R * 0.18;  // corner handles close to the corner: smooth, squarish corners
  const pts = [];
  const edge = (i, ax, ay, bx, by, nx, ny) => {
    // A straight run from (ax, ay) to (bx, by), pushed along the normal (nx, ny) by the wave.
    if (!wave) { pts.push(`L${bx.toFixed(1)} ${by.toFixed(1)}`); return; }
    const n = 14;
    for (let s = 1; s <= n; s++) {
      const u = s / n;
      const d = wave(i, u);
      pts.push(`L${(ax + (bx - ax) * u + nx * d).toFixed(1)} ${(ay + (by - ay) * u + ny * d).toFixed(1)}`);
    }
  };
  pts.push(`M${x + R} ${y}`);
  edge(0, x + R, y, x + w - R, y, 0, 1);                                   // top
  pts.push(`C${x + w - k} ${y} ${x + w} ${y + k} ${x + w} ${y + R}`);
  edge(1, x + w, y + R, x + w, y + h - R, -1, 0);                          // right
  pts.push(`C${x + w} ${y + h - k} ${x + w - k} ${y + h} ${x + w - R} ${y + h}`);
  edge(2, x + w - R, y + h, x + R, y + h, 0, -1);                          // bottom
  pts.push(`C${x + k} ${y + h} ${x} ${y + h - k} ${x} ${y + h - R}`);
  edge(3, x, y + h - R, x, y + R, 1, 0);                                   // left
  pts.push(`C${x} ${y + k} ${x + k} ${y} ${x + R} ${y}Z`);
  return pts.join('');
}

// A wobble that started at `start` (ms): how far edges move at time `now`, for a pane.
// Each edge sways in its own way (one or two bulges), dying out in about 0.7 s.
export function wobbleWave(start, now, amp, seed) {
  const t = (now - start) / 1000;
  if (t > 0.9) return null;
  const a = amp * Math.exp(-t * 5.5);
  return (edge, u) => {
    const m = 1 + ((seed + edge) % 2);           // one or two bulges along the edge
    const phase = (seed * 1.7 + edge * 2.3) % 6.28;
    return a * Math.sin(Math.PI * u * m) * Math.cos(2 * Math.PI * 3.1 * t + phase);
  };
}

// The average colour of a picture, for the splash when it lands.
export function averageColour(bitmap) {
  try {
    const g = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, 1, 1);
    const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
    return (r << 16) | (gg << 8) | b;
  } catch {
    return 0x4da3ff;
  }
}
