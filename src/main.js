// Starts the app and connects everything: panes, mouse, keyboard, drag-and-drop,
// paste, the right-click menu, board files and autosave.

import { Application } from '../vendor/pixi.min.mjs';
import { Board } from './board.js';
import { Layout } from './layout.js';
import { Viewports } from './viewports.js';
import { imagesFromDrop, imagesFromPaste } from './importer.js';
import { showMenu, hideMenu } from './menu.js';
import {
  FILE_EXT, packBoard, unpackBoard, isBoardFile, describeBoard, canPickFiles,
  pickSaveLocation, ensureWritePermission, writeToHandle, pickBoardToOpen, downloadBlob, autosave,
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
  onPaneAction: (action, pane) => paneAction(action, pane),
  onLayoutChanged: () => viewChanged(),
});
const layout = () => viewports.layout;

// ---------- Redrawing ----------

// Instead of redrawing 60 times a second all the time, we ask for one redraw
// whenever something changes. Several requests in the same frame become one.
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    viewports.render();
    emptyHint.classList.toggle('hidden', board.items.length > 0);
  });
}
window.addEventListener('resize', () => { viewports.position(); requestRender(); });

const emptyHint = document.getElementById('empty-hint');

// ---------- Messages ----------

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message, ms = 4000) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------- The board's file name, unsaved changes and autosave ----------

const doc = {
  name: 'Untitled board',  // file name without the extension
  handle: null,            // the file on disk we save to with Ctrl/⌘+S (Chrome only)
  unsaved: false,          // changes since the last save to a file
};

const titleEl = document.getElementById('board-title');
function updateTitle() {
  titleEl.querySelector('.name').textContent = doc.name;
  titleEl.classList.toggle('unsaved', doc.unsaved);
  document.title = `${doc.unsaved ? '• ' : ''}${doc.name} – Reference Board`;
}

// Something on the board changed (images added, moved, removed...).
function contentChanged() {
  doc.unsaved = true;
  updateTitle();
  scheduleAutosave();
}

// Only the view changed (pan, zoom, panes). Remembered, but doesn't count as unsaved.
function viewChanged() {
  scheduleAutosave();
}

let autosaveTimer;
let loading = false;
function scheduleAutosave() {
  if (loading) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveStateNow, 600);
}
async function saveStateNow() {
  clearTimeout(autosaveTimer);
  try {
    await autosave.saveState({
      board: describeBoard(board, layout()),
      name: doc.name, handle: doc.handle, unsaved: doc.unsaved,
    });
  } catch (err) {
    console.warn('Autosave failed', err);
  }
}
// Save one last time when the tab is hidden or closed.
document.addEventListener('visibilitychange', () => { if (document.hidden) saveStateNow(); });

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
  const wasEmpty = board.items.length === 0;
  const GAP = 20;
  // createImageBitmap does the heavy decoding off the main thread,
  // so the app stays responsive while big files load.
  const decoded = (await Promise.all(list.map(async (entry) => {
    const bitmap = await decode(entry.blob, entry.name);
    return bitmap && { entry, bitmap };
  }))).filter(Boolean);
  if (!decoded.length) return;

  const totalWidth = decoded.reduce((sum, d) => sum + d.bitmap.width, 0) + GAP * (decoded.length - 1);
  let x = wx - totalWidth / 2;
  const added = [];
  for (const { entry, bitmap } of decoded) {
    const item = board.addImage(bitmap, x + bitmap.width / 2, wy, entry);
    x += bitmap.width + GAP;
    added.push(item);
    autosave.saveImage(String(item.id), entry.blob).catch((err) => console.warn('Autosave of image failed', err));
  }
  board.selected = added[added.length - 1];
  // On an empty board, zoom so the first images fit nicely.
  if (wasEmpty) fitPane(pane, board.items);
  contentChanged();
  requestRender();
}

