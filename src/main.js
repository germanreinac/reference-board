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
import { openCompare, compareOpen } from './compare.js';
import { motionOn, setMotion, averageColour, ripple } from './liquid.js';
import * as drive from './drive.js';
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
import { loadTheme, themeColours, toggleTheme, currentTheme, themeInk, nextTheme, pastelName, applyLook, currentLook, defaultLook } from './theme.js';
import { VERSION } from './version.js';
import { LEVELS } from './board.js';
import { BRAND_FONTS, customFonts, customFontBlob, loadCustomFonts, addFontFile, uploadFont, ensureFont, isFontFile, isBrandFont } from './fonts.js';
document.querySelector('.home-version').textContent = `Version ${VERSION}`;
import {
  FILE_EXT, packBoard, unpackBoard, isBoardFile, isBoardPart, joinParts, describeBoard, canPickFiles,
  pickSaveLocation, ensureWritePermission, writeToHandle, pickBoardToOpen, downloadBlob,
  store, newBoardId, askToKeepStorage, storageIsKept, packBackup, unpackBackup, isBackupFile, BACKUP_EXT,
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
// If the graphics card drops the board's drawing (out of memory, or the driver reset),
// everything would go blank: save and reload the page instead.
app.canvas.addEventListener('webglcontextlost', () => {
  toast('The graphics card reset. Reloading the board…', 10000);
  Promise.resolve(mainDoc && saveNow()).catch(() => {}).finally(() => setTimeout(() => location.reload(), 1200));
});

// The board you're working on: the one in the pane you last clicked. Each pane can
// show a different board (see "Boards on screen" below); `board`, `history` and
// `current` always point at the one you're working on.
let board = new Board();
const docs = new Map();   // every board on screen, by id (see "Boards on screen")
let mainDoc = null;       // the board in the address bar
let activeDoc = null;     // the one you're working on
const panesEl = document.getElementById('panes');
const viewports = new Viewports({
  app, board, boardOf: (pane) => docOfPane(pane)?.board || board, paneLabel: (pane) => paneLabel(pane), layout: new Layout(), element: panesEl, background: BOARD_COLOUR,
  requestRender: () => requestRender(),
  onPaneAction: (action, pane, button) => paneAction(action, pane, button),
  onLayoutChanged: () => viewChanged(),
  createEditor: (pane, host) => createEditor(pane, host, {
    add: (result) => addSearchResult(result),
    fill: (results, query) => fillBoard(results, query),
    changed: () => viewChanged(),
    toast: (m) => toast(m),
    addImage: (blob, name) => addBlobToBoard(blob, name),
    // The main colours of the image selected on the board (for the mood board's colours).
    palette: async () => {
      const it = board.selection.find((x) => x.kind === 'image' && x.blob);
      return it ? (await imageColours(it, 5)).map((c) => c.hex) : null;
    },
  }),
});
const layout = () => viewports.layout;
viewports.setColours(themeColours());
board.setInk(themeInk());

// The panes showing the board (not search or the mannequin).
const boardPanes = () => layout().visiblePanes().filter((p) => p.type === 'board');
// The board pane under the mouse, or else the first one on screen. Can be null.
// The board in that pane becomes the one you're working on.
function targetBoardPane(x = mouse.x, y = mouse.y) {
  const p = x === null ? null : viewports.paneAt(x, y);
  const pane = p?.type === 'board' ? p : boardPanes().find((q) => docOfPane(q) === activeDoc) || boardPanes()[0] || null;
  if (pane) activate(docOfPane(pane));
  return pane;
}

// Which screen is showing: 'home' or 'board'.
let mode = 'home';
function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  hideMenu();
  // The home screen is always dark; each board has its own look (set when it opens).
  if (m !== 'board') applyLook({ theme: 'dark' });
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
    // Keep the text in view sharp, for the most zoomed-in pane that shows it.
    for (const d of docs.values()) {
      const views = boardPanes().filter((p) => (docOfPane(p) || mainDoc) === d).map((p) => {
        const a = p.camera.toWorld(0, 0), z = p.camera.toWorld(p.rect.w, p.rect.h);
        return { zoom: Math.max(1, p.camera.zoom), x0: a.x, y0: a.y, x1: z.x, y1: z.y };
      });
      d.board.updateTextSharpness(views, app.renderer.resolution);
    }
    viewports.render();
    detailSoon();
    noteEditor.position();
    placeToolbar();
    placeSelectionBar();
    // The "drop images here" hint is for a brand-new board: only while every board on
    // screen is empty.
    const allEmpty = boardPanes().every((p) => (docOfPane(p)?.board || board).isEmpty());
    emptyHint.classList.toggle('hidden', !allEmpty || noteEditor.editing);
    // Keep drawing while something is moving (springs, wobbles, splashes).
    if (viewports.animating() || [...docs.values()].some((d) => d.board.animating())) requestRender();
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
  for (const d of docs.values()) d.board.setInk(themeInk());
  app.renderer.background.color = e.detail.gap;
  requestRender();
});

// ---------- Messages ----------

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message, ms = 4000) {
  if (!message) message = 'Something went wrong.';
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
// The top bar and the window title show the main board (the one in the address bar).
function updateTitle() {
  const main = mainDoc?.meta;
  if (document.activeElement !== nameInput) nameInput.value = main?.name || '';
  document.title = main ? `${main.name} – artdirection.io` : 'artdirection.io · Reference Board';
  renderTabs();
}

// ---------- Boards on screen ----------
//
// The board in the address bar is the main one: it owns the pane layout. Any pane can
// show another board too. Every board on screen is a "doc":
//   { meta, board, history, thumbStale, layoutJSON }
// meta is the saved record without the board data; layoutJSON is the other board's own
// layout, kept as it was so saving it doesn't overwrite it with this one.
// (docs, mainDoc and activeDoc are declared at the top, next to `board`.)

function makeDoc(meta) {
  const b = new Board();
  b.setInk(themeInk());
  return { meta, board: b, history: new History(() => updateHistoryButtons()), thumbStale: false, layoutJSON: null };
}

// The doc a board pane shows (null for tool panes).
function docOfPane(pane) {
  if (!pane || pane.type !== 'board') return null;
  return (pane.boardId && docs.get(pane.boardId)) || mainDoc;
}

// Start working on another board on screen: its selection, undo and name.
function activate(doc) {
  if (!doc || doc === activeDoc) return;
  if (noteEditor.editing) noteEditor.finish();
  finishCaption();
  closeStarPanel();
  cropping = null;
  if (activeDoc) activeDoc.board.selection = [];
  activeDoc = doc;
  board = doc.board;
  history = doc.history;
  current = doc.meta;
  updateHistoryButtons();
  updateStarButton();
  viewports.position();
  requestRender();
}

// The small name label on a pane, shown when more than one board is on screen.
function paneLabel(pane) {
  if (pane.type !== 'board' || docs.size < 2) return null;
  const d = docOfPane(pane);
  return d ? { text: d.meta.name, active: d === activeDoc, main: d === mainDoc } : null;
}

// Something on the board changed (images added, moved, removed...).
function contentChanged() {
  if (!current || !activeDoc) return;
  current.updated = Date.now();
  activeDoc.thumbStale = true;
  scheduleSave();
  syncSoon();
}

// Only the view changed (pan, zoom, panes). Remembered, but doesn't change "last edited".
function viewChanged() {
  scheduleSave();
}

let saveTimer;
let loading = false;
let lastThumb = 0;
function scheduleSave() {
  if (loading || !mainDoc) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 600);
}

