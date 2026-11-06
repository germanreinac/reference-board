// Starts the app and connects everything: the home screen, panes, mouse, keyboard,
// drag-and-drop, paste, the right-click menu, board files and saving.
//
// The address bar says where you are:
//   #/              the home screen (your boards)
//   #/board/<id>    one board
// so the browser's Back button and bookmarks just work.

import { Application } from '../vendor/pixi.min.mjs';
import { Board } from './board.js';
import { Layout } from './layout.js';
import { Viewports } from './viewports.js';
import { Home } from './home.js';
import { imagesFromDrop, imagesFromPaste } from './importer.js';
import { showMenu, hideMenu } from './menu.js';
import { History } from './history.js';
import { Toolbar, BrushCursor, TOOL_KEYS } from './tools.js';
import { NoteEditor } from './note-editor.js';
import { createEditor } from './editors.js';
import { RESULT_DRAG_TYPE } from './search-pane.js';
import { SOURCES, loadKeys, downloadResult } from './sources.js';
import { TYPE_ICONS, TYPE_NAMES } from './viewports.js';
import { PANE_TYPES } from './layout.js';
import {
  FILE_EXT, packBoard, unpackBoard, isBoardFile, describeBoard, canPickFiles,
  pickSaveLocation, ensureWritePermission, writeToHandle, pickBoardToOpen, downloadBlob,
  store, newBoardId, askToKeepStorage,
} from './storage.js';

const BOARD_COLOUR = '#1b1b1d';
const GAP_COLOUR = '#0e0e0f';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
document.querySelectorAll('.mod-key').forEach((el) => (el.textContent = isMac ? '⌘' : 'Ctrl'));

// ---------- Set up the drawing surface ----------

const app = new Application();
await app.init({
  resizeTo: window,
  background: GAP_COLOUR,                 // shows through as the thin lines between panes
  antialias: true,
  autoDensity: true,                      // sharp on high-resolution screens
  resolution: window.devicePixelRatio || 1,
  autoStart: false,                       // only redraw when something changes (saves battery)
  preference: 'webgl',
});
document.getElementById('stage').appendChild(app.canvas);

const board = new Board();
const panesEl = document.getElementById('panes');
const viewports = new Viewports({
  app, board, layout: new Layout(), element: panesEl, background: BOARD_COLOUR,
  requestRender: () => requestRender(),
  onPaneAction: (action, pane, button) => paneAction(action, pane, button),
  onLayoutChanged: () => viewChanged(),
  createEditor: (pane, host) => createEditor(pane, host, {
    add: (result) => addSearchResult(result),
    changed: () => viewChanged(),
    toast: (m) => toast(m),
    addImage: (blob, name) => addBlobToBoard(blob, name),
  }),
});
const layout = () => viewports.layout;

// The panes showing the board (not search or the mannequin).
const boardPanes = () => layout().visiblePanes().filter((p) => p.type === 'board');
// The board pane under the mouse, or else the first one on screen. Can be null.
function targetBoardPane(x = mouse.x, y = mouse.y) {
  const p = x === null ? null : viewports.paneAt(x, y);
  return p?.type === 'board' ? p : boardPanes()[0] || null;
}

// Which screen is showing: 'home' or 'board'.
let mode = 'home';
function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  hideMenu();
  if (m === 'board') {
    viewports.position();
    requestRender();
  }
}

// ---------- Redrawing ----------

// Instead of redrawing 60 times a second all the time, we ask for one redraw
// whenever something changes. Several requests in the same frame become one.
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (mode !== 'board') return;
    // Keep note text sharp for the most zoomed-in pane.
    const maxZoom = Math.max(1, ...boardPanes().map((p) => p.camera.zoom));
    board.updateTextSharpness(maxZoom, app.renderer.resolution);
    viewports.render();
    noteEditor.position();
    placeToolbar();
    emptyHint.classList.toggle('hidden', !board.isEmpty() || noteEditor.editing);
  });
}
window.addEventListener('resize', () => { if (mode === 'board') { viewports.position(); requestRender(); } });

const emptyHint = document.getElementById('empty-hint');

// Keep the drawing toolbar at the bottom middle of the biggest board pane
// (hidden when no pane shows the board).
function placeToolbar() {
  const el = document.getElementById('toolbar');
  const panes = boardPanes();
  el.classList.toggle('no-board', panes.length === 0);
  emptyHint.style.visibility = panes.length ? '' : 'hidden';
  if (!panes.length) return;
  const r = panes.reduce((a, b) => (b.rect.w * b.rect.h > a.rect.w * a.rect.h ? b : a)).rect;
  // The "drop images here" hint goes in the middle of that pane too.
  Object.assign(emptyHint.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const half = el.offsetWidth / 2;
  const x = Math.min(Math.max(r.x + r.w / 2, half + 8), window.innerWidth - half - 8);
  el.style.left = `${x}px`;
  el.style.bottom = `${window.innerHeight - (r.y + r.h) + 12}px`;
}

// ---------- Messages ----------

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message, ms = 4000) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------- The open board and saving ----------

