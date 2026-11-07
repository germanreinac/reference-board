// Starts the app and connects everything: the home screen, panes, mouse, keyboard,
// drag-and-drop, paste, the right-click menu, board files and saving.
//
// The address bar says where you are:
//   #/              the home screen (your boards)
//   #/board/<id>    one board
// so the browser's Back button and bookmarks just work.

import { Application, Graphics } from '../vendor/pixi.min.mjs';
import { Board } from './board.js';
import { Camera } from './camera.js';
import { Layout } from './layout.js';
import { Viewports } from './viewports.js';
import { Home } from './home.js';
import { imagesFromDrop, imagesFromPaste } from './importer.js';
import { showMenu, hideMenu } from './menu.js';
import { History } from './history.js';
import { Toolbar, BrushCursor, TOOL_KEYS, COLOURS } from './tools.js';
import { NoteEditor } from './note-editor.js';
import { createEditor } from './editors.js';
import { RESULT_DRAG_TYPE } from './search-pane.js';
import { SOURCES, loadKeys, downloadResult } from './sources.js';
import { TYPE_ICONS, TYPE_NAMES } from './viewports.js';
import { PANE_TYPES } from './layout.js';
import { loadTheme, themeColours, toggleTheme, currentTheme } from './theme.js';
import { VERSION } from './version.js';
import { LEVELS } from './board.js';
import { BRAND_FONTS, customFonts, customFontBlob, loadCustomFonts, addFontFile, uploadFont, ensureFont, isFontFile, isBrandFont } from './fonts.js';
document.querySelector('.home-version').textContent = `Version ${VERSION}`;
import {
  FILE_EXT, packBoard, unpackBoard, isBoardFile, describeBoard, canPickFiles,
  pickSaveLocation, ensureWritePermission, writeToHandle, pickBoardToOpen, downloadBlob,
  store, newBoardId, askToKeepStorage,
} from './storage.js';

loadTheme();
const BOARD_COLOUR = themeColours().board;
const GAP_COLOUR = themeColours().gap;
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
    fill: (results, query) => fillBoard(results, query),
    changed: () => viewChanged(),
    toast: (m) => toast(m),
    addImage: (blob, name) => addBlobToBoard(blob, name),
  }),
});
const layout = () => viewports.layout;
viewports.setColours(themeColours());
board.setInk(currentTheme() === 'light' ? 0x1f1f22 : 0xffffff);

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
    placeSelectionBar();
    emptyHint.classList.toggle('hidden', !board.isEmpty() || noteEditor.editing);
  });
}
window.addEventListener('resize', () => { if (mode === 'board') { viewports.position(); requestRender(); } });

const emptyHint = document.getElementById('empty-hint');