// Write every board on screen to Chrome's storage. Preview pictures are updated at
// most every 10 seconds while you work, and always when you leave the board.
async function saveNow({ thumb = false } = {}) {
  clearTimeout(saveTimer);
  if (!mainDoc || loading) return;
  try {
    const due = thumb || Date.now() - lastThumb > 10000;
    if (due) lastThumb = Date.now();
    for (const d of [...docs.values()]) {
      const lay = d === mainDoc ? layout() : { toJSON: () => d.layoutJSON };
      await store.putBoard({ ...d.meta, board: describeBoard(d.board, lay) });
      if (d.thumbStale && due) {
        d.thumbStale = false;
        await store.saveThumb(d.meta.id, await viewports.snapshot(d.board));
      }
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
    const bitmap = await createImageBitmap(blob);
    // Bigger than the graphics card can take: show a copy that fits (the file itself is
    // kept as it is). It still measures its real size on the board.
    if (Math.max(bitmap.width, bitmap.height) > maxTexture) {
      const fitted = await scaledCopy(bitmap, maxTexture);
      fitted.fullWidth = bitmap.width;
      fitted.fullHeight = bitmap.height;
      bitmap.close();
      return fitted;
    }
    return bitmap;
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
  for (const [i, { entry, bitmap }] of decoded.entries()) {
    const item = board.addImage(bitmap, x + bitmap.width / 2, wy, entry);
    x += bitmap.width + GAP;
    added.push(item);
    if (motionOn()) board.popIn(item, averageColour(bitmap), i * 60);
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
  if (motionOn()) {
    // Up in flames (with a sweeper to tidy the ash).
    for (const item of items) {
      if (item.kind === 'image' && current) store.deleteImage(current.id, item.id).catch(() => {});
      board.burn(item);
    }
  } else {
    for (const item of items) removeThing(item.kind, item.id);
  }
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
const FRAME_PROPS = ['w', 'h', 'name', 'level', 'font', 'weight', 'italic', 'color', 'fill', 'titleBase'];
const IMAGE_PROPS = ['caption', 'star'];
const propsOf = (kind) => ({ note: TEXT_PROPS, shape: SHAPE_PROPS, frame: FRAME_PROPS, image: IMAGE_PROPS }[kind] || []);
function stateOf(item) {
  const s = item.sprite;
  const st = { kind: item.kind, id: item.id, x: s.x, y: s.y, sx: item.anim?.sx ?? s.scale.x, sy: item.anim?.sy ?? s.scale.y, r: s.rotation, crop: item.crop || null, grey: !!item.grey };
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
  if (it.kind === 'image') board.setCaption(it, it.caption);
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
  showMenu(x, y, alignItems());
}
function alignItems() {
  return [
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
    { label: 'Lay out as a storyboard', action: storyboardSelection },
    { label: 'Colour script (main colours under each image)', action: colourScript },
  ];
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
// While typing, clicking on the title's band moves the cursor there (drag to select).
let titleEditor = null;
panesEl.addEventListener('pointerdown', (e) => {
  if (!titleEditor || e.button !== 0) return;
  const pane = viewports.paneAt(e.clientX, e.clientY);
  if (pane?.type !== 'board') return;
  const at = (ev) => { const w = pane.camera.toWorld(ev.clientX - pane.rect.x, ev.clientY - pane.rect.y); return board.titleIndexAt(titleEditor.f, w.x, w.y); };
  const i0 = at(e);
  if (i0 < 0) return;                       // clicked elsewhere: that finishes the title as usual
  e.preventDefault();                       // keep typing (don't let the box lose focus)
  e.stopImmediatePropagation();
  const { input } = titleEditor;
  input.focus();
  input.setSelectionRange(i0, i0);
  input.dispatchEvent(new Event('select'));
  const move = (ev) => {
    const i1 = at(ev);
    if (i1 < 0) return;
    input.setSelectionRange(Math.min(i0, i1), Math.max(i0, i1), i1 < i0 ? 'backward' : 'forward');
    input.dispatchEvent(new Event('select'));
  };
  const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
}, true);
function renameFrame(f, pane, at = -1) {
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
  // Start where you double-clicked (or at the end).
  const startAt = at >= 0 ? Math.min(at, input.value.length) : input.value.length;
  input.setSelectionRange(startAt, startAt);
  titleEditor = { f, input };
  const before = [stateOf(f)];
  const original = f.name;
  // You type into an invisible box; what you see is the title on the board itself, with a
  // rounded band behind it that follows the text round the frame (curving round the
  // corners) and a blinking cursor. See Board._drawTitleBand.
  input.classList.add('ghost');
  const css = getComputedStyle(document.body);
  const colour = (name, fallback) => { const v = css.getPropertyValue(name).trim(); return /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : fallback; };
  board.titleEdit = { frame: f, caret: input.value.length, fill: colour('--input', 0x141416), accent: colour('--accent', 0x4da3ff) };
  let lastGood = input.value, lastSel = [input.selectionStart, input.selectionEnd], warned = 0;
  const update = () => {
    if (!board.titleFits(f, input.value)) {
      // Gone all the way round: no more room (make the frame bigger for more).
      input.value = lastGood;
      input.setSelectionRange(lastSel[0], lastSel[1]);
      if (Date.now() - warned > 2500) { toast('The title has gone all the way round. Make the frame bigger for more room.', 2600); warned = Date.now(); }
    }
    lastGood = input.value;
    lastSel = [input.selectionStart, input.selectionEnd];
    f.name = input.value.trim() ? input.value : original;
    board.titleEdit.caret = input.value.trim() ? (input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd) : 0;
    board.titleEdit.sel = [input.selectionStart, input.selectionEnd];
    board.drawFrame(f);
    requestRender();
  };
  for (const ev of ['input', 'keyup', 'select', 'click']) input.addEventListener(ev, update);
  document.addEventListener('selectionchange', update);
  const blink = setInterval(requestRender, 300);
  update();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    clearInterval(blink);
    document.removeEventListener('selectionchange', update);
    board.titleEdit = null;
    titleEditor = null;
    f.name = save && input.value.trim() ? input.value.trim() : original;
    board.drawFrame(f);
    if (f.name !== original) recordChange([f], before);
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

// ---------- Pushing through the jelly between panes ----------
//
// Dragging something towards another pane, it sticks at the edge for a moment while the
// gap bulges and ripples, then breaks through with a splash. Into a pane showing the same
// board, it carries on under the mouse there. Into another board's pane, a floating copy
// follows the mouse and it lands on that board when you let go.

const MEMBRANE = 36;   // how far past the edge (pixels) before it breaks through
let lastJellyRipple = 0;

// Returns the screen point the dragged things should follow.
function portalDrag(d, e) {
  const cursor = { x: e.clientX, y: e.clientY };
  if (!motionOn()) return cursor;
  const r = d.pane.rect;
  const inside = cursor.x >= r.x && cursor.x <= r.x + r.w && cursor.y >= r.y && cursor.y <= r.y + r.h;
  if (inside) { endGhost(d); d.broke = null; return cursor; }
  const over = viewports.paneAt(cursor.x, cursor.y);
  const depth = Math.max(r.x - cursor.x, cursor.x - (r.x + r.w), r.y - cursor.y, cursor.y - (r.y + r.h));
  const clamped = { x: Math.max(r.x, Math.min(r.x + r.w, cursor.x)), y: Math.max(r.y, Math.min(r.y + r.h, cursor.y)) };
  if (!over || over.type !== 'board') return d.ghost ? clamped : cursor;   // window edge, top bar, a tool pane
  if (d.ghost) { moveGhost(d, cursor); return clamped; }
  if (depth < MEMBRANE) {
    // Stuck in the jelly: the gap bulges where you push.
    const now = performance.now();
    if (now - lastJellyRipple > 55) { ripple(clamped.x, clamped.y, 2 + depth * 0.22); lastJellyRipple = now; }
    return clamped;
  }
  // Through!
  ripple(clamped.x, clamped.y, 12);
  viewports.wobble(3, [d.pane, over]);
  if (docOfPane(over) === docOfPane(d.pane)) {
    // Same board: keep dragging in that pane (the board point under the mouse stays the same).
    d.pane = over;
    d.snap = null;
    activePane = over;
    return cursor;
  }
  startGhost(d, cursor);
  return clamped;
}

function startGhost(d, at) {
  const el = document.createElement('div');
  el.className = 'drag-ghost';
  const img = d.items.find((x) => x.kind === 'image' && x.blob);
  if (img) {
    d.ghostUrl = URL.createObjectURL(img.blob);
    el.style.backgroundImage = `url("${d.ghostUrl}")`;
    const k = Math.min(1, 160 / Math.max(img.width, img.height));
    Object.assign(el.style, { width: `${img.width * k}px`, height: `${img.height * k}px` });
  }
  if (d.items.length > 1) el.dataset.count = String(d.items.length);
  document.body.appendChild(el);
  d.ghost = el;
  for (const x of d.items) { x.ghostAlpha = x.sprite.alpha; x.sprite.alpha *= 0.25; }
  moveGhost(d, at);
}
function moveGhost(d, at) {
  if (d.ghost) d.ghost.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%) rotate(-4deg)`;
}
function endGhost(d) {
  if (!d?.ghost) return;
  d.ghost.remove();
  d.ghost = null;
  if (d.ghostUrl) URL.revokeObjectURL(d.ghostUrl);
  for (const x of d.items) { if (x.ghostAlpha !== undefined) { x.sprite.alpha = x.ghostAlpha; delete x.ghostAlpha; } }
}

// Dragging things out of one board's pane and letting go over a pane that shows another
// board copies them there (the originals stay). Hold Alt to move them instead. Returns false if it's the same board.
function moveToOtherBoard(d) {
  const target = mouse.x === null ? null : viewports.paneAt(mouse.x, mouse.y);
  const to = docOfPane(target);
  const from = docOfPane(d.pane);
  if (!to || !from || to === from) return false;
  // Put them back where they were on this board first.
  d.items.forEach((item, i) => { item.sprite.position.set(d.before[i].x, d.before[i].y); });
  const box = board.bounds(d.items);
  const things = d.items.map(thingData);
  // Keep them under the mouse the way you were holding them.
  const w = target.camera.toWorld(mouse.x - target.rect.x, mouse.y - target.rect.y);
  const at = { x: w.x + (box.x + box.width / 2 - d.start.x), y: w.y + (box.y + box.height / 2 - d.start.y) };
  const copy = !altHeld;
  if (!copy) { board.selection = [...d.items]; removeSelected(); }
  activate(to);
  activePane = target;
  pasteThings({ things, box }, at);
  toast(`${copy ? 'Copied' : 'Moved'} to ${to.meta.name}${copy ? ' (hold Alt while letting go to move instead)' : '. Undo in each board puts it back'}`, 2400);
  return true;
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

// ---------- Captions ----------
//
// A caption is text that belongs to an image: it sits under it and moves, scales and
// turns with it. Double-click an image (or press Enter, or the bar's caption button) to write one.

let captionEditing = null;
function editCaption(item, pane = activePane || targetBoardPane()) {
  if (!item || item.kind !== 'image' || !pane) return;
  finishCaption();
  const before = [stateOf(item)];
  const ta = document.createElement('textarea');
  ta.className = 'caption-editor';
  ta.value = item.caption || '';
  ta.placeholder = item.sourceUrl ? 'Write a caption… (where it\'s from is in the right-click menu)' : 'Write a caption…';
  ta.spellcheck = true;
  document.body.appendChild(ta);
  if (item.captionText) item.captionText.visible = false;
  const place = () => {
    const f = board.captionFrame(item);
    const s = item.sprite;
    const z = pane.camera.zoom;
    const cos = Math.cos(s.rotation), sin = Math.sin(s.rotation);
    const lx = -f.w / 2, ly = f.h / 2 + f.gap;
    const wx = s.x + lx * cos - ly * sin, wy = s.y + lx * sin + ly * cos;
    Object.assign(ta.style, {
      left: `${pane.rect.x + pane.camera.x + wx * z}px`,
      top: `${pane.rect.y + pane.camera.y + wy * z}px`,
      width: `${Math.max(120, f.w * z)}px`,
      fontSize: `${Math.max(11, 32 * f.k * z)}px`,
      transform: `rotate(${s.rotation}rad)`,
    });
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  place();
  ta.addEventListener('input', place);
  ta.focus();
  ta.select();
  const finish = (save) => {
    if (!captionEditing) return;
    captionEditing = null;
    ta.remove();
    if (save && ta.value.trim() !== (item.caption || '')) {
      board.setCaption(item, ta.value);
      recordChange([item], before);
    } else if (item.captionText) {
      item.captionText.visible = true;
    }
    requestRender();
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  ta.addEventListener('blur', () => finish(true));
  captionEditing = { item, finish };
}
function finishCaption() { captionEditing?.finish(true); }

// ---------- Stars: your favourites ----------
//
// Star images (M, or ★ in the bar) to pick favourites while you go through a board.
// The ★ button in the top bar lists them, and "Focus on starred" fades everything else back.

function toggleStar() {
  const imgs = board.selection.filter((x) => x.kind === 'image');
  if (!imgs.length) { toast('Select images to star them.', 1600); return; }
  const on = !imgs.every((x) => x.star);
  const before = imgs.map(stateOf);
  for (const x of imgs) x.star = on;
  recordChange(imgs, before);
  toast(on ? `Starred ${imgs.length > 1 ? `${imgs.length} images` : 'it'}. The ★ in the top bar lists your starred images.` : 'Star removed', 1800);
  updateStarButton();
  requestRender();
}

function setFocus(on) {
  board.focus = on;
  updateStarButton();
  requestRender();
  if (on && !board.starred.length) toast('Nothing is starred yet: select images and press M.', 2400);
}

const starButton = document.getElementById('star-button');
function updateStarButton() {
  const n = board.starred.length;
  starButton.classList.toggle('on', !!board.focus);
  starButton.querySelector('.count').textContent = n ? String(n) : '';
  starButton.title = `Starred images${n ? ` (${n})` : ''}. Shift+M: focus on them`;
}

// The list of starred images, under the ★ button.
let starPanel = null;
function closeStarPanel() {
  if (!starPanel) return;
  for (const u of starPanel.urls) URL.revokeObjectURL(u);
  starPanel.el.remove();
  starPanel = null;
}
function openStarPanel() {
  if (starPanel) { closeStarPanel(); return; }
  hideMenu();
  const el = document.createElement('div');
  el.className = 'star-panel';
  const urls = [];
  const list = board.starred;
  el.innerHTML = `
    <div class="star-head"><strong>Starred</strong><span>${list.length || ''}</span></div>
    <div class="star-actions">
      <button data-a="focus" class="${board.focus ? 'on' : ''}">Focus on starred</button>
      <button data-a="select" ${list.length ? '' : 'disabled'}>Select them</button>
    </div>
    <div class="star-grid"></div>
    ${list.length ? '' : '<p class="star-empty">Nothing starred yet. Select images and press <kbd>M</kbd> or ★ in the bar above them.</p>'}`;
  const grid = el.querySelector('.star-grid');
  for (const item of list) {
    const b = document.createElement('button');
    b.className = 'star-thumb';
    b.title = item.caption || item.name || 'Image';
    if (item.blob) { const u = URL.createObjectURL(item.blob); urls.push(u); b.style.backgroundImage = `url("${u}")`; }
    if (item.caption) b.dataset.caption = item.caption;
    b.addEventListener('click', () => goToThing(item));
    grid.appendChild(b);
  }
  el.querySelector('[data-a="focus"]').addEventListener('click', (e) => { setFocus(!board.focus); e.currentTarget.classList.toggle('on', board.focus); });
  el.querySelector('[data-a="select"]').addEventListener('click', () => { board.selection = [...board.starred]; requestRender(); closeStarPanel(); });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(el);
  const r = starButton.getBoundingClientRect();
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`;
  starPanel = { el, urls };
}
starButton.addEventListener('click', (e) => { e.stopPropagation(); openStarPanel(); });
window.addEventListener('pointerdown', () => closeStarPanel());

// Zoom a pane to something and select it.
function goToThing(item) {
  const pane = boardPanes().find((p) => docOfPane(p) === activeDoc) || boardPanes()[0];
  if (!pane) return;
  const b = board.bounds([item]);
  pane.camera.frame(b, pane.rect.w, pane.rect.h, Math.min(pane.rect.w, pane.rect.h) * 0.12);
  board.selection = [item];
  viewChanged();
  requestRender();
}

// ---------- Compare ----------

// Each image as it looks on the board (cropped, flipped, greyscale), as a picture link.
async function lookOf(item) {
  const bitmap = await createImageBitmap(item.blob);
  const c = item.crop || { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const canvas = new OffscreenCanvas(c.w, c.h);
  const g = canvas.getContext('2d');
  if (item.grey) g.filter = 'grayscale(1)';
  const fx = item.sprite.scale.x < 0 ? -1 : 1, fy = item.sprite.scale.y < 0 ? -1 : 1;
  g.translate(fx < 0 ? c.w : 0, fy < 0 ? c.h : 0);
  g.scale(fx, fy);
  g.drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
  return { url, name: item.caption || item.name || 'Image', width: c.w, height: c.h };
}

async function compareSelection() {
  const imgs = readingOrder(board.selection.filter((x) => x.kind === 'image' && x.blob));
  if (imgs.length !== 2) { toast('Select exactly two images to compare.', 1800); return; }
  const [a, b] = await Promise.all(imgs.map(lookOf));
  openCompare(a, b, () => { URL.revokeObjectURL(a.url); URL.revokeObjectURL(b.url); });
}

// ---------- Storyboard and colour script ----------

// Images in reading order: rows from top to bottom, left to right in each row.
function readingOrder(items) {
  return readingRows(items).flat();
}
function readingRows(items) {
  const boxes = new Map(items.map((i) => [i, board.bounds([i])]));
  const sorted = [...items].sort((a, b) => boxes.get(a).y - boxes.get(b).y);
  const rows = [];
  for (const it of sorted) {
    const b = boxes.get(it);
    const row = rows.find((r) => Math.abs(r.mid - (b.y + b.height / 2)) < Math.max(r.h, b.height) / 2);
    if (row) row.items.push(it); else rows.push({ mid: b.y + b.height / 2, h: b.height, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => boxes.get(a).x - boxes.get(b).x));
}

// Lay the selected images out like storyboard panels: same height, straight, in rows,
// numbered in reading order (a number caption is added where there's none yet).
function storyboardSelection() {
  const imgs = readingOrder(board.selection.filter((x) => x.kind === 'image'));
  if (imgs.length < 2) { toast('Select two or more images to lay out as a storyboard.', 2000); return; }
  const before = imgs.map(stateOf);
  const start = board.bounds(imgs);
  const heights = imgs.map((i) => Math.abs(i.height * i.sprite.scale.y)).sort((a, b) => a - b);
  const H = heights[Math.floor(heights.length / 2)];
  const cols = Math.min(imgs.length, Math.max(2, Math.round(Math.sqrt(imgs.length * 1.8))));
  const gap = H * 0.12;
  imgs.forEach((it, i) => {
    const s = it.sprite;
    const k = H / it.height;
    s.rotation = 0;
    s.scale.set(Math.sign(s.scale.x || 1) * k, Math.sign(s.scale.y || 1) * k);
    if (!it.caption) board.setCaption(it, String(i + 1));
  });
  // Rows are as tall as their tallest caption needs.
  let y = start.y;
  for (let r = 0; r * cols < imgs.length; r++) {
    const row = imgs.slice(r * cols, r * cols + cols);
    let x = start.x;
    for (const it of row) {
      const w = Math.abs(it.width * it.sprite.scale.x);
      it.sprite.position.set(x + w / 2, y + H / 2);
      x += w + gap;
    }
    board.syncImages();
    const rowBottom = Math.max(...row.map((it) => { const b = board.bounds([it]); return b.y + b.height; }));
    y = rowBottom + gap * 1.6;
  }
  recordChange(imgs, before);
  requestRender();
  toast('Laid out as a storyboard. Double-click a panel to write under it.', 2600);
}

// The main colours of an image (what's visible of it), biggest share first.
async function imageColours(item, k = 5) {
  const bitmap = await createImageBitmap(item.blob);
  const c = item.crop || { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const W = 64, H = Math.max(8, Math.round(64 * c.h / c.w));
  const small = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
  small.drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, W, H);
  return mainColours(small.getImageData(0, 0, W, H).data, k);
}

// Colour script: under each selected image, a strip of its main colours in proportion,
// grouped with the image so they move together. Read along the row to see how the
// colour and mood change through a sequence.
async function colourScript() {
  const rows = readingRows(board.selection.filter((x) => x.kind === 'image' && x.blob && !x.name.startsWith('Colours of')));
  const imgs = rows.flat();
  if (!imgs.length) { toast('Select the images (shots, panels…) to make a colour script of.', 2200); return; }
  toast('Working out the colours…', 20000);
  const before = imgs.map(stateOf);
  const added = [];
  for (const it of imgs) {
    const cols = await imageColours(it, 5);
    const PW = 600, PH = 90;
    const canvas = new OffscreenCanvas(PW, PH);
    const g = canvas.getContext('2d');
    let x = 0;
    cols.forEach((col, i) => {
      const w = i === cols.length - 1 ? PW - x : Math.round(PW * col.share / cols.reduce((n, c) => n + c.share, 0));
      g.fillStyle = col.hex;
      g.fillRect(x, 0, w, PH);
      x += w;
    });
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const b = board.bounds([it]);
    const k = Math.abs(it.width * it.sprite.scale.x) / PW;
    const group = it.group || newGroupId();
    it.group = group;
    const strip = board.addImage(await createImageBitmap(blob), it.sprite.x, b.y + b.height + PH * k * 0.5 + b.width * 0.03, { name: `Colours of ${it.name || 'image'}`, blob, scaleX: k, scaleY: k, group });
    store.saveImage(current.id, strip.id, blob).catch(() => {});
    added.push(strip);
  }
  // Rows further down move down to make room for the strips, so nothing overlaps.
  let push = 0;
  rows.forEach((row) => {
    const strips = added.filter((a) => row.some((it) => it.group === a.group));
    for (const x of [...row, ...strips]) x.sprite.y += push;
    const below = Math.max(...strips.map((st) => { const b = board.bounds([st]); return b.y + b.height; }));
    const rowBottom = Math.max(...row.map((it) => { const b = board.bounds([it]); return b.y + b.height; }));
    push += Math.max(0, below - rowBottom) + (strips[0] ? board.bounds([strips[0]]).height * 0.4 : 0);
  });
  const after = imgs.map(stateOf);
  const data = added.map((a) => ({ ...board.imageJSON(a), blob: a.blob }));
  history.push({
    undo: () => { data.forEach((d) => removeImageById(d.id)); before.forEach(applyState); requestRender(); },
    redo: async () => { for (const d of data) await restoreImage(d); after.forEach(applyState); requestRender(); },
  });
  toast(`Colour script made for ${imgs.length} image${imgs.length > 1 ? 's' : ''}. Each strip is grouped with its image.`, 2600);
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
  for (const p of pane ? [pane] : boardPanes()) {
    const b = docOfPane(p)?.board || board;
    const bounds = b.bounds(b === board ? items : null);
    if (bounds) p.camera.frame(bounds, p.rect.w, p.rect.h, 60);
  }
  viewChanged();
}

// ---------- Full-quality images that stay fluid ----------
//
// Images are kept exactly as they came in: full size, never shrunk or re-compressed. But
// a board of hundreds of big photos can't all sit full size on the graphics card at once,
// so each image is drawn at the size it needs on screen, like Miro or PureRef:
//   - a small saved preview (640 px) when it's small on screen, so big boards open fast
//   - sharper levels (1280, 2560, 5120 px…) as you zoom in, up to the full original
//   - back down when it's out of view, within a memory budget.

const PREVIEW = 640;              // the longest side of a preview, in pixels
const FULL_BUDGET = 200e6;        // pixels kept on the graphics card above preview size
let maxTexture = 8192;            // the biggest picture this graphics card takes
try { maxTexture = app.renderer.gl.getParameter(app.renderer.gl.MAX_TEXTURE_SIZE) || 8192; } catch {}

async function makePreview(bitmap) {
  return scaledCopy(bitmap, PREVIEW);
}
// A copy of a picture (or image file) whose longest side is `side` pixels.
function scaledCopy(source, side, w = source.width, h = source.height) {
  const k = Math.min(1, side / Math.max(w, h));
  return createImageBitmap(source, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' });
}
async function previewFile(bitmap) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  return c.convertToBlob({ type: 'image/webp', quality: 0.85 });
}
// Save a preview of a big image for next time (in the background).
function rememberPreview(boardId, item, preview) {
  if (!boardId || !preview) return;
  previewFile(preview).then((blob) => store.savePreview(boardId, item.id, { w: item.fullWidth, h: item.fullHeight, blob })).catch(() => {});
}

async function inParallel(list, n, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) await work(list[next++]);
  }));
}

let detailTimer;
let detailBusy = false;
function detailSoon() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(updateDetail, 140);
}

const longSide = (it) => Math.max(it.fullWidth, it.fullHeight);
// The sizes an image can be drawn at (longest side), smallest first.
function levelsOf(it) {
  const top = Math.min(longSide(it), maxTexture);
  const out = [];
  for (let L = PREVIEW; L < top; L *= 2) out.push(L);
  out.push(top);
  return out;
}
const boardOfItem = (it) => [...docs.values()].find((d) => d.board.items.includes(it))?.board;

async function updateDetail() {
  if (mode !== 'board') return;
  if (detailBusy || loading) { detailSoon(); return; }
  detailBusy = true;
  try {
    const res = app.renderer.resolution;
    // How many screen pixels the image's longest side covers, for images in view.
    const need = new Map();
    const all = [];
    for (const pane of boardPanes()) {
      const b = (docOfPane(pane) || mainDoc)?.board;
      if (!b) continue;
      const cam = pane.camera;
      const a = cam.toWorld(0, 0), z = cam.toWorld(pane.rect.w, pane.rect.h);
      for (const it of b.items) {
        if (longSide(it) <= PREVIEW || !it.blob) continue;
        all.push(it);
        const s = it.sprite;
        const sx = Math.abs(s.scale.x), sy = Math.abs(s.scale.y);
        const r = Math.hypot(it.width * sx, it.height * sy) / 2;
        if (s.x + r < a.x || s.x - r > z.x || s.y + r < a.y || s.y - r > z.y) continue;
        need.set(it, Math.max(need.get(it) || 0, longSide(it) * Math.max(sx, sy) * cam.zoom * res));
      }
    }
    // The size each image in view should have: the smallest level that covers the screen.
    const target = new Map();
    for (const [it, px] of need) {
      const level = levelsOf(it).find((L) => L >= px * 1.05) || levelsOf(it).at(-1);
      if (level > PREVIEW) target.set(it, level);
    }
    const pixelsAt = (it, L) => { const k = L / longSide(it); return it.fullWidth * it.fullHeight * k * k; };
    const levelNow = (it) => Math.max(it.source.pixelWidth, it.source.pixelHeight);
    // Biggest on screen first, within the budget.
    const keep = new Map();
    let used = 0;
    for (const [it, L] of [...target].sort((x, y) => (need.get(y[0]) || 0) - (need.get(x[0]) || 0))) {
      const px = pixelsAt(it, L);
      if (used + px > FULL_BUDGET && keep.size) continue;
      keep.set(it, L);
      used += px;
    }
    // Images already sharp but not needed now: keep them while there's room (no flicker).
    for (const it of all) {
      if (keep.has(it) || levelNow(it) <= PREVIEW) continue;
      const px = pixelsAt(it, levelNow(it));
      if (used + px <= FULL_BUDGET) { keep.set(it, levelNow(it)); used += px; }
    }
    // Back to the preview for the rest.
    for (const it of all) {
      if (keep.has(it) || levelNow(it) <= PREVIEW || it.sprite.destroyed) continue;
      it.preview ||= await makePreview(it.source.resource);
      const b = boardOfItem(it);
      if (!b || it.sprite.destroyed) continue;
      const old = it.source.resource;
      b.setImageBitmap(it, it.preview);
      if (old !== it.preview) old.close?.();
    }
    // Sharper pictures where they're wanted, biggest on screen first, a few at a time.
    const up = [...keep].filter(([it, L]) => L > levelNow(it) * 1.01);
    await inParallel(up, 3, async ([it, L]) => {
      try {
        const bitmap = L >= longSide(it) ? await createImageBitmap(it.blob) : await scaledCopy(it.blob, L, it.fullWidth, it.fullHeight);
        const b = boardOfItem(it);
        if (!b || it.sprite.destroyed || levelNow(it) >= bitmap.width) { bitmap.close(); return; }
        const old = it.source.resource;
        b.setImageBitmap(it, bitmap);
        if (old !== it.preview) old.close?.();
        requestRender();
      } catch (err) {
        console.warn('Sharper image skipped', err);
      }
    });
  } finally {
    detailBusy = false;
  }
}

// ---------- Opening and closing boards ----------

// Put a saved board on screen. `getBlob(item)` fetches each image's file.
async function loadBoard(data, getBlob, board, { withLayout = true, boardId = null } = {}) {
  loading = true;
  try {
    board.clear();
    const items = data?.items || [];
    const blobs = await Promise.all(items.map((item) => Promise.resolve(getBlob(item)).catch(() => null)));
    // Images open from their saved previews (quick), and the ones on screen sharpen right
    // after (see updateDetail). The first time, each big image is read once to make its
    // preview (and kept full size while it fits in the budget).
    let fullPixels = 0;
    const pictures = new Array(items.length).fill(null);
    await inParallel(items.map((_, i) => i), 6, async (i) => {
      const blob = blobs[i];
      if (!blob) return;
      const saved = boardId ? await store.loadPreview(boardId, items[i].id).catch(() => null) : null;
      if (saved) {
        if (!saved.blob) {
          const full = await decode(blob, items[i].name);
          if (full) pictures[i] = { bitmap: full, fullWidth: saved.w, fullHeight: saved.h };
          return;
        }
        const preview = await createImageBitmap(saved.blob).catch(() => null);
        if (preview) { pictures[i] = { bitmap: preview, preview, fullWidth: saved.w, fullHeight: saved.h }; return; }
      }
      const full = await decode(blob, items[i].name);
      if (!full) return;
      const w = full.width, h = full.height, px = w * h;
      if (Math.max(w, h) <= PREVIEW) {
        if (boardId) store.savePreview(boardId, items[i].id, { w, h, blob: null }).catch(() => {});
        pictures[i] = { bitmap: full };
        return;
      }
      const preview = await makePreview(full);
      pictures[i] = { preview, fullWidth: w, fullHeight: h, remember: true };
      if (Math.max(w, h) <= maxTexture && fullPixels + px <= FULL_BUDGET / 2) {
        fullPixels += px;
        pictures[i].bitmap = full;
      } else {
        pictures[i].bitmap = preview;
        full.close();
      }
    });
    let missing = 0;
    items.forEach((item, i) => {
      const p = pictures[i];
      if (!p) { missing++; return; }
      const added = board.addImage(p.bitmap, item.x, item.y, { ...item, blob: blobs[i], fullWidth: p.fullWidth, fullHeight: p.fullHeight });
      added.preview = p.preview || null;
      if (p.remember) rememberPreview(boardId, added, p.preview);
    });
    for (const s of data?.strokes || []) board.addStroke(s);
    for (const n of data?.notes || []) board.addNote(n);
    for (const x of data?.shapes || []) board.addShape(x);
    for (const f of data?.frames || []) board.addFrame(f);
    // Make sure the fonts the text uses are loaded, then lay the text out again.
    const used = [...new Set([...board.notes, ...board.frames].map((n) => `${n.font || 'Inter'}|${n.weight}|${!!n.italic}`))];
    Promise.all(used.map((k) => { const [f, w, i] = k.split('|'); return ensureFont(f, w, i === 'true'); }))
      .then(() => { board.relayoutNotes(); board.frames.forEach((f) => board.drawFrame(f)); requestRender(); });
    board.selected = null;
    if (withLayout) viewports.setLayout(data?.layout ? Layout.fromJSON(data.layout) : new Layout());
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
  applyLook(meta.look || defaultLook());
  const doc = makeDoc(meta);
  docs.set(id, doc);
  mainDoc = doc;
  activeDoc = null;
  activate(doc);
  await loadBoard(data, (item) => store.loadImage(id, item.id), doc.board, { boardId: id });
  // Boards opened from a file, or from the first version, may not have a preview yet.
  doc.thumbStale = !doc.board.isEmpty() && !(await store.loadThumb(id).catch(() => null));
  const waiting = data?.incoming;
  // Panes that show other boards: load those too.
  for (const pane of layout().panes()) {
    if (!pane.boardId || pane.boardId === id) { pane.boardId = null; continue; }
    if (!(await loadOtherBoard(pane.boardId))) pane.boardId = null;
  }
  activate(doc);
  addTab(id);
  updateTitle();
  viewports.position();
  requestRender();
  await placeIncoming(doc, waiting);
}

// Load a board to show in a pane next to the main one. Returns its doc, or null if it's gone.
async function loadOtherBoard(id) {
  if (docs.has(id)) return docs.get(id);
  const record = await store.getBoard(id);
  if (!record) return null;
  const { board: data, ...meta } = record;
  const doc = makeDoc(meta);
  doc.layoutJSON = data?.layout || null;
  docs.set(id, doc);
  await loadBoard(data, (item) => store.loadImage(id, item.id), doc.board, { withLayout: false, boardId: id });
  doc.thumbStale = !doc.board.isEmpty() && !(await store.loadThumb(id).catch(() => null));
  if (data?.incoming?.length) setTimeout(() => placeIncoming(doc, data.incoming), 0);
  return doc;
}

// Boards that no pane shows any more are saved and let go.
async function releaseUnusedBoards() {
  const shown = new Set(layout().panes().filter((p) => p.type === 'board').map((p) => p.boardId).filter(Boolean));
  const unused = [...docs].filter(([id, d]) => d !== mainDoc && !shown.has(id));
  if (!unused.length) return;
  await saveNow();
  for (const [id, d] of unused) {
    if (activeDoc === d) activate(mainDoc);
    d.board.clear();
    docs.delete(id);
  }
  viewports.position();
}

// Show a board in a pane (null: the main board).
async function showBoardInPane(pane, id) {
  if (id === mainDoc?.meta.id) id = null;
  if (id && !(await loadOtherBoard(id))) { toast('That board no longer exists.'); return; }
  pane.type = 'board';
  pane.boardId = id;
  pane.state = {};
  await releaseUnusedBoards();
  viewports.rebuild();
  activate(docOfPane(pane));
  fitPane(pane, null);
  viewChanged();
  requestRender();
}

// Save the open board, then free its images from memory.
async function leaveBoard() {
  if (!mainDoc) return;
  noteEditor.finish();
  await saveNow({ thumb: true });
  for (const d of docs.values()) d.board.clear();
  docs.clear();
  mainDoc = activeDoc = current = null;
  board = new Board();
  history = new History(() => updateHistoryButtons());
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
  if (location.hash.startsWith('#/add')) {
    await leaveBoard();
    setMode('add');
    showAddPage();
    return;
  }
  const id = location.hash.match(/^#\/board\/([\w-]+)/)?.[1];
  if (id) {
    if (mainDoc?.meta.id !== id) {
      await leaveBoard();
      // Show the board's own look straight away (no flash of another one).
      const rec = await store.getBoard(id);
      if (rec) applyLook(rec.look || defaultLook());
      setMode('board');
      await openBoardById(id);
    }
    if (current) setMode('board');
  } else {
    await leaveBoard();
    setMode('home');
    await home.refresh();
    showSafetyNote();
  }
}
window.addEventListener('hashchange', route);

const goHome = () => { location.hash = '#/'; };
const openBoard = (id) => { location.hash = `#/board/${id}`; };
// Open a board and wait until it's on screen.
async function openBoardNow(id) {
  openBoard(id);
  await route();
announceBoards();
updateDriveButton();
syncNow();
}

// "Untitled board", "Untitled board 2", ...
async function freeName(base) {
  const names = new Set((await store.listBoards()).map((b) => b.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

async function createBoard({ name, data = null, group = '' } = {}) {
  announceBoards();
  const now = Date.now();
  const id = newBoardId();
  await store.putBoard({
    id, name: await freeName(name || 'Untitled board'), created: now, updated: now, handle: null,
    board: data || { items: [], layout: null }, look: defaultLook(), ...(group ? { group } : {}),
  });
  askToKeepStorage();
  return id;
}

async function newBoard({ group = '' } = {}) {
  openBoard(await createBoard({ group }));
}

async function renameBoard(id, name) {
  announceBoards();
  const doc = docs.get(id);
  if (doc) {
    doc.meta.name = name;
    doc.meta.changed = Date.now();
    updateTitle();
    viewports.position();
    await saveNow();
    return;
  }
  const record = await store.getBoard(id);
  if (record) await store.putBoard({ ...record, name, changed: Date.now() });
  syncSoon();
}

// Delete boards (one or several, after asking once). Returns true if they were deleted.
async function deleteBoards(ids) {
  const records = (await Promise.all(ids.map((id) => store.getBoard(id)))).filter(Boolean);
  if (!records.length) return false;
  const what = records.length === 1 ? `"${records[0].name}"` : `these ${records.length} boards`;
  if (!confirm(`Delete ${what}? This can't be undone.`)) return false;
  for (const rec of records) {
    drive.removeBoard(rec);
    await store.deleteBoard(rec.id);
  }
  const gone = new Set(records.map((r) => r.id));
  tabIds = tabIds.filter((t) => !gone.has(t));
  saveTabs();
  announceBoards();
  await home.refresh();
  return true;
}

// Put boards in a project ('' = no project).
async function setBoardsGroup(ids, group) {
  const now = Date.now();
  for (const id of ids) {
    const rec = await store.getBoard(id);
    if (!rec || (rec.group || '') === group) continue;
    await store.putBoard({ ...rec, group, changed: now });
  }
  await home.refresh();
  syncSoon();
}

// ---------- Board files ----------

// Add a .refboard file as a new board. Returns the new board's id.
async function importBoardFile(file, handle = null) {
  toast(`Opening ${file.name}…`, 60000);
  const { data, images, fonts } = await unpackBoard(file);
  // Fonts the board's text uses come with it.
  for (const f of fonts) await addFontFile(f.blob, f.name).catch(() => {});
  const id = newBoardId();
  // Copy the images into Chrome's storage, a few at a time (a big board can be gigabytes).
  let done = 0;
  await inParallel(data.items, 6, async (item) => {
    const blob = images.get(item.file);
    if (blob) {
      try {
        await store.saveImage(id, item.id, blob);
      } catch (err) {
        // Out of room: Chrome only lets a site use part of the free disk space.
        store.deleteBoard(id).catch(() => {});
        throw new Error(err?.name === 'QuotaExceededError' || !err?.message
          ? `There isn't enough room in Chrome's storage for ${file.name}. Free some disk space (or delete boards you don't need) and try again.`
          : err.message);
      }
    }
    if (++done % 25 === 0 && data.items.length > 50) toast(`Adding ${file.name}… ${done} of ${data.items.length} images`, 60000);
  });
  const now = Date.now();
  const { look, ...rest } = data;
  await store.putBoard({ id, name: await freeName(file.name.replace(/\.refboard$/i, '')), created: now, updated: now, handle, board: rest, ...(look ? { look } : {}) });
  askToKeepStorage();
  toast(`Added ${file.name}`, 1500);
  return id;
}

async function openFile() {
  try {
    const picked = await pickBoardToOpen();
    if (picked && isBackupFile(picked.file)) await restoreBackup(picked.file);
    else if (picked) openBoard(await importBoardFile(picked.file, picked.handle));
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
      getData: () => ({ ...describeBoard(board, activeDoc === mainDoc ? layout() : { toJSON: () => activeDoc.layoutJSON }), ...(current?.look ? { look: current.look } : {}) }),
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
      getData: () => ({ ...record.board, ...(record.look ? { look: record.look } : {}) }),
      getBlob: (item) => store.loadImage(id, item.id),
    });
  } catch (err) {
    toast(err.message || "Couldn't save the board.");
  }
}

// ---------- Google Drive ----------
//
// Boards sync with your own Google Drive (see src/drive.js): when the app opens, every
// 3 minutes, when you come back to the tab, and shortly after you change something.

const driveButton = document.getElementById('drive-button');
let driveState = drive.isConnected() ? 'idle' : 'off';
let lastSynced = 0;
let driveProgress = '';
const driveHooks = {
  beforeSync: () => saveNow(),
  isOpen: (id) => docs.has(id),
  queueForBoard: (id, blob, name, src) => receiveBlob(id, blob, name, src),
  boardsChanged: () => { if (mode === 'home') home.refresh(); renderTabs(); announceBoards(); },
  onProgress: (text) => {
    driveProgress = text;
    const el = document.getElementById('drive-progress');
    el.textContent = text;
    el.hidden = !text;
    updateDriveButton();
  },
  onStatus: (state, detail) => {
    driveState = state;
    if (state === 'synced') lastSynced = Date.now();
    if (state === 'error') console.warn('Drive:', detail);
    updateDriveButton();
  },
};
// The open boards keep their Drive details in memory too, so saving doesn't undo them.
window.addEventListener('drive-updated', (e) => {
  const d = docs.get(e.detail.boardId);
  if (d) d.meta.drive = e.detail.drive;
});

function syncNow() {
  if (!drive.isConnected() || mode === 'add') return Promise.resolve();
  return drive.sync(driveHooks);
}
let syncTimer;
function syncSoon() {
  if (!drive.isConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 15000);
}
setInterval(syncNow, 180000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });

async function connectDrive() {
  try {
    await drive.connect();
    if (mode === 'add') { toast('Connected to Google Drive ✓', 2000); return; }
    toast('Connected to Google Drive. Your boards are being copied to an "Art Direction" folder…', 3500);
    await syncNow();
    if (driveState === 'synced') toast('Your boards are in Google Drive ✓', 2500);
    else if (drive.lastError()) toast(`Couldn't sync: ${drive.lastError()}`, 9000);
  } catch (err) {
    toast(err.message || "Couldn't connect to Google Drive.", 4000);
  }
  updateDriveButton();
}

function updateDriveButton() {
  for (const el of document.querySelectorAll('.drive-status')) {
    el.dataset.state = drive.isConnected() ? (drive.needsReconnect() && driveState !== 'syncing' ? 'reconnect' : driveState) : 'off';
    const mins = lastSynced ? Math.round((Date.now() - lastSynced) / 60000) : null;
    el.title = {
      off: 'Google Drive: not connected. Click to keep your boards in your own Drive',
      syncing: driveProgress || 'Google Drive: syncing…',
      synced: `Google Drive: synced${mins === null ? '' : mins < 1 ? ' just now' : ` ${mins} min ago`}`,
      idle: 'Google Drive: connected',
      reconnect: 'Google Drive: click to reconnect (Google asks again about every hour)',
      error: "Google Drive: couldn't sync. Click for options",
    }[el.dataset.state] || 'Google Drive';
  }
}

function driveMenu(x, y) {
  if (!drive.isConnected()) {
    showMenu(x, y, [
      { label: 'Connect Google Drive…', action: connectDrive },
      { label: 'Your boards are copied to a folder in your own Drive, so they follow you to other computers and your phone. The app can only see the files it makes.', disabled: true },
    ]);
    return;
  }
  showMenu(x, y, [
    ...(drive.needsReconnect() || driveState === 'reconnect' ? [{ label: 'Reconnect Google Drive', action: connectDrive }] : []),
    ...(driveState === 'error' && drive.lastError() ? [{ label: `Problem: ${drive.lastError().slice(0, 140)}`, disabled: true }, '-'] : []),
    { label: 'Sync now', action: async () => { await syncNow(); toast(driveState === 'synced' ? 'Synced with Google Drive ✓' : `Couldn't sync: ${drive.lastError() || 'try reconnecting'}`, driveState === 'synced' ? 2000 : 9000); } },
    { label: 'Open the folder in Google Drive', action: () => window.open(drive.driveFolderUrl(), '_blank', 'noopener') },
    { label: 'Save photos from your phone…', action: () => { location.hash = '#/add'; } },
    '-',
    { label: 'Disconnect', action: () => { if (confirm('Disconnect Google Drive? Your boards stay here and in Drive; they just stop syncing.')) { drive.disconnect(); driveState = 'off'; updateDriveButton(); } } },
  ]);
}
for (const el of document.querySelectorAll('.drive-status')) {
  el.addEventListener('click', (e) => {
    if (drive.isConnected() && (drive.needsReconnect() || driveState === 'reconnect')) { connectDrive(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    driveMenu(Math.max(8, r.right - 260), r.bottom + 4);
  });
}
setInterval(updateDriveButton, 30000);

// ---------- The phone page: save photos to a board ----------
//
// artdirection.io/#/add — made for the phone (add it to the home screen). Pick photos
// (screenshots, saved images), pick a board, done: they go to the board's Drive folder
// and appear on the board on your computer. Without Drive, it saves to this browser's boards.

let addFiles = [];
let addBoard = null;
async function showAddPage() {
  const page = document.getElementById('add-page');
  const list = page.querySelector('.add-boards');
  const status = page.querySelector('.add-status');
  page.querySelector('.add-connect').hidden = drive.isConnected() && !drive.needsReconnect();
  status.textContent = '';
  // Boards: from Drive when connected, plus the ones in this browser.
  let boards = [];
  if (drive.isConnected()) {
    boards = drive.knownBoards();
    drive.listDriveBoards().then((b) => { if (b.length) drawAddBoards(b); }).catch(() => {});
  }
  const local = (await store.listBoards()).sort((a, b) => b.updated - a.updated).map((b) => ({ id: b.id, name: b.name, local: true }));
  for (const b of local) if (!boards.some((x) => x.id === b.id)) boards.push(b);
  drawAddBoards(boards);
  updateAddButton();
}
function drawAddBoards(boards) {
  const list = document.querySelector('#add-page .add-boards');
  list.replaceChildren(...boards.map((b) => {
    const el = document.createElement('button');
    el.className = 'add-board';
    el.textContent = b.name;
    el.classList.toggle('on', addBoard?.id === b.id);
    el.addEventListener('click', () => { addBoard = b; drawAddBoards(boards); updateAddButton(); });
    return el;
  }));
  if (!boards.length) list.innerHTML = '<p class="add-empty">No boards yet. Make one on your computer first (and connect Google Drive there).</p>';
}
function updateAddButton() {
  const send = document.querySelector('#add-page .add-send');
  send.disabled = !addFiles.length || !addBoard;
  send.textContent = !addFiles.length ? 'Choose photos first' : !addBoard ? 'Pick a board' : `Save ${addFiles.length} to ${addBoard.name}`;
  document.querySelector('#add-page .add-count').textContent = addFiles.length ? `${addFiles.length} chosen` : '';
  const thumbs = document.querySelector('#add-page .add-thumbs');
  for (const img of thumbs.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  thumbs.replaceChildren(...addFiles.slice(0, 12).map((f) => Object.assign(document.createElement('img'), { src: URL.createObjectURL(f), alt: '' })));
}
{
  const page = document.getElementById('add-page');
  const input = page.querySelector('.add-input');
  page.querySelector('.add-pick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles = [...input.files].filter((f) => f.type.startsWith('image/')); updateAddButton(); });
  page.querySelector('.add-connect').addEventListener('click', async () => { await connectDrive(); showAddPage(); });
  page.querySelector('.add-send').addEventListener('click', async () => {
    const status = page.querySelector('.add-status');
    const send = page.querySelector('.add-send');
    send.disabled = true;
    let done = 0;
    try {
      for (const f of addFiles) {
        status.textContent = `Saving ${done + 1} of ${addFiles.length}…`;
        const viaDrive = drive.isConnected() && !addBoard.local;
        if (viaDrive) await drive.sendPhoto(addBoard.id, f);
        else await queueForBoard(addBoard.id, f, f.name.replace(/\.[a-z0-9]+$/i, ''), '');
        done++;
      }
      status.textContent = `Saved ${done} to ${addBoard.name} ✓${drive.isConnected() && !addBoard.local ? ' They\'ll appear on the board on your computer.' : ''}`;
      addFiles = [];
      input.value = '';
      updateAddButton();
    } catch (err) {
      status.textContent = `${err.message || "Couldn't save."}${done ? ` (${done} saved)` : ''}`;
      send.disabled = false;
    }
  });
}

// ---------- Backing up every board ----------
//
// One file with all your boards in it, for safe keeping (e.g. in Google Drive or on a
// USB stick). Opening it later adds the boards back; it never replaces any.

const BACKUP_KEY = 'refboard.lastBackup';
async function backupAllBoards() {
  try {
    await saveNow({ thumb: true });
    const records = (await store.listBoards()).sort((a, b) => b.updated - a.updated);
    if (!records.length) { toast('There are no boards to back up yet.'); return; }
    toast(`Backing up ${records.length} board${records.length > 1 ? 's' : ''}…`, 60000);
    const boards = [];
    for (const r of records) {
      const full = await store.getBoard(r.id);
      boards.push({ name: r.name, blob: await packBoard(full.board, (item) => store.loadImage(r.id, item.id), customFontBlob) });
    }
    const day = new Date().toISOString().slice(0, 10);
    downloadBlob(await packBackup(boards), `Reference Board backup ${day}${BACKUP_EXT}`);
    try { localStorage.setItem(BACKUP_KEY, String(Date.now())); } catch {}
    toast(`Backed up ${records.length} board${records.length > 1 ? 's' : ''}. Keep the file somewhere safe, like Google Drive.`, 4000);
    showSafetyNote();
  } catch (err) {
    console.error(err);
    toast("Couldn't make the backup.");
  }
}

async function restoreBackup(file) {
  const files = await unpackBackup(file);
  if (!files.length) { toast('There are no boards in that backup.'); return; }
  for (const f of files) await importBoardFile(f);
  toast(`Added ${files.length} board${files.length > 1 ? 's' : ''} from the backup.`, 3000);
  if (mode === 'home') home.refresh(); else goHome();
}

// On the home screen: whether Chrome will keep the boards, and when you last backed up.
async function showSafetyNote() {
  const el = document.getElementById('safety-note');
  const kept = await storageIsKept();
  let last = 0;
  try { last = Number(localStorage.getItem(BACKUP_KEY)) || 0; } catch {}
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  el.textContent = `${kept ? '✓ Chrome will keep your boards, even when the disk is nearly full.' : 'Chrome may clear your boards if the disk gets very full: installing the app or backing up keeps them safe.'} `
    + `Last backup: ${days === null ? 'never' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}.`;
  el.classList.toggle('warn', !kept && (days === null || days > 14));
}
document.getElementById('backup-button').addEventListener('click', backupAllBoards);

// ---------- Installing as an app, and working offline ----------

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable', err));
}
// Chrome offers to install when it's possible; we show our own button for it.
let installPrompt = null;
const installButton = document.getElementById('install-button');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installButton.hidden = false;
});
async function installApp() {
  if (!installPrompt) {
    toast('To install: use the install icon at the right of Chrome\'s address bar, or ⋮ → Cast, save and share → Install page as app.', 5000);
    return;
  }
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({}));
  if (outcome === 'accepted') { installPrompt = null; installButton.hidden = true; }
}
installButton.addEventListener('click', installApp);
window.addEventListener('appinstalled', () => { installButton.hidden = true; askToKeepStorage(); toast('Installed. Reference Board now has its own window and icon.', 3000); });
const isInstalled = () => matchMedia('(display-mode: standalone)').matches;

// Once installed, double-clicking a .refboard file on your computer opens it here.
window.launchQueue?.setConsumer(async ({ files }) => {
  for (const handle of files || []) {
    const file = await handle.getFile();
    if (isBackupFile(file)) await restoreBackup(file);
    else openBoard(await importBoardFile(file, handle));
  }
});

// ---------- Home screen ----------

const home = new Home(document.getElementById('home'), {
  open: openBoard,
  create: newBoard,
  importFile: openFile,
  rename: renameBoard,
  exportFile: exportBoard,
  remove: deleteBoards,
  setGroup: setBoardsGroup,
});

// ---------- Tabs: the boards you have open ----------
//
// Like browser tabs: every board you open gets a tab in the top bar, so you can jump
// between them. Remembered in this browser (not part of any board).

const TABS_KEY = 'refboard.tabs';
let tabIds = [];
try { tabIds = JSON.parse(localStorage.getItem(TABS_KEY) || '[]').filter((x) => typeof x === 'string'); } catch {}
const saveTabs = () => { try { localStorage.setItem(TABS_KEY, JSON.stringify(tabIds)); } catch {} };
const tabsEl = document.getElementById('board-tabs');

function addTab(id) {
  if (!tabIds.includes(id)) { tabIds.push(id); saveTabs(); }
}

function closeTab(id) {
  const i = tabIds.indexOf(id);
  if (i < 0) return;
  tabIds.splice(i, 1);
  saveTabs();
  if (mainDoc?.meta.id === id) {
    const next = tabIds[Math.min(i, tabIds.length - 1)];
    if (next) openBoard(next); else goHome();
  } else {
    renderTabs();
  }
}

let tabsDrawn = 0;
async function renderTabs() {
  const n = ++tabsDrawn;
  if (!mainDoc) return;
  const boards = new Map((await store.listBoards()).map((b) => [b.id, b]));
  if (n !== tabsDrawn) return;  // a newer redraw started meanwhile
  const before = tabIds.length;
  tabIds = tabIds.filter((id) => boards.has(id) || id === mainDoc?.meta.id);
  if (tabIds.length !== before) saveTabs();
  const keep = document.activeElement === nameInput;
  tabsEl.replaceChildren();
  tabIds.forEach((id, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    const isOpen = id === mainDoc?.meta.id;
    tab.classList.toggle('active', isOpen);
    if (isOpen) {
      tab.appendChild(nameInput);
    } else {
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = boards.get(id)?.name || 'Board';
      tab.title = `${name.textContent}${i < 9 ? ` (Alt+${i + 1})` : ''}`;
      tab.appendChild(name);
      tab.addEventListener('click', () => openBoard(id));
    }
    // Middle-click closes, like in Chrome.
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Close tab (the board stays in your boards)';
    close.innerHTML = '<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    tab.appendChild(close);
    tabsEl.appendChild(tab);
  });
  if (keep) nameInput.focus();
  tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// The + button: a new board, or any of your boards in a new tab.
document.getElementById('tab-add').addEventListener('click', async (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const boards = (await store.listBoards()).filter((b) => !tabIds.includes(b.id)).sort((a, b) => b.updated - a.updated);
  showMenu(r.left, r.bottom + 4, [
    { label: 'New board', action: newBoard },
    ...(boards.length ? ['-', { label: 'Open in a new tab', disabled: true }] : []),
    ...boards.slice(0, 20).map((b) => ({ label: b.name, action: () => openBoard(b.id) })),
    '-',
    { label: 'All boards…', action: goHome },
  ]);
});

// ---------- Board name and home button ----------

document.getElementById('home-button').addEventListener('click', goHome);
// One button for the look: dark → light → colour → dark… (see src/theme.js).
// The look belongs to the board that's open (its preview on the home screen matches).
function cycleTheme() {
  toggleTheme();
  if (currentTheme() === 'pastel') toast(`Colour mode: ${pastelName()}`, 1400);
  updateThemeButtons();
  if (mainDoc) {
    mainDoc.meta.look = currentLook();
    mainDoc.meta.updated = Date.now();
    if (!mainDoc.board.isEmpty()) mainDoc.thumbStale = true;
    scheduleSave();
    syncSoon();
  }
}
function updateThemeButtons() {
  const next = nextTheme();
  for (const id of ['bar-theme-button']) {
    const b = document.getElementById(id);
    b.dataset.next = next;
    b.title = `Switch to ${next === 'colour' ? 'colour mode (a random soft palette)' : `${next} mode`}`;
  }
}
document.getElementById('bar-theme-button').addEventListener('click', cycleTheme);
updateThemeButtons();

// ---------- Shortcuts and help ----------
//
// The ? button in the top bar (or the ? key) lists what you can do, so the board itself
// stays clear of instructions.

const HELP = [
  ['Getting around', [
    ['Zoom', 'Scroll'], ['Pan', 'Drag empty space, middle mouse, or Space + drag'], ['Fit everything (or the selection)', 'F'], ['Actual size', '1'],
  ]],
  ['Adding', [
    ['Images', 'Drop them in, or paste with Ctrl/⌘ + V'], ['From any website', 'Right-click → Save image to board (browser extension)'],
    ['Search for images', 'Ctrl/⌘ + F'], ['From your phone', 'artdirection.io/#/add'],
  ]],
  ['Tools', [
    ['Select and move', 'V'], ['Hand', 'H'], ['Pen (Shift: straight line)', 'B'], ['Eraser', 'E'], ['Text', 'T'], ['Sticky note', 'N'], ['Shape', 'S'], ['Frame', 'A'],
  ]],
  ['Selection', [
    ['Select several', 'Shift-click, or Shift-drag a box'], ['Select all', 'Ctrl/⌘ + A'], ['Duplicate / copy', 'Ctrl/⌘ + D / C'],
    ['Group / ungroup', 'Ctrl/⌘ + G / Shift + G'], ['Nudge', 'Arrow keys (Shift: more)'], ['Delete', 'Delete'],
    ['Star a favourite / focus on stars', 'M / Shift + M'], ['Caption', 'Enter, or double-click an image'], ['Lock', 'L'],
  ]],
  ['Panes and boards', [
    ['Split side by side / top and bottom', 'Alt + V / H'], ['Close pane', 'Alt + W'], ['Maximize pane', 'Ctrl + Space'],
    ['Move several dividers', 'Drag where they meet'], ['Switch board tab', 'Alt + 1…9'], ['Present', 'Ctrl/⌘ + Enter'],
    ['Undo / redo', 'Ctrl/⌘ + Z / Shift + Z'], ['Save to file / open', 'Ctrl/⌘ + S / O'],
  ]],
];
const helpPanel = document.createElement('div');
helpPanel.id = 'help-panel';
helpPanel.hidden = true;
helpPanel.innerHTML = `
  <div class="help-box" role="dialog" aria-label="Shortcuts and help">
    <div class="help-head"><strong>Shortcuts</strong><button class="help-close" title="Close (Esc)">×</button></div>
    <div class="help-cols">${HELP.map(([title, rows]) => `
      <section><h3>${title}</h3>${rows.map(([what, how]) => `<div class="help-row"><span>${what}</span><kbd>${how}</kbd></div>`).join('')}</section>`).join('')}
    </div>
    <p class="help-foot">Right-click anything for more. Settings (light, dark, colour mode, snapping, liquid motion) are in the right-click menu and the ⋯ button.</p>
  </div>`;
document.body.appendChild(helpPanel);
function toggleHelp(open = helpPanel.hidden) {
  helpPanel.hidden = !open;
}
helpPanel.addEventListener('pointerdown', (e) => { if (e.target === helpPanel) toggleHelp(false); });
helpPanel.querySelector('.help-close').addEventListener('click', () => toggleHelp(false));
document.getElementById('help-button').addEventListener('click', () => toggleHelp());
document.getElementById('board-menu-button').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right - 230, r.bottom + 4, null);
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') {
    if (e.key === 'Escape') nameInput.value = mainDoc?.meta.name || '';
    nameInput.blur();
  }
});
nameInput.addEventListener('blur', () => {
  const value = nameInput.value.trim();
  if (mainDoc && value && value !== mainDoc.meta.name) renameBoard(mainDoc.meta.id, value);
  else updateTitle();
});

// ---------- Panes ----------

function paneAction(action, pane, button) {
  const l = layout();
  if (action === 'type' || action === 'board') {
    const r = button.getBoundingClientRect();
    paneMenu(pane, r.left, r.bottom + 4, action === 'board');
    return;
  }
  if (action === 'split-row' || action === 'split-col') {
    if (!l.split(pane, action === 'split-row' ? 'row' : 'col')) {
      toast(l.panes().length >= 16 ? 'That\'s the most panes there can be.' : 'That pane is too small to split.', 2000);
      return;
    }
    // The new pane opens out of the old one with a spring, and the edges ripple.
    const split = l.splits().find((n) => n.a.pane === pane);
    viewports.rebuild();
    if (split) {
      const both = [split.a.pane, split.b.pane];
      viewports.springSplit(split, 0.985, 0.5, () => viewChanged());
      viewports.wobble(5, both);
    }
    viewChanged();
    requestRender();
    return;
  } else if (action === 'close') {
    if (docOfPane(pane) === activeDoc) activate(mainDoc);
    const parent = l.splits().find((n) => n.a.pane === pane || n.b.pane === pane);
    const finish = () => {
      if (!l.close(pane)) return;
      releaseUnusedBoards();
      viewports.rebuild();
      viewports.wobble(4);
      viewChanged();
      requestRender();
    };
    // Squeeze the pane shut first (when it sits directly in a split), then remove it.
    if (parent && !l.maximized && motionOn()) viewports.springSplit(parent, parent.ratio, parent.a.pane === pane ? 0 : 1, finish);
    else finish();
    return;
  } else if (action === 'maximize') {
    l.toggleMaximize(pane);
    viewports.wobble(3);
  }
  viewports.rebuild();
  viewChanged();
  requestRender();
}

// What a pane shows: this board, another board, or a tool.
async function paneMenu(pane, x, y, boardsOnly = false) {
  const others = (await store.listBoards())
    .filter((b) => b.id !== mainDoc?.meta.id)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 14);
  const shows = pane.type === 'board' ? (pane.boardId || mainDoc?.meta.id) : null;
  const tick = (on) => (on ? '✓ ' : '');
  const items = [
    { label: `${tick(shows === mainDoc?.meta.id)}This board: ${mainDoc?.meta.name || ''}`, action: () => showBoardInPane(pane, null) },
    ...(others.length ? ['-', { label: 'Show another board here', disabled: true }] : []),
    ...others.map((b) => ({ label: `${tick(shows === b.id)}${b.name}`, action: () => showBoardInPane(pane, b.id) })),
  ];
  if (!boardsOnly) {
    items.push('-', ...PANE_TYPES.filter((t) => t !== 'board').map((t) => ({
      label: `${tick(pane.type === t)}${TYPE_NAMES[t]}`,
      action: () => setPaneType(pane, t),
    })));
  }
  showMenu(x, y, items);
}