function removeImage(item) {
  autosave.deleteImage(String(item.id)).catch(() => {});
  board.remove(item);
  contentChanged();
  requestRender();
}

// Zoom a pane so these images fill it. With no pane given, every visible pane.
function fitPane(pane, items) {
  const bounds = board.bounds(items);
  if (!bounds) return;
  for (const p of pane ? [pane] : layout().visiblePanes()) p.camera.frame(bounds, p.rect.w, p.rect.h, 60);
  viewChanged();
}

// ---------- Opening, saving and new boards ----------

// Put a saved board on screen. `getBlob(item)` fetches each image's file.
async function loadBoard(data, getBlob) {
  loading = true;
  try {
    board.clear();
    const blobs = await Promise.all(data.items.map((item) => getBlob(item)));
    const bitmaps = await Promise.all(data.items.map((item, i) => (blobs[i] ? decode(blobs[i], item.name) : null)));
    let missing = 0;
    data.items.forEach((item, i) => {
      if (!bitmaps[i]) { missing++; return; }
      board.addImage(bitmaps[i], item.x, item.y, { ...item, blob: blobs[i] });
    });
    board.selected = null;
    viewports.setLayout(Layout.fromJSON(data.layout));
    if (missing) toast(`${missing} image${missing > 1 ? 's' : ''} couldn't be loaded.`);
  } finally {
    loading = false;
  }
  requestRender();
}

// Only ask when there's something that would be lost.
function okToReplace() {
  if (!doc.unsaved || board.items.length === 0) return true;
  return confirm(`"${doc.name}" has changes that aren't saved to a file. Continue anyway?`);
}

async function openBoardFile(file, handle = null) {
  if (!okToReplace()) return;
  toast(`Opening ${file.name}…`, 60000);
  try {
    const { data, images } = await unpackBoard(file);
    await loadBoard(data, (item) => images.get(item.file));
    Object.assign(doc, { name: file.name.replace(/\.refboard$/i, ''), handle, unsaved: false });
    updateTitle();
    toast(`Opened ${file.name}`, 1500);
    // Make the opened board the autosaved one.
    await autosave.clearImages();
    await Promise.all(board.items.map((item) => autosave.saveImage(String(item.id), item.blob)));
    await saveStateNow();
  } catch (err) {
    toast(err.message || "Couldn't open that file.");
  }
}

async function openBoard() {
  try {
    const picked = await pickBoardToOpen();
    if (picked) await openBoardFile(picked.file, picked.handle);
  } catch (err) {
    toast(err.message || "Couldn't open that file.");
  }
}

let saving = false;
async function saveBoard({ saveAs = false } = {}) {
  if (saving) return;
  saving = true;
  try {
    if (canPickFiles) {
      // Ask where to save (or for permission) first, while Chrome still counts it as your click.
      let handle = saveAs ? null : doc.handle;
      if (handle) await ensureWritePermission(handle);
      else handle = await pickSaveLocation(doc.name + FILE_EXT);
      if (!handle) return;  // cancelled
      toast('Saving…', 60000);
      await writeToHandle(handle, await packBoard(board, layout()));
      Object.assign(doc, { handle, name: handle.name.replace(/\.refboard$/i, ''), unsaved: false });
    } else {
      // Other browsers: download a copy instead.
      downloadBlob(await packBoard(board, layout()), doc.name + FILE_EXT);
      doc.unsaved = false;
    }
    updateTitle();
    toast(`Saved ${doc.name}${FILE_EXT}`, 1500);
    saveStateNow();
  } catch (err) {
    toast(err.message || "Couldn't save the board.");
  } finally {
    saving = false;
  }
}

async function newBoard() {
  if (!okToReplace()) return;
  board.clear();
  viewports.setLayout(new Layout());
  Object.assign(doc, { name: 'Untitled board', handle: null, unsaved: false });
  updateTitle();
  await autosave.clearImages().catch(() => {});
  await saveStateNow();
  requestRender();
}

