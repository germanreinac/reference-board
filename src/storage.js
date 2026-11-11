// Saving and opening boards.
//
// Two kinds of saving:
//   1. Board files (.refboard). One file holds the whole board: every image, where
//      it sits, and the pane layout. You can send it to anyone; they open it by
//      dropping it on the website. Inside, it's an ordinary zip file, so the
//      images can also be pulled out with any unzip tool.
//   2. Your boards list. Chrome keeps every board you make on your computer, and
//      saves changes as you work, so closing the tab never loses anything. These
//      live only in this browser on this computer: save to a file to back up or share.

import { listZip, zipEntry, zipText, makeZip } from './zipfile.js';

export const FILE_EXT = '.refboard';
// A backup of all your boards: one file holding a .refboard file for each board.
export const BACKUP_EXT = '.refboards';
const FORMAT = 'reference-board';
const VERSION = 1;

const EXT_FOR_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
const TYPE_FOR_EXT = Object.fromEntries(Object.entries(EXT_FOR_TYPE).map(([t, e]) => [e, t]));
TYPE_FOR_EXT.jpeg = 'image/jpeg';

// A plain description of the board: images (without their pixels), pen strokes,
// notes and the pane layout.
export function describeBoard(board, layout) {
  const { items, strokes, notes, shapes, frames, palettes, storyboards } = board.toJSON();
  const withFiles = items.map((d, i) => {
    const blob = board.items[i].blob;
    const ext = EXT_FOR_TYPE[blob?.type] || 'png';
    return { ...d, file: `images/${d.id}.${ext}` };
  });
  return { format: FORMAT, version: VERSION, items: withFiles, strokes, notes, shapes, frames, palettes, storyboards, layout: layout.toJSON() };
}

// ---------- Board files ----------
//
// Read and written piece by piece (src/zipfile.js), so boards of any size work: images
// go in and come out exactly as they are, without loading the whole file into memory.

// Pack a board into a single .refboard file (a zip).
// `data` is a board description; `getBlob(item)` returns each image's file.
// `getFont(name)` returns an uploaded font's file (null for built-in fonts); those
// fonts go into the board file too, so it looks the same on someone else's computer.
export async function packBoard(data, getBlob, getFont = () => null, onProgress) {
  const fontFiles = [];
  for (const name of new Set((data.notes || []).map((n) => n.font).filter(Boolean))) {
    const blob = getFont(name);
    if (blob) fontFiles.push({ name, file: `fonts/${fontFiles.length}.font`, blob });
  }
  data = { ...data, fontFiles: fontFiles.map(({ name, file }) => ({ name, file })) };
  const entries = [{ name: 'board.json', text: JSON.stringify(data, null, 1) }];
  for (const f of fontFiles) entries.push({ name: f.file, data: new Uint8Array(await f.blob.arrayBuffer()) });
  for (const item of data.items) {
    const blob = await getBlob(item);
    if (blob) entries.push({ name: item.file, blob });
    // A sketch's layers, so it can be painted on again wherever the board is opened.
    for (const l of item.sketch?.layers || []) {
      const layer = await getBlob({ id: l.key });
      if (layer) entries.push({ name: `sketches/${l.key}.png`, blob: layer });
    }
  }
  return makeZip(entries, onProgress);
}

// Read a .refboard file. Returns the description and the images as Blobs.
export async function unpackBoard(file) {
  let entries;
  try {
    entries = new Map((await listZip(file)).map((e) => [e.name, e]));
  } catch {
    throw new Error(file.parts
      ? `Some parts of "${file.name}" seem to be missing. Drop all its parts together.`
      : "That file isn't a reference board, or it's damaged.");
  }
  if (!entries.has('board.json')) throw new Error("That file isn't a reference board.");
  const data = JSON.parse(await zipText(file, entries.get('board.json')));
  if (data.format !== FORMAT) throw new Error("That file isn't a reference board.");
  if (data.version > VERSION) throw new Error('That board was made with a newer version. Refresh the page to update.');
  const images = new Map();
  for (const item of data.items) {
    const e = entries.get(item.file);
    if (!e) continue;
    const ext = item.file.split('.').pop().toLowerCase();
    images.set(item.file, await zipEntry(file, e, TYPE_FOR_EXT[ext] || 'image/png'));
    for (const l of item.sketch?.layers || []) {
      const name = `sketches/${l.key}.png`;
      if (entries.has(name)) images.set(name, await zipEntry(file, entries.get(name), 'image/png'));
    }
  }
  const fonts = [];
  for (const f of data.fontFiles || []) if (entries.has(f.file)) fonts.push({ name: f.name, blob: await zipEntry(file, entries.get(f.file)) });
  return { data, images, fonts };
}

export function isBoardFile(file) {
  return file.name?.toLowerCase().endsWith(FILE_EXT);
}