function setPaneType(pane, type) {
  if (pane.type === type) return;
  if (docOfPane(pane) === activeDoc) activate(mainDoc);
  pane.type = type;
  pane.boardId = null;
  releaseUnusedBoards();
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
// as a mood board, in columns. One undo removes the whole set.
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
    if (motionOn()) board.popIn(item, averageColour(p.bitmap), added.length * 45);
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
  if (d?.source === 'refboard-extension' && d.type === 'hello') { announceBoards(); return; }
  if (d?.source !== 'refboard-extension' || d.type !== 'add' || !d.item?.dataUrl) return;
  incoming = incoming.then(() => receive(d.item)).catch((err) => { console.error(err); toast("Couldn't add the image from the extension."); });
});

async function receive(item) {
  const blob = await (await fetch(item.dataUrl)).blob();
  await routing;
  // Saved to a chosen board (or a new one) from the extension's board list.
  let boardId = item.boardId || null;
  if (item.newBoard) boardId = await createBoard({ name: item.newBoard });
  if (boardId && !(await store.getBoard(boardId))) boardId = null;
  if (!boardId) {
    // Older extension, or no board chosen: the board that's open, or else the Inbox.
    if (mode === 'board' && current) boardId = current.id;
    else boardId = await inboxId();
  }
  await receiveBlob(boardId, blob, item.name || 'image', item.sourceUrl || '');
  const record = await store.getBoard(boardId);
  toast(`Saved to ${record?.name || 'the board'}`, 1600);
  announceBoards();
}