// ---------- Panes ----------

function paneAction(action, pane) {
  const l = layout();
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

  // A board file opens the board.
  const boardFile = [...e.dataTransfer.files].find(isBoardFile);
  if (boardFile) return openBoardFile(boardFile);

  const pane = viewports.paneAt(e.clientX, e.clientY) || layout().visiblePanes()[0];
  const at = pane.camera.toWorld(e.clientX - pane.rect.x, e.clientY - pane.rect.y);
  try {
    const list = await imagesFromDrop(e.dataTransfer);
    if (list.length === 0) return toast('Nothing to add. Drop image files, images from a web page, or a board file.');
    await addImages(list, at.x, at.y, pane);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Paste ----------

window.addEventListener('paste', async (e) => {
  // Paste under the mouse if it's over a pane, otherwise in the middle of the first pane.
  const pane = hoverPane() || layout().visiblePanes()[0];
  const local = mouse.x === null
    ? { x: pane.rect.w / 2, y: pane.rect.h / 2 }
    : { x: mouse.x - pane.rect.x, y: mouse.y - pane.rect.y };
  const at = pane.camera.toWorld(local.x, local.y);
  try {
    const list = await imagesFromPaste(e.clipboardData);
    if (list.length === 0) return toast('There is no image on the clipboard.');
    await addImages(list, at.x, at.y, pane);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Mouse and pen ----------

const mouse = { x: null, y: null };
let spaceHeld = false;
// What the current drag is doing: { kind: 'pan', pane } or { kind: 'move', pane, item, offsetX, offsetY }
let drag = null;

function hoverPane() {
  return mouse.x === null ? null : viewports.paneAt(mouse.x, mouse.y);
}

function localPoint(pane, e) {
  return { x: e.clientX - pane.rect.x, y: e.clientY - pane.rect.y };
}

panesEl.addEventListener('pointerdown', (e) => {
  const pane = viewports.paneFromElement(e.target);
  if (!pane) return;
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (e.button === 2) return;  // right button: handled by the menu
  panesEl.setPointerCapture(e.pointerId);

  const p = localPoint(pane, e);
  // Middle button, or Space + left button, always pans.
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    drag = { kind: 'pan', pane };
  } else if (e.button === 0) {
    const w = pane.camera.toWorld(p.x, p.y);
    const hit = board.hitTest(w.x, w.y);
    if (hit) {
      // Clicked an image: select it, raise it to the top and start moving it.
      board.selected = hit;
      board.bringToFront(hit);
      drag = { kind: 'move', pane, item: hit, offsetX: w.x - hit.sprite.x, offsetY: w.y - hit.sprite.y, moved: false };
    } else {
      // Clicked empty space: deselect and pan.
      board.selected = null;
      drag = { kind: 'pan', pane };
    }
  }
  panesEl.classList.toggle('panning', drag?.kind === 'pan');
  requestRender();
});

panesEl.addEventListener('pointermove', (e) => {
  const dx = e.clientX - (mouse.x ?? e.clientX);
  const dy = e.clientY - (mouse.y ?? e.clientY);
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (!drag) return;
  if (drag.kind === 'pan') {
    drag.pane.camera.panBy(dx, dy);
  } else if (drag.kind === 'move') {
    // The image follows the mouse in the pane you're dragging in; every other pane updates too.
    const p = localPoint(drag.pane, e);
    const w = drag.pane.camera.toWorld(p.x, p.y);
    drag.item.sprite.position.set(w.x - drag.offsetX, w.y - drag.offsetY);
    drag.moved = true;
  }
  requestRender();
});

function endDrag() {
  if (drag?.kind === 'move' && drag.moved) contentChanged();
  else if (drag?.kind === 'pan') viewChanged();
  drag = null;
  panesEl.classList.remove('panning');
}
panesEl.addEventListener('pointerup', endDrag);
panesEl.addEventListener('pointercancel', endDrag);
document.addEventListener('pointerleave', () => { if (!drag) { mouse.x = null; mouse.y = null; } });

// Stop the middle button from starting Chrome's auto-scroll.
panesEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

// Scroll wheel / trackpad: zoom the pane under the mouse, towards the mouse.
panesEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const pane = viewports.paneAt(e.clientX, e.clientY);
  if (!pane) return;
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
    { label: 'New board', action: newBoard },
    { label: 'Open…', shortcut: `${MOD}O`, action: openBoard },
    { label: 'Save', shortcut: `${MOD}S`, action: () => saveBoard() },
    { label: 'Save as…', shortcut: `${MOD}Shift+S`, action: () => saveBoard({ saveAs: true }) },
  ];
  if (pane) {
    items.push('-',
      { label: 'Split side by side', shortcut: 'Alt+V', action: () => paneAction('split-row', pane) },
      { label: 'Split top and bottom', shortcut: 'Alt+H', action: () => paneAction('split-col', pane) },
      { label: l.maximized ? 'Restore panes' : 'Maximize pane', shortcut: 'Ctrl+Space', disabled: !several, action: () => paneAction('maximize', pane) },
      { label: 'Close pane', shortcut: 'Alt+W', disabled: !several, action: () => paneAction('close', pane) },
      '-',
      { label: board.selected ? 'Fit selected image' : 'Fit everything', shortcut: 'F', disabled: !board.items.length, action: () => { fitPane(pane, board.selected ? [board.selected] : board.items); requestRender(); } },
      { label: 'Delete image', shortcut: 'Del', disabled: !board.selected, action: () => removeImage(board.selected) },
    );
  }
  showMenu(x, y, items);
}

panesEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const pane = viewports.paneFromElement(e.target);
  if (pane) {
    // Right-clicking an image selects it, so the menu acts on it.
    const p = localPoint(pane, e);
    const w = pane.camera.toWorld(p.x, p.y);
    board.selected = board.hitTest(w.x, w.y);
    requestRender();
  }
  openMenu(e.clientX, e.clientY, pane);
});