// The board that's open: { id, name, created, updated, handle }. null on the home screen.
// (`handle` is the file on disk that Ctrl/⌘+S saves to, once you've saved it to a file.)
let current = null;

const nameInput = document.getElementById('board-name');
function updateTitle() {
  const name = current?.name || 'Reference Board';
  if (document.activeElement !== nameInput) nameInput.value = current?.name || '';
  document.title = current ? `${name} – Reference Board` : 'Reference Board';
}

// Something on the board changed (images added, moved, removed...).
let thumbStale = false;
function contentChanged() {
  if (!current) return;
  current.updated = Date.now();
  thumbStale = true;
  scheduleSave();
}

// Only the view changed (pan, zoom, panes). Remembered, but doesn't change "last edited".
function viewChanged() {
  scheduleSave();
}

let saveTimer;
let loading = false;
let lastThumb = 0;
function scheduleSave() {
  if (loading || !current) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 600);
}

// Write the open board to Chrome's storage. The preview picture is updated at
// most every 10 seconds while you work, and always when you leave the board.
async function saveNow({ thumb = false } = {}) {
  clearTimeout(saveTimer);
  if (!current || loading) return;
  const id = current.id;
  try {
    await store.putBoard({ ...current, board: describeBoard(board, layout()) });
    if (thumbStale && (thumb || Date.now() - lastThumb > 10000)) {
      thumbStale = false;
      lastThumb = Date.now();
      await store.saveThumb(id, await viewports.snapshot());
    }
  } catch (err) {
    console.warn('Saving failed', err);
    toast("Couldn't save to Chrome's storage. Save the board to a file to be safe.");
  }
}
// Save when the tab is hidden or closed.
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow({ thumb: true }); });

// ---------- Adding images ----------

async function decode(blob, name) {
  try {
    return await createImageBitmap(blob);
  } catch {
    toast(`Couldn't read "${name}". The file may be damaged or in an unsupported format.`);
    return null;
  }
}

// Decode images and place them side by side around a board position.
async function addImages(list, wx, wy, pane) {
  if (!current) return;
  const boardId = current.id;
  const wasEmpty = board.isEmpty();
  const GAP = 20;
  // createImageBitmap does the heavy decoding off the main thread,
  // so the app stays responsive while big files load.
  const decoded = (await Promise.all(list.map(async (entry) => {
    const bitmap = await decode(entry.blob, entry.name);
    return bitmap && { entry, bitmap };
  }))).filter(Boolean);
  if (!decoded.length || current?.id !== boardId) return;

  const totalWidth = decoded.reduce((sum, d) => sum + d.bitmap.width, 0) + GAP * (decoded.length - 1);
  let x = wx - totalWidth / 2;
  const added = [];
  for (const { entry, bitmap } of decoded) {
    const item = board.addImage(bitmap, x + bitmap.width / 2, wy, entry);
    x += bitmap.width + GAP;
    added.push(item);
    store.saveImage(boardId, item.id, entry.blob).catch((err) => console.warn('Saving image failed', err));
  }
  board.selected = added[added.length - 1];
  // On an empty board, zoom so the first images fit nicely.
  if (wasEmpty) fitPane(pane, null);
  const saved = added.map((item) => ({ ...board.imageJSON(item), blob: item.blob }));
  history.push({
    undo: () => saved.forEach((d) => removeImageById(d.id)),
    redo: () => Promise.all(saved.map((d) => restoreImage(d))),
  });
  contentChanged();
  requestRender();
}

// Put an image back (undo and redo use this).
async function restoreImage(data) {
  const bitmap = await decode(data.blob, data.name);
  if (!bitmap || !current) return;
  board.addImage(bitmap, data.x, data.y, data);
  store.saveImage(current.id, data.id, data.blob).catch(() => {});
  requestRender();
}

function removeImageById(id) {
  const item = board.find('image', id);
  if (!item) return;
  if (current) store.deleteImage(current.id, item.id).catch(() => {});
  board.remove(item);
  requestRender();
}

// Delete the selected image or note.
function removeSelected() {
  const item = board.selected;
  if (!item) return;
  if (item.kind === 'note') {
    const data = board.noteJSON(item);
    data.index = board.remove(item);
    history.push({ undo: () => { board.addNote(data); requestRender(); }, redo: () => removeNoteById(data.id) });
  } else {
    const data = { ...board.imageJSON(item), blob: item.blob, index: board.items.indexOf(item) };
    removeImageById(item.id);
    history.push({ undo: () => restoreImage(data), redo: () => removeImageById(data.id) });
  }
  contentChanged();
  requestRender();
}