// Put a picture on a board: right away if it's on screen, otherwise it waits on the
// board and is placed the next time it's opened.
async function receiveBlob(boardId, blob, name, sourceUrl) {
  const doc = docs.get(boardId);
  if (doc) {
    activate(doc);
    await addBlobToBoard(blob, name, sourceUrl);
  } else {
    await queueForBoard(boardId, blob, name, sourceUrl);
    if (mode === 'home') home.refresh();
    renderTabs();
  }
}

// ---------- Images waiting on a board that isn't open ----------
//
// The extension can save to any board. If that board isn't open, the picture is stored
// with it and listed in board.incoming; opening the board places them all in view.

async function queueForBoard(boardId, blob, name, sourceUrl) {
  const key = `in-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await store.saveImage(boardId, key, blob);
  const record = await store.getBoard(boardId);
  if (!record) return;
  const data = record.board || { items: [], layout: null };
  data.incoming = [...(data.incoming || []), { key, name, sourceUrl, at: Date.now() }];
  await store.putBoard({ ...record, board: data, updated: Date.now() });
}

// Place a board's waiting pictures (called once it's on screen).
async function placeIncoming(doc, incoming) {
  if (!incoming?.length) return;
  const id = doc.meta.id;
  const list = (await Promise.all(incoming.map(async (x) => {
    const blob = await store.loadImage(id, x.key).catch(() => null);
    return blob && { blob, name: x.name || 'image', sourceUrl: x.sourceUrl || '' };
  }))).filter(Boolean);
  if (list.length) {
    const pane = boardPanes().find((p) => docOfPane(p) === doc) || boardPanes()[0];
    const c = pane ? pane.camera.toWorld(pane.rect.w / 2, pane.rect.h / 2) : { x: 0, y: 0 };
    activate(doc);
    await addImages(list, c.x, c.y, pane, { free: true });
    toast(`${list.length} new image${list.length > 1 ? 's' : ''} saved from the browser`, 2600);
  }
  for (const x of incoming) store.deleteImage(id, x.key).catch(() => {});
  saveNow();
}

// Tell the browser extension which boards there are, for its "Save to board" list.
let announceTimer;
function announceBoards() {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(async () => {
    const boards = (await store.listBoards()).map((b) => ({ id: b.id, name: b.name, updated: b.updated }));
    window.postMessage({ source: 'refboard-app', type: 'boards', boards }, location.origin);
  }, 300);
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
// Boards dragged between projects on the home screen are handled there (src/home.js).
const boardDrag = (e) => e.dataTransfer?.types?.includes('application/x-refboard-boards');
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (boardDrag(e)) return;
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
  if (boardDrag(e)) return;

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

    const backups = [...e.dataTransfer.files].filter(isBackupFile);
    if (backups.length) { for (const f of backups) await restoreBackup(f); return; }
    // Board files are added to your boards, never replacing one.
    const boardFiles = [...e.dataTransfer.files].filter(isBoardFile);
    // A big board sent in parts (Name.refboard.001, .002…): joined back together.
    const parts = [...e.dataTransfer.files].filter(isBoardPart);
    if (parts.length) boardFiles.push(...joinParts(parts));
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

let history = new History(() => updateHistoryButtons());
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
  // After placing a note or text, go back to moving things.
  if (isNew && (toolbar.tool === 'note' || toolbar.tool === 'text')) toolbar.setTool('select');
  const before = { ...stateOf(note), text: oldText };
  // Lines starting with "- " or "* " become bullets.
  text = text.replace(/^([ \t]*)[-*] /gm, '$1• ');
  // Text starting with "# ", "## " or "### " becomes a heading (a common shortcut).
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

// ---------- Snapping ----------
//
// While you move things, their left, middle and right line up with the left, middle and
// right of anything else nearby when they get close (and the same for top, middle and
// bottom). Pink lines show what lined up. Ctrl/⌘ while dragging turns it off for that move.

let snapOn = true;
try { snapOn = localStorage.getItem('refboard.snap') !== 'off'; } catch {}
function setSnap(on) {
  snapOn = on;
  try { localStorage.setItem('refboard.snap', on ? 'on' : 'off'); } catch {}
  toast(on ? 'Snapping on. Hold Ctrl/⌘ while dragging to place freely.' : 'Snapping off', 1800);
}

const edges = (b) => ({ x: [b.x, b.x + b.width / 2, b.x + b.width], y: [b.y, b.y + b.height / 2, b.y + b.height] });

function snapMove(d, dx, dy) {
  const zoom = d.pane.camera.zoom;
  if (!d.snap) {
    // Work out once per drag: the box being moved, and the boxes of everything else in view.
    const moving = new Set(d.items);
    const r = d.pane.rect;
    const view = { ...d.pane.camera.toWorld(0, 0), w: r.w / zoom, h: r.h / zoom };
    // (On the first call nothing has moved yet, so this is where they started.)
    const box0 = board.bounds(d.items);
    const others = board.selectable
      .filter((x) => !moving.has(x))
      .map((x) => board.bounds([x]))
      .filter((b) => b && b.x < view.x + view.w * 1.5 && b.x + b.width > view.x - view.w * 0.5 && b.y < view.y + view.h * 1.5 && b.y + b.height > view.y - view.h * 0.5)
      .slice(0, 800);
    d.snap = { box0, others };
  }
  const { box0, others } = d.snap;
  if (!box0 || !others.length) return { dx, dy };
  const limit = 7 / zoom;
  const box = { x: box0.x + dx, y: box0.y + dy, width: box0.width, height: box0.height };
  const mine = edges(box);
  // The smallest nudge that lines one of our edges up with one of theirs.
  const best = (axis) => {
    let shift = null;
    for (const o of others) for (const t of edges(o)[axis]) for (const m of mine[axis]) {
      const diff = t - m;
      if (Math.abs(diff) <= limit && (shift === null || Math.abs(diff) < Math.abs(shift))) shift = diff;
    }
    return shift;
  };
  const sx = best('x'), sy = best('y');
  if (sx !== null) dx += sx;
  if (sy !== null) dy += sy;
  // Guides for everything that now lines up exactly.
  const snapped = edges({ x: box0.x + dx, y: box0.y + dy, width: box0.width, height: box0.height });
  const by = snapped.y, bx = snapped.x;
  const eps = 0.5 / zoom;
  const guides = [];
  for (const o of others) {
    const oe = edges(o);
    if (sx !== null) for (const t of oe.x) for (const m of bx) if (Math.abs(t - m) < eps) {
      guides.push({ x1: m, y1: Math.min(by[0], o.y), x2: m, y2: Math.max(by[2], o.y + o.height) });
    }
    if (sy !== null) for (const t of oe.y) for (const m of by) if (Math.abs(t - m) < eps) {
      guides.push({ x1: Math.min(bx[0], o.x), y1: m, x2: Math.max(bx[2], o.x + o.width), y2: m });
    }
  }
  board.guides = guides;
  return { dx, dy };
}

function dragTo(d, w, e) {
  if (d.kind === 'move') {
    let dx = w.x - d.start.x, dy = w.y - d.start.y;
    // Snap to other things' edges and middles (hold Ctrl/⌘ to place freely).
    const free = !snapOn || e.ctrlKey || e.metaKey;
    board.guides = [];
    if (!free) ({ dx, dy } = snapMove(d, dx, dy));
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
    if (it.kind === 'frame' || it.shape === 'rect' || it.shape === 'ellipse' || it.shape === 'star') {
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

// The bar of buttons above what's selected.
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
  frame: '<svg viewBox="0 0 16 16"><rect x="2" y="5" width="12" height="9" rx="1.5"/><path d="M2.5 2.4h5.5"/></svg>',
  duplicate: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"/></svg>',
  delete: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg>',
  star: '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
  caption: '<svg viewBox="0 0 16 16"><rect x="2" y="1.5" width="12" height="8" rx="1.5"/><path d="M2.5 12h11M2.5 14.5h7"/></svg>',
  compare: '<svg viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M8 1.5v13"/><path d="M8 3h5a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0113 13H8z" fill="currentColor" stroke="none" opacity=".5"/></svg>',
};
const SEL_ACTIONS = [
  ['star', 'Star as a favourite (M)', toggleStar, (sel) => sel.some((x) => x.kind === 'image')],
  ['caption', 'Write a caption under it (Enter, or double-click the image)', () => editCaption(board.selected), (sel) => sel.length === 1 && sel[0].kind === 'image'],
  ['compare', 'Compare these two (slider, side by side, overlay, difference)', () => compareSelection(), (sel) => sel.length === 2 && sel.every((x) => x.kind === 'image')],
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
  <div class="sel-palette" hidden></div>
  <div class="sel-palette fill-palette" hidden></div>`;
selectionBar.prepend(textControls);
const levelSelect = textControls.querySelector('.sel-level');
for (const [id, l] of Object.entries(LEVELS)) levelSelect.add(new Option(l.label, id));
const fontSelect = textControls.querySelector('.sel-font');
const palette = textControls.querySelector('.sel-palette:not(.fill-palette)');
// A frame's background: see-through, or a solid colour (soft ones first).
const fillPalette = textControls.querySelector('.fill-palette');
const FRAME_FILLS = ['#ffffff', '#efece4', '#2b2b30', '#141416', '#ffd6d6', '#ffe6c2', '#fff4b8', '#d3f2de', '#d5e8ff', '#e6dbff', '#ff5a5a', '#4da3ff'];
{
  const none = document.createElement('button');
  none.className = 'swatch none';
  none.title = 'No fill (see-through)';
  none.addEventListener('click', () => { setTextProps({ fill: null }); fillPalette.hidden = true; });
  fillPalette.appendChild(none);
  for (const c of FRAME_FILLS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => { setTextProps({ fill: c }); fillPalette.hidden = true; });
    fillPalette.appendChild(b);
  }
  const any = Object.assign(document.createElement('input'), { type: 'color', title: 'Any colour' });
  any.className = 'swatch custom-input';
  any.addEventListener('input', () => setTextProps({ fill: any.value }));
  fillPalette.appendChild(any);
}
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
const selectedFrames = () => board.selection.filter((x) => x.kind === 'frame');

