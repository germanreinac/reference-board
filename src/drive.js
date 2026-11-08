// Google Drive: your boards in your own Drive, so they follow you to other computers
// and your phone. Nothing goes to us; the app talks to Google directly from your browser.
//
// What's in your Drive:
//   Art Direction/                 a folder the app makes
//     Characters/                  one folder per board (renamed with the board)
//       board.json                 where everything sits, captions, notes…
//       hero-12.png …              the images, one file each
//
// Permission: "see and change only the files this app made" (drive.file). The app can't
// see anything else in your Drive.
//
// Sync, every few minutes and when you come back to the tab:
//   - boards changed here are sent up (only new images are uploaded)
//   - boards changed on another device come down (only missing images are downloaded)
//   - photos saved from the phone page ("incoming") are placed on their board
// A board that's open on screen is only updated from Drive the next time it's opened,
// so nothing changes under your hands. If a board changed in both places, the most
// recent change wins.

import { store } from './storage.js';

export const CLIENT_ID = '856304417844-lb59l8pm1h56pecdps2rhdfd0mbtkimo.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const KEY = 'refboard.drive';          // { connected, token, expires, rootId, boards: [{id, name}] }

// ---------- Settings kept in this browser ----------

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(patch) {
  const next = { ...load(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}
export const isConnected = () => !!load().connected;
// Boards seen in Drive last time (for the phone page, which may have no boards of its own).
export const knownBoards = () => load().boards || [];
export const lastError = () => load().lastError || '';

// ---------- Signing in ----------

let gisLoading = null;
function loadGoogle() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisLoading = null; reject(new Error("Couldn't reach Google. Check your internet connection.")); };
    document.head.appendChild(s);
  });
  return gisLoading;
}

// Ask Google for permission (opens Google's own sign-in window). `interactive` must be
// true when called from a click; otherwise browsers block the window.
async function requestToken(interactive) {
  await loadGoogle();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (res) => {
        if (res.error || !res.access_token) {
          reject(new Error(res.error === 'access_denied' ? 'Google said access was denied. Is your Google account listed under Test users in the Google Cloud console?' : `Google sign-in: ${res.error_description || res.error || 'cancelled'}`));
          return;
        }
        const expires = Date.now() + (Number(res.expires_in) || 3600) * 1000 - 60000;
        save({ connected: true, token: res.access_token, expires });
        resolve(res.access_token);
      },
      error_callback: (err) => reject(new Error({
        popup_closed: 'The Google sign-in window was closed before finishing.',
        popup_failed_to_open: 'Chrome blocked the Google sign-in window. Allow pop-ups for artdirection.io (icon at the right of the address bar) and try again.',
      }[err?.type] || `Google sign-in didn't work (${err?.type || 'unknown'}).`)),
    });
    client.requestAccessToken({ prompt: interactive ? '' : 'none' });
    // If Google never answers (e.g. its window was blocked silently), give up after a while.
    if (!interactive) setTimeout(() => reject(new Error('Google sign-in timed out.')), 20000);
  });
}

// Connect (from a click). Returns true when connected.
export async function connect() {
  await requestToken(true);
  return true;
}

export function disconnect() {
  const { token } = load();
  if (token) window.google?.accounts?.oauth2?.revoke?.(token, () => {});
  try { localStorage.removeItem(KEY); } catch {}
}

// A working access token, or null if you need to click "Reconnect" (Google's sign-in
// lasts about an hour; after that a click is needed to renew it).
async function token() {
  const s = load();
  if (!s.connected) return null;
  if (s.token && s.expires > Date.now()) return s.token;
  try { return await requestToken(false); } catch { return null; }
}
export const needsReconnect = () => isConnected() && !(load().expires > Date.now());

// ---------- Talking to Drive ----------

class DriveError extends Error {}

async function call(url, opts = {}, retry = true) {
  const t = await token();
  if (!t) throw new DriveError('reconnect');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
  if (res.status === 401 && retry) { save({ token: null, expires: 0 }); return call(url, opts, false); }
  if (!res.ok) {
    // Google explains what's wrong in the reply; pass that on.
    let why = '';
    try { const j = await res.json(); why = j.error?.message || j.error_description || ''; } catch {}
    throw new DriveError(`Google Drive said ${res.status}${why ? `: ${why}` : ''}`);
  }
  return res;
}
const json = async (url, opts) => (await call(url, opts)).json();

