// Reading PureRef boards (.pur files), so they can be brought into Melti.
//
// PureRef's format isn't published. This follows the layout worked out by
// github.com/FyorDev/PureRef-format (PureRef 1.10 and 1.11), all numbers big-endian:
//
//   header (224 bytes)   version text, item counts, where the picture table starts, the view
//   pictures             one after another: a whole PNG/JPEG file, or 4 bytes saying
//                        "same picture as item #id" (a duplicate)
//   items                images and texts: position, transform, crop, colours
//   folder               a text
//   picture table        for each image item: its id and where its picture starts and ends
//
// Only the small parts (header, items, table) are actually read. The pictures are cut
// straight out of the file as Blobs, so even a board of several gigabytes opens quickly
// and doesn't need to fit in memory.

const IMAGE_ITEM = 'GraphicsImageItem';
const TEXT_ITEM = 'GraphicsTextItem';

export function isPureRefFile(file) {
  return /\.pur$/i.test(file?.name || '');
}

// Reads a bit of the file at a time, keeping one window of it in memory.
class Reader {
  constructor(file) { this.file = file; this.start = 0; this.bytes = new Uint8Array(0); this.view = null; }
  async need(at, n) {
    if (at >= this.start && at + n <= this.start + this.bytes.length) return;
    if (at + n > this.file.size) throw new Error('short');
    const size = Math.max(n, 4 << 20);
    this.start = at;
    this.bytes = new Uint8Array(await this.file.slice(at, Math.min(this.file.size, at + size)).arrayBuffer());
    this.view = new DataView(this.bytes.buffer);
  }
  async u8(at) { await this.need(at, 1); return this.view.getUint8(at - this.start); }
  async u16(at) { await this.need(at, 2); return this.view.getUint16(at - this.start); }
  async u32(at) { await this.need(at, 4); return this.view.getUint32(at - this.start); }
  async i32(at) { await this.need(at, 4); return this.view.getInt32(at - this.start); }
  async u64(at) { await this.need(at, 8); return Number(this.view.getBigUint64(at - this.start)); }
  async f64(at) { await this.need(at, 8); return this.view.getFloat64(at - this.start); }
  async raw(at, n) { await this.need(at, n); return this.bytes.slice(at - this.start, at - this.start + n); }
  // A text: its length in bytes, then UTF-16. Returns [text, next position].
  async str(at) {
    const n = await this.u32(at);
    if (n === 0xffffffff) return [null, at + 4];
    const b = await this.raw(at + 4, n);
    return [new TextDecoder('utf-16be').decode(b), at + 4 + n];
  }
}

// A transform as PureRef keeps it: 3x3, of which the top two rows' first two numbers matter.
async function matrix(r, at) {
  return { m11: await r.f64(at), m12: await r.f64(at + 8), m21: await r.f64(at + 24), m22: await r.f64(at + 32) };
}

const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1 };
const mul = (a, b) => ({   // a after b
  m11: b.m11 * a.m11 + b.m12 * a.m21, m12: b.m11 * a.m12 + b.m12 * a.m22,
  m21: b.m21 * a.m11 + b.m22 * a.m21, m22: b.m21 * a.m12 + b.m22 * a.m22,
});
const apply = (m, x, y) => ({ x: m.m11 * x + m.m21 * y, y: m.m12 * x + m.m22 * y });

// Turn a transform into Melti's scale + rotation (a flip is a negative scaleY).
function decompose(m) {
  const sx = Math.hypot(m.m11, m.m12) || 1;
  const rotation = Math.atan2(m.m12, m.m11);
  const det = m.m11 * m.m22 - m.m12 * m.m21;
  const sy = det / sx || sx;
  // A flipped picture reads as "flipped left-right", not "upside down and turned half round".
  if (sy < 0 && Math.abs(rotation) > Math.PI / 2) return { scaleX: -sx, scaleY: -sy, rotation: rotation > 0 ? rotation - Math.PI : rotation + Math.PI };
  return { scaleX: sx, scaleY: sy, rotation };
}