// Change text (or shape) settings on everything selected, as one undo step.
function setTextProps(props) {
  const notes = selectedNotes();
  const shapes = selectedShapes();
  const frames = selectedFrames();
  if (frames.length && !notes.length && !shapes.length) {
    // Frame titles: level, font, bold, italic and colour, like text.
    editSelection((f) => {
      if (props.level) { f.level = props.level; f.weight = Math.max(600, LEVELS[props.level].weight); }
      for (const k of ['font', 'italic', 'color', 'weight', 'fill']) if (k in props) f[k] = props[k];
      board.drawFrame(f);
    }, frames);
    if (props.font || props.weight || 'italic' in props) {
      Promise.all(frames.map((f) => ensureFont(f.font, f.weight, f.italic))).then(() => { frames.forEach((f) => board.drawFrame(f)); requestRender(); });
    }
    lastControls = '';
    return;
  }
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
  const list = selectedNotes().length ? selectedNotes() : selectedFrames();
  setTextProps({ weight: list.every((n) => n.weight >= 600) ? 400 : 700 });
});
textControls.querySelector('[data-text="italic"]').addEventListener('click', () => {
  const list = selectedNotes().length ? selectedNotes() : selectedFrames();
  setTextProps({ italic: !list.every((n) => n.italic) });
});
textControls.querySelector('[data-text="align"]').addEventListener('click', () => {
  const order = ['left', 'center', 'right'];
  const now = selectedNotes()[0]?.align || 'left';
  setTextProps({ align: order[(order.indexOf(now) + 1) % 3] });
});
textControls.querySelector('[data-text="colour"]').addEventListener('click', () => { palette.hidden = !palette.hidden; fillPalette.hidden = true; });
textControls.querySelector('[data-text="box"]').addEventListener('click', () => {
  const order = ['none', 'fill', 'outline'];
  const now = selectedNotes()[0]?.box || 'none';
  setTextProps({ box: order[(order.indexOf(now) + 1) % 3] });
});
textControls.querySelector('[data-text="fill"]').addEventListener('click', () => {
  // Frames: pick a background colour. Shapes: fill on or off.
  if (selectedFrames().length && !selectedShapes().length) { fillPalette.hidden = !fillPalette.hidden; palette.hidden = true; return; }
  setTextProps({ fill: !selectedShapes().every((x) => x.fill) });
});
selectionBar.addEventListener('pointerdown', (e) => e.stopPropagation());

