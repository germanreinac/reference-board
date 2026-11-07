// How well a picture matches a palette of colours, from 0 (not at all) to 1.
//
// The picture is shrunk to 24×24 pixels. Colours are compared the way eyes see
// them (in "Lab" colour space, where equal distances look equally different).
// A picture scores well when:
//   - each palette colour covers a fair part of it, and
//   - not much of it is in colours that aren't in the palette.

const SIZE = 24;
const NEAR = 24;   // Lab distance that counts as "that colour"

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToLab([r, g, b]) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Score from a picture's pixels (RGBA bytes).
export function paletteScore(pixels, palette) {
  const pal = palette.map((h) => rgbToLab(hexToRgb(h)));
  const cover = pal.map(() => 0);
  let off = 0, n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    n++;
    const lab = rgbToLab([pixels[i], pixels[i + 1], pixels[i + 2]]);
    let best = Infinity, bi = 0;
    pal.forEach((p, j) => { const d = dist(lab, p); if (d < best) { best = d; bi = j; } });
    if (best < NEAR) cover[bi]++;
    else if (best > NEAR * 1.8) off++;
  }
  if (!n) return 0;
  // Each colour counts up to about a fifth of the picture; square root so a little goes a long way.
  const each = cover.map((c) => Math.min(1, Math.sqrt(c / n / 0.2)));
  const mean = each.reduce((a, b) => a + b, 0) / each.length;
  return 0.7 * mean + 0.3 * (1 - off / n);
}

// Score a picture at a web address. null when it can't be read (some sites don't allow it).
export async function scoreUrl(url, palette, signal) {
  try {
    const res = await fetch(url, { mode: 'cors', signal });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const g = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, SIZE, SIZE);
    bitmap.close?.();
    return paletteScore(g.getImageData(0, 0, SIZE, SIZE).data, palette);
  } catch {
    return null;
  }
}

// Score many results, a few at a time. Calls progress(done, total) as it goes.
export async function scoreAll(results, palette, { signal, progress = () => {} } = {}) {
  const scores = new Map();
  let next = 0, done = 0;
  const worker = async () => {
    while (next < results.length && !signal?.aborted) {
      const r = results[next++];
      scores.set(r, await scoreUrl(r.thumb, palette, signal));
      progress(++done, results.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return scores;
}
