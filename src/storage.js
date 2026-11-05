// Saving and opening boards.
//
// Two kinds of saving:
//   1. Board files (.refboard). One file holds the whole board: every image, where
//      it sits, and the pane layout. You can send it to anyone; they open it by
//      dropping it on the website. Inside, it's an ordinary zip file, so the
//      images can also be pulled out with any unzip tool.
//   2. Autosave. Chrome keeps a copy of the current board on your computer, so
//      closing the tab never loses work. It lives only in this browser.

import { zip, unzip, strToU8, strFromU8 } from '../vendor/fflate.mjs';

export const FILE_EXT = '.refboard';
const FORMAT = 'reference-board';
const VERSION = 1;

const EXT_FOR_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
const TYPE_FOR_EXT = Object.fromEntries(Object.entries(EXT_FOR_TYPE).map(([t, e]) => [e, t]));
TYPE_FOR_EXT.jpeg = 'image/jpeg';

// A plain description of the board: images (without their pixels) and layout.
export function describeBoard(board, layout) {
  const items = board.toJSON().map((d, i) => {
    const blob = board.items[i].blob;
    const ext = EXT_FOR_TYPE[blob?.type] || 'png';
    return { ...d, file: `images/${d.id}.${ext}` };
  });
  return { format: FORMAT, version: VERSION, items, layout: layout.toJSON() };
}

// ---------- Board files ----------

// Pack the board into a single .refboard file (a zip).
export async function packBoard(board, layout) {
  const data = describeBoard(board, layout);
  const files = { 'board.json': [strToU8(JSON.stringify(data, null, 1)), { level: 6 }] };
  await Promise.all(board.items.map(async (item, i) => {
    if (!item.blob) return;
    // Images are already compressed, so we store them as they are (level 0 = no extra squeezing).
    files[data.items[i].file] = [new Uint8Array(await item.blob.arrayBuffer()), { level: 0 }];
  }));
  const bytes = await new Promise((resolve, reject) => zip(files, (err, out) => (err ? reject(err) : resolve(out))));
  return new Blob([bytes], { type: 'application/zip' });
}

// Read a .refboard file. Returns the description and the images as Blobs.
export async function unpackBoard(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let files;
  try {
    files = await new Promise((resolve, reject) => unzip(bytes, (err, out) => (err ? reject(err) : resolve(out))));
  } catch {
    throw new Error("That file isn't a reference board, or it's damaged.");
  }
  if (!files['board.json']) throw new Error("That file isn't a reference board.");
  const data = JSON.parse(strFromU8(files['board.json']));
  if (data.format !== FORMAT) throw new Error("That file isn't a reference board.");
  if (data.version > VERSION) throw new Error('That board was made with a newer version. Refresh the page to update.');
  const images = new Map();
  for (const item of data.items) {
    const raw = files[item.file];
    if (!raw) continue;
    const ext = item.file.split('.').pop().toLowerCase();
    images.set(item.file, new Blob([raw], { type: TYPE_FOR_EXT[ext] || 'image/png' }));
  }
  return { data, images };
}

export function isBoardFile(file) {
  return file.name?.toLowerCase().endsWith(FILE_EXT);
}

// Chrome (and Edge) can save straight to a file you pick, and save to it again
// with Ctrl/⌘+S. Other browsers fall back to downloading a copy.
export const canPickFiles = 'showSaveFilePicker' in window;

const PICKER_TYPES = [{ description: 'Reference board', accept: { 'application/x-reference-board': [FILE_EXT] } }];

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
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: FILE_EXT });
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

// ---------- Autosave (IndexedDB, Chrome's built-in storage) ----------
//
// Images are stored one by one, once each, when they're added, and the small
// board description is rewritten on every change. That keeps autosave fast even
// for boards with many large images.

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('reference-board', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('images');
      req.result.createObjectStore('state');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const autosave = {
  saveImage: (id, blob) => run('images', 'readwrite', (s) => s.put(blob, id)),
  deleteImage: (id) => run('images', 'readwrite', (s) => s.delete(id)),
  saveState: (state) => run('state', 'readwrite', (s) => s.put(state, 'current')),
  loadState: () => run('state', 'readonly', (s) => s.get('current')),
  loadImage: (id) => run('images', 'readonly', (s) => s.get(id)),
  clearImages: () => run('images', 'readwrite', (s) => s.clear()),
};