// Show the text controls for the selection, and keep them in step with it.
let lastControls = '';
function updateTextControls(sel) {
  const notes = sel.filter((x) => x.kind === 'note');
  const shapes = sel.filter((x) => x.kind === 'shape');
  const frames = sel.filter((x) => x.kind === 'frame');
  const isText = notes.length > 0 && notes.length === sel.length;
  const isShape = shapes.length > 0 && shapes.length === sel.length;
  const isFrame = frames.length > 0 && frames.length === sel.length;
  textControls.hidden = !isText && !isShape && !isFrame;
  if (textControls.hidden) { palette.hidden = true; fillPalette.hidden = true; return; }
  const fillButton = textControls.querySelector('[data-text="fill"]');
  fillButton.title = isFrame ? 'Background colour' : 'Fill the shape';
  if (isFrame) {
    // A frame's title: level, font, bold, italic, colour (no alignment or box).
    for (const el of textControls.querySelectorAll('.sel-level, .sel-font, [data-text="bold"], [data-text="italic"]')) el.hidden = false;
    for (const el of textControls.querySelectorAll('[data-text="align"], [data-text="box"]')) el.hidden = true;
    fillButton.hidden = false;
    const f = frames[0];
    const key = frames.map((x) => `${x.id}:${x.font}:${x.level}:${x.weight}:${x.italic}:${x.color}:${x.fill}`).join(',') + customFonts().join(',');
    if (key === lastControls) return;
    lastControls = key;
    levelSelect.value = f.level || 'body';
    fillFontMenu(f.font || 'Inter');
    textControls.querySelector('[data-text="bold"]').classList.toggle('on', frames.every((x) => x.weight >= 600));
    textControls.querySelector('[data-text="italic"]').classList.toggle('on', frames.every((x) => x.italic));
    textControls.querySelector('.sel-colour').style.setProperty('--c', f.color || `#${board.ink.toString(16).padStart(6, '0')}`);
    fillButton.classList.toggle('on', frames.some((x) => x.fill));
    fillButton.style.setProperty('--fill', f.fill || 'transparent');
    return;
  }
  fillButton.style.removeProperty('--fill');
  fillPalette.hidden = true;
  // Shapes only get a colour and a fill; text gets everything else.
  for (const el of textControls.querySelectorAll('.sel-level, .sel-font, [data-text="bold"], [data-text="italic"], [data-text="align"], [data-text="box"]')) el.hidden = !isText;
  textControls.querySelector('[data-text="fill"]').hidden = !(isShape && shapes.some((x) => x.shape === 'rect' || x.shape === 'ellipse' || x.shape === 'star'));
  if (isShape) {
    const key = shapes.map((x) => `${x.id}:${x.color}:${x.fill}`).join(',');
    if (key === lastControls) return;
    lastControls = key;
    textControls.querySelector('[data-text="fill"]').classList.toggle('on', shapes.every((x) => x.fill));
    textControls.querySelector('.sel-colour').style.setProperty('--c', shapes[0].color === 'ink' ? themeColours().text : shapes[0].color);
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
  selectionBar.querySelector('[data-action="star"]').classList.toggle('on', sel.some((x) => x.kind === 'image') && sel.filter((x) => x.kind === 'image').every((x) => x.star));
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
// Whether Alt / Option is down (Alt-dropping onto another board copies instead of moving).
let altHeld = false;
for (const t of ['keydown', 'keyup', 'pointermove', 'pointerup']) window.addEventListener(t, (e) => { altHeld = e.altKey; }, true);
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
// The eraser rubs out only the part of a stroke it touches: the rest of the stroke stays,
// split in two if the eraser went through its middle.
function eraseAt(pane, e) {
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const radius = toolbar.state.eraserSize / 2 / pane.camera.zoom;
  for (const s of board.strokesAt(w.x, w.y, radius)) {
    const reach = radius + s.size * 0.35;
    const runs = [];
    let run = [];
    for (let i = 0; i < s.points.length; i += 3) {
      const gone = Math.hypot(s.points[i] - w.x, s.points[i + 1] - w.y) <= reach;
      if (gone) { if (run.length) runs.push(run); run = []; }
      else run.push(s.points[i], s.points[i + 1], s.points[i + 2]);
    }
    if (run.length) runs.push(run);
    const keptAll = runs.length === 1 && runs[0].length === s.points.length;
    if (keptAll) continue;   // the eraser passed between its points: nothing to rub out
    drag.removed.push(board.strokeJSON(s));
    board.removeStroke(s);
    for (const pts of runs) {
      if (pts.length < 6) continue;   // a speck: let it go
      const piece = board.addStroke({ points: pts, color: s.color, size: s.size, simulatePressure: s.simulatePressure });
      drag.added.push(piece.id);
    }
  }
}

// One point of a stroke being drawn. Points closer together than about half a pixel on
// screen are skipped (they only add jitter). Shift draws a straight line from the start.
function addPoint(stroke, pane, e) {
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const pressure = e.pointerType === 'pen' ? 0.15 + 0.85 * Math.max(0.05, e.pressure) : 0.5;
  const pts = stroke.points;
  if (e.shiftKey && pts.length >= 3) {
    // A straight line: just the first point and this one (with a few in between, so the
    // line keeps an even width).
    const [x0, y0, p0] = pts;
    pts.length = 0;
    for (let k = 0; k <= 8; k++) pts.push(x0 + (w.x - x0) * k / 8, y0 + (w.y - y0) * k / 8, p0 + (pressure - p0) * k / 8);
    return;
  }
  const n = pts.length;
  if (n >= 3 && Math.hypot(pts[n - 3] - w.x, pts[n - 2] - w.y) < 0.6 / pane.camera.zoom) return;
  pts.push(w.x, w.y, pressure);
}

panesEl.addEventListener('pointerdown', (e) => {
  const pane = viewports.paneFromElement(e.target);
  if (!pane) return;
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (pane.type !== 'board') return;  // search and the mannequin handle their own mouse
  if (document.activeElement === nameInput) nameInput.blur();
  activate(docOfPane(pane));  // clicking a pane that shows another board starts working on it
  finishCaption();
  board.settleAll();
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
    drag = { kind: 'erase', pane, removed: [], added: [] };
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
    // Stir the dotted background a little (see viewports.stir).
    if (pane?.type === 'board' && !presenting) viewports.stir(pane, e.clientX - pane.rect.x, e.clientY - pane.rect.y);
    let over = null;
    if (pane?.type === 'board' && toolbar.tool === 'select' && docOfPane(pane) === activeDoc) {
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
    // Moving things into another pane pushes through a thin layer of jelly first.
    const at = drag.kind === 'move' ? portalDrag(drag, e) : { x: e.clientX, y: e.clientY };
    const w = drag.pane.camera.toWorld(at.x - drag.pane.rect.x, at.y - drag.pane.rect.y);
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
  board.guides = [];
  endGhost(d);
  panesEl.classList.remove('panning');

  if (d.kind === 'create') {
    const it = d.item;
    if (!d.moved || (it.kind !== 'shape' || it.shape === 'rect' || it.shape === 'ellipse' || it.shape === 'star' ? Math.max(it.w, it.h) : Math.hypot(it.dx, it.dy)) * d.pane.camera.zoom < 6) {
      // Just a click: a shape or frame of a standard size.
      const z = d.pane.camera.zoom;
      if (it.kind === 'frame') { it.w = 960 / z; it.h = 540 / z; board.drawFrame(it); }
      else if (it.shape === 'rect' || it.shape === 'ellipse' || it.shape === 'star') { it.w = 180 / z; it.h = 120 / z; board.drawShape(it); }
      else { it.dx = 180 / z; it.dy = 0; board.drawShape(it); }
      it.sprite.position.set(d.start.x, d.start.y);
    }
    const kind = it.kind;
    const data = kind === 'frame' ? board.frameJSON(it) : board.shapeJSON(it);
    history.push({ undo: () => removeThing(kind, data.id), redo: () => restoreThing({ kind, data }) });
    board.selected = it;
    toolbar.setTool('select');
    contentChanged();
  } else if (d.kind === 'move' && d.moved && moveToOtherBoard(d)) {
    // (handled: dropped onto a pane that shows another board)
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
    // Undo puts back the strokes as they were before; redo leaves the pieces that are left.
    const made = new Set(d.added);
    const originals = d.removed.filter((s) => !made.has(s.id));
    const pieces = d.added.map((id) => board.find('stroke', id)).filter(Boolean).map((s) => board.strokeJSON(s));
    history.push({
      undo: () => {
        pieces.forEach((s) => { const x = board.find('stroke', s.id); if (x) board.removeStroke(x); });
        originals.forEach((s) => board.addStroke(s));
      },
      redo: () => {
        originals.forEach((s) => { const x = board.find('stroke', s.id); if (x) board.removeStroke(x); });
        pieces.forEach((s) => board.addStroke(s));
      },
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
  activate(docOfPane(pane));
  const p = localPoint(pane, e);
  const w = pane.camera.toWorld(p.x, p.y);
  const title = board.frameTitleAt(w.x, w.y);
  if (title) return renameFrame(title, pane, board.titleIndexAt(title, w.x, w.y));
  const hit = board.hitTest(w.x, w.y);
  if (hit?.kind === 'note') editNote(hit, pane);
  else if (hit?.kind === 'frame') renameFrame(hit, pane);
  else if (hit?.kind === 'image') { board.selection = [hit]; editCaption(hit, pane); }
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

// The right-click menu (and the ⋯ menu in the top bar, which has no pane).
// Kept short: what you can do with what's selected first, then a few groups.
function openMenu(x, y, pane) {
  const l = layout();
  const several = l.panes().length > 1;
  const sel = board.selection;
  const imgs = sel.filter((x) => x.kind === 'image');
  const one = board.selected;
  const n = sel.length;

  const boardMenu = [
    { label: board.frames.length ? `Present (${board.frames.length} frame${board.frames.length > 1 ? 's' : ''})` : 'Present', shortcut: `${MOD}Enter`, disabled: board.isEmpty(), action: startPresent },
    '-',
    { label: 'Save to file', shortcut: `${MOD}S`, action: () => saveToFile() },
    { label: 'Save to file as…', shortcut: `${MOD}Shift+S`, action: () => saveToFile({ saveAs: true }) },
    { label: 'Open file…', shortcut: `${MOD}O`, action: openFile },
    { label: 'Back up all boards', action: backupAllBoards },
    '-',
    { label: 'New board', action: newBoard },
    { label: 'All boards', action: goHome },
    '-',
    { label: 'Capture screen…', action: captureScreen },
    { label: 'Lock everything', action: () => setLocked('all', true) },
    { label: 'Unlock everything', action: () => setLocked('all', false) },
  ];
  const settingsMenu = [
    { label: { light: 'Light mode', colour: 'Colour mode', dark: 'Dark mode' }[nextTheme()], action: cycleTheme },
    { label: 'Shortcuts and help', shortcut: '?', action: toggleHelp },
    { label: snapOn ? 'Snapping: on ✓' : 'Snapping: off', action: () => setSnap(!snapOn) },
    { label: drive.isConnected() ? 'Google Drive: connected ✓' : 'Connect Google Drive…', action: () => (drive.isConnected() ? driveMenu(x, y) : connectDrive()) },
    { label: motionOn() ? 'Liquid motion: on ✓' : 'Liquid motion: off', action: () => { setMotion(!motionOn()); toast(motionOn() ? 'Liquid motion on' : 'Liquid motion off: everything moves instantly', 1800); } },
    '-',
    ...(isInstalled() ? [] : [{ label: 'Install as an app…', action: installApp }]),
    { label: document.documentElement.dataset.refboardExtension ? 'Browser extension: installed ✓' : 'Get the browser extension…', action: () => window.open(EXTENSION_HELP, '_blank', 'noopener') },
  ];

  // The ⋯ button in the top bar: the board's own menu.
  if (!pane) {
    showMenu(x, y, [...boardMenu, '-', { label: 'Settings', submenu: settingsMenu }]);
    return;
  }

  const paneMenu = [
    { label: 'Split side by side', shortcut: 'Alt+V', action: () => paneAction('split-row', pane) },
    { label: 'Split top and bottom', shortcut: 'Alt+H', action: () => paneAction('split-col', pane) },
    { label: l.maximized ? 'Restore panes' : 'Maximize pane', shortcut: 'Ctrl+Space', disabled: !several, action: () => paneAction('maximize', pane) },
    { label: 'Close pane', shortcut: 'Alt+W', disabled: !several, action: () => paneAction('close', pane) },
  ];
  const groups = ['-',
    { label: 'Pane', submenu: paneMenu },
    { label: 'Board', submenu: boardMenu },
    { label: 'Settings', submenu: settingsMenu },
  ];

  // Nothing selected: everyday things, then the groups.
  if (!n) {
    const at = pane.camera.toWorld(x - pane.rect.x, y - pane.rect.y);
    showMenu(x, y, [
      // Right-clicked something locked: it can't be selected, so offer to unlock it here.
      ...(menuTarget?.locked ? [{ label: `Unlock ${menuTarget.kind === 'image' ? 'image' : menuTarget.kind === 'note' ? 'note' : menuTarget.kind}`, shortcut: 'L', action: () => setLocked(menuTarget, false) }, '-'] : []),
      ...(clipboard ? [{ label: 'Paste here', shortcut: `${MOD}V`, action: () => pasteThings(clipboard, at) }] : []),
      { label: 'Fit everything', shortcut: 'F', disabled: board.isEmpty(), action: () => { fitPane(pane, null); requestRender(); } },
      { label: 'Select all', shortcut: `${MOD}A`, disabled: board.isEmpty(), action: () => { board.selection = [...board.items, ...board.notes, ...board.shapes].filter((t) => !t.locked); requestRender(); } },
      ...(board.starred.length ? [{ label: board.focus ? 'Stop focusing on starred' : 'Focus on starred', shortcut: 'Shift+M', action: () => setFocus(!board.focus) }] : []),
      '-',
      { label: 'Undo', shortcut: `${MOD}Z`, disabled: !history.done.length, action: undo },
      { label: 'Redo', shortcut: `${MOD}Shift+Z`, disabled: !history.undone.length, action: redo },
      ...groups,
    ]);
    return;
  }

  // Something selected: what you can do with it.
  const what = n > 1 ? `${n} things` : one.kind === 'image' ? 'image' : one.kind === 'note' ? (one.style === 'text' ? 'text' : 'note') : one.kind;
  const imageMenu = [
    { label: 'Flip left to right', action: () => flipSelection('x') },
    { label: 'Flip upside down', action: () => flipSelection('y') },
    { label: 'Greyscale on / off', action: toggleGrey },
    ...(one?.kind === 'image' ? [
      { label: 'Crop…', action: startCrop },
      ...(one.crop ? [{ label: 'Show the whole image', action: resetCrop }] : []),
    ] : []),
    '-',
    ...(one?.kind === 'image' ? [{ label: 'Extract colours', action: extractColours }] : []),
    { label: 'Colour script', action: colourScript },
    '-',
    ...(one?.kind === 'image' ? [
      { label: 'Copy image', action: () => copyImage(one) },
      { label: 'Download image', action: () => downloadImage(one) },
      ...(one.sourceUrl ? [{ label: 'Open where it came from', action: () => window.open(one.sourceUrl, '_blank', 'noopener') }] : []),
    ] : []),
  ];
  const arrangeMenu = [
    ...(n > 1 ? [{ label: 'Align and spread', submenu: alignItems() }] : []),
    ...(imgs.length > 1 ? [{ label: 'Lay out as a storyboard', action: storyboardSelection }] : []),
    '-',
    ...(n > 1 ? [{ label: 'Group', shortcut: `${MOD}G`, action: groupSelection }] : []),
    ...(sel.some((s) => s.group) ? [{ label: 'Ungroup', shortcut: `${MOD}Shift+G`, action: ungroupSelection }] : []),
    { label: 'Put a frame around', action: frameSelection },
    '-',
    { label: 'Bring to front', action: () => reorderSelection(true) },
    { label: 'Send to back', action: () => reorderSelection(false) },
    { label: board.selected ? 'Zoom to fit it' : 'Zoom to fit them', shortcut: 'F', action: () => { fitPane(pane, sel); requestRender(); } },
  ];
  const locked = menuTarget?.locked;
  showMenu(x, y, [
    { label: 'Copy', shortcut: `${MOD}C`, action: copySelection },
    { label: 'Duplicate', shortcut: `${MOD}D`, action: duplicateSelection },
    { label: `Delete ${what}`, shortcut: 'Del', action: removeSelected },
    '-',
    ...(imgs.length ? [{ label: imgs.every((x) => x.star) ? 'Remove star' : 'Star as a favourite', shortcut: 'M', action: toggleStar }] : []),
    ...(one?.kind === 'image' ? [{ label: one.caption ? 'Edit caption' : 'Write a caption', shortcut: 'Enter', action: () => editCaption(one, pane) }] : []),
    ...(n === 2 && imgs.length === 2 ? [{ label: 'Compare these two…', action: compareSelection }] : []),
    '-',
    ...(imgs.length ? [{ label: 'Image', submenu: imageMenu }] : []),
    { label: 'Arrange', submenu: arrangeMenu },
    { label: locked ? 'Unlock' : 'Lock', shortcut: 'L', action: () => (menuTarget ? setLocked(menuTarget, !locked) : setLocked(null, true)) },
    ...groups,
  ]);
}

panesEl.addEventListener('contextmenu', (e) => {
  const clicked = viewports.paneFromElement(e.target);
  // Inside a tool pane, keep Chrome's own menu (e.g. to copy an image or open its page).
  if (clicked && clicked.type !== 'board' && e.target.closest('.pane-editor')) return;
  e.preventDefault();
  const pane = clicked?.type === 'board' ? clicked : null;
  if (pane) activate(docOfPane(pane));
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
  if (compareOpen()) return;
  if (!helpPanel.hidden && e.key === 'Escape') { toggleHelp(false); return; }
  if (e.key === '?' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); toggleHelp(); return; }
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

  // Alt+1…9: go to that tab.
  if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) {
    const id = tabIds[Number(e.code.slice(5)) - 1];
    e.preventDefault();
    if (id && id !== mainDoc?.meta.id) openBoard(id);
    return;
  }
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
  } else if (e.code === 'KeyM') {
    if (e.shiftKey) setFocus(!board.focus); else toggleStar();
  } else if (e.key === 'Enter' && board.selected?.kind === 'image') {
    e.preventDefault();
    editCaption(board.selected, targetBoardPane());
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
// If there are boards, ask Chrome (again) to keep them. Chrome decides quietly.
store.listBoards().then((b) => { if (b.length) askToKeepStorage(); }).catch(() => {});
document.fonts.addEventListener('loadingdone', () => { for (const d of docs.values()) d.board.relayoutNotes(); requestRender(); });
await route();

// Handy for testing from the browser console.
window.__refboard = { get board() { return board; }, get docs() { return docs; }, viewports, layout, addImages, saveNow, get current() { return current; }, store, routing: () => routing };
