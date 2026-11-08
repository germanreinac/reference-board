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

// ---------- Pane outlines: a liquid surface ----------
//
// The space between panes behaves like one liquid surface. Every point on screen has a
// small sideways push (`push`), so both sides of a gap bend together, like a stream:
//   - at rest, slow gentle waves flow along the gaps, so no edge is ever ruler-straight
//   - things that happen (splitting, closing, dragging a divider) drop "ripples" that
//     spread out in rings from where they happened, and fade
// Corners are rounded and the waves fade out towards them, so corners stay put.

export const CORNER = 16;   // how round pane corners are (pixels)
const CALM = 2.4;           // how far edges sway at rest (pixels)

const ripples = [];         // { x, y, amp, start }

// Drop a ripple at (x, y) on screen. `amp` is how strong (pixels).
export function ripple(x, y, amp = 6) {
  if (!motionOn()) return;
  ripples.push({ x, y, amp, start: performance.now() });
  if (ripples.length > 40) ripples.splice(0, ripples.length - 40);
}

// Are there ripples still spreading?
export function rippling(now = performance.now()) {
  for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].start > 1600) ripples.splice(i, 1);
  return ripples.length > 0;
}

// How far the liquid pushes a point sideways: along x for upright edges (axis 'x'),
// along y for flat edges (axis 'y'). `t` is in seconds.
export function push(axis, x, y, t, now) {
  let d;
  if (axis === 'x') {
    d = CALM * (0.6 * Math.sin(0.011 * y + 0.004 * x + 0.8 * t) + 0.4 * Math.sin(0.027 * y - 0.009 * x - 1.25 * t + 1.3));
  } else {
    d = CALM * (0.6 * Math.sin(0.010 * x + 0.005 * y + 0.7 * t + 2.1) + 0.4 * Math.sin(0.024 * x - 0.008 * y - 1.1 * t));
  }
  for (const r of ripples) {
    const tt = (now - r.start) / 1000;
    if (tt < 0) continue;
    const dist = Math.hypot(x - r.x, y - r.y);
    // A ring moving outward (about 260 px a second), fading with time and distance.
    d += r.amp * Math.exp(-2.6 * tt) * Math.exp(-dist / 520) * Math.sin(0.03 * dist - 7.8 * tt);
  }
  return d;
}

// The outline of a pane as an SVG path: a rounded rectangle whose sides follow the
// liquid. `t` (seconds) and `now` (ms) say where the waves are; motion off = still waves.
export function paneOutline({ x, y, w, h }, t = 0, now = 0) {
  const R = Math.min(CORNER, w / 2, h / 2);
  const k = R * 0.2;
  const pts = [];
  // A side from (ax, ay) to (bx, by). Upright sides move along x, flat sides along y.
  const side = (ax, ay, bx, by, axis) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.min(40, Math.round(len / 22)));
    for (let s = 1; s <= n; s++) {
      const u = s / n;
      const px = ax + (bx - ax) * u, py = ay + (by - ay) * u;
      // Fade the waves out over the last bit before each corner, so corners stay put.
      const edgeDist = Math.min(u, 1 - u) * len;
      const fade = Math.min(1, edgeDist / 40);
      const d = push(axis, px, py, t, now) * fade;
      pts.push(axis === 'x' ? `L${(px + d).toFixed(1)} ${py.toFixed(1)}` : `L${px.toFixed(1)} ${(py + d).toFixed(1)}`);
    }
  };
  pts.push(`M${x + R} ${y}`);
  side(x + R, y, x + w - R, y, 'y');                                       // top
  pts.push(`C${x + w - k} ${y} ${x + w} ${y + k} ${x + w} ${y + R}`);
  side(x + w, y + R, x + w, y + h - R, 'x');                               // right
  pts.push(`C${x + w} ${y + h - k} ${x + w - k} ${y + h} ${x + w - R} ${y + h}`);
  side(x + w - R, y + h, x + R, y + h, 'y');                               // bottom
  pts.push(`C${x + k} ${y + h} ${x} ${y + h - k} ${x} ${y + h - R}`);
  side(x, y + h - R, x, y + R, 'x');                                       // left
  pts.push(`C${x} ${y + k} ${x + k} ${y} ${x + R} ${y}Z`);
  return pts.join('');
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