// The drawing toolbar always sits at the bottom middle of the window (see style.css);
// it's hidden when no pane shows the board. The "drop images here" hint goes in the
// middle of the biggest board pane.
function placeToolbar() {
  const el = document.getElementById('toolbar');
  const panes = boardPanes();
  el.classList.toggle('no-board', panes.length === 0);
  emptyHint.style.visibility = panes.length ? '' : 'hidden';
  if (!panes.length) return;
  const r = panes.reduce((a, b) => (b.rect.w * b.rect.h > a.rect.w * a.rect.h ? b : a)).rect;
  Object.assign(emptyHint.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}

// Light and dark mode: redraw the board in the new colours.
window.addEventListener('themechange', (e) => {
  viewports.setColours(e.detail);
  board.setInk(currentTheme() === 'light' ? 0x1f1f22 : 0xffffff);
  app.renderer.background.color = e.detail.gap;
  requestRender();
});

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
// `free`: move the new images to the nearest empty spot, so they never land on top
// of something (used for images added from search and the mannequin).
async function addImages(list, wx, wy, pane, { free = false } = {}) {
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
  if (free) {
    const tallest = Math.max(...decoded.map((d) => d.bitmap.height));
    ({ x: wx, y: wy } = board.freeSpot(totalWidth, tallest, wx, wy));
  }
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
  const items = [...board.selection];
  if (!items.length) return;
  const gone = items.map(thingData);
  for (const item of items) removeThing(item.kind, item.id);
  history.push({
    undo: () => Promise.all(gone.map(restoreThing)).then(requestRender),
    redo: () => gone.forEach((g) => removeThing(g.kind, g.data.id)),
  });
  contentChanged();
  requestRender();
}

// Any image, note, shape or frame as plain data (with its picture, for images),
// and back again. Used by delete, undo, copy and paste.
function thingData(item) {
  const index = board.listOf(item.kind).indexOf(item);
  if (item.kind === 'image') return { kind: 'image', data: { ...board.imageJSON(item), blob: item.blob, index } };
  if (item.kind === 'note') return { kind: 'note', data: { ...board.noteJSON(item), index } };
  if (item.kind === 'shape') return { kind: 'shape', data: { ...board.shapeJSON(item), index } };
  return { kind: 'frame', data: { ...board.frameJSON(item), index } };
}
function restoreThing({ kind, data }) {
  if (kind === 'image') return restoreImage(data);
  const item = kind === 'note' ? board.addNote(data) : kind === 'shape' ? board.addShape(data) : board.addFrame(data);
  requestRender();
  return item;
}
function removeThing(kind, id) {
  if (kind === 'image') return removeImageById(id);
  const x = board.find(kind, id);
  if (x) board.remove(x);
  requestRender();
}

// ---------- Editing selected images: undo-able changes ----------

// The parts of an image or note that moving, scaling, rotating, flipping, cropping
// and greyscale change. Saved before and after an edit, for undo.
const TEXT_PROPS = ['text', 'color', 'font', 'level', 'base', 'weight', 'italic', 'align', 'box'];
const SHAPE_PROPS = ['color', 'fill', 'strokeWidth', 'w', 'h', 'dx', 'dy'];
const FRAME_PROPS = ['w', 'h', 'name'];
const propsOf = (kind) => ({ note: TEXT_PROPS, shape: SHAPE_PROPS, frame: FRAME_PROPS }[kind] || []);
function stateOf(item) {
  const s = item.sprite;
  const st = { kind: item.kind, id: item.id, x: s.x, y: s.y, sx: s.scale.x, sy: s.scale.y, r: s.rotation, crop: item.crop || null, grey: !!item.grey };
  for (const k of propsOf(item.kind)) st[k] = item[k];
  st.group = item.group || null;
  return st;
}
function applyState(st) {
  const it = board.find(st.kind, st.id);
  if (!it) return;
  if (it.kind === 'image') {
    if (JSON.stringify(it.crop || null) !== JSON.stringify(st.crop)) board.setCrop(it, st.crop, { keepPlace: false });
    if (!!it.grey !== st.grey) board.setGrey(it, st.grey);
  }
  for (const k of propsOf(it.kind)) if (k in st) it[k] = st[k];
  if ('group' in st) it.group = st.group;
  if (it.kind === 'note') board.layoutNote(it);
  if (it.kind === 'shape') board.drawShape(it);
  if (it.kind === 'frame') board.drawFrame(it);
  it.sprite.position.set(st.x, st.y);
  it.sprite.scale.set(st.sx, st.sy);
  it.sprite.rotation = st.r;
}
// Record an edit of these items for undo, given their state from before it.
function recordChange(items, before) {
  const after = items.map(stateOf);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  history.push({
    undo: () => { before.forEach(applyState); requestRender(); },
    redo: () => { after.forEach(applyState); requestRender(); },
  });
  contentChanged();
}
// Change the selected things with `fn(item)`, as one undo step.
function editSelection(fn, items = board.selection) {
  const list = [...items];
  if (!list.length) return;
  const before = list.map(stateOf);
  list.forEach(fn);
  recordChange(list, before);
  requestRender();
}

// Flip horizontally ('x') or vertically ('y'). Several things flip as a group.
function flipSelection(axis) {
  const box = board.selectionBox();
  if (!box) return;
  const group = board.selection.length > 1;
  editSelection((item) => {
    const s = item.sprite;
    if (item.kind === 'image') { if (axis === 'x') s.scale.x *= -1; else s.scale.y *= -1; s.rotation = -s.rotation; }
    if (group) { if (axis === 'x') s.x = 2 * box.cx - s.x; else s.y = 2 * box.cy - s.y; }
  });
}

function toggleGrey() {
  const images = board.selection.filter((i) => i.kind === 'image');
  if (!images.length) return;
  const on = !images.every((i) => i.grey);
  editSelection((item) => board.setGrey(item, on), images);
}

// Put the selected things in tidy rows, keeping their sizes, in reading order.
function arrangeSelection() {
  const items = [...board.selection];
  if (items.length < 2) return;
  const boxes = new Map(items.map((i) => [i, board.bounds([i])]));
  const start = board.bounds(items);
  const order = items.sort((a, b) => {
    const A = boxes.get(a), B = boxes.get(b);
    const rowA = Math.round(A.y / (start.height / 4 || 1)), rowB = Math.round(B.y / (start.height / 4 || 1));
    return rowA - rowB || A.x - B.x;
  });
  const area = order.reduce((n, i) => n + boxes.get(i).width * boxes.get(i).height, 0);
  const sizes = order.map((i) => boxes.get(i));
  const gap = Math.max(10, Math.min(...sizes.map((b) => Math.min(b.width, b.height))) * 0.06);
  const rowWidth = Math.max(Math.sqrt(area) * 1.4, Math.max(...sizes.map((b) => b.width)));
  const before = order.map(stateOf);
  let x = start.x, y = start.y, rowH = 0;
  for (const item of order) {
    const b = boxes.get(item);
    if (x > start.x && x + b.width > start.x + rowWidth) { x = start.x; y += rowH + gap; rowH = 0; }
    item.sprite.x += x - b.x;
    item.sprite.y += y - b.y;
    x += b.width + gap;
    rowH = Math.max(rowH, b.height);
  }
  recordChange(order, before);
  requestRender();
}

// ---------- Groups, alignment, frames, layer order ----------

const newGroupId = () => 'g' + Math.random().toString(36).slice(2, 9);

function groupSelection() {
  const items = board.selection.filter((x) => x.kind !== 'frame');
  if (items.length < 2) return;
  const id = newGroupId();
  editSelection((x) => { x.group = id; }, items);
  toast('Grouped. Click any of them to select the whole group. Ctrl/⌘+Shift+G ungroups.', 2600);
}
function ungroupSelection() {
  const items = board.selection.filter((x) => x.group);
  if (!items.length) return;
  editSelection((x) => { x.group = null; }, items);
  toast('Ungrouped', 1400);
}

// Line the selection up: 'left', 'center', 'right', 'top', 'middle', 'bottom',
// or spread it out evenly: 'spread-x', 'spread-y'. Groups move as one piece.
function alignSelection(how) {
  const sel = [...board.selection];
  if (sel.length < 2) return;
  // Treat each group as one block.
  const blocks = [];
  const seen = new Set();
  for (const x of sel) {
    if (seen.has(x)) continue;
    const members = x.group ? sel.filter((y) => y.group === x.group) : [x];
    members.forEach((m) => seen.add(m));
    blocks.push({ members, box: board.bounds(members) });
  }
  if (blocks.length < 2) return;
  const all = board.bounds(sel);
  const moveBlock = (b, dx, dy) => b.members.forEach((m) => { m.sprite.x += dx; m.sprite.y += dy; });
  const before = sel.map(stateOf);
  if (how === 'spread-x' || how === 'spread-y') {
    const horiz = how === 'spread-x';
    const sorted = [...blocks].sort((a, b) => (horiz ? a.box.x - b.box.x : a.box.y - b.box.y));
    const total = sorted.reduce((n, b) => n + (horiz ? b.box.width : b.box.height), 0);
    const space = ((horiz ? all.width : all.height) - total) / (sorted.length - 1);
    let at = horiz ? all.x : all.y;
    for (const b of sorted) {
      if (horiz) moveBlock(b, at - b.box.x, 0); else moveBlock(b, 0, at - b.box.y);
      at += (horiz ? b.box.width : b.box.height) + space;
    }
  } else {
    for (const b of blocks) {
      const x = { left: all.x - b.box.x, center: all.x + all.width / 2 - (b.box.x + b.box.width / 2), right: all.x + all.width - (b.box.x + b.box.width) }[how] || 0;
      const y = { top: all.y - b.box.y, middle: all.y + all.height / 2 - (b.box.y + b.box.height / 2), bottom: all.y + all.height - (b.box.y + b.box.height) }[how] || 0;
      moveBlock(b, x, y);
    }
  }
  recordChange(sel, before);
  requestRender();
}

function alignMenu(x, y) {
  showMenu(x, y, [
    { label: 'Align left', action: () => alignSelection('left') },
    { label: 'Align centres', action: () => alignSelection('center') },
    { label: 'Align right', action: () => alignSelection('right') },
    '-',
    { label: 'Align top', action: () => alignSelection('top') },
    { label: 'Align middles', action: () => alignSelection('middle') },
    { label: 'Align bottom', action: () => alignSelection('bottom') },
    '-',
    { label: 'Spread evenly across', action: () => alignSelection('spread-x') },
    { label: 'Spread evenly down', action: () => alignSelection('spread-y') },
    '-',
    { label: 'Arrange in a grid', action: arrangeSelection },
  ]);
}

// A frame around what's selected, with a little room around it.
function frameSelection() {
  const sel = board.selection.filter((x) => x.kind !== 'frame');
  if (!sel.length) return;
  const b = board.bounds(sel);
  const pane = activePane || targetBoardPane();
  const pad = Math.max(b.width, b.height) * 0.06 + 20 / (pane?.camera.zoom || 1);
  const f = board.addFrame({
    x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width + pad * 2, h: b.height + pad * 2,
    name: `Frame ${board.frames.length + 1}`, titleSize: 15 / (pane?.camera.zoom || 1),
  });
  const data = board.frameJSON(f);
  history.push({ undo: () => removeThing('frame', data.id), redo: () => restoreThing({ kind: 'frame', data }) });
  board.selected = f;
  contentChanged();
  requestRender();
  toast('Frame added. Double-click its name to rename it. Frames are the slides of Present mode.', 3200);
}

// Rename a frame: a text box over its name.
function renameFrame(f, pane) {
  const input = document.createElement('input');
  input.className = 'frame-rename';
  input.value = f.name;
  const z = pane.camera.zoom;
  Object.assign(input.style, {
    left: `${pane.rect.x + pane.camera.x + (f.sprite.x + f.title.x) * z}px`,
    top: `${pane.rect.y + pane.camera.y + (f.sprite.y + f.title.y) * z}px`,
    fontSize: `${Math.max(11, f.titleSize * z)}px`,
  });
  document.body.appendChild(input);
  input.focus();
  input.select();
  const before = [stateOf(f)];
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim()) { f.name = input.value.trim(); board.drawFrame(f); recordChange([f], before); }
    input.remove();
    requestRender();
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

function reorderSelection(front) {
  const sel = [...board.selection];
  if (!sel.length) return;
  for (const x of sel) (front ? board.bringToFront(x) : board.sendToBack(x));
  contentChanged();
  requestRender();
}

// ---------- Copy, paste, duplicate, nudge ----------

let clipboard = null;  // things copied with Ctrl/⌘+C: { things, box }

function copySelection() {
  const sel = [...board.selection];
  if (!sel.length) return false;
  clipboard = { things: sel.map(thingData), box: board.bounds(sel) };
  toast(`Copied ${sel.length === 1 ? 'it' : `${sel.length} things`}. Ctrl/⌘+V pastes, on this board or another.`, 1600);
  return true;
}

// Paste copied things, centred on a board position (default: a little offset).
async function pasteThings(clip, at = null) {
  if (!clip || !current) return;
  const box = clip.box;
  const dx = at ? at.x - (box.x + box.width / 2) : 30 / (activePane?.camera.zoom || 1);
  const dy = at ? at.y - (box.y + box.height / 2) : 30 / (activePane?.camera.zoom || 1);
  const groups = new Map();
  const added = [];
  for (const t of clip.things) {
    const data = { ...t.data, id: undefined, index: undefined, x: t.data.x + dx, y: t.data.y + dy, locked: false };
    if (data.group) { if (!groups.has(data.group)) groups.set(data.group, newGroupId()); data.group = groups.get(data.group); }
    if (t.kind === 'image') {
      const bitmap = await decode(t.data.blob, t.data.name);
      if (!bitmap) continue;
      const item = board.addImage(bitmap, data.x, data.y, data);
      store.saveImage(current.id, item.id, t.data.blob).catch(() => {});
      added.push(item);
    } else {
      added.push(restoreThing({ kind: t.kind, data }));
    }
  }
  const saved = added.map(thingData);
  history.push({ undo: () => saved.forEach((g) => removeThing(g.kind, g.data.id)), redo: () => Promise.all(saved.map(restoreThing)).then(requestRender) });
  board.selection = added;
  contentChanged();
  requestRender();
}

function duplicateSelection() {
  const sel = [...board.selection];
  if (!sel.length) return;
  pasteThings({ things: sel.map(thingData), box: board.bounds(sel) });
}

// Arrow keys move the selection a pixel (or ten with Shift) on screen.
let nudgeTimer = null;
let nudgeBefore = null;
function nudge(dx, dy, big) {
  const sel = [...board.selection];
  if (!sel.length) return;
  const z = (activePane || targetBoardPane())?.camera.zoom || 1;
  const step = (big ? 10 : 1) / z;
  if (!nudgeBefore) nudgeBefore = sel.map(stateOf);
  for (const x of sel) { x.sprite.x += dx * step; x.sprite.y += dy * step; }
  requestRender();
  // Several quick nudges count as one step for undo.
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { recordChange(sel, nudgeBefore); nudgeBefore = null; }, 500);
}

// ---------- Copy and download an image ----------