function removeNoteById(id) {
  const note = board.find('note', id);
  if (note) board.remove(note);
  requestRender();
}

// Zoom a pane so these images and notes fill it (null = everything on the board).
// With no pane given, every visible pane.
function fitPane(pane, items) {
  const bounds = board.bounds(items);
  if (!bounds) return;
  for (const p of pane ? [pane] : boardPanes()) p.camera.frame(bounds, p.rect.w, p.rect.h, 60);
  viewChanged();
}

// ---------- Opening and closing boards ----------

// Put a saved board on screen. `getBlob(item)` fetches each image's file.
async function loadBoard(data, getBlob) {
  loading = true;
  try {
    board.clear();
    const items = data?.items || [];
    const blobs = await Promise.all(items.map((item) => Promise.resolve(getBlob(item)).catch(() => null)));
    const bitmaps = await Promise.all(items.map((item, i) => (blobs[i] ? decode(blobs[i], item.name) : null)));
    let missing = 0;
    items.forEach((item, i) => {
      if (!bitmaps[i]) { missing++; return; }
      board.addImage(bitmaps[i], item.x, item.y, { ...item, blob: blobs[i] });
    });
    for (const s of data?.strokes || []) board.addStroke(s);
    for (const n of data?.notes || []) board.addNote(n);
    board.selected = null;
    viewports.setLayout(data?.layout ? Layout.fromJSON(data.layout) : new Layout());
    if (missing) toast(`${missing} image${missing > 1 ? 's' : ''} couldn't be loaded.`);
  } finally {
    loading = false;
  }
}

async function openBoardById(id) {
  const record = await store.getBoard(id);
  if (!record) {
    toast('That board no longer exists.');
    location.hash = '#/';
    return;
  }
  const { board: data, ...meta } = record;
  current = meta;
  history.clear();
  updateHistoryButtons();
  await loadBoard(data, (item) => store.loadImage(id, item.id));
  // Boards opened from a file, or from the first version, may not have a preview yet.
  thumbStale = !board.isEmpty() && !(await store.loadThumb(id).catch(() => null));
  updateTitle();
}

// Save the open board, then free its images from memory.
async function leaveBoard() {
  if (!current) return;
  noteEditor.finish();
  await saveNow({ thumb: true });
  history.clear();
  current = null;
  board.clear();
  viewports.setLayout(new Layout());
  updateTitle();
}