// Files matching a search, with the details we use.
async function list(q) {
  const out = [];
  let page = '';
  do {
    const params = new URLSearchParams({ q, spaces: 'drive', pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,appProperties,size)' });
    if (page) params.set('pageToken', page);
    const r = await json(`${API}/files?${params}`);
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}
const tagged = (_, value) => `appProperties has { key='refboard' and value='${value}' } and trashed = false`;

async function createFolder(name, parent, props) {
  return json(`${API}/files?fields=id,name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined, appProperties: props }),
  });
}

// Upload a new file (metadata and contents in one go).
async function upload(blob, meta) {
  const boundary = `rb${Math.random().toString(36).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob,
    `\r\n--${boundary}--`,
  ]);
  return json(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
}
// Replace a file's contents.
const replace = (id, blob) => json(`${UPLOAD}/files/${id}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
const patch = (id, meta) => json(`${API}/files/${id}?fields=id,name,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
const trash = (id) => patch(id, { trashed: true });
const download = async (id) => (await call(`${API}/files/${id}?alt=media`)).blob();

async function rootFolder() {
  const s = load();
  if (s.rootId) return s.rootId;
  const found = await list(tagged('refboard', 'root'));
  const id = found[0]?.id || (await createFolder('Art Direction', null, { refboard: 'root' })).id;
  save({ rootId: id });
  return id;
}

// ---------- Sync ----------

// Run `work` on every item, `n` at a time.
async function inParallel(list, n, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) await work(list[next++]);
  }));
}

const extOf = (type) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[type] || 'png');
const safeName = (s) => String(s || 'image').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'image';

// hooks: { beforeSync(), isOpen(boardId), queueForBoard(boardId, blob, name, sourceUrl),
//          boardsChanged(), onStatus(state, detail) }
let running = null;
export function sync(hooks) {
  running ??= doSync(hooks).finally(() => { running = null; });
  return running;
}

async function doSync(hooks) {
  if (!isConnected()) return;
  hooks.onStatus('syncing');
  try {
    if (!(await token())) { hooks.onStatus('reconnect'); return; }
    await hooks.beforeSync?.();
    const root = await rootFolder();
    const [folders, datas, incoming] = await Promise.all([
      list(tagged('refboard', 'board')),
      list(tagged('refboard', 'data')),
      list(tagged('refboard', 'incoming')),
    ]);
    const dataOf = new Map(datas.map((f) => [f.parents?.[0], f]));
    const remote = new Map(folders.map((f) => [f.appProperties?.boardId, f]));
    save({ boards: folders.map((f) => ({ id: f.appProperties?.boardId, name: f.name, folderId: f.id })) });
    let changed = false;

    // 1. Boards on Drive: bring down what's newer there. Each board appears as soon as it's
    //    in; smaller boards first, so the list fills up quickly. Images come several at once.
    const toGet = [];
    for (const [boardId, folder] of remote) {
      if (!boardId) continue;
      const data = dataOf.get(folder.id);
      if (!data || hooks.isOpen(boardId)) continue;
      const local = await store.getBoard(boardId);
      const remoteTime = Date.parse(data.modifiedTime);
      if (local?.drive?.remoteTime >= remoteTime) continue;              // nothing new up there
      if (local && local.updated > (local.drive?.syncedAt || 0) && local.updated > remoteTime) continue;  // ours is newer: sent up below
      toGet.push({ boardId, folder, data, local, remoteTime });
    }
    toGet.sort((a, b) => (Number(a.data.size) || 0) - (Number(b.data.size) || 0));
    let boardsDone = 0, imagesDone = 0, imagesTotal = 0;
    const progress = () => hooks.onProgress?.(toGet.length ? `Getting your boards from Drive… ${boardsDone} of ${toGet.length}${imagesTotal ? ` · ${imagesDone} of ${imagesTotal} images` : ''}` : '');
    for (const job of toGet) {
      const { boardId, folder, data, local, remoteTime } = job;
      try {
        const parsed = JSON.parse(await (await download(data.id)).text());
        const images = parsed.driveImages || {};
        const items = parsed.board?.items || [];
        const missing = [];
        for (const item of items) if (images[item.id] && !(await store.loadImage(boardId, item.id).catch(() => null))) missing.push(item);
        imagesTotal += missing.length;
        progress();
        await inParallel(missing, 6, async (item) => {
          try { await store.saveImage(boardId, item.id, await download(images[item.id])); } catch (err) { console.warn('Drive: image skipped', err); }
          imagesDone++;
          if (imagesDone % 5 === 0) progress();
        });
        const board = { ...(parsed.board || {}), incoming: local?.board?.incoming || [] };
        await store.putBoard({
          ...(local || { id: boardId, created: parsed.created || Date.now(), handle: null }),
          name: parsed.name || folder.name, updated: parsed.updated || remoteTime, board,
          drive: { folderId: folder.id, dataId: data.id, images, remoteTime, syncedAt: Date.now() },
        });
        changed = true;
        hooks.boardsChanged?.();       // show it on the home screen straight away
      } catch (err) {
        console.warn(`Drive: couldn't get "${folder.name}"`, err);
        if (err.message === 'reconnect') throw err;
      }
      boardsDone++;
      progress();
    }
    hooks.onProgress?.('');

    // 2. Boards changed here: send them up.
    for (const rec of await store.listBoards()) {
      const d = rec.drive || {};
      if (d.syncedAt && rec.updated <= d.syncedAt && remote.has(rec.id)) continue;
      const fresh = await store.getBoard(rec.id);   // the latest, in case it was just saved
      await pushBoard(fresh, root, remote.get(rec.id), dataOf);
      changed = true;
    }

    // 3. Photos saved from the phone page: put them on their boards.
    for (const f of incoming) {
      const folder = folders.find((x) => x.id === f.parents?.[0]);
      const boardId = folder?.appProperties?.boardId;
      if (!boardId || !(await store.getBoard(boardId))) continue;
      const blob = await download(f.id);
      await hooks.queueForBoard(boardId, blob, f.appProperties?.name || f.name.replace(/\.[a-z0-9]+$/i, ''), '');
      await trash(f.id);
      changed = true;
    }

    if (changed) hooks.boardsChanged?.();
    save({ lastError: '' });
    hooks.onStatus('synced');
  } catch (err) {
    console.warn('Drive sync', err);
    save({ lastError: err.message, lastErrorAt: Date.now() });
    hooks.onStatus(err.message === 'reconnect' ? 'reconnect' : 'error', err.message);
  }
}