// A big board file can come in numbered parts ("Name.refboard.001", ".002"…), to fit size
// limits when sending it. Dropped together, the parts are joined back into the board file
// (end to end, as they were cut: nothing is copied or changed).
const PART = /^(.*\.refboard)\.(\d{3})$/i;
export const isBoardPart = (file) => PART.test(file.name || '');
export function joinParts(files) {
  const groups = new Map();
  for (const f of files) {
    const [, base, n] = f.name.match(PART);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({ n: Number(n), f });
  }
  return [...groups].map(([base, parts]) => {
    parts.sort((a, b) => a.n - b.n);
    parts.forEach((p, i) => {
      if (p.n !== i + 1) throw new Error(`Part ${String(i + 1).padStart(3, '0')} of "${base}" is missing. Drop all its parts together.`);
    });
    const joined = new File(parts.map((p) => p.f), base, { type: 'application/zip' });
    joined.parts = parts.length;
    return joined;
  });
}

export function isBackupFile(file) {
  return file.name?.toLowerCase().endsWith(BACKUP_EXT);
}

// Pack board files ([{ name, blob }]) into one backup file.
export async function packBackup(boards) {
  const entries = [{ name: 'backup.json', text: JSON.stringify({ format: 'reference-board-backup', made: Date.now(), boards: boards.map((b) => b.name) }) }];
  const used = new Set();
  for (const b of boards) {
    let file = `${b.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Board'}`;
    for (let n = 2; used.has(file.toLowerCase()); n++) file = `${b.name} ${n}`;
    used.add(file.toLowerCase());
    entries.push({ name: file + FILE_EXT, blob: b.blob });
  }
  return makeZip(entries);
}

// The board files inside a backup, as File objects.
export async function unpackBackup(file) {
  let entries;
  try {
    entries = await listZip(file);
  } catch {
    throw new Error("That file isn't a backup of boards, or it's damaged.");
  }
  const out = [];
  for (const e of entries.filter((x) => x.name.toLowerCase().endsWith(FILE_EXT))) {
    out.push(new File([await zipEntry(file, e)], e.name.split('/').pop(), { type: 'application/zip' }));
  }
  return out;
}

// Chrome (and Edge) can save straight to a file you pick, and save to it again
// with Ctrl/⌘+S. Other browsers fall back to downloading a copy.
export const canPickFiles = 'showSaveFilePicker' in window;

const PICKER_TYPES = [{ description: 'Reference board', accept: { 'application/x-reference-board': [FILE_EXT, BACKUP_EXT] } }];

// Ask where to save. Returns a file handle, or null if you cancelled.
export async function pickSaveLocation(suggestedName) {
  try {
    return await window.showSaveFilePicker({ suggestedName, types: PICKER_TYPES, id: 'refboard' });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

// After a page reload Chrome asks once more for permission to write to the file.
// This has to happen straight after a click or key press, before any slow work.
export async function ensureWritePermission(handle) {
  if ((await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') return;
  if ((await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') {
    throw new Error("Chrome didn't get permission to save to that file. Try Save As instead.");
  }
}

export async function writeToHandle(handle, blob) {
  const out = await handle.createWritable();
  await out.write(blob);
  await out.close();
}

// Ask which board to open. Returns { file, handle } or null if you cancelled.
export async function pickBoardToOpen() {
  if (canPickFiles) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, id: 'refboard' });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  // Fallback: a hidden file input.
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: `${FILE_EXT},${BACKUP_EXT}` });
    input.onchange = () => resolve(input.files[0] ? { file: input.files[0], handle: null } : null);
    input.click();
  });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Your boards (IndexedDB, Chrome's built-in storage) ----------
//
// Four storage areas:
//   boards  one record per board: name, dates, and the board description
//   images  every image file, stored once, keyed "<board id>/<image id>"
//   thumbs  a small preview picture of each board, for the home screen
//   state   only used by the very first version; moved into "boards" on upgrade
//
// Images are written once when they're added, and the small board description is
// rewritten on every change. That keeps saving fast even for boards with many big images.

export function newBoardId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('reference-board', 5);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      const tx = req.transaction;
      for (const name of ['images', 'state', 'thumbs', 'fonts', 'previews', 'sketches']) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
      }
      if (!d.objectStoreNames.contains('boards')) d.createObjectStore('boards', { keyPath: 'id' });
      if (e.oldVersion === 1) moveOldAutosave(tx);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other tabs of this app and refresh.'));
  });
  return dbPromise;
}