// A colour: a byte saying how it's written (1 RGB, 2 HSV), alpha, then three 16-bit numbers.
async function colour(r, at) {
  const spec = await r.u8(at);
  const a = (await r.u16(at + 1)) / 65535;
  let c = [await r.u16(at + 3), await r.u16(at + 5), await r.u16(at + 7)].map((v) => v / 65535);
  if (spec === 2) {   // HSV (hue in hundredths of a degree)
    const h = ((await r.u16(at + 3)) / 36000) * 6, s = c[1], v = c[2];
    const i = Math.floor(h) % 6, f = h - Math.floor(h);
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    c = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  }
  const hex = '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: a };
}

async function sniffType(r, at) {
  const b = await r.raw(at, 12);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[8] === 0x57) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

// Read a .pur file. Returns { version, images, texts, linked } in board coordinates:
//   images: { blob, name, source, x, y, scaleX, scaleY, rotation, crop, z }  (x, y = centre of what shows)
//   texts:  { text, x, y, scale, rotation, color, background, z }
//   linked: images that aren't inside the file (only a path to a file on that computer)
export async function readPureRef(file) {
  const r = new Reader(file);
  let version;
  try {
    const n = await r.u32(0);
    if (n < 2 || n > 64) throw 0;
    version = new TextDecoder('utf-16be').decode(await r.raw(4, n));
    if (!/^\d+(\.\d+)*$/.test(version)) throw 0;
  } catch {
    throw new Error("That doesn't look like a PureRef file.");
  }
  const shift = (await r.u32(0)) - 8;   // (a longer version text moves the rest along)
  const tableAt = await r.u64(16 + shift);
  if (!tableAt || tableAt > file.size) throw unsupported(version);
  const itemsEnd = tableAt;   // (the items, then the folder text, end before it)

  // The picture table: at the end of the file.
  let at = tableAt;
  const table = new Map();   // item id -> [start, end]
  while (at + 20 <= file.size) {
    table.set(await r.u32(at), [await r.u64(at + 4), await r.u64(at + 12)]);
    at += 20;
  }
  if (!table.size) throw unsupported(version);

  // The items start where the last picture ends (skipping any 4-byte duplicates after it).
  let pos = Math.max(224 + shift, ...[...table.values()].map(([, e]) => e));
  const isItemAt = async (p) => {
    if (p + 12 > itemsEnd) return '';
    const n = await r.u32(p + 8);
    if (n !== 32 && n !== 34) return '';
    return new TextDecoder('utf-16be').decode(await r.raw(p + 12, n));
  };
  for (let tries = 0; !(await isItemAt(pos)) && tries < 100000 && pos < itemsEnd; tries++) pos += 4;
  if (!(await isItemAt(pos))) throw unsupported(version);

  const imageItems = [], texts = [];

  // A text item (on its own, or attached to an image: then `parent` places it).
  async function readText(p, parent) {
    const end = await r.u64(p);
    let q = p + 12 + (await r.u32(p + 8));
    const [text, q1] = await r.str(q); q = q1;
    const m = await matrix(r, q); q += 48;
    const x = await r.f64(q), y = await r.f64(q + 8); q += 16 + 8;
    q += 4;   // id
    const z = await r.f64(q); q += 8;
    const fg = await colour(r, q); q += 9 + 2;
    const bg = await colour(r, q); q += 9;
    const children = await r.u32(q + 2);
    // Where it is on the board: a child's place and transform are relative to its parent.
    const world = parent ? mul(parent.m, m) : m;
    const o = parent ? apply(parent.m, x, y) : { x, y };
    const ox = (parent?.x || 0) + o.x, oy = (parent?.y || 0) + o.y;
    const d = decompose(world);
    texts.push({ text: text || '', x: ox, y: oy, scale: Math.abs(d.scaleX), rotation: d.rotation, color: fg.hex, background: bg.alpha > 0.05 ? bg.hex : null, z: (parent?.z ?? z) + (parent ? 0.001 : 0) });
    let next = end;
    for (let i = 0; i < children; i++) next = await readText(next, { m: world, x: ox, y: oy, z });
    return next;
  }

  async function readImage(p) {
    const end = await r.u64(p);
    let q = p + 12 + (await r.u32(p + 8));
    let source = null, name = null;
    let forced = false;
    if ((await r.u32(q)) === 0) { forced = true; q += 4; }
    [source, q] = await r.str(q);
    if (!forced) [name, q] = await r.str(q);
    q += 8;
    const m = await matrix(r, q); q += 48;
    const x = await r.f64(q), y = await r.f64(q + 8); q += 16 + 8;
    const id = await r.u32(q); q += 4;
    const z = await r.f64(q); q += 8;
    q += 48;   // the transform before cropping
    const cropX = await r.f64(q), cropY = await r.f64(q + 8), cropScale = (await r.f64(q + 16)) || 1; q += 24;
    const count = await r.u32(q); q += 4;
    const xs = [], ys = [];
    for (let i = 0; i < count && i < 10000; i++) { xs.push(await r.f64(q + 4)); ys.push(await r.f64(q + 12)); q += 20; }
    const children = q + 25 <= end ? await r.u32(q + 21) : 0;
    imageItems.push({ id, source, name, m, x, y, z, cropX, cropY, cropScale, xs, ys });
    let next = end;
    for (let i = 0; i < children; i++) next = await readText(next, { m, x, y, z });
    return next;
  }

  while (pos < itemsEnd) {
    const kind = await isItemAt(pos);
    if (kind === IMAGE_ITEM) pos = await readImage(pos);
    else if (kind === TEXT_ITEM) pos = await readText(pos, null);
    else break;
  }
  if (!imageItems.length && !texts.length) throw unsupported(version);

  // Each image item's picture: its own, or (a duplicate) another item's.
  const range = async (id, depth = 0) => {
    const span = table.get(id);
    if (!span || depth > 8) return null;
    const [s, e] = span;
    if (e - s === 4) {
      const other = await r.u32(s);
      if (other === 0xffffffff) return null;   // linked, not inside the file
      return range(other, depth + 1);
    }
    return span;
  };

  const images = [];
  let linked = 0;
  for (const it of imageItems) {
    const span = await range(it.id);
    if (!span) { linked++; continue; }
    const type = await sniffType(r, span[0]);
    if (!type) { linked++; continue; }
    const blob = file.slice(span[0], span[1], type);
    // The visible part: the crop outline (in the item's own space) as a box in the picture's pixels.
    let crop = null, cx = 0, cy = 0;
    if (it.xs.length >= 3) {
      const l = Math.min(...it.xs), t = Math.min(...it.ys), rr = Math.max(...it.xs), b = Math.max(...it.ys);
      crop = { x: (l - it.cropX) / it.cropScale, y: (t - it.cropY) / it.cropScale, w: (rr - l) / it.cropScale, h: (b - t) / it.cropScale };
      cx = (l + rr) / 2; cy = (t + b) / 2;
    }
    const at2 = apply(it.m, cx, cy);
    const d = decompose(it.m);
    images.push({
      blob, name: displayName(it.name, it.source), source: it.source || '',
      x: it.x + at2.x, y: it.y + at2.y,
      // (a picture saved smaller than it shows has a crop scale: fold it into the size)
      scaleX: d.scaleX * it.cropScale, scaleY: d.scaleY * it.cropScale, rotation: d.rotation,
      crop, z: it.z,
    });
  }
  return { version, images, texts, linked };
}

function displayName(name, source) {
  const n = (name || '').trim() || (source || '').split(/[\\/]/).pop() || '';
  return n.replace(/\.[a-z0-9]{2,4}$/i, '');
}

function unsupported(version) {
  return new Error(`This PureRef file (version ${version}) is laid out in a way Melti can't read yet.`);
}