// Work out what to show from the address bar. Runs one at a time, in order.
let routing = Promise.resolve();
function route() {
  routing = routing.then(doRoute).catch((err) => {
    console.error(err);
    toast('Something went wrong opening that board.');
  });
  return routing;
}
async function doRoute() {
  const id = location.hash.match(/^#\/board\/([\w-]+)/)?.[1];
  if (id) {
    if (current?.id !== id) {
      await leaveBoard();
      setMode('board');
      await openBoardById(id);
    }
    if (current) setMode('board');
  } else {
    await leaveBoard();
    setMode('home');
    await home.refresh();
  }
}
window.addEventListener('hashchange', route);

const goHome = () => { location.hash = '#/'; };
const openBoard = (id) => { location.hash = `#/board/${id}`; };
// Open a board and wait until it's on screen.
async function openBoardNow(id) {
  openBoard(id);
  await route();
}

// "Untitled board", "Untitled board 2", ...
async function freeName(base) {
  const names = new Set((await store.listBoards()).map((b) => b.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

async function createBoard({ name, data = null } = {}) {
  const now = Date.now();
  const id = newBoardId();
  await store.putBoard({
    id, name: await freeName(name || 'Untitled board'), created: now, updated: now, handle: null,
    board: data || { items: [], layout: null },
  });
  askToKeepStorage();
  return id;
}

async function newBoard() {
  openBoard(await createBoard());
}

async function renameBoard(id, name) {
  if (current?.id === id) {
    current.name = name;
    updateTitle();
    await saveNow();
    return;
  }
  const record = await store.getBoard(id);
  if (record) await store.putBoard({ ...record, name });
}

async function deleteBoard(id, name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  await store.deleteBoard(id);
  await home.refresh();
}

// ---------- Board files ----------

// Add a .refboard file as a new board. Returns the new board's id.
async function importBoardFile(file, handle = null) {
  toast(`Opening ${file.name}…`, 60000);
  const { data, images } = await unpackBoard(file);
  const id = newBoardId();
  await Promise.all(data.items.map((item) => {
    const blob = images.get(item.file);
    return blob ? store.saveImage(id, item.id, blob) : null;
  }));
  const now = Date.now();
  await store.putBoard({ id, name: await freeName(file.name.replace(/\.refboard$/i, '')), created: now, updated: now, handle, board: data });
  askToKeepStorage();
  toast(`Added ${file.name}`, 1500);
  return id;
}

async function openFile() {
  try {
    const picked = await pickBoardToOpen();
    if (picked) openBoard(await importBoardFile(picked.file, picked.handle));
  } catch (err) {
    toast(err.message || "Couldn't open that file.");
  }
}

// Save a board to a file. `handle` is where to save (null = ask).
// Asking happens first, while Chrome still counts it as your click.
async function writeBoardFile({ name, handle, getData, getBlob }) {
  if (canPickFiles) {
    if (handle) await ensureWritePermission(handle);
    else handle = await pickSaveLocation(name + FILE_EXT);
    if (!handle) return null;  // cancelled
    toast('Saving…', 60000);
    await writeToHandle(handle, await packBoard(getData(), getBlob));
  } else {
    // Other browsers: download a copy instead.
    downloadBlob(await packBoard(getData(), getBlob), name + FILE_EXT);
  }
  toast(`Saved ${handle?.name || name + FILE_EXT}`, 1500);
  return handle;
}

let saving = false;
async function saveToFile({ saveAs = false } = {}) {
  if (saving || !current) return;
  saving = true;
  try {
    const blobs = new Map(board.items.map((i) => [i.id, i.blob]));
    const handle = await writeBoardFile({
      name: current.name,
      handle: saveAs ? null : current.handle,
      getData: () => describeBoard(board, layout()),
      getBlob: (item) => blobs.get(item.id),
    });
    if (handle && current) {
      current.handle = handle;
      saveNow();
    }
  } catch (err) {
    toast(err.message || "Couldn't save the board.");
  } finally {
    saving = false;
  }
}

// From the home screen: save any board to a file without opening it.
async function exportBoard(id) {
  try {
    const record = await store.getBoard(id);
    if (!record) return;
    await writeBoardFile({
      name: record.name,
      handle: null,
      getData: () => record.board,
      getBlob: (item) => store.loadImage(id, item.id),
    });
  } catch (err) {
    toast(err.message || "Couldn't save the board.");
  }
}

// ---------- Home screen ----------

const home = new Home(document.getElementById('home'), {
  open: openBoard,
  create: newBoard,
  importFile: openFile,
  rename: renameBoard,
  exportFile: exportBoard,
  remove: deleteBoard,
});

// ---------- Board name and home button ----------

document.getElementById('home-button').addEventListener('click', goHome);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') {
    if (e.key === 'Escape') nameInput.value = current?.name || '';
    nameInput.blur();
  }
});
nameInput.addEventListener('blur', () => {
  const value = nameInput.value.trim();
  if (current && value && value !== current.name) renameBoard(current.id, value);
  else updateTitle();
});

// ---------- Panes ----------

function paneAction(action, pane, button) {
  const l = layout();
  if (action === 'type') {
    const r = button.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, PANE_TYPES.map((t) => ({
      label: `${pane.type === t ? '✓ ' : ''}${TYPE_NAMES[t]}`,
      action: () => setPaneType(pane, t),
    })));
    return;
  }
  if (action === 'split-row' || action === 'split-col') {
    if (!l.split(pane, action === 'split-row' ? 'row' : 'col')) {
      toast(l.panes().length >= 16 ? 'That\'s the most panes there can be.' : 'That pane is too small to split.', 2000);
      return;
    }
  } else if (action === 'close') {
    if (!l.close(pane)) return;
  } else if (action === 'maximize') {
    l.toggleMaximize(pane);
  }
  viewports.rebuild();
  viewChanged();
  requestRender();
}

function setPaneType(pane, type) {
  if (pane.type === type) return;
  pane.type = type;
  pane.state = {};
  viewports.rebuild();
  viewChanged();
  requestRender();
  viewports.editorOf(pane)?.focus?.();
}

// Ctrl/⌘+F: go to the search pane, or open one next to the pane you're in.
function openSearch() {
  const existing = layout().visiblePanes().find((p) => p.type === 'search');
  if (existing) return viewports.editorOf(existing)?.focus();
  const pane = hoverPane() || layout().visiblePanes()[0];
  const copy = layout().split(pane, pane.rect.w >= pane.rect.h ? 'row' : 'col');
  if (!copy) return toast('There\'s no room for a search pane here. Make a pane bigger first.');
  copy.type = 'search';
  copy.state = {};
  viewports.rebuild();
  viewChanged();
  requestRender();
  viewports.editorOf(copy)?.focus();
}