// The first version kept a single autosaved board. Turn it into the first board in the list.
function moveOldAutosave(tx) {
  const get = tx.objectStore('state').get('current');
  get.onsuccess = () => {
    const old = get.result;
    if (!old?.board) return;
    const id = newBoardId();
    const now = Date.now();
    tx.objectStore('boards').put({ id, name: old.name || 'Untitled board', created: now, updated: now, handle: old.handle || null, board: old.board });
    const images = tx.objectStore('images');
    images.openCursor().onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) return;
      if (!String(cursor.key).includes('/')) {
        images.put(cursor.value, `${id}/${cursor.key}`);
        cursor.delete();
      }
      cursor.continue();
    };
    tx.objectStore('state').delete('current');
  };
}

// Run some work on one or more storage areas and wait until it's safely written.
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    const req = fn(tx);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const imagesOf = (boardId) => IDBKeyRange.bound(`${boardId}/`, `${boardId}/\uffff`);

async function allOf(storeName, boardId) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const os = d.transaction(storeName, 'readonly').objectStore(storeName);
    const keys = os.getAllKeys(imagesOf(boardId));
    const values = os.getAll(imagesOf(boardId));
    values.onsuccess = () => resolve(new Map(keys.result.map((k, i) => [String(k).slice(boardId.length + 1), values.result[i]])));
    values.onerror = keys.onerror = () => reject(values.error || keys.error);
  });
}

export const store = {
  listBoards: () => run('boards', 'readonly', (tx) => tx.objectStore('boards').getAll()),
  getBoard: (id) => run('boards', 'readonly', (tx) => tx.objectStore('boards').get(id)),
  putBoard: (record) => run('boards', 'readwrite', (tx) => tx.objectStore('boards').put(record)),
  // Delete a board with all its images and its preview.
  deleteBoard: (id) => run(['boards', 'images', 'thumbs', 'previews', 'sketches'], 'readwrite', (tx) => {
    tx.objectStore('sketches').delete(imagesOf(id));
    tx.objectStore('boards').delete(id);
    tx.objectStore('thumbs').delete(id);
    tx.objectStore('images').delete(imagesOf(id));
    tx.objectStore('previews').delete(imagesOf(id));
  }),

  // Images are kept exactly as they came in (full size, never re-compressed).
  saveImage: (boardId, imageId, blob) => run(['images', 'previews'], 'readwrite', (tx) => {
    tx.objectStore('previews').delete(`${boardId}/${imageId}`);
    return tx.objectStore('images').put(blob, `${boardId}/${imageId}`);
  }),
  deleteImage: (boardId, imageId) => run(['images', 'previews'], 'readwrite', (tx) => {
    tx.objectStore('previews').delete(`${boardId}/${imageId}`);
    return tx.objectStore('images').delete(`${boardId}/${imageId}`);
  }),
  loadImage: (boardId, imageId) => run('images', 'readonly', (tx) => tx.objectStore('images').get(`${boardId}/${imageId}`)),
  // Everything kept for a board in one go (much quicker than asking a thousand times):
  // a Map from image id (as text) to its file, or to its saved preview.
  loadImages: (boardId) => allOf('images', boardId),
  loadPreviews: (boardId) => allOf('previews', boardId),

  // A small copy of each big image, so big boards open quickly: { w, h, blob } (w x h is
  // the full image's size; blob is null for images small enough to show as they are).
  savePreview: (boardId, imageId, rec) => run('previews', 'readwrite', (tx) => tx.objectStore('previews').put(rec, `${boardId}/${imageId}`)),
  // A sketch's layers, so it can be opened again in the Sketch studio:
  // { w, h, paper, layers: [{ name, visible, opacity, blob }] }.
  saveSketch: (boardId, imageId, rec) => run('sketches', 'readwrite', (tx) => tx.objectStore('sketches').put(rec, `${boardId}/${imageId}`)),
  loadSketch: (boardId, imageId) => run('sketches', 'readonly', (tx) => tx.objectStore('sketches').get(`${boardId}/${imageId}`)),
  loadPreview: (boardId, imageId) => run('previews', 'readonly', (tx) => tx.objectStore('previews').get(`${boardId}/${imageId}`)),

  saveFont: (name, blob) => run('fonts', 'readwrite', (tx) => tx.objectStore('fonts').put(blob, name)),
  listFonts: async () => {
    const names = await run('fonts', 'readonly', (tx) => tx.objectStore('fonts').getAllKeys());
    const blobs = await run('fonts', 'readonly', (tx) => tx.objectStore('fonts').getAll());
    return names.map((name, i) => ({ name, blob: blobs[i] }));
  },

  saveThumb: (boardId, blob) => run('thumbs', 'readwrite', (tx) => tx.objectStore('thumbs').put(blob, boardId)),
  loadThumb: (boardId) => run('thumbs', 'readonly', (tx) => tx.objectStore('thumbs').get(boardId)),
};

// Ask Chrome to keep our storage even when the disk is getting full.
// (Chrome decides by itself; it usually agrees for sites you use often.)
export function askToKeepStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

// Whether Chrome has promised to keep the boards (it won't clear them to free up space).
export async function storageIsKept() {
  try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
}