async function copyImage(item) {
  try {
    const bitmap = await createImageBitmap(item.blob);
    const c = item.crop || { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    const canvas = new OffscreenCanvas(c.w, c.h);
    canvas.getContext('2d').drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Image copied. Paste it into any app.', 1800);
  } catch {
    toast("Couldn't copy the image. Try Download image instead.");
  }
}
function downloadImage(item) {
  const ext = (item.blob?.type || 'image/png').split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  downloadBlob(item.blob, `${(item.name || 'image').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.${ext}`);
}

// Crop: the next box you drag over the selected image becomes the part that's kept.
let cropping = null;  // the image being cropped
function startCrop() {
  const item = board.selected;
  if (item?.kind !== 'image') return toast('Select one image to crop it.');
  cropping = item;
  toast('Drag a box over the part of the image to keep. Esc cancels.', 6000);
  requestRender();
}
function finishCrop(m) {
  const item = cropping;
  cropping = null;
  toastEl.classList.remove('show');
  if (!item || Math.abs(m.x1 - m.x0) < 2 || Math.abs(m.y1 - m.y0) < 2) return;
  // Turn the box's corners into the picture's own pixels.
  const s = item.sprite;
  const cur = item.crop || { x: 0, y: 0, w: item.fullWidth, h: item.fullHeight };
  const toPixel = (x, y) => {
    const dx = x - s.x, dy = y - s.y;
    const cos = Math.cos(-s.rotation), sin = Math.sin(-s.rotation);
    return { x: cur.x + cur.w / 2 + (dx * cos - dy * sin) / s.scale.x, y: cur.y + cur.h / 2 + (dx * sin + dy * cos) / s.scale.y };
  };
  const pts = [toPixel(m.x0, m.y0), toPixel(m.x1, m.y0), toPixel(m.x1, m.y1), toPixel(m.x0, m.y1)];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.max(cur.x, Math.min(...xs)), x1 = Math.min(cur.x + cur.w, Math.max(...xs));
  const y0 = Math.max(cur.y, Math.min(...ys)), y1 = Math.min(cur.y + cur.h, Math.max(...ys));
  if (x1 - x0 < 4 || y1 - y0 < 4) return toast('That box missed the image.');
  editSelection((it) => board.setCrop(it, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), [item]);
}
function resetCrop() {
  const images = board.selection.filter((i) => i.kind === 'image' && i.crop);
  editSelection((it) => board.setCrop(it, null), images);
}

// Extract colours: add a palette of the image's main colours next to it, each
// block as wide as how much of the image has that colour, with its colour code.
async function extractColours() {
  const item = board.selected;
  if (item?.kind !== 'image' || !item.blob) return toast('Select one image to take its colours.');
  const bitmap = await createImageBitmap(item.blob);
  const c = item.crop || { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const W = 80, H = Math.max(8, Math.round(80 * c.h / c.w));
  const small = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
  small.drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, W, H);
  const colours = mainColours(small.getImageData(0, 0, W, H).data, 6);
  // Draw the palette picture.
  const PW = 1200, PH = 300;
  const canvas = new OffscreenCanvas(PW, PH);
  const g = canvas.getContext('2d');
  let x = 0;
  colours.forEach((col, i) => {
    const w = i === colours.length - 1 ? PW - x : Math.round(PW * col.share);
    g.fillStyle = col.hex;
    g.fillRect(x, 0, w, PH);
    if (w > 70) {
      const light = 0.299 * col.r + 0.587 * col.g + 0.114 * col.b > 150;
      g.fillStyle = light ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
      g.font = '600 26px system-ui, sans-serif';
      g.fillText(col.hex.toUpperCase(), x + 16, PH - 46);
      g.font = '22px system-ui, sans-serif';
      g.fillText(`${Math.round(col.share * 100)}%`, x + 16, PH - 18);
    }
    x += w;
  });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  // Place it just to the right of the image, about as wide as the image looks.
  const b = board.bounds([item]);
  const scale = b.width / PW;
  const spot = board.freeSpot(PW * scale, PH * scale, b.x + b.width + 30 + (PW * scale) / 2, b.y + (PH * scale) / 2);
  const paletteBitmap = await createImageBitmap(blob);
  const added = board.addImage(paletteBitmap, spot.x, spot.y, { name: `Colours of ${item.name || 'image'}`, blob, scaleX: scale, scaleY: scale });
  store.saveImage(current.id, added.id, blob).catch(() => {});
  const data = { ...board.imageJSON(added), blob };
  history.push({ undo: () => removeImageById(data.id), redo: () => restoreImage(data) });
  contentChanged();
  requestRender();
}

// The k most common colours of an image's pixels (k-means), biggest share first.
function mainColours(data, k) {
  const px = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
  if (!px.length) return [{ r: 128, g: 128, b: 128, hex: '#808080', share: 1 }];
  // Start from colours spread across the image (k-means++ style), then refine.
  const centres = [px[Math.floor(px.length / 2)]];
  while (centres.length < k) {
    let far = px[0], best = -1;
    for (const p of px) {
      const d = Math.min(...centres.map((c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2));
      if (d > best) { best = d; far = p; }
    }
    centres.push([...far]);
  }
  let counts = [];
  for (let round = 0; round < 10; round++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts = centres.map(() => 0);
    for (const p of px) {
      let bi = 0, bd = Infinity;
      centres.forEach((c, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
      sums[bi][0] += p[0]; sums[bi][1] += p[1]; sums[bi][2] += p[2]; counts[bi]++;
    }
    centres.forEach((c, i) => { if (counts[i]) { c[0] = sums[i][0] / counts[i]; c[1] = sums[i][1] / counts[i]; c[2] = sums[i][2] / counts[i]; } });
  }
  const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
  return centres.map((c, i) => ({ r: c[0], g: c[1], b: c[2], hex: `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`, share: counts[i] / px.length }))
    .filter((c) => c.share >= 0.02).sort((a, b) => b.share - a.share);
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
    for (const x of data?.shapes || []) board.addShape(x);
    for (const f of data?.frames || []) board.addFrame(f);
    // Make sure the fonts the text uses are loaded, then lay the text out again.
    const used = [...new Set(board.notes.map((n) => `${n.font}|${n.weight}|${n.italic}`))];
    Promise.all(used.map((k) => { const [f, w, i] = k.split('|'); return ensureFont(f, w, i === 'true'); }))
      .then(() => { board.relayoutNotes(); requestRender(); });
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
  // #/inbox: the Inbox board, where the browser extension puts images while no
  // board is open. Made the first time it's needed.
  if (location.hash.startsWith('#/inbox')) {
    location.replace(`#/board/${await inboxId()}`);
    return doRoute();
  }
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
  const { data, images, fonts } = await unpackBoard(file);
  // Fonts the board's text uses come with it.
  for (const f of fonts) await addFontFile(f.blob, f.name).catch(() => {});
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
    await writeToHandle(handle, await packBoard(getData(), getBlob, customFontBlob));
  } else {
    // Other browsers: download a copy instead.
    downloadBlob(await packBoard(getData(), getBlob, customFontBlob), name + FILE_EXT);
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
document.getElementById('theme-button').addEventListener('click', toggleTheme);
document.getElementById('bar-theme-button').addEventListener('click', toggleTheme);
document.getElementById('board-menu-button').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right - 230, r.bottom + 4, null);
});
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
  // Dropped somewhere on purpose: put it there. Otherwise: the nearest empty spot.
  await addImages([{ blob, name, sourceUrl }], wx, wy, pane, { free: !at });
}

// "Fill board": download a set of search results and lay them out on the board
// as a mood board, in Pinterest-style columns. One undo removes the whole set.
async function fillBoard(results, query) {
  if (!current || !results.length) return;
  const boardId = current.id;
  const pane = targetBoardPane();
  const keys = loadKeys();
  const got = new Array(results.length);
  let next = 0;
  let done = 0;
  toast(`Adding ${results.length} images…`, 120000);
  // At most six downloads at a time, so the browser stays responsive.
  const worker = async () => {
    while (next < results.length) {
      const i = next++;
      const r = results[i];
      try {
        const { blob } = await downloadResult(r);
        got[i] = { r, blob, bitmap: await createImageBitmap(blob) };
        SOURCES[r.source]?.used?.(r, keys[r.source]);
      } catch {
        // skip images that can't be downloaded
      }
      done++;
      toast(`Adding images… ${done} of ${results.length}`, 120000);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, results.length) }, worker));
  if (current?.id !== boardId) return;
  const ok = got.filter(Boolean);
  if (!ok.length) return toast("Couldn't download any of those images. Try another search.");

  // Columns of equal width; each image goes into the shortest column.
  const COL = 600;
  const GAP = 24;
  const cols = Math.max(2, Math.min(6, Math.round(Math.sqrt(ok.length * 1.4))));
  const heights = new Array(cols).fill(0);
  const placed = ok.map((e) => {
    const scale = COL / e.bitmap.width;
    const h = e.bitmap.height * scale;
    const c = heights.indexOf(Math.min(...heights));
    const spot = { ...e, scale, col: c, top: heights[c], h };
    heights[c] += h + GAP;
    return spot;
  });
  const blockW = cols * COL + (cols - 1) * GAP;
  const blockH = Math.max(...heights) - GAP;
  // Next to what's already on the board, or in the middle of the view on an empty board.
  const existing = board.bounds();
  const centre = pane ? pane.camera.toWorld(pane.rect.w / 2, pane.rect.h / 2) : { x: 0, y: 0 };
  const left = existing ? existing.x + existing.width + 300 : centre.x - blockW / 2;
  const top = existing ? existing.y : centre.y - blockH / 2;

  const added = [];
  for (const p of placed) {
    const name = [p.r.title, p.r.author && `by ${p.r.author}`].filter(Boolean).join(' ') || query;
    const item = board.addImage(p.bitmap, left + p.col * (COL + GAP) + COL / 2, top + p.top + p.h / 2, {
      name, sourceUrl: p.r.pageUrl || p.r.full, blob: p.blob, scaleX: p.scale, scaleY: p.scale,
    });
    store.saveImage(boardId, item.id, p.blob).catch((err) => console.warn('Saving image failed', err));
    added.push(item);
  }
  const saved = added.map((item) => ({ ...board.imageJSON(item), blob: item.blob }));
  history.push({
    undo: () => saved.forEach((d) => removeImageById(d.id)),
    redo: () => Promise.all(saved.map((d) => restoreImage(d))),
  });
  board.selected = null;
  fitPane(pane, added);
  contentChanged();
  requestRender();
  const missed = results.length - ok.length;
  toast(`Added ${ok.length} images${missed ? ` (${missed} couldn't be downloaded)` : ''}. Ctrl/⌘+Z removes them all.`, 3500);
}

// ---------- From the browser extension and screen capture ----------

async function inboxId() {
  const found = (await store.listBoards()).find((b) => b.name === 'Inbox');
  return found ? found.id : createBoard({ name: 'Inbox' });
}

// Images arrive from the extension one at a time, in order.
let incoming = Promise.resolve();
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (d?.source !== 'refboard-extension' || d.type !== 'add' || !d.item?.dataUrl) return;
  incoming = incoming.then(() => receive(d.item)).catch((err) => { console.error(err); toast("Couldn't add the image from the extension."); });
});