titleEl.addEventListener('click', () => {
  const r = titleEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, null);
});

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const pane = hoverPane() || layout().visiblePanes()[0];

  // Files
  if (mod && e.code === 'KeyS') { e.preventDefault(); hideMenu(); saveBoard({ saveAs: e.shiftKey }); return; }
  if (mod && e.code === 'KeyO') { e.preventDefault(); hideMenu(); openBoard(); return; }

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
    e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (board.selected) removeImage(board.selected);
  } else if (e.key === 'f' || e.key === 'F') {
    // Fit the selected image, or everything if nothing is selected.
    fitPane(pane, board.selected ? [board.selected] : board.items);
    requestRender();
  } else if (e.key === '1') {
    // Back to 100% (actual pixels), around the middle of the pane.
    pane.camera.zoomAt(pane.rect.w / 2, pane.rect.h / 2, 1 / pane.camera.zoom);
    viewChanged();
    requestRender();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false;
    panesEl.classList.remove('can-pan');
  }
});
// If the window loses focus while Space is held, don't get stuck in pan mode.
window.addEventListener('blur', () => { spaceHeld = false; panesEl.classList.remove('can-pan'); });

// ---------- Start up: bring back the last board ----------

try {
  const saved = await autosave.loadState();
  if (saved?.board) {
    await loadBoard(saved.board, (item) => autosave.loadImage(String(item.id)));
    Object.assign(doc, { name: saved.name || 'Untitled board', handle: saved.handle || null, unsaved: !!saved.unsaved });
  }
} catch (err) {
  console.warn("Couldn't restore the last board", err);
}
updateTitle();
requestRender();

// Handy for testing from the browser console.
window.__refboard = { board, viewports, layout, addImages, saveStateNow, doc };