// Put an image from search (or from the mannequin) onto the board.
// With no position given: the middle of the board pane you last worked in.
async function addSearchResult(result, at = null) {
  if (!current) return;
  toast('Adding image…', 30000);
  try {
    const { blob, smaller } = await downloadResult(result);
    const source = SOURCES[result.source];
    source?.used?.(result, loadKeys()[result.source]);
    const name = [result.title, result.author && `by ${result.author}`].filter(Boolean).join(' ') || 'image';
    await addBlobToBoard(blob, name, result.pageUrl || result.full, at);
    toast(smaller ? 'Added a smaller version (the original site blocks full-size downloads).' : 'Added to the board', smaller ? 4000 : 1200);
  } catch (err) {
    toast(err.message);
  }
}

async function addBlobToBoard(blob, name, sourceUrl = '', at = null) {
  const pane = at?.pane || targetBoardPane();
  let wx = 0, wy = 0;
  if (at) ({ x: wx, y: wy } = at);
  else if (pane) ({ x: wx, y: wy } = pane.camera.toWorld(pane.rect.w / 2, pane.rect.h / 2));
  await addImages([{ blob, name, sourceUrl }], wx, wy, pane);
}

// ---------- Drag and drop ----------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag-over');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');

  try {
    // A result dragged from the search pane.
    const result = e.dataTransfer.getData(RESULT_DRAG_TYPE);
    if (result && mode === 'board') {
      const pane = targetBoardPane(e.clientX, e.clientY);
      const over = viewports.paneAt(e.clientX, e.clientY);
      // Dropped on the board: put it where it was dropped. Dropped elsewhere: middle of a board pane.
      const at = pane && over === pane ? { ...pane.camera.toWorld(e.clientX - pane.rect.x, e.clientY - pane.rect.y), pane } : null;
      return addSearchResult(JSON.parse(result), at);
    }

    // Board files are added to your boards, never replacing one.
    const boardFiles = [...e.dataTransfer.files].filter(isBoardFile);
    if (boardFiles.length) {
      let lastId;
      for (const f of boardFiles) lastId = await importBoardFile(f);
      if (boardFiles.length === 1) openBoard(lastId);
      else if (mode === 'home') home.refresh();
      return;
    }

    const list = await imagesFromDrop(e.dataTransfer);
    if (list.length === 0) return toast('Nothing to add. Drop image files, images from a web page, or a board file.');

    // Images dropped on the home screen start a new board.
    if (mode === 'home') await openBoardNow(await createBoard());
    const pane = targetBoardPane(e.clientX, e.clientY);
    const over = viewports.paneAt(e.clientX, e.clientY);
    const at = !pane ? { x: 0, y: 0 } : over === pane
      ? pane.camera.toWorld(e.clientX - pane.rect.x, e.clientY - pane.rect.y)
      : pane.camera.toWorld(pane.rect.w / 2, pane.rect.h / 2);
    await addImages(list, at.x, at.y, pane);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Paste ----------

window.addEventListener('paste', async (e) => {
  if (e.target.closest?.('input, textarea')) return;
  try {
    const list = await imagesFromPaste(e.clipboardData);
    if (list.length === 0) return toast('There is no image on the clipboard.');
    // Pasting on the home screen starts a new board.
    if (mode === 'home') await openBoardNow(await createBoard());
    // Paste under the mouse if it's over a pane, otherwise in the middle of the first pane.
    const pane = targetBoardPane();
    if (!pane) return addImages(list, 0, 0, null);
    const local = hoverPane() !== pane
      ? { x: pane.rect.w / 2, y: pane.rect.h / 2 }
      : { x: mouse.x - pane.rect.x, y: mouse.y - pane.rect.y };
    const at = pane.camera.toWorld(local.x, local.y);
    await addImages(list, at.x, at.y, pane);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Undo, tools and notes ----------

const history = new History(() => updateHistoryButtons());
function updateHistoryButtons() {
  toolbar.setHistory(history.done.length > 0, history.undone.length > 0);
}
async function undo() {
  noteEditor.finish();
  await history.undo();
  board.selected = null;
  contentChanged();
  requestRender();
}
async function redo() {
  noteEditor.finish();
  await history.redo();
  board.selected = null;
  contentChanged();
  requestRender();
}

const toolbar = new Toolbar(document.getElementById('toolbar'), {
  onChange: () => { updateCursor(); requestRender(); },
  onUndo: undo,
  onRedo: redo,
});
const brushCursor = new BrushCursor(document.getElementById('brush-cursor'));

// When a note's editing ends: save the text, or remove the note if it's empty.
const noteEditor = new NoteEditor((note, text, oldText) => {
  if (!board.notes.includes(note)) return;
  const isNew = note.isNew;
  delete note.isNew;
  // After placing a note, go back to moving things (like Figma and Miro do).
  if (isNew && toolbar.tool === 'note') toolbar.setTool('select');
  if (!text) {
    board.remove(note);
    if (!isNew) {
      const data = { ...board.noteJSON(note), text: oldText };
      history.push({ undo: () => { board.addNote(data); requestRender(); }, redo: () => removeNoteById(data.id) });
      contentChanged();
    }
  } else if (isNew) {
    board.setNoteText(note, text);
    const data = board.noteJSON(note);
    history.push({ undo: () => removeNoteById(data.id), redo: () => { board.addNote(data); requestRender(); } });
    contentChanged();
  } else if (text !== oldText) {
    board.setNoteText(note, text);
    const id = note.id;
    const setText = (t) => { const n = board.find('note', id); if (n) board.setNoteText(n, t); requestRender(); };
    history.push({ undo: () => setText(oldText), redo: () => setText(text) });
    contentChanged();
  }
  requestRender();
});

function editNote(note, pane) {
  board.selected = null;
  noteEditor.start(note, pane);
  requestRender();
}

// Add a new note where you clicked and start typing in it.
function addNoteAt(pane, wx, wy) {
  // Sized so the text is about 18 pixels tall at the zoom you're working at.
  const note = board.addNote({ x: wx, y: wy, text: '', color: toolbar.color, fontSize: 18 / pane.camera.zoom });
  note.isNew = true;
  editNote(note, pane);
}

// ---------- Mouse and pen ----------

const mouse = { x: null, y: null };
let spaceHeld = false;
// What the current drag is doing:
//   { kind: 'pan', pane }
//   { kind: 'move', pane, item, offsetX, offsetY, from }
//   { kind: 'draw', pane, stroke }
//   { kind: 'erase', pane, removed }
let drag = null;

function hoverPane() {
  return mouse.x === null ? null : viewports.paneAt(mouse.x, mouse.y);
}

function localPoint(pane, e) {
  return { x: e.clientX - pane.rect.x, y: e.clientY - pane.rect.y };
}

// The tablet pen's eraser end reports itself as button 5.
const isPenEraser = (e) => e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);

function updateCursor() {
  panesEl.dataset.tool = toolbar.tool;
  const t = toolbar.tool;
  if (mouse.x !== null && hoverPane()?.type === 'board' && (t === 'pen' || t === 'eraser') && !spaceHeld) brushCursor.show(mouse.x, mouse.y, toolbar.size, t === 'eraser');
  else brushCursor.hide();
}

// Remove the strokes under the eraser.
function eraseAt(pane, e) {
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const radius = toolbar.state.eraserSize / 2 / pane.camera.zoom;
  for (const s of board.strokesAt(w.x, w.y, radius)) {
    drag.removed.push(board.strokeJSON(s));
    board.removeStroke(s);
  }
}

function addPoint(stroke, pane, e) {
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const pressure = e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 0.5;
  stroke.points.push(w.x, w.y, pressure);
}

panesEl.addEventListener('pointerdown', (e) => {
  const pane = viewports.paneFromElement(e.target);
  if (!pane) return;
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (pane.type !== 'board') return;  // search and the mannequin handle their own mouse
  if (document.activeElement === nameInput) nameInput.blur();
  if (e.button === 2) return;  // right button: handled by the menu
  panesEl.setPointerCapture(e.pointerId);

  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const tool = toolbar.tool;

  // Middle button, or Space + left button, always pans.
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    drag = { kind: 'pan', pane };
  } else if (isPenEraser(e) || (e.button === 0 && tool === 'eraser')) {
    board.selected = null;
    drag = { kind: 'erase', pane, removed: [] };
    eraseAt(pane, e);
  } else if (e.button === 0 && tool === 'pen') {
    board.selected = null;
    const stroke = board.addStroke({ points: [], color: toolbar.color, size: toolbar.state.penSize / pane.camera.zoom, simulatePressure: e.pointerType !== 'pen' });
    addPoint(stroke, pane, e);
    board.redrawStroke(stroke, false);
    drag = { kind: 'draw', pane, stroke };
  } else if (e.button === 0 && tool === 'note') {
    e.preventDefault();  // keep the text box focused
    drag = null;
    // While typing, a click elsewhere just finishes the note.
    if (noteEditor.editing) noteEditor.finish();
    else {
      const hit = board.hitTest(w.x, w.y);
      if (hit?.kind === 'note') editNote(hit, pane);
      else addNoteAt(pane, w.x, w.y);
    }
  } else if (e.button === 0) {
    const hit = board.hitTest(w.x, w.y);
    if (hit) {
      // Clicked an image or note: select it, raise it to the top and start moving it.
      board.selected = hit;
      board.bringToFront(hit);
      drag = { kind: 'move', pane, item: hit, offsetX: w.x - hit.sprite.x, offsetY: w.y - hit.sprite.y, from: { x: hit.sprite.x, y: hit.sprite.y }, moved: false };
    } else {
      // Clicked empty space: deselect and pan.
      board.selected = null;
      drag = { kind: 'pan', pane };
    }
  }
  panesEl.classList.toggle('panning', drag?.kind === 'pan');
  updateCursor();
  requestRender();
});

panesEl.addEventListener('pointermove', (e) => {
  const dx = e.clientX - (mouse.x ?? e.clientX);
  const dy = e.clientY - (mouse.y ?? e.clientY);
  mouse.x = e.clientX; mouse.y = e.clientY;
  updateCursor();
  if (!drag) return;
  if (drag.kind === 'pan') {
    drag.pane.camera.panBy(dx, dy);
  } else if (drag.kind === 'move') {
    // It follows the mouse in the pane you're dragging in; every other pane updates too.
    const p = localPoint(drag.pane, e);
    const w = drag.pane.camera.toWorld(p.x, p.y);
    drag.item.sprite.position.set(w.x - drag.offsetX, w.y - drag.offsetY);
    drag.moved = true;
  } else if (drag.kind === 'draw') {
    // A tablet sends more points than there are frames; use them all for smooth lines.
    const events = e.getCoalescedEvents?.() || [e];
    for (const ev of events.length ? events : [e]) addPoint(drag.stroke, drag.pane, ev);
    board.redrawStroke(drag.stroke, false);
  } else if (drag.kind === 'erase') {
    eraseAt(drag.pane, e);
  }
  requestRender();
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  panesEl.classList.remove('panning');

  if (d.kind === 'move' && d.moved) {
    const { kind, id } = d.item;
    const from = d.from;
    const to = { x: d.item.sprite.x, y: d.item.sprite.y };
    const place = (pos) => { const it = board.find(kind, id); if (it) it.sprite.position.set(pos.x, pos.y); requestRender(); };
    history.push({ undo: () => place(from), redo: () => place(to) });
    contentChanged();
  } else if (d.kind === 'draw') {
    board.redrawStroke(d.stroke, true);
    const data = board.strokeJSON(d.stroke);
    history.push({
      undo: () => { const s = board.find('stroke', data.id); if (s) board.removeStroke(s); },
      redo: () => board.addStroke(data),
    });
    contentChanged();
  } else if (d.kind === 'erase' && d.removed.length) {
    const removed = d.removed;
    history.push({
      undo: () => removed.forEach((s) => board.addStroke(s)),
      redo: () => removed.forEach((s) => { const x = board.find('stroke', s.id); if (x) board.removeStroke(x); }),
    });
    contentChanged();
  } else if (d.kind === 'pan') {
    viewChanged();
  }
  requestRender();
}
panesEl.addEventListener('pointerup', endDrag);
panesEl.addEventListener('pointercancel', endDrag);
panesEl.addEventListener('pointerleave', () => { if (!drag) brushCursor.hide(); });
document.addEventListener('pointerleave', () => { if (!drag) { mouse.x = null; mouse.y = null; } });

// Double-click a note to edit it (with any tool).
panesEl.addEventListener('dblclick', (e) => {
  const pane = viewports.paneFromElement(e.target);
  if (pane?.type !== 'board') return;
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const hit = board.hitTest(w.x, w.y);
  if (hit?.kind === 'note') editNote(hit, pane);
});

// Stop the middle button from starting Chrome's auto-scroll.
panesEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

// Scroll wheel / trackpad: zoom the pane under the mouse, towards the mouse.
panesEl.addEventListener('wheel', (e) => {
  const pane = viewports.paneAt(e.clientX, e.clientY);
  if (pane?.type !== 'board') return;  // let search results scroll normally
  e.preventDefault();
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 16;   // some mice report "lines" instead of pixels
  // Trackpad pinch arrives as a wheel event with Ctrl held; it needs a stronger factor.
  const speed = e.ctrlKey ? 0.01 : 0.0015;
  const p = localPoint(pane, e);
  pane.camera.zoomAt(p.x, p.y, Math.exp(-delta * speed));
  viewChanged();
  requestRender();
}, { passive: false });

// ---------- Right-click menu ----------

function openMenu(x, y, pane) {
  const l = layout();
  const several = l.panes().length > 1;
  const items = [
    { label: 'All boards', action: goHome },
    { label: 'New board', action: newBoard },
    { label: 'Open file…', shortcut: `${MOD}O`, action: openFile },
    { label: 'Save to file', shortcut: `${MOD}S`, action: () => saveToFile() },
    { label: 'Save to file as…', shortcut: `${MOD}Shift+S`, action: () => saveToFile({ saveAs: true }) },
  ];
  if (pane) {
    items.push('-',
      { label: 'Split side by side', shortcut: 'Alt+V', action: () => paneAction('split-row', pane) },
      { label: 'Split top and bottom', shortcut: 'Alt+H', action: () => paneAction('split-col', pane) },
      { label: l.maximized ? 'Restore panes' : 'Maximize pane', shortcut: 'Ctrl+Space', disabled: !several, action: () => paneAction('maximize', pane) },
      { label: 'Close pane', shortcut: 'Alt+W', disabled: !several, action: () => paneAction('close', pane) },
      '-',
      { label: board.selected ? 'Fit selection' : 'Fit everything', shortcut: 'F', disabled: board.isEmpty(), action: () => { fitPane(pane, board.selected ? [board.selected] : null); requestRender(); } },
      { label: board.selected?.kind === 'note' ? 'Delete note' : 'Delete image', shortcut: 'Del', disabled: !board.selected, action: removeSelected },
      '-',
      { label: 'Undo', shortcut: `${MOD}Z`, disabled: !history.done.length, action: undo },
      { label: 'Redo', shortcut: `${MOD}Shift+Z`, disabled: !history.undone.length, action: redo },
    );
  }
  showMenu(x, y, items);
}

panesEl.addEventListener('contextmenu', (e) => {
  const clicked = viewports.paneFromElement(e.target);
  // Inside a tool pane, keep Chrome's own menu (e.g. to copy an image or open its page).
  if (clicked && clicked.type !== 'board' && e.target.closest('.pane-editor')) return;
  e.preventDefault();
  const pane = clicked?.type === 'board' ? clicked : null;
  if (pane) {
    // Right-clicking an image selects it, so the menu acts on it.
    const p = localPoint(pane, e);
    const w = pane.camera.toWorld(p.x, p.y);
    board.selected = board.hitTest(w.x, w.y);
    requestRender();
  }
  openMenu(e.clientX, e.clientY, pane);
});

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.code === 'KeyF' && mode === 'board') { e.preventDefault(); hideMenu(); openSearch(); return; }
  if (e.target.closest?.('input, textarea, select')) return;

  if (mod && e.code === 'KeyO') { e.preventDefault(); hideMenu(); openFile(); return; }
  if (mode !== 'board') return;

  const pane = hoverPane() || layout().visiblePanes()[0];
  if (mod && e.code === 'KeyS') { e.preventDefault(); hideMenu(); saveToFile({ saveAs: e.shiftKey }); return; }
  if (mod && e.code === 'KeyZ') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }

  // Panes (e.code is used so these work on Mac, where Option+letter types a symbol)
  if (e.altKey && !mod) {
    const action = { KeyV: 'split-row', KeyH: 'split-col', KeyW: 'close' }[e.code];
    if (action) { e.preventDefault(); paneAction(action, pane); return; }
  }
  if ((e.ctrlKey && e.code === 'Space') || e.code === 'Backquote') {
    e.preventDefault();
    paneAction('maximize', pane);
    return;
  }

  if (mod || e.altKey) return;

  if (e.code === 'Space') {
    spaceHeld = true;
    panesEl.classList.add('can-pan');
    updateCursor();
    e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    removeSelected();
  } else if (TOOL_KEYS[e.code]) {
    toolbar.setTool(TOOL_KEYS[e.code]);
  } else if (e.key === '[' || e.key === ']') {
    toolbar.nudgeSize(e.key === ']' ? 1 : -1);
  } else if (e.key === 'f' || e.key === 'F') {
    // Fit the selection, or everything if nothing is selected.
    fitPane(targetBoardPane(), board.selected ? [board.selected] : null);
    requestRender();
  } else if (e.key === '1') {
    // Back to 100% (actual pixels), around the middle of the pane.
    const bp = targetBoardPane();
    if (bp) bp.camera.zoomAt(bp.rect.w / 2, bp.rect.h / 2, 1 / bp.camera.zoom);
    viewChanged();
    requestRender();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false;
    panesEl.classList.remove('can-pan');
    updateCursor();
  }
});
// If the window loses focus while Space is held, don't get stuck in pan mode.
window.addEventListener('blur', () => { spaceHeld = false; panesEl.classList.remove('can-pan'); });

// ---------- Start up ----------

updateTitle();
await route();

// Handy for testing from the browser console.
window.__refboard = { board, viewports, layout, addImages, saveNow, get current() { return current; }, store, routing: () => routing };
