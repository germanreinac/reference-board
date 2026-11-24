// Reading PureRef boards (.pur files), so they can be brought into Melti.
//
// PureRef's format isn't published, and it changed completely in PureRef 2:
//   PureRef 2.x  an SQLite database with its first bytes moved to the end of the file.
//                Layout worked out by github.com/FyorDev/pur-2-file-format (2.0.3 and 2.1.3).
//                See readPureRef2 below.
//   PureRef 1.x  its own binary layout, worked out by github.com/FyorDev/PureRef-format
//                (1.10 and 1.11), all numbers big-endian:
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

// Reads the file in 1 MB blocks, each read from disk once and kept while reading (up to
// 512 MB; past that the least recently used are let go). A picture's pages can be
// scattered all over a PureRef 2 file, so this matters a lot for big, much-edited boards.
const BLOCK = 1 << 20, KEEP = 512;
class Reader {
  constructor(file) { this.file = file; this.blocks = new Map(); this.reads = 0; }
  async block(i) {
    let b = this.blocks.get(i);
    if (b) return b;
    b = new Uint8Array(await this.file.slice(i * BLOCK, Math.min(this.file.size, (i + 1) * BLOCK)).arrayBuffer());
    this.reads++;
    this.onRead?.(Math.min(this.file.size, this.reads * BLOCK), this.file.size);
    this.blocks.set(i, b);
    if (this.blocks.size > KEEP) this.blocks.delete(this.blocks.keys().next().value);
    return b;
  }
  async raw(at, n) {
    if (at < 0 || at + n > this.file.size) throw new Error('short');
    const i0 = Math.floor(at / BLOCK), i1 = Math.floor((at + n - 1) / BLOCK);
    if (n === 0) return new Uint8Array(0);
    if (i0 === i1) { const b = await this.block(i0); return b.slice(at - i0 * BLOCK, at - i0 * BLOCK + n); }
    const out = new Uint8Array(n);
    for (let i = i0, o = 0; i <= i1; i++) {
      const b = await this.block(i);
      const s = i === i0 ? at - i0 * BLOCK : 0, e = i === i1 ? at + n - i1 * BLOCK : b.length;
      out.set(b.subarray(s, e), o); o += e - s;
    }
    return out;
  }
  async view(at, n) { const b = await this.raw(at, n); return new DataView(b.buffer); }
  async u8(at) { return (await this.view(at, 1)).getUint8(0); }
  async u16(at) { return (await this.view(at, 2)).getUint16(0); }
  async u32(at) { return (await this.view(at, 4)).getUint32(0); }
  async i32(at) { return (await this.view(at, 4)).getInt32(0); }
  async u64(at) { return Number((await this.view(at, 8)).getBigUint64(0)); }
  async f64(at) { return (await this.view(at, 8)).getFloat64(0); }
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
export async function readPureRef(file, onProgress = () => {}) {
  const r = new Reader(file);
  r.onRead = onProgress;   // (how much of the file has been read)
  let version;
  try {
    const n = await r.u32(0);
    if (n < 2 || n > 64) throw 0;
    version = new TextDecoder('utf-16be').decode(await r.raw(4, n));
    if (!/^\d+(\.\d+)*$/.test(version)) throw 0;
  } catch {
    throw new Error("That doesn't look like a PureRef file.");
  }
  if (Number(version.split('.')[0]) >= 2) return readPureRef2(file, r, version, onProgress);
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
  return { version, images, texts, strokes: [], linked };
}

function displayName(name, source) {
  const n = (name || '').trim() || (source || '').split(/[\\/]/).pop() || '';
  return n.replace(/\.[a-z0-9]{2,4}$/i, '');
}

function unsupported(version) {
  return new Error(`This PureRef file (version ${version}) is laid out in a way Melti can't read yet.`);
}

// ---------- PureRef 2 ----------
//
// The file is an ordinary SQLite database D whose first H bytes were swapped for PureRef's
// header and moved to the end:   [header: H bytes][D from H to N][D's first H bytes]
// So byte o of the database is at o in the file, or at N + o when o < H.
// A tiny SQLite reader below walks just the tables PureRef uses, reading pages from the
// file as needed. Pictures are stored whole (PNG, JPEG...) but spread over database pages,
// so each one becomes a Blob stitched from slices of the file: no copying into memory.

class Db {
  constructor(r, H, N) { this.r = r; this.H = H; this.N = N; }
  // Where database bytes [o, o + n) are in the file, as [start, end] pieces.
  ranges(o, n) {
    const out = [];
    if (o < this.H) { const e = Math.min(o + n, this.H); out.push([this.N + o, this.N + e]); n -= e - o; o = e; }
    if (n > 0) out.push([o, o + n]);
    return out;
  }
  async bytes(o, n) {
    const parts = this.ranges(o, n);
    if (parts.length === 1) return this.r.raw(parts[0][0], n);
    const out = new Uint8Array(n);
    let at = 0;
    for (const [s, e] of parts) { out.set(await this.r.raw(s, e - s), at); at += e - s; }
    return out;
  }
  async open() {
    const h = await this.bytes(0, 100);
    if (new TextDecoder().decode(h.subarray(0, 15)) !== 'SQLite format 3') throw new Error('not sqlite');
    const v = new DataView(h.buffer, h.byteOffset);
    this.ps = v.getUint16(16) === 1 ? 65536 : v.getUint16(16);
    this.U = this.ps - h[20];
    const schema = {};
    for await (const row of this.rows(1)) {
      const [type, name, , root, sql] = row.values;
      if (type === 'table' && sql) schema[name] = { root, cols: columnsOf(sql) };
    }
    this.schema = schema;
  }
  async u32(o) { const b = await this.bytes(o, 4); return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]; }
  // Every row of the table whose b-tree starts at page `root`, in rowid order.
  async *rows(root) {
    const page = await this.bytes((root - 1) * this.ps, this.ps);
    const at = root === 1 ? 100 : 0;
    const v = new DataView(page.buffer, page.byteOffset, page.length);
    const kind = page[at], cells = v.getUint16(at + 3);
    if (kind === 5) {   // interior: children to the left of each key, then the right-most child
      for (let i = 0; i < cells; i++) yield* this.rows(v.getUint32(v.getUint16(at + 12 + i * 2)));
      yield* this.rows(v.getUint32(at + 8));
    } else if (kind === 13) {   // leaf: the rows themselves
      for (let i = 0; i < cells; i++) {
        let p = v.getUint16(at + 8 + i * 2);
        let size, rowid;
        [size, p] = varint(page, p);
        [rowid, p] = varint(page, p);
        // How much of the row is on this page; the rest is on a chain of overflow pages.
        const X = this.U - 35;
        let local = size;
        if (size > X) {
          const M = Math.floor(((this.U - 12) * 32) / 255) - 23;
          const K = M + ((size - M) % (this.U - 4));
          local = K <= X ? K : M;
        }
        const pl = { size, local: page.slice(p, p + local), next: local < size ? v.getUint32(p + local) : 0, chain: [] };
        yield { rowid, values: await this.record(pl) };
      }
    }
  }
  // Pieces making up bytes [a, b) of a row: Uint8Arrays (on the row's page) or database ranges.
  async pieces(pl, a, b) {
    const out = [];
    const L = pl.local.length, per = this.U - 4;
    if (a < L) { out.push(pl.local.subarray(a, Math.min(b, L))); a = Math.min(b, L); }
    while (a < b) {
      const k = Math.floor((a - L) / per);
      while (pl.chain.length <= k) {
        const pg = pl.chain.length ? await this.u32((pl.chain[pl.chain.length - 1] - 1) * this.ps) : pl.next;
        if (!pg) throw new Error('broken chain');
        pl.chain.push(pg);
      }
      const off = (a - L) % per, n = Math.min(b - a, per - off);
      out.push([(pl.chain[k] - 1) * this.ps + 4 + off, n]);
      a += n;
    }
    return out;
  }
  async read(pl, a, b) {
    const parts = await this.pieces(pl, a, b);
    const out = new Uint8Array(b - a);
    let at = 0;
    for (const p of parts) {
      const bytes = p instanceof Uint8Array ? p : await this.bytes(p[0], p[1]);
      out.set(bytes, at); at += bytes.length;
    }
    return out;
  }
  // A row's values. Big blobs (pictures) come back as { blobParts } to be cut from the file.
  async record(pl) {
    const head = await this.read(pl, 0, Math.min(pl.size, 9));
    const [hsize] = varint(head, 0);
    const h = await this.read(pl, 0, hsize);
    let p = varint(h, 0)[1];
    const types = [];
    while (p < hsize) { let t; [t, p] = varint(h, p); types.push(t); }
    const values = [];
    let at = hsize;
    for (const t of types) {
      const n = t >= 12 ? Math.floor((t - 12) / 2) : [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0][t];
      if (t >= 12 && t % 2 === 0 && n > 65536) {
        const parts = [];
        for (const piece of await this.pieces(pl, at, at + n)) {
          if (piece instanceof Uint8Array) parts.push(piece.slice());
          else for (const [s, e] of this.ranges(piece[0], piece[1])) parts.push(this.r.file.slice(s, e));
        }
        values.push({ blobParts: parts, length: n });
      } else {
        const b = n ? await this.read(pl, at, at + n) : new Uint8Array(0);
        values.push(decodeValue(t, b));
      }
      at += n;
    }
    return values;
  }
  // A table's rows as objects (column name -> value). An INTEGER PRIMARY KEY is the rowid.
  async table(name) {
    const t = this.schema[name];
    if (!t) return [];
    const out = [];
    for await (const row of this.rows(t.root)) {
      const o = {};
      t.cols.forEach((c, i) => { o[c.name] = c.key ? row.rowid : row.values[i] ?? null; });
      out.push(o);
    }
    return out;
  }
}

