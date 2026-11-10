// Zip files of any size, read and written piece by piece.
//
// Board files are zips. A board with a thousand full-size photos can be gigabytes, far
// more than fits in memory at once, so nothing here loads a whole file:
//   - reading looks at the list at the end of the zip, then hands out each file inside
//     as a slice of the zip on disk (images are stored as they are, so a slice is the
//     image itself, with no copying)
//   - writing builds the zip out of the image files themselves plus small headers, and
//     the browser streams it to disk when it's saved.
// Big zips (over 4 GB, or more than 65,535 files) use the ZIP64 format, as other tools do.

import { inflateSync, deflateSync, strToU8, strFromU8 } from '../vendor/fflate.mjs';

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const MAX32 = 0xffffffff;

// 64-bit numbers as plain numbers (fine up to 9 petabytes).
const get64 = (v, at) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;
function set64(v, at, n) {
  v.setUint32(at, n % 2 ** 32, true);
  v.setUint32(at + 4, Math.floor(n / 2 ** 32), true);
}

// ---------- Reading ----------

// The files inside a zip: [{ name, method, size, csize, offset }].
export async function listZip(file) {
  const tailSize = Math.min(file.size, 65557 + 20);
  const tail = await bytes(file.slice(file.size - tailSize));
  const tv = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  let count = tv.getUint16(end + 10, true);
  let cdSize = tv.getUint32(end + 12, true);
  let cdOffset = tv.getUint32(end + 16, true);
  // ZIP64: the real numbers are in a bigger record just before.
  if ((count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) && end >= 20 && tv.getUint32(end - 20, true) === 0x07064b50) {
    const at = get64(tv, end - 20 + 8);
    const z = new DataView((await bytes(file.slice(at, at + 56))).buffer);
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error('damaged zip');
    count = get64(z, 32);
    cdSize = get64(z, 40);
    cdOffset = get64(z, 48);
  }
  const cd = await bytes(file.slice(cdOffset, cdOffset + cdSize));
  const v = new DataView(cd.buffer);
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('damaged zip');
    const method = v.getUint16(p + 10, true);
    let csize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = strFromU8(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: the sizes and offset that didn't fit, in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = v.getUint16(e, true), len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === MAX32) { size = get64(v, q); q += 8; }
        if (csize === MAX32) { csize = get64(v, q); q += 8; }
        if (offset === MAX32) { offset = get64(v, q); q += 8; }
      }
      e += 4 + len;
    }
    out.push({ name, method, size, csize, offset });
    p = extraEnd + commentLen;
  }
  return out;
}

// One file inside the zip, as a Blob. Stored files are a slice of the zip (no copying).
export async function zipEntry(file, entry, type = '') {
  const head = new DataView((await bytes(file.slice(entry.offset, entry.offset + 30))).buffer);
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error('damaged zip');
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = file.slice(start, start + entry.csize, type);
  if (entry.method === 0) return data;
  if (entry.method === 8) return new Blob([inflateSync(await bytes(data))], { type });
  throw new Error('unsupported zip');
}

export async function zipText(file, entry) {
  return strFromU8(await bytes(await zipEntry(file, entry)));
}

// ---------- Writing ----------

let crcTable;
function crc32(chunk, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  crc = ~crc;
  for (let i = 0; i < chunk.length; i++) crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
// A file's checksum, read a piece at a time.
async function crcOf(blob) {
  let crc = 0;
  const STEP = 8 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += STEP) crc = crc32(await bytes(blob.slice(at, at + STEP)), crc);
  return crc;
}

// Make a zip. entries: [{ name, blob } | { name, text } | { name, data: Uint8Array }].
// Text and data are compressed; blobs (images, already compressed) are stored as they are.
// `onProgress(done, total)` is called as files are added.
export async function makeZip(entries, onProgress = () => {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  let done = 0;
  for (const entry of entries) {
    const name = strToU8(entry.name);
    let data, method, size, crc;
    if (entry.blob) {
      data = entry.blob;
      method = 0;
      size = data.size;
      crc = await crcOf(data);
    } else {
      const raw = entry.data || strToU8(entry.text);
      data = deflateSync(raw, { level: 6 });
      method = 8;
      size = raw.length;
      crc = crc32(raw);
    }
    const csize = data.size ?? data.length;
    const big = size >= MAX32 || csize >= MAX32;
    // Local header (with ZIP64 sizes when they don't fit in 4 bytes).
    const local = new DataView(new ArrayBuffer(30 + name.length + (big ? 20 : 0)));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, big ? 45 : 20, true);
    local.setUint16(6, 0x0800, true);              // names are UTF-8
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, big ? MAX32 : csize, true);
    local.setUint32(22, big ? MAX32 : size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, big ? 20 : 0, true);
    new Uint8Array(local.buffer).set(name, 30);
    if (big) {
      local.setUint16(30 + name.length, 0x0001, true);
      local.setUint16(32 + name.length, 16, true);
      set64(local, 34 + name.length, size);
      set64(local, 42 + name.length, csize);
    }
    parts.push(local.buffer, data);
    central.push({ name, method, crc, size, csize, offset });
    offset += local.byteLength + csize;
    onProgress(++done, entries.length);
  }
  // The list of files at the end.
  const cdStart = offset;
  for (const c of central) {
    const need64 = c.size >= MAX32 || c.csize >= MAX32 || c.offset >= MAX32;
    const extra = need64 ? 28 : 0;
    const h = new DataView(new ArrayBuffer(46 + c.name.length + extra));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 45, true);
    h.setUint16(6, need64 ? 45 : 20, true);
    h.setUint16(8, 0x0800, true);
    h.setUint16(10, c.method, true);
    h.setUint32(16, c.crc, true);
    h.setUint32(20, need64 ? MAX32 : c.csize, true);
    h.setUint32(24, need64 ? MAX32 : c.size, true);
    h.setUint16(28, c.name.length, true);
    h.setUint16(30, extra, true);
    h.setUint32(42, need64 ? MAX32 : c.offset, true);
    new Uint8Array(h.buffer).set(c.name, 46);
    if (need64) {
      const at = 46 + c.name.length;
      h.setUint16(at, 0x0001, true);
      h.setUint16(at + 2, 24, true);
      set64(h, at + 4, c.size);
      set64(h, at + 12, c.csize);
      set64(h, at + 20, c.offset);
    }
    parts.push(h.buffer);
    offset += h.byteLength;
  }
  const cdSize = offset - cdStart;
  const need64 = central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
  if (need64) {
    const z = new DataView(new ArrayBuffer(56 + 20));
    z.setUint32(0, 0x06064b50, true);
    set64(z, 4, 44);
    z.setUint16(12, 45, true);
    z.setUint16(14, 45, true);
    set64(z, 24, central.length);
    set64(z, 32, central.length);
    set64(z, 40, cdSize);
    set64(z, 48, cdStart);
    z.setUint32(56, 0x07064b50, true);              // where to find it
    set64(z, 64, offset);
    z.setUint32(72, 1, true);
    parts.push(z.buffer);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, need64 ? 0xffff : central.length, true);
  end.setUint16(10, need64 ? 0xffff : central.length, true);
  end.setUint32(12, need64 ? MAX32 : cdSize, true);
  end.setUint32(16, need64 ? MAX32 : cdStart, true);
  parts.push(end.buffer);
  return new Blob(parts, { type: 'application/zip' });
}