// Send one board up: its folder (renamed if needed), new images, then board.json.
async function pushBoard(rec, root, folder, dataOf) {
  const d = { images: {}, ...(rec.drive || {}) };
  if (!folder) {
    folder = await createFolder(safeName(rec.name), root, { refboard: 'board', boardId: rec.id });
  } else if (folder.name !== safeName(rec.name)) {
    await patch(folder.id, { name: safeName(rec.name) });
  }
  d.folderId = folder.id;
  const items = rec.board?.items || [];
  const keep = new Set(items.map((i) => String(i.id)));
  for (const item of items) {
    if (d.images[item.id]) continue;
    const blob = await store.loadImage(rec.id, item.id).catch(() => null);
    if (!blob) continue;
    const up = await upload(blob, { name: `${safeName(String(item.name || 'image').replace(/\.[a-z0-9]{2,4}$/i, ''))}-${item.id}.${extOf(blob.type)}`, parents: [folder.id], appProperties: { refboard: 'image', itemId: String(item.id) } });
    d.images[item.id] = up.id;
  }
  // Images removed from the board go to Drive's bin (recoverable for 30 days).
  for (const [itemId, fileId] of Object.entries(d.images)) {
    if (!keep.has(String(itemId))) { await trash(fileId).catch(() => {}); delete d.images[itemId]; }
  }
  const { incoming, ...board } = rec.board || {};
  const payload = new Blob([JSON.stringify({ name: rec.name, created: rec.created, updated: rec.updated, board, driveImages: d.images })], { type: 'application/json' });
  const dataId = d.dataId || dataOf.get(folder.id)?.id;
  const res = dataId ? await replace(dataId, payload) : await upload(payload, { name: 'board.json', parents: [folder.id], appProperties: { refboard: 'data' } });
  d.dataId = res.id;
  d.remoteTime = Date.parse(res.modifiedTime) || Date.now();
  d.syncedAt = Date.now();
  // Write the Drive details back without touching anything else that may have changed.
  const latest = await store.getBoard(rec.id);
  if (latest) await store.putBoard({ ...latest, drive: d });
  driveUpdated(rec.id, d);
}

// main.js keeps the open boards' details in memory; it listens for this.
function driveUpdated(boardId, drive) {
  window.dispatchEvent(new CustomEvent('drive-updated', { detail: { boardId, drive } }));
}

// A board was deleted here: send its Drive folder to the bin too.
export async function removeBoard(rec) {
  if (!isConnected() || !rec?.drive?.folderId) return;
  try { await trash(rec.drive.folderId); } catch (err) { console.warn('Drive: could not remove folder', err); }
}

// ---------- The phone page: save photos to a board's folder ----------

export async function sendPhoto(boardId, file) {
  const s = load();
  let folderId = (s.boards || []).find((b) => b.id === boardId)?.folderId;
  if (!folderId) {
    const local = await store.getBoard(boardId);
    folderId = local?.drive?.folderId;
  }
  if (!folderId) throw new Error('That board isn\'t in Drive yet. Open Art Direction on your computer once so it syncs.');
  const name = safeName(file.name.replace(/\.[a-z0-9]+$/i, '')) || 'photo';
  await upload(file, { name: `${name}.${extOf(file.type)}`, parents: [folderId], appProperties: { refboard: 'incoming', name } });
}

// Refresh the list of boards in Drive (for the phone page).
export async function listDriveBoards() {
  const folders = await list(tagged('refboard', 'board'));
  const boards = folders.map((f) => ({ id: f.appProperties?.boardId, name: f.name, folderId: f.id, modified: f.modifiedTime })).filter((b) => b.id);
  save({ boards });
  return boards;
}

export const driveFolderUrl = () => (load().rootId ? `https://drive.google.com/drive/folders/${load().rootId}` : 'https://drive.google.com/');