function varint(b, p) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const c = b[p++];
    v = v * 128 + (c & 0x7f);
    if (c < 0x80) return [v, p];
  }
  return [v * 256 + b[p++], p];
}

function decodeValue(t, b) {
  if (t === 0) return null;
  if (t === 8) return 0;
  if (t === 9) return 1;
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  if (t === 7) return v.getFloat64(0);
  if (t >= 1 && t <= 6) {
    let n = BigInt(b[0] & 0x80 ? -1 : 0);
    for (const c of b) n = (n << 8n) | BigInt(c);
    return Number(BigInt.asIntN(b.length * 8, n));
  }
  if (t % 2 === 1) return new TextDecoder().decode(b);
  return b;
}

// Column names from a CREATE TABLE statement.
function columnsOf(sql) {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  return body.split(',').map((part) => {
    const words = part.trim().split(/\s+/);
    return { name: words[0].replace(/^["'`[]|["'`\]]$/g, ''), key: /integer\s+primary\s+key/i.test(part) };
  });
}

// PureRef stores Qt values as text whose characters are really bytes.
function cellBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v !== 'string') return null;
  const out = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i) & 0xff;
  return out;
}

// A Qt value: type id, null flag, (a type name for custom types), then the value.
function variant(v) {
  const b = cellBytes(v);
  if (!b || b.length < 5) return null;
  const d = new DataView(b.buffer, b.byteOffset, b.length);
  const type = d.getUint32(0);
  let p = 5, name = '';
  if (type === 1024) { const n = d.getUint32(p); name = new TextDecoder().decode(b.subarray(p + 4, p + 4 + n)).replace(/\0$/, ''); p += 4 + n; }
  return { type, name, d, p };
}