async function receive(item) {
  const blob = await (await fetch(item.dataUrl)).blob();
  // On the home screen, images go to the Inbox board.
  if (mode !== 'board') await openBoardNow(await inboxId());
  await routing;
  await addBlobToBoard(blob, item.name || 'image', item.sourceUrl || '');
  toast(`Added to ${current?.name || 'the board'}`, 1600);
}

// Capture screen: a picture of any window or screen (Chrome asks which one).
async function captureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast("This browser can't capture the screen.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return;  // cancelled
  }
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 250));  // let the first real frame arrive
    const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await addBlobToBoard(blob, 'Screen capture');
    toast('Screen captured. Crop it with the bar above the image.', 3000);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
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

    // Font files are added to your fonts.
    const fontFiles = [...e.dataTransfer.files].filter(isFontFile);
    if (fontFiles.length) {
      const names = [];
      for (const f of fontFiles) names.push(await addFontFile(f, f.name));
      toast(`Added the font${names.length > 1 ? 's' : ''} ${names.join(', ')}. Pick it from the font menu of any text.`, 4000);
      return;
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
    // Nothing from outside the app: paste what was copied on a board (Ctrl/⌘+C), at the mouse.
    if (list.length === 0 && clipboard && mode === 'board') {
      const pane = targetBoardPane();
      const at = pane && hoverPane() === pane ? pane.camera.toWorld(mouse.x - pane.rect.x, mouse.y - pane.rect.y) : null;
      return pasteThings(clipboard, at);
    }
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
  // After placing a note or text, go back to moving things (like Figma and Miro do).
  if (isNew && (toolbar.tool === 'note' || toolbar.tool === 'text')) toolbar.setTool('select');
  const before = { ...stateOf(note), text: oldText };
  // Lines starting with "- " or "* " become bullets.
  text = text.replace(/^([ \t]*)[-*] /gm, '$1• ');
  // Like Notion: text starting with "# ", "## " or "### " becomes a heading.
  if (note.style === 'text') {
    const m = text.match(/^(#{1,3}) +/);
    if (m) {
      note.level = ['h1', 'h2', 'h3'][m[1].length - 1];
      note.weight = LEVELS[note.level].weight;
      text = text.slice(m[0].length);
    }
  }
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
  } else {
    board.setNoteText(note, text);
    const after = stateOf(note);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      history.push({ undo: () => { applyState(before); requestRender(); }, redo: () => { applyState(after); requestRender(); } });
      contentChanged();
    }
  }
  requestRender();
});

function editNote(note, pane) {
  board.selected = null;
  noteEditor.start(note, pane);
  requestRender();
}

// The text level and font new text starts with: whatever you used last.
const TEXT_PREFS = 'refboard-text';
function textPrefs() {
  try { return { level: 'body', font: 'Inter', ...JSON.parse(localStorage.getItem(TEXT_PREFS)) }; } catch { return { level: 'body', font: 'Inter' }; }
}
function rememberTextLevel(level, font) {
  try { localStorage.setItem(TEXT_PREFS, JSON.stringify({ ...textPrefs(), ...(level ? { level } : {}), ...(font ? { font } : {}) })); } catch {}
}

// Add a new sticky note or text where you clicked and start typing in it.
function addNoteAt(pane, wx, wy, style = 'sticky') {
  // Sized so body text is about 18 pixels tall at the zoom you're working at.
  const size = 18 / pane.camera.zoom;
  const prefs = textPrefs();
  const note = style === 'text'
    ? board.addNote({ x: wx, y: wy, text: '', style: 'text', color: themeColours().text, base: size, level: prefs.level, font: prefs.font, fontSize: size })
    : board.addNote({ x: wx, y: wy, text: '', color: toolbar.color, fontSize: size });
  note.isNew = true;
  editNote(note, pane);
}

// ---------- Selecting, moving, scaling and rotating ----------

let activePane = null;  // the board pane you last clicked in (the selection bar shows there)

// Is a scale or rotate handle of the selection under this board point? Returns
// 'rotate', a corner number (0-3) or null.
function handleAt(pane, w) {
  if (!board.selection.length || board.selection.some((x) => x.locked)) return null;
  const h = board.handles(pane.camera.zoom);
  const reach = 9 / pane.camera.zoom;
  if (Math.hypot(w.x - h.rotate.x, w.y - h.rotate.y) <= reach) return 'rotate';
  const i = h.corners.findIndex((c) => Math.hypot(w.x - c.x, w.y - c.y) <= reach);
  return i === -1 ? null : i;
}

function dragTo(d, w, e) {
  if (d.kind === 'move') {
    const dx = w.x - d.start.x, dy = w.y - d.start.y;
    d.items.forEach((item, i) => item.sprite.position.set(d.before[i].x + dx, d.before[i].y + dy));
    d.moved = true;
  } else if (d.kind === 'scale') {
    // Scale from the opposite corner, keeping the shape.
    const f = Math.max(0.02, Math.hypot(w.x - d.anchor.x, w.y - d.anchor.y) / d.startDist);
    d.items.forEach((item, i) => {
      const b = d.before[i];
      item.sprite.position.set(d.anchor.x + (b.x - d.anchor.x) * f, d.anchor.y + (b.y - d.anchor.y) * f);
      if (item.kind === 'image' || item.style === 'text' || item.kind === 'shape') item.sprite.scale.set(b.sx * f, b.sy * f);
      if (item.kind === 'frame') { item.w = b.w * f; item.h = b.h * f; board.drawFrame(item); }
    });
  } else if (d.kind === 'rotate') {
    // Turn around the middle of the selection. Shift snaps to 15° steps.
    let a = Math.atan2(w.y - d.cy, w.x - d.cx) - d.start;
    if (e.shiftKey) {
      const step = Math.PI / 12;
      const base = d.items.length === 1 ? d.before[0].r : 0;
      a = Math.round((base + a) / step) * step - base;
    }
    const cos = Math.cos(a), sin = Math.sin(a);
    d.items.forEach((item, i) => {
      const b = d.before[i];
      const rx = b.x - d.cx, ry = b.y - d.cy;
      item.sprite.position.set(d.cx + rx * cos - ry * sin, d.cy + rx * sin + ry * cos);
      if (item.kind === 'image' || item.style === 'text' || item.kind === 'shape') item.sprite.rotation = b.r + a;
    });
  } else if (d.kind === 'create') {
    d.moved = true;
    const it = d.item;
    if (it.kind === 'frame' || it.shape === 'rect' || it.shape === 'ellipse') {
      let wx = w.x - d.start.x, wy = w.y - d.start.y;
      if (e.shiftKey && it.kind === 'shape') { const m = Math.max(Math.abs(wx), Math.abs(wy)); wx = Math.sign(wx || 1) * m; wy = Math.sign(wy || 1) * m; }
      it.sprite.position.set(d.start.x + wx / 2, d.start.y + wy / 2);
      if (it.kind === 'frame') { it.w = Math.max(1, Math.abs(wx)); it.h = Math.max(1, Math.abs(wy)); board.drawFrame(it); }
      else { it.w = Math.max(1, Math.abs(wx)); it.h = Math.max(1, Math.abs(wy)); board.drawShape(it); }
    } else {
      // Lines and arrows: Shift keeps them to 45° steps.
      let dx = w.x - d.start.x, dy = w.y - d.start.y;
      if (e.shiftKey) { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4); const l = Math.hypot(dx, dy); dx = Math.cos(a) * l; dy = Math.sin(a) * l; }
      it.dx = dx; it.dy = dy;
      it.sprite.position.set(d.start.x + dx / 2, d.start.y + dy / 2);
      board.drawShape(it);
    }
  } else if (d.kind === 'marquee' || d.kind === 'crop') {
    board.marquee.x1 = w.x;
    board.marquee.y1 = w.y;
    if (d.kind === 'marquee') {
      const m = board.marquee;
      const inside = board.inRect(m.x0, m.y0, m.x1, m.y1);
      board.selection = [...new Set([...d.base, ...inside.flatMap((x) => board.groupOf(x))])];
    }
  }
}

