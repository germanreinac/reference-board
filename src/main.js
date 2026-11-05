// Starts the app and connects the mouse, keyboard, drag-and-drop and paste to the board.

import { Application } from '../vendor/pixi.min.mjs';
import { Board } from './board.js';
import { Camera } from './camera.js';
import { imagesFromDrop, imagesFromPaste } from './importer.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
if (isMac) document.querySelectorAll('.mod-key').forEach((el) => (el.textContent = '⌘'));

// ---------- Set up the drawing surface ----------

const app = new Application();
await app.init({
  resizeTo: window,
  background: '#1b1b1d',
  antialias: true,
  autoDensity: true,                      // sharp on high-resolution screens
  resolution: window.devicePixelRatio || 1,
  autoStart: false,                       // only redraw when something changes (saves battery)
  preference: 'webgl',
});
document.getElementById('stage').appendChild(app.canvas);
const canvas = app.canvas;

const board = new Board();
const camera = new Camera();
app.stage.addChild(board.world);

// Center the board's origin in the window to start with.
camera.x = window.innerWidth / 2;
camera.y = window.innerHeight / 2;

// ---------- Redrawing ----------

// Instead of redrawing 60 times a second all the time, we ask for one redraw
// whenever something changes. Several requests in the same frame become one.
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    camera.applyTo(board.world);
    board.drawOverlay(camera.zoom);
    app.render();
    zoomReadout.textContent = `${Math.round(camera.zoom * 100)}%`;
    emptyHint.classList.toggle('hidden', board.items.length > 0);
  });
}
window.addEventListener('resize', requestRender);

const zoomReadout = document.getElementById('zoom-readout');
const emptyHint = document.getElementById('empty-hint');

// ---------- Messages ----------

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

// ---------- Adding images ----------

// Decode images and place them side by side, starting at a board position.
async function addImages(list, wx, wy) {
  const wasEmpty = board.items.length === 0;
  const GAP = 20;
  const added = [];
  // Decode all images at once. createImageBitmap does the heavy work off the
  // main thread, so the app stays responsive while big files load.
  const decoded = await Promise.all(
    list.map(async (entry) => {
      try {
        return { entry, bitmap: await createImageBitmap(entry.blob) };
      } catch {
        toast(`Couldn't read "${entry.name}". The file may be damaged or in an unsupported format.`);
        return null;
      }
    }),
  );
  const ok = decoded.filter(Boolean);
  // Lay them out in a row, centred on the drop point.
  const totalWidth = ok.reduce((sum, d) => sum + d.bitmap.width, 0) + GAP * (ok.length - 1);
  let x = wx - totalWidth / 2;
  for (const { entry, bitmap } of ok) {
    const item = board.addImage(bitmap, x + bitmap.width / 2, wy, entry);
    x += bitmap.width + GAP;
    added.push(item);
  }
  if (added.length) {
    board.selected = added[added.length - 1];
    // On an empty board, zoom so the first images fit nicely in the window.
    if (wasEmpty) camera.frame(board.bounds(), window.innerWidth, window.innerHeight, 60);
  }
  requestRender();
}

// Drag and drop
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
  const at = camera.toWorld(e.clientX, e.clientY);
  try {
    const list = await imagesFromDrop(e.dataTransfer);
    if (list.length === 0) return toast('Nothing to add. Drop image files, or images from a web page.');
    await addImages(list, at.x, at.y);
  } catch (err) {
    toast(err.message);
  }
});

// Paste
window.addEventListener('paste', async (e) => {
  // Paste at the mouse position if it's over the window, otherwise in the middle.
  const at = camera.toWorld(mouse.x ?? window.innerWidth / 2, mouse.y ?? window.innerHeight / 2);
  try {
    const list = await imagesFromPaste(e.clipboardData);
    if (list.length === 0) return toast('There is no image on the clipboard.');
    await addImages(list, at.x, at.y);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Mouse and pen ----------

const mouse = { x: null, y: null };
let spaceHeld = false;
let drag = null; // what the current drag is doing: { kind: 'pan' } or { kind: 'move', item, offsetX, offsetY }

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  mouse.x = e.clientX; mouse.y = e.clientY;

  // Middle button, or Space + left button, always pans.
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    drag = { kind: 'pan' };
  } else if (e.button === 0) {
    const w = camera.toWorld(e.clientX, e.clientY);
    const hit = board.hitTest(w.x, w.y);
    if (hit) {
      // Clicked an image: select it, raise it to the top and start moving it.
      board.selected = hit;
      board.bringToFront(hit);
      drag = { kind: 'move', item: hit, offsetX: w.x - hit.sprite.x, offsetY: w.y - hit.sprite.y };
    } else {
      // Clicked empty space: deselect and pan.
      board.selected = null;
      drag = { kind: 'pan' };
    }
  }
  canvas.classList.toggle('panning', drag?.kind === 'pan');
  requestRender();
});

canvas.addEventListener('pointermove', (e) => {
  const dx = e.clientX - (mouse.x ?? e.clientX);
  const dy = e.clientY - (mouse.y ?? e.clientY);
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (!drag) return;
  if (drag.kind === 'pan') {
    camera.panBy(dx, dy);
  } else if (drag.kind === 'move') {
    const w = camera.toWorld(e.clientX, e.clientY);
    drag.item.sprite.position.set(w.x - drag.offsetX, w.y - drag.offsetY);
  }
  requestRender();
});

function endDrag() {
  drag = null;
  canvas.classList.remove('panning');
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { if (!drag) { mouse.x = null; mouse.y = null; } });

// Stop the middle button from starting Chrome's auto-scroll.
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

// Scroll wheel / trackpad: zoom towards the mouse.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 16;   // some mice report "lines" instead of pixels
  // Trackpad pinch arrives as a wheel event with Ctrl held; it needs a stronger factor.
  const speed = e.ctrlKey ? 0.01 : 0.0015;
  camera.zoomAt(e.clientX, e.clientY, Math.exp(-delta * speed));
  requestRender();
}, { passive: false });

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;

  if (e.code === 'Space') {
    spaceHeld = true;
    canvas.classList.add('can-pan');
    e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (board.selected) {
      board.remove(board.selected);
      requestRender();
    }
  } else if (e.key === 'f' || e.key === 'F') {
    // Fit the selected image, or everything if nothing is selected.
    const target = board.selected ? [board.selected] : board.items;
    camera.frame(board.bounds(target), window.innerWidth, window.innerHeight, 60);
    requestRender();
  } else if (e.key === '1' && !e.metaKey && !e.ctrlKey) {
    // Back to 100% (actual pixels), around the middle of the window.
    camera.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / camera.zoom);
    requestRender();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false;
    canvas.classList.remove('can-pan');
  }
});
// If the window loses focus while Space is held, don't get stuck in pan mode.
window.addEventListener('blur', () => { spaceHeld = false; canvas.classList.remove('can-pan'); });

requestRender();

// Handy for testing from the browser console.
window.__refboard = { board, camera, addImages, requestRender };