// A transform: x' = a x + c y + e, y' = b x + d y + f.
const NONE = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function qtransform(v) {
  const q = variant(v);
  if (!q || q.type !== 80) return NONE;
  const n = (i) => q.d.getFloat64(q.p + i * 8);
  return { a: n(0), b: n(1), c: n(3), d: n(4), e: n(6), f: n(7) };
}
// First t1, then t2.
const then = (t1, t2) => ({
  a: t1.a * t2.a + t1.b * t2.c, b: t1.a * t2.b + t1.b * t2.d,
  c: t1.c * t2.a + t1.d * t2.c, d: t1.c * t2.b + t1.d * t2.d,
  e: t1.e * t2.a + t1.f * t2.c + t2.e, f: t1.e * t2.b + t1.f * t2.d + t2.f,
});
const map = (t, x, y) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f });
function invert(t) {
  const det = t.a * t.d - t.b * t.c || 1;
  const a = t.d / det, b = -t.b / det, c = -t.c / det, d = t.a / det;
  return { a, b, c, d, e: -(t.e * a + t.f * c), f: -(t.e * b + t.f * d) };
}

// A QPainterPath payload (at q.p, or `at`): its points, as lists of [x, y] per sub-path.
// Curves are followed in small steps.
function pathPoints(d, at) {
  const count = d.getUint32(at); at += 4;
  const subs = [];
  let cur = null, last = null;
  for (let i = 0; i < count; i++) {
    const type = d.getInt32(at), x = d.getFloat64(at + 4), y = d.getFloat64(at + 12); at += 20;
    if (type === 0) { cur = [[x, y]]; subs.push(cur); }
    else if (type === 1) cur?.push([x, y]);
    else if (type === 2 && i + 2 < count) {
      const x2 = d.getFloat64(at + 4), y2 = d.getFloat64(at + 12), x3 = d.getFloat64(at + 24), y3 = d.getFloat64(at + 32);
      at += 40; i += 2;
      const [x0, y0] = last;
      for (let k = 1; k <= 8; k++) {
        const s = k / 8, u = 1 - s;
        cur?.push([u * u * u * x0 + 3 * u * u * s * x + 3 * u * s * s * x2 + s * s * s * x3, u * u * u * y0 + 3 * u * u * s * y + 3 * u * s * s * y2 + s * s * s * y3]);
      }
      last = [x3, y3];
      continue;
    }
    last = [x, y];
  }
  if (count) at += 8;
  return { subs, at };
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
    .replace(/\n+$/, '').trim();
}