// The bar of buttons above what's selected (like Miro).
const selectionBar = document.getElementById('selection-bar');
const SEL_ICONS = {
  lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>',
  flipX: '<svg viewBox="0 0 16 16"><path d="M8 2v12M6 4L2 12h4zM10 4l4 8h-4z"/></svg>',
  flipY: '<svg viewBox="0 0 16 16"><path d="M2 8h12M4 6l8-4v4zM4 10l8 4v-4z"/></svg>',
  crop: '<svg viewBox="0 0 16 16"><path d="M4.5 1.5v10h10M1.5 4.5h10v10"/></svg>',
  grey: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 000-11z" fill="currentColor"/></svg>',
  colours: '<svg viewBox="0 0 16 16"><rect x="1.5" y="4" width="4.3" height="8" rx="1"/><rect x="5.8" y="4" width="4.3" height="8" rx="1"/><rect x="10.2" y="4" width="4.3" height="8" rx="1"/></svg>',
  align: '<svg viewBox="0 0 16 16"><path d="M2.5 1.5v13"/><rect x="4.5" y="3.5" width="8" height="3" rx="1"/><rect x="4.5" y="9.5" width="5" height="3" rx="1"/></svg>',
  group: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke-dasharray="2 2"/><rect x="4" y="4" width="4" height="4" rx="1"/><rect x="8.5" y="8.5" width="3.5" height="3.5" rx="1"/></svg>',
  ungroup: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/><path d="M9.5 3.5l3 3M12.5 3.5l-3 3"/></svg>',
  frame: '<svg viewBox="0 0 16 16"><path d="M4.5 1.5v13M11.5 1.5v13M1.5 4.5h13M1.5 11.5h13"/></svg>',
  duplicate: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"/></svg>',
  delete: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg>',
};
const SEL_ACTIONS = [
  ['lock', 'Lock (L)', () => setLocked(null, true)],
  ['flipX', 'Flip left to right', () => flipSelection('x'), (sel) => sel.some((x) => x.kind === 'image')],
  ['flipY', 'Flip upside down', () => flipSelection('y'), (sel) => sel.some((x) => x.kind === 'image')],
  ['crop', 'Crop', startCrop, (sel) => sel.length === 1 && sel[0].kind === 'image'],
  ['grey', 'Greyscale on / off', toggleGrey, (sel) => sel.some((x) => x.kind === 'image')],
  ['colours', 'Extract colours: add a palette of this image', extractColours, (sel) => sel.length === 1 && sel[0].kind === 'image'],
  ['align', 'Align, spread out or arrange', () => { const r = selectionBar.querySelector('[data-action="align"]').getBoundingClientRect(); alignMenu(r.left, r.bottom + 6); }, (sel) => sel.length > 1],
  ['group', 'Group (Ctrl/⌘+G)', groupSelection, (sel) => sel.length > 1 && !(sel.every((x) => x.group && x.group === sel[0].group))],
  ['ungroup', 'Ungroup (Ctrl/⌘+Shift+G)', ungroupSelection, (sel) => sel.some((x) => x.group)],
  ['frame', 'Put a frame around these', frameSelection, (sel) => sel.some((x) => x.kind !== 'frame')],
  ['duplicate', 'Duplicate (Ctrl/⌘+D)', duplicateSelection],
  ['delete', 'Delete (Del)', removeSelected],
];
for (const [id, title, action] of SEL_ACTIONS) {
  const b = document.createElement('button');
  b.dataset.action = id;
  b.title = title;
  b.innerHTML = SEL_ICONS[id];
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.stopPropagation(); action(); });
  selectionBar.appendChild(b);
}
// ---------- Text controls in the selection bar ----------

const ALIGN_ICONS = {
  left: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h7M2.5 12h9"/></svg>',
  center: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M4.5 8h7M3.5 12h9"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M6.5 8h7M4.5 12h9"/></svg>',
};
const textControls = document.createElement('div');
textControls.className = 'sel-text';
textControls.innerHTML = `
  <select class="sel-level" title="Text level"></select>
  <select class="sel-font" title="Font"></select>
  <button data-text="bold" title="Bold (Ctrl/⌘+B)"><b>B</b></button>
  <button data-text="italic" title="Italic (Ctrl/⌘+I)"><i>I</i></button>
  <button data-text="align" title="Alignment"></button>
  <button data-text="box" title="Background: none, soft box or outline (keeps text readable over images)"><svg viewBox="0 0 16 16"><rect x="1.5" y="3.5" width="13" height="9" rx="2"/><path d="M5 10l3-5 3 5M6 8.5h4"/></svg></button>
  <button data-text="fill" title="Fill the shape"><svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="currentColor" fill-opacity="0.35"/></svg></button>
  <button data-text="colour" class="sel-colour" title="Colour"></button>
  <div class="sel-palette" hidden></div>`;
selectionBar.prepend(textControls);
const levelSelect = textControls.querySelector('.sel-level');
for (const [id, l] of Object.entries(LEVELS)) levelSelect.add(new Option(l.label, id));
const fontSelect = textControls.querySelector('.sel-font');
const palette = textControls.querySelector('.sel-palette');
for (const c of COLOURS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.setProperty('--c', c);
  b.addEventListener('click', () => { setTextProps({ color: c }); palette.hidden = true; });
  palette.appendChild(b);
}
const anyColour = Object.assign(document.createElement('input'), { type: 'color', title: 'Any colour' });
anyColour.className = 'swatch custom-input';
anyColour.addEventListener('input', () => setTextProps({ color: anyColour.value }));
palette.appendChild(anyColour);

function fillFontMenu(current) {
  fontSelect.replaceChildren();
  const brand = document.createElement('optgroup');
  brand.label = 'Board fonts';
  for (const f of BRAND_FONTS) brand.appendChild(new Option(f.name, f.name));
  fontSelect.appendChild(brand);
  const mine = customFonts();
  if (mine.length) {
    const g = document.createElement('optgroup');
    g.label = 'Your fonts';
    for (const name of mine) g.appendChild(new Option(name, name));
    fontSelect.appendChild(g);
  }
  if (current && !isBrandFont(current) && !mine.includes(current)) fontSelect.appendChild(new Option(`${current} (missing)`, current));
  fontSelect.appendChild(new Option('Upload a font…', '__upload'));
  fontSelect.value = current || 'Inter';
}

const selectedNotes = () => board.selection.filter((x) => x.kind === 'note');
const selectedShapes = () => board.selection.filter((x) => x.kind === 'shape');

// Change text (or shape) settings on everything selected, as one undo step.
function setTextProps(props) {
  const notes = selectedNotes();
  const shapes = selectedShapes();
  if (shapes.length && !notes.length) {
    editSelection((x) => {
      if ('color' in props) x.color = props.color;
      if ('fill' in props) x.fill = props.fill;
      board.drawShape(x);
    }, shapes);
    lastControls = '';
    return;
  }
  if (!notes.length) return;
  editSelection((n) => {
    if (props.level && n.style === 'text') { n.level = props.level; n.weight = LEVELS[props.level].weight; }
    for (const k of ['font', 'italic', 'align', 'color', 'weight', 'box']) if (k in props) n[k] = props[k];
    board.layoutNote(n);
  }, notes);
  if (props.font || props.weight || 'italic' in props) {
    // Lay out again once the font (in this weight) has loaded.
    Promise.all(notes.map((n) => ensureFont(n.font, n.weight, n.italic))).then(() => { board.relayoutNotes(); requestRender(); });
  }
  if (props.level) rememberTextLevel(props.level);
  if (props.font) rememberTextLevel(null, props.font);
  lastControls = '';
}

levelSelect.addEventListener('change', () => setTextProps({ level: levelSelect.value }));
fontSelect.addEventListener('change', async () => {
  if (fontSelect.value !== '__upload') return setTextProps({ font: fontSelect.value });
  try {
    const name = await uploadFont();
    if (name) { setTextProps({ font: name }); toast(`Added the font ${name}. It's kept for all your boards.`, 3000); }
  } catch (err) {
    toast(err.message);
  }
  lastControls = '';
});
textControls.querySelector('[data-text="bold"]').addEventListener('click', () => {
  const notes = selectedNotes();
  setTextProps({ weight: notes.every((n) => n.weight >= 600) ? 400 : 700 });
});
textControls.querySelector('[data-text="italic"]').addEventListener('click', () => {
  setTextProps({ italic: !selectedNotes().every((n) => n.italic) });
});
textControls.querySelector('[data-text="align"]').addEventListener('click', () => {
  const order = ['left', 'center', 'right'];
  const now = selectedNotes()[0]?.align || 'left';
  setTextProps({ align: order[(order.indexOf(now) + 1) % 3] });
});
textControls.querySelector('[data-text="colour"]').addEventListener('click', () => { palette.hidden = !palette.hidden; });
textControls.querySelector('[data-text="box"]').addEventListener('click', () => {
  const order = ['none', 'fill', 'outline'];
  const now = selectedNotes()[0]?.box || 'none';
  setTextProps({ box: order[(order.indexOf(now) + 1) % 3] });
});
textControls.querySelector('[data-text="fill"]').addEventListener('click', () => {
  setTextProps({ fill: !selectedShapes().every((x) => x.fill) });
});
selectionBar.addEventListener('pointerdown', (e) => e.stopPropagation());

// Show the text controls for the selection, and keep them in step with it.
let lastControls = '';
function updateTextControls(sel) {
  const notes = sel.filter((x) => x.kind === 'note');
  const shapes = sel.filter((x) => x.kind === 'shape');
  const isText = notes.length > 0 && notes.length === sel.length;
  const isShape = shapes.length > 0 && shapes.length === sel.length;
  textControls.hidden = !isText && !isShape;
  if (textControls.hidden) { palette.hidden = true; return; }
  // Shapes only get a colour and a fill; text gets everything else.
  for (const el of textControls.querySelectorAll('.sel-level, .sel-font, [data-text="bold"], [data-text="italic"], [data-text="align"], [data-text="box"]')) el.hidden = !isText;
  textControls.querySelector('[data-text="fill"]').hidden = !(isShape && shapes.some((x) => x.shape === 'rect' || x.shape === 'ellipse'));
  if (isShape) {
    const key = shapes.map((x) => `${x.id}:${x.color}:${x.fill}`).join(',');
    if (key === lastControls) return;
    lastControls = key;
    textControls.querySelector('[data-text="fill"]').classList.toggle('on', shapes.every((x) => x.fill));
    textControls.querySelector('.sel-colour').style.setProperty('--c', shapes[0].color);
    return;
  }
  const n = notes[0];
  const key = notes.map((x) => `${x.id}:${x.font}:${x.level}:${x.weight}:${x.italic}:${x.align}:${x.color}:${x.box}`).join(',') + customFonts().join(',');
  if (key === lastControls) return;
  lastControls = key;
  const allText = notes.every((x) => x.style === 'text');
  levelSelect.hidden = !allText;
  textControls.querySelector('[data-text="box"]').hidden = !allText;
  textControls.querySelector('[data-text="box"]').classList.toggle('on', (n.box || 'none') !== 'none');
  if (allText) levelSelect.value = n.level;
  fillFontMenu(n.font);
  textControls.querySelector('[data-text="bold"]').classList.toggle('on', notes.every((x) => x.weight >= 600));
  textControls.querySelector('[data-text="italic"]').classList.toggle('on', notes.every((x) => x.italic));
  textControls.querySelector('[data-text="align"]').innerHTML = ALIGN_ICONS[n.align || 'left'];
  textControls.querySelector('.sel-colour').style.setProperty('--c', n.color);
}

function placeSelectionBar() {
  const sel = board.selection;
  updateTextControls(sel);
  const pane = activePane && boardPanes().includes(activePane) ? activePane : boardPanes()[0];
  const show = mode === 'board' && sel.length > 0 && !drag && !cropping && pane && !noteEditor.editing;
  selectionBar.hidden = !show;
  if (!show) return;
  for (const [id, , , when] of SEL_ACTIONS) selectionBar.querySelector(`[data-action="${id}"]`).hidden = when ? !when(sel) : false;
  // Just above the top of the selection, kept inside the pane.
  const b = board.bounds(sel);
  const cam = pane.camera;
  const r = pane.rect;
  const cx = r.x + cam.x + (b.x + b.width / 2) * cam.zoom;
  const top = r.y + cam.y + b.y * cam.zoom;
  const w = selectionBar.offsetWidth, h = selectionBar.offsetHeight;
  const x = Math.min(Math.max(cx - w / 2, r.x + 8), r.x + r.w - w - 8);
  let y = top - h - 40;
  if (y < r.y + 8) {
    // No room above: go below it, unless that runs into the drawing toolbar at the
    // bottom; then sit just inside the selection's top edge.
    y = r.y + cam.y + (b.y + b.height) * cam.zoom + 14;
    const tb = document.getElementById('toolbar').getBoundingClientRect();
    const bottom = Math.min(r.y + r.h, tb.height ? tb.top : Infinity) - 8;
    if (y + h > bottom) y = Math.min(Math.max(r.y + 8, top + 14), bottom - h);   // just inside the top edge, clear of the rotate handle
  }
  selectionBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
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
  // The drawing toolbar fades out while you work in a search or mannequin pane,
  // so it never covers their buttons.
  const over = hoverPane();
  document.getElementById('toolbar').classList.toggle('away', !!over && over.type !== 'board');
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
  if (e.button === 1 || (e.button === 0 && (spaceHeld || tool === 'hand'))) {
    // Middle button, Space + drag, or the Hand tool: only ever moves the view.
    e.preventDefault();
    if (tool === 'hand') board.selected = null;
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
  } else if (e.button === 0 && (tool === 'note' || tool === 'text')) {
    e.preventDefault();  // keep the text box focused
    drag = null;
    // While typing, a click elsewhere just finishes the note.
    if (noteEditor.editing) noteEditor.finish();
    else {
      const hit = board.hitTest(w.x, w.y);
      if (hit?.kind === 'note') editNote(hit, pane);
      else addNoteAt(pane, w.x, w.y, tool === 'text' ? 'text' : 'sticky');
    }
  } else if (e.button === 0 && (tool === 'shape' || tool === 'frame')) {
    // Drag to draw a shape or a frame.
    board.selected = null;
    let item;
    if (tool === 'frame') {
      item = board.addFrame({ x: w.x, y: w.y, w: 1, h: 1, name: `Frame ${board.frames.length + 1}`, titleSize: 15 / pane.camera.zoom });
    } else {
      const shape = toolbar.state.shape;
      item = board.addShape({ shape, x: w.x, y: w.y, w: 1, h: 1, dx: 1, dy: 0, color: toolbar.color, strokeWidth: toolbar.state.shapeSize / pane.camera.zoom });
    }
    drag = { kind: 'create', pane, item, start: w, moved: false };
  } else if (e.button === 0 && cropping) {
    // Cropping: drag a box over the part to keep.
    board.marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
    drag = { kind: 'crop', pane };
  } else if (e.button === 0) {
    const handle = handleAt(pane, w);
    // A frame's name label selects the frame; otherwise the top thing under the mouse.
    const hit = board.frameTitleAt(w.x, w.y) || board.hitTest(w.x, w.y);
    if (handle !== null) {
      // A corner handle scales, the round handle above rotates.
      const box = board.selectionBox();
      const items = [...board.selection];
      const before = items.map(stateOf);
      if (handle === 'rotate') {
        drag = { kind: 'rotate', pane, items, before, cx: box.cx, cy: box.cy, start: Math.atan2(w.y - box.cy, w.x - box.cx) };
      } else {
        const anchor = box.corners[(handle + 2) % 4];
        drag = { kind: 'scale', pane, items, before, anchor, startDist: Math.max(1e-6, Math.hypot(w.x - anchor.x, w.y - anchor.y)) };
      }
    } else if (e.shiftKey) {
      // Shift: click adds or removes one; dragging on empty space draws a selection box.
      if (hit) {
        const group = board.groupOf(hit);
        const on = board.isSelected(hit);
        board.selection = on ? board.selection.filter((x) => !group.includes(x)) : [...new Set([...board.selection, ...group])];
        drag = null;
      }
      else {
        board.marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
        drag = { kind: 'marquee', pane, base: [...board.selection] };
      }
    } else if (hit) {
      // Clicked an image or note: select it (keeping a group selected if it's part of
      // one), raise it to the top and start moving everything selected.
      if (!board.isSelected(hit)) board.selection = board.groupOf(hit);
      board.bringToFront(hit);
      // Frames take what's inside them along.
      const items = [...new Set([...board.selection, ...board.selection.filter((x) => x.kind === 'frame').flatMap((f) => board.contentsOf(f))])];
      drag = { kind: 'move', pane, items, before: items.map(stateOf), start: w, moved: false };
    } else {
      // Clicked empty space: deselect and pan.
      board.selected = null;
      drag = { kind: 'pan', pane };
    }
  }
  activePane = pane;
  panesEl.classList.toggle('panning', drag?.kind === 'pan');
  updateCursor();
  requestRender();
});