function cssColour(c) {
  const m = /#([0-9a-f]{8}|[0-9a-f]{6})\b/i.exec(c || '');
  if (!m) return null;
  return '#' + m[1].slice(-6).toLowerCase();   // (#AARRGGBB: the alpha is dropped)
}

async function readPureRef2(file, r, version, onProgress) {
  let p, N;
  try {
    [, p] = await r.str(0);
    p += 4;
    N = await r.u64(p); p += 8;
    [, p] = await r.str(p);   // the app version
    [, p] = await r.str(p);   // a checksum
    if (version !== '2.0') { const t = await r.u32(p); p += 4 + (t === 0xffffffff ? 0 : t); }   // a preview picture
  } catch { throw unsupported(version); }
  const H = p;
  if (!(N > H && N <= file.size)) throw unsupported(version);
  const db = new Db(r, H, N);
  try { await db.open(); } catch { throw unsupported(version); }

  const items = new Map((await db.table('items')).map((it) => [it.id, it]));
  const imageRows = new Map((await db.table('images')).map((im) => [im.id, im]));
  const groups = new Set((await db.table('items_groups')).map((g) => g.id));

  // Where each item is on the board (transforms are relative to the parent group).
  const worldOf = new Map();
  const world = (id, depth = 0) => {
    if (worldOf.has(id)) return worldOf.get(id);
    const it = items.get(id);
    if (!it || depth > 64) return NONE;
    const own = qtransform(it.transform);
    const w = it.parent >= 0 && items.has(it.parent) ? then(own, world(it.parent, depth + 1)) : own;
    worldOf.set(id, w);
    return w;
  };
  const opacityOf = (id, depth = 0) => {
    const it = items.get(id);
    if (!it || depth > 64) return 1;
    return (it.opacity ?? 1) * (it.parent >= 0 ? opacityOf(it.parent, depth + 1) : 1);
  };
  const topGroup = (id) => {
    let g = null, it = items.get(id), n = 0;
    while (it && it.parent >= 0 && n++ < 64) { if (groups.has(it.parent)) g = it.parent; it = items.get(it.parent); }
    return g === null ? null : `pr${g}`;
  };
  // Stacking order: siblings by z, each group's things together.
  const kids = new Map();
  for (const it of items.values()) {
    const k = it.parent >= 0 && items.has(it.parent) ? it.parent : -1;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(it);
  }
  const order = new Map();
  const walk = (k, depth = 0) => {
    if (depth > 64) return;
    for (const it of (kids.get(k) || []).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id - b.id)) { order.set(it.id, order.size); walk(it.id, depth + 1); }
  };
  walk(-1);

  const images = [];
  let linked = 0;
  for (const ii of await db.table('items_images')) {
    const res = imageRows.get(ii.image);
    if (!res || !res.data?.blobParts && !(res.data instanceof Uint8Array && res.data.length)) { linked++; continue; }
    const parts = res.data.blobParts || [res.data];
    const head = new Uint8Array(await new Blob(parts.slice(0, 1)).slice(0, 12).arrayBuffer());
    const type = head[0] === 0x89 ? 'image/png' : head[0] === 0xff ? 'image/jpeg' : head[0] === 0x47 ? 'image/gif'
      : head[0] === 0x52 && head[8] === 0x57 ? 'image/webp' : head[0] === 0x42 ? 'image/bmp' : '';
    if (!type) { linked++; continue; }
    const imgT = qtransform(ii.image_transform);
    const toWorld = then(imgT, world(ii.id));
    // The visible part: the clip outline, in the picture's own pixels.
    let crop = null;
    const w = res.width || 0, h = res.height || 0;
    const q = variant(ii.image_bounds);
    if (q && q.type === 1024) {
      const pts = pathPoints(q.d, q.p).subs.flat();
      if (pts.length >= 3) {
        const back = invert(imgT);
        const px = pts.map(([x, y]) => map(back, x, y));
        const l = Math.min(...px.map((o) => o.x)), t = Math.min(...px.map((o) => o.y));
        const rr = Math.max(...px.map((o) => o.x)), b = Math.max(...px.map((o) => o.y));
        if (!(w && h && l <= 0.5 && t <= 0.5 && rr >= w - 0.5 && b >= h - 0.5)) crop = { x: l, y: t, w: rr - l, h: b - t };
      }
    }
    const c = crop ? { x: crop.x + crop.w / 2, y: crop.y + crop.h / 2 } : { x: w / 2, y: h / 2 };
    const at = map(toWorld, c.x, c.y);
    const dd = decompose({ m11: toWorld.a, m12: toWorld.b, m21: toWorld.c, m22: toWorld.d });
    const it = items.get(ii.id);
    images.push({
      blob: new Blob(parts, { type }), name: displayName(it?.name, res.source || res.origin), source: res.source || '',
      x: at.x, y: at.y, scaleX: dd.scaleX, scaleY: dd.scaleY, rotation: dd.rotation, crop,
      opacity: opacityOf(ii.id), group: topGroup(ii.id), z: order.get(ii.id) ?? 0,
    });
  }

  const texts = [];
  for (const n of await db.table('items_notes')) {
    const text = htmlToText(n.text);
    if (!text) continue;
    const body = String(n.text || '').replace(/<head[\s\S]*?<\/head>/i, '');
    const size = /font-size:\s*([\d.]+)\s*(pt|px)/i.exec(body);
    const px = size ? Number(size[1]) * (size[2].toLowerCase() === 'pt' ? 4 / 3 : 1) : 22;
    const t = world(n.id);
    const d = decompose({ m11: t.a, m12: t.b, m21: t.c, m22: t.d });
    texts.push({
      text, x: t.e, y: t.f, scale: Math.abs(d.scaleX), rotation: d.rotation, size: px,
      color: cssColour(n.text_color) || cssColour(/color:\s*(#[0-9a-f]+)/i.exec(body)?.[1]) || null,
      background: cssColour(n.background_color), group: topGroup(n.id), z: order.get(n.id) ?? 0,
    });
  }

  const strokes = [];
  for (const dr of await db.table('items_drawings')) {
    const q = variant(dr.strokes);
    if (!q || q.type !== 1024) continue;
    const t = world(dr.id);
    const k = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1;
    try {
      let at = q.p;
      const count = q.d.getUint32(at); at += 4;
      for (let i = 0; i < count; i++) {
        const ver = q.d.getInt8(at); at += ver > 99 ? 1 : 0;
        const rgb = [q.d.getUint16(at + 3), q.d.getUint16(at + 5), q.d.getUint16(at + 7)];
        at += 11;
        const width = q.d.getFloat64(at); at += 8;
        const path = pathPoints(q.d, at); at = path.at + 16 + (ver > 99 ? 4 : 0);
        const color = '#' + rgb.map((v) => Math.round(v / 257).toString(16).padStart(2, '0')).join('');
        for (const sub of path.subs) {
          if (sub.length < 2) continue;
          const points = [];
          for (const [x, y] of sub) { const o = map(t, x, y); points.push(o.x, o.y, 0.5); }
          strokes.push({ points, color, size: width * k, z: order.get(dr.id) ?? 0 });
        }
      }
    } catch { /* a drawing we can't read is left out */ }
  }

  return { version, images, texts, strokes, linked };
}