panesEl.addEventListener('pointermove', (e) => {
  const dx = e.clientX - (mouse.x ?? e.clientX);
  const dy = e.clientY - (mouse.y ?? e.clientY);
  mouse.x = e.clientX; mouse.y = e.clientY;
  updateCursor();
  if (!drag) {
    // Show which handle the mouse is over.
    const pane = viewports.paneFromElement(e.target);
    let over = null;
    if (pane?.type === 'board' && toolbar.tool === 'select') {
      const p = localPoint(pane, e);
      over = handleAt(pane, pane.camera.toWorld(p.x, p.y));
    }
    panesEl.dataset.handle = over === null ? '' : over === 'rotate' ? 'rotate' : over % 2 ? 'nesw' : 'nwse';
    return;
  }
  if (drag.kind === 'pan') {
    drag.pane.camera.panBy(dx, dy);
  } else if (['move', 'scale', 'rotate', 'marquee', 'crop', 'create'].includes(drag.kind)) {
    // These follow the mouse in the pane you're dragging in; every other pane updates too.
    const p = localPoint(drag.pane, e);
    const w = drag.pane.camera.toWorld(p.x, p.y);
    dragTo(drag, w, e);
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

  if (d.kind === 'create') {
    const it = d.item;
    if (!d.moved || (it.kind !== 'shape' || it.shape === 'rect' || it.shape === 'ellipse' ? Math.max(it.w, it.h) : Math.hypot(it.dx, it.dy)) * d.pane.camera.zoom < 6) {
      // Just a click: a shape or frame of a standard size.
      const z = d.pane.camera.zoom;
      if (it.kind === 'frame') { it.w = 960 / z; it.h = 540 / z; board.drawFrame(it); }
      else if (it.shape === 'rect' || it.shape === 'ellipse') { it.w = 180 / z; it.h = 120 / z; board.drawShape(it); }
      else { it.dx = 180 / z; it.dy = 0; board.drawShape(it); }
      it.sprite.position.set(d.start.x, d.start.y);
    }
    const kind = it.kind;
    const data = kind === 'frame' ? board.frameJSON(it) : board.shapeJSON(it);
    history.push({ undo: () => removeThing(kind, data.id), redo: () => restoreThing({ kind, data }) });
    board.selected = it;
    toolbar.setTool('select');
    contentChanged();
  } else if (['move', 'scale', 'rotate'].includes(d.kind)) {
    recordChange(d.items, d.before);
  } else if (d.kind === 'marquee') {
    board.marquee = null;
  } else if (d.kind === 'crop') {
    const m = board.marquee;
    board.marquee = null;
    finishCrop(m);
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
  // (Found by position: while clicking, the mouse is captured by the whole pane area.)
  const pane = viewports.paneAt(e.clientX, e.clientY);
  if (pane?.type !== 'board') return;
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const title = board.frameTitleAt(w.x, w.y);
  if (title) return renameFrame(title, pane);
  const hit = board.hitTest(w.x, w.y);
  if (hit?.kind === 'note') editNote(hit, pane);
  else if (hit?.kind === 'frame') renameFrame(hit, pane);
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

const EXTENSION_HELP = 'https://github.com/germanreinac/reference-board#browser-extension';

// The image or note that was right-clicked (it may be locked), for Lock / Unlock.
let menuTarget = null;

// Lock or unlock one thing, or everything ('all'). Can be undone.
function setLocked(target, locked) {
  const targets = target === null ? [...board.selection] : [target];
  const changed = targets.flatMap((t) => board.setLocked(t, locked)).map((x) => [x.kind, x.id]);
  if (!changed.length) return;
  const apply = (value) => {
    for (const [kind, id] of changed) { const x = board.find(kind, id); if (x) board.setLocked(x, value); }
    requestRender();
  };
  history.push({ undo: () => apply(!locked), redo: () => apply(locked) });
  toast(locked ? `Locked ${changed.length === 1 ? 'it' : `${changed.length} things`}. Right-click to unlock.` : 'Unlocked', 2200);
  contentChanged();
  requestRender();
}

function openMenu(x, y, pane) {
  const l = layout();
  const several = l.panes().length > 1;
  const items = [
    { label: 'All boards', action: goHome },
    { label: 'New board', action: newBoard },
    { label: 'Open file…', shortcut: `${MOD}O`, action: openFile },
    { label: 'Save to file', shortcut: `${MOD}S`, action: () => saveToFile() },
    { label: 'Save to file as…', shortcut: `${MOD}Shift+S`, action: () => saveToFile({ saveAs: true }) },
    { label: currentTheme() === 'light' ? 'Dark mode' : 'Light mode', action: toggleTheme },
    { label: board.frames.length ? `Present (${board.frames.length} frame${board.frames.length > 1 ? 's' : ''})` : 'Present', shortcut: `${MOD}Enter`, disabled: board.isEmpty(), action: startPresent },
    '-',
    { label: 'Capture screen…', action: captureScreen },
    { label: document.documentElement.dataset.refboardExtension ? 'Browser extension: installed ✓' : 'Get the browser extension…', action: () => window.open(EXTENSION_HELP, '_blank', 'noopener') },
  ];
  if (pane) {
    items.push('-',
      { label: 'Split side by side', shortcut: 'Alt+V', action: () => paneAction('split-row', pane) },
      { label: 'Split top and bottom', shortcut: 'Alt+H', action: () => paneAction('split-col', pane) },
      { label: l.maximized ? 'Restore panes' : 'Maximize pane', shortcut: 'Ctrl+Space', disabled: !several, action: () => paneAction('maximize', pane) },
      { label: 'Close pane', shortcut: 'Alt+W', disabled: !several, action: () => paneAction('close', pane) },
      '-',
      { label: board.selected ? 'Fit selection' : 'Fit everything', shortcut: 'F', disabled: board.isEmpty(), action: () => { fitPane(pane, board.selected ? [board.selected] : null); requestRender(); } },
      { label: board.selection.length > 1 ? `Delete ${board.selection.length} things` : board.selected?.kind === 'note' ? 'Delete note' : 'Delete image', shortcut: 'Del', disabled: !board.selection.length, action: removeSelected },
      ...(board.selection.some((x) => x.kind === 'image') ? [
        '-',
        { label: 'Flip left to right', action: () => flipSelection('x') },
        { label: 'Flip upside down', action: () => flipSelection('y') },
        { label: 'Greyscale on / off', action: toggleGrey },
        ...(board.selected?.kind === 'image' ? [
          { label: 'Crop…', action: startCrop },
          ...(board.selected.crop ? [{ label: 'Undo crop (show the whole image)', action: resetCrop }] : []),
          { label: 'Extract colours', action: extractColours },
        ] : []),
      ] : []),
      ...(board.selection.length > 1 ? [
        { label: 'Align and spread…', action: () => alignMenu(x, y) },
        { label: 'Group', shortcut: `${MOD}G`, action: groupSelection },
      ] : []),
      ...(board.selection.some((s) => s.group) ? [{ label: 'Ungroup', shortcut: `${MOD}Shift+G`, action: ungroupSelection }] : []),
      ...(board.selection.length ? [
        '-',
        { label: 'Duplicate', shortcut: `${MOD}D`, action: duplicateSelection },
        { label: 'Copy', shortcut: `${MOD}C`, action: copySelection },
        { label: 'Bring to front', action: () => reorderSelection(true) },
        { label: 'Send to back', action: () => reorderSelection(false) },
        { label: 'Put a frame around', action: frameSelection },
      ] : []),
      ...(board.selected?.kind === 'image' ? [
        { label: 'Copy image', action: () => copyImage(board.selected) },
        { label: 'Download image', action: () => downloadImage(board.selected) },
      ] : []),
      ...(menuTarget ? [{
        label: `${menuTarget.locked ? 'Unlock' : 'Lock'} ${menuTarget.kind === 'note' ? 'note' : 'image'}`,
        shortcut: 'L',
        action: () => setLocked(menuTarget, !menuTarget.locked),
      }] : []),
      { label: 'Lock everything', action: () => setLocked('all', true) },
      { label: 'Unlock everything', action: () => setLocked('all', false) },
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
    const hit = board.hitTest(w.x, w.y, { includeLocked: true });
    if (!(hit && !hit.locked && board.isSelected(hit))) board.selected = hit && !hit.locked ? hit : null;
    menuTarget = hit;
    requestRender();
  } else {
    menuTarget = null;
  }
  openMenu(e.clientX, e.clientY, pane);
});

// ---------- Present mode ----------
//
// Shows the board full screen, one frame at a time, like slides. With no frames,
// the whole board is the one slide. → / Space / click: next. ← / right-click: back.
// Esc: stop. The frames are shown in the order they were made.

let presenting = null;  // { pane, slides, index, before, anim }

// While presenting frames, everything outside the current frame is covered with the
// background colour, so each frame reads as a clean slide.
const presentCover = new Graphics();
function coverOutside(slide) {
  presentCover.clear();
  if (!board.frames.length) return;
  const { x, y, width: w, height: h } = slide;
  const far = 1e6;
  presentCover
    .rect(x - far, y - far, far * 2 + w, far).rect(x - far, y + h, far * 2 + w, far)
    .rect(x - far, y, far, h).rect(x + w, y, far, h)
    .fill(themeColours().board);
}

function slideBounds(f) {
  return { x: f.sprite.x - f.w / 2, y: f.sprite.y - f.h / 2, width: f.w, height: f.h, name: f.name };
}

function startPresent() {
  if (mode !== 'board' || presenting) return;
  if (board.isEmpty()) { toast('Add something to the board first.', 1800); return; }
  const l = layout();
  const pane = targetBoardPane() || l.panes().find((p) => p.type === 'board');
  if (!pane) { toast('Present needs a board pane. Switch a pane back to Board first.', 2600); return; }
  hideMenu();
  if (noteEditor.editing) noteEditor.finish();
  cropping = null;
  const slides = board.frames.length ? board.frames.map(slideBounds) : [{ ...board.bounds(null), name: current?.name || '' }];
  presenting = {
    pane, slides, index: 0, anim: 0,
    before: { maximized: l.maximized, camera: { x: pane.camera.x, y: pane.camera.y, zoom: pane.camera.zoom }, selection: [...board.selection] },
  };
  board.selection = [];
  board.frameLayer.visible = false;   // just the content, no frame outlines or names
  board.world.addChild(presentCover);
  viewports.hideDots = true;
  l.maximized = l.panes().length > 1 ? pane : null;
  document.body.classList.add('presenting');
  hud.hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  viewports.rebuild();
  showSlide(0, false);
}

function stopPresent() {
  if (!presenting) return;
  const { pane, before } = presenting;
  cancelAnimationFrame(presenting.anim);
  presenting = null;
  document.body.classList.remove('presenting');
  hud.hidden = true;
  board.frameLayer.visible = true;
  presentCover.clear();
  presentCover.removeFromParent();
  viewports.hideDots = false;
  layout().maximized = before.maximized;
  Object.assign(pane.camera, before.camera);
  board.selection = before.selection.filter((x) => board.find(x.kind, x.id));
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  viewports.rebuild();
  requestRender();
}

// Move the camera to a slide: a short, smooth glide (or a jump).
function showSlide(i, animate = true) {
  const P = presenting;
  if (!P) return;
  P.index = Math.max(0, Math.min(P.slides.length - 1, i));
  const slide = P.slides[P.index];
  const cam = P.pane.camera;
  const { w, h } = P.pane.rect;
  const target = new Camera();
  target.frame(slide, w, h, Math.min(w, h) * 0.04);
  coverOutside(slide);
  hudText.textContent = `${P.index + 1} / ${P.slides.length}${slide.name ? ` · ${slide.name}` : ''}`;
  hud.classList.remove('faded');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.add('faded'), 2200);
  cancelAnimationFrame(P.anim);
  if (!animate) { Object.assign(cam, { x: target.x, y: target.y, zoom: target.zoom }); requestRender(); return; }
  // Glide the middle of the view and the zoom (zoom in steps that feel even: log scale).
  const from = { c: cam.toWorld(w / 2, h / 2), z: Math.log(cam.zoom) };
  const to = { c: target.toWorld(w / 2, h / 2), z: Math.log(target.zoom) };
  const start = performance.now();
  const ms = 520;
  const step = (now) => {
    if (presenting !== P) return;
    const t = Math.min(1, (now - start) / ms);
    const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;   // ease in and out
    const zoom = Math.exp(from.z + (to.z - from.z) * k);
    const cx = from.c.x + (to.c.x - from.c.x) * k, cy = from.c.y + (to.c.y - from.c.y) * k;
    Object.assign(cam, { zoom, x: w / 2 - cx * zoom, y: h / 2 - cy * zoom });
    requestRender();
    if (t < 1) P.anim = requestAnimationFrame(step);
  };
  P.anim = requestAnimationFrame(step);
}

// The little bar at the bottom while presenting: back, "2 / 5 · name", next, stop.
const hud = document.createElement('div');
hud.id = 'present-hud';
hud.hidden = true;
hud.innerHTML = `
  <button data-go="-1" title="Back (←)"><svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg></button>
  <span class="present-where"></span>
  <button data-go="1" title="Next (→ or Space)"><svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5"/></svg></button>
  <button data-go="stop" title="Stop presenting (Esc)"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
document.body.appendChild(hud);
const hudText = hud.querySelector('.present-where');
let hudTimer;
hud.addEventListener('pointerdown', (e) => e.stopPropagation());
hud.addEventListener('click', (e) => {
  const go = e.target.closest('button')?.dataset.go;
  if (go === 'stop') stopPresent();
  else if (go) showSlide(presenting.index + Number(go));
});
// Moving the mouse brings the bar back for a moment.
window.addEventListener('pointermove', () => {
  if (!presenting) return;
  hud.classList.remove('faded');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.add('faded'), 2200);
});

// While presenting, a click moves on (right-click goes back) instead of editing.
panesEl.addEventListener('pointerdown', (e) => {
  if (!presenting) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  if (e.button === 0) showSlide(presenting.index + (e.shiftKey ? -1 : 1));
  else if (e.button === 2) showSlide(presenting.index - 1);
}, true);
panesEl.addEventListener('contextmenu', (e) => { if (presenting) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
panesEl.addEventListener('dblclick', (e) => { if (presenting) e.stopImmediatePropagation(); }, true);
// Leaving full screen (Chrome uses Esc for that itself) ends the presentation too.
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && presenting) stopPresent(); });
// The window changes size when it goes full screen: fit the slide again.
window.addEventListener('resize', () => { if (presenting) requestAnimationFrame(() => showSlide(presenting.index, false)); });

function presentKey(e) {
  const P = presenting;
  const k = e.key;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) showSlide(P.index + 1);
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) showSlide(P.index - 1);
  else if (k === 'Home') showSlide(0);
  else if (k === 'End') showSlide(P.slides.length - 1);
  else if (k === 'Escape') stopPresent();
  else return;
  e.preventDefault();
}

document.getElementById('present-button').addEventListener('click', startPresent);

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (presenting) { presentKey(e); return; }
  if (mod && e.key === 'Enter' && mode === 'board' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); startPresent(); return; }
  if (mod && e.code === 'KeyF' && mode === 'board') { e.preventDefault(); hideMenu(); openSearch(); return; }
  if (e.target.closest?.('input, textarea, select')) return;

  if (mod && e.code === 'KeyO') { e.preventDefault(); hideMenu(); openFile(); return; }
  if (mode !== 'board') return;

  const pane = hoverPane() || layout().visiblePanes()[0];
  if (mod && e.code === 'KeyS') { e.preventDefault(); hideMenu(); saveToFile({ saveAs: e.shiftKey }); return; }
  if (mod && e.code === 'KeyZ') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
  if (mod && (e.code === 'KeyB' || e.code === 'KeyI') && selectedNotes().length) {
    e.preventDefault();
    textControls.querySelector(`[data-text="${e.code === 'KeyB' ? 'bold' : 'italic'}"]`).click();
    return;
  }
  if (mod && e.code === 'KeyG') { e.preventDefault(); (e.shiftKey ? ungroupSelection : groupSelection)(); requestRender(); return; }
  if (mod && e.code === 'KeyD') { e.preventDefault(); duplicateSelection(); return; }
  if (mod && e.code === 'KeyC' && board.selection.length) { if (copySelection()) e.preventDefault(); return; }
  if (!mod && !e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && board.selection.length) {
    e.preventDefault();
    nudge({ ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0, e.shiftKey);
    return;
  }
  if (mod && e.code === 'KeyA') { e.preventDefault(); board.selection = [...board.items, ...board.notes, ...board.shapes].filter((x) => !x.locked); requestRender(); return; }

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
  } else if (e.code === 'KeyL' && board.selection.length) {
    setLocked(null, true);
  } else if (e.key === 'Escape') {
    if (cropping) { cropping = null; toast('Crop cancelled', 1200); }
    else board.selected = null;
    requestRender();
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
// Uploaded fonts first, so text draws in the right font. When any font finishes
// loading later, lay the text out again with it.
await loadCustomFonts();
document.fonts.addEventListener('loadingdone', () => { board.relayoutNotes(); requestRender(); });
await route();

// Handy for testing from the browser console.
window.__refboard = { board, viewports, layout, addImages, saveNow, get current() { return current; }, store, routing: () => routing };
