// Shows the board in every pane of the layout.
//
// How it works: each pane gets its own off-screen picture (a "render texture").
// Every frame, the board is drawn once into each pane's picture through that
// pane's camera, and then the pictures are placed side by side on screen.
// Images live on the graphics card only once, however many panes show them.
//
// On top of the canvas sit plain HTML boxes, one per pane (they catch the mouse
// and hold the small pane buttons), plus the draggable dividers.
//
// A pane can also show a tool instead of the board (image search, the 3D
// mannequin). Those tools live inside the pane's HTML box; see src/editors.js.

import { RenderTexture, Sprite, Matrix, TilingSprite, Texture } from '../vendor/pixi.min.mjs';
import { GAP } from './layout.js';
import { Camera } from './camera.js';
import { paneOutline, ripple, rippling, spring, motionOn } from './liquid.js';

const ICONS = {
  'split-row': '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>',
  'split-col': '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 8h13"/></svg>',
  maximize: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5l4.5-4.5"/></svg>',
  restore: '<svg viewBox="0 0 16 16"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4.5-4.5M6.5 9.5l-4.5 4.5"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

// Icons for what a pane shows (the first pane button).
export const TYPE_ICONS = {
  board: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="7" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/></svg>',
  mannequin: '<svg viewBox="0 0 16 16"><circle cx="8" cy="3" r="1.7"/><path d="M8 5v5M8 6.5l-3.5 2M8 6.5l3.5 2M8 10l-2.5 4.5M8 10l2.5 4.5"/></svg>',
};
export const TYPE_NAMES = { board: 'Board', search: 'Image search', mannequin: '3D mannequin' };

const TOOL_TITLES = {
  type: 'What this pane shows',
  'split-row': 'Split side by side (Alt+V)',
  'split-col': 'Split top and bottom (Alt+H)',
  maximize: 'Maximize / restore (Ctrl+Space)',
  close: 'Close pane (Alt+W)',
};

export class Viewports {
  // createEditor(pane, hostElement) makes the tool shown in a non-board pane.
  // boardOf(pane) is the board a pane shows (panes can show different boards);
  // paneLabel(pane) is { text, active } for the little name label, or null.
  constructor({ app, board, boardOf, paneLabel, layout, element, background, requestRender, onPaneAction, onLayoutChanged, createEditor }) {
    this.createEditor = createEditor;
    this.app = app;
    this.board = board;
    this.boardOf = boardOf || (() => this.board);
    this.paneLabel = paneLabel || (() => null);
    this.el = element;              // the HTML layer above the canvas
    this.background = background;   // board colour
    this.dots = makeDots();         // the dotted background, drawn behind the board in each pane
    this.dotColour = '#3a3a40';
    this.requestRender = requestRender;
    this.onPaneAction = onPaneAction;
    this.onLayoutChanged = onLayoutChanged;
    this.views = new Map();         // pane -> { el, zoomEl, texture, sprite }
    this.dividers = [];             // { split, el }
    this.matrix = new Matrix();
    // The space between panes, drawn over everything as one shape with a soft-cornered
    // hole for each pane. Its edges move like a liquid (see src/liquid.js).
    this.edges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.edges.classList.add('pane-edges');
    this.edgePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.edgePath.setAttribute('fill-rule', 'evenodd');
    // A drop of liquid where gaps cross, like mercury pooling.
    this.dropPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.edges.append(this.edgePath, this.dropPath);
    this.springs = 0;    // springs moving dividers right now
    this.junctions = []; // handles where dividers meet: drag one to move them all
    this.setLayout(layout);
    this._flow();
  }

  setLayout(layout) {
    this.layout = layout;
    this.rebuild();
  }

  // Recreate the pane boxes and dividers after a split, close or new layout.
  rebuild() {
    const panes = this.layout.panes();
    // Remove views for panes that no longer exist.
    for (const [pane, view] of this.views) {
      if (!panes.includes(pane)) {
        view.editor?.destroy();
        view.el.remove();
        view.sprite.destroy();
        view.texture.destroy(true);
        this.views.delete(pane);
      }
    }
    for (const pane of panes) if (!this.views.has(pane)) this.views.set(pane, this._createView(pane));
    for (const pane of panes) this._syncEditor(pane, this.views.get(pane));

    for (const d of this.dividers) d.el.remove();
    this.dividers = this.layout.splits().map((split) => this._createDivider(split));

    this.el.classList.toggle('single', panes.length === 1);
    this.el.appendChild(this.edges);  // always on top of the panes
    this.position();
  }

  _createView(pane) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.dataset.pane = pane.id;
    const tools = document.createElement('div');
    tools.className = 'pane-tools';
    for (const action of ['type', 'split-row', 'split-col', 'maximize', 'close']) {
      const b = document.createElement('button');
      b.dataset.action = action;
      b.title = TOOL_TITLES[action];
      b.innerHTML = ICONS[action] || '';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());  // don't pan when clicking a button
      b.addEventListener('click', (e) => { e.stopPropagation(); this.onPaneAction(action, pane, b); });
      tools.appendChild(b);
    }
    const zoomEl = document.createElement('div');
    zoomEl.className = 'pane-zoom';
    // Which board this pane shows, when there's more than one on screen. Click it to change.
    const label = document.createElement('button');
    label.className = 'pane-label';
    label.hidden = true;
    label.addEventListener('pointerdown', (e) => e.stopPropagation());
    label.addEventListener('click', (e) => { e.stopPropagation(); this.onPaneAction('board', pane, label); });
    // Tools such as image search are put in here.
    const host = document.createElement('div');
    host.className = 'pane-editor';
    el.append(host, tools, zoomEl, label);
    this.el.appendChild(el);

    const texture = RenderTexture.create({ width: 1, height: 1, resolution: this.app.renderer.resolution });
    const sprite = new Sprite(texture);
    this.app.stage.addChild(sprite);
    return { el, zoomEl, tools, host, label, texture, sprite, editor: null, editorType: 'board' };
  }

  // Make sure a pane shows the right thing: the board, or a tool.
  _syncEditor(pane, view) {
    view.el.dataset.type = pane.type;
    const typeButton = view.tools.querySelector('[data-action="type"]');
    typeButton.innerHTML = TYPE_ICONS[pane.type];
    typeButton.title = `Showing: ${TYPE_NAMES[pane.type]}. Click to change`;
    if (view.editorType === pane.type) return;
    view.editor?.destroy();
    view.editor = null;
    view.host.replaceChildren();
    view.editorType = pane.type;
    if (pane.type !== 'board') view.editor = this.createEditor(pane, view.host);
  }

  // Is this pane on either side of that split?
  _inside(node, pane) {
    if (node.type === 'pane') return node.pane === pane;
    return this._inside(node.a, pane) || this._inside(node.b, pane);
  }

  editorOf(pane) {
    return this.views.get(pane)?.editor || null;
  }

  _createDivider(split) {
    const el = document.createElement('div');
    el.className = `divider ${split.dir}`;
    el.addEventListener('pointerdown', (e) => this._dragSplits(e, el, [split]));
    // Double-click a divider to make both sides equal again.
    el.addEventListener('dblclick', () => {
      this.springSplit(split, split.ratio, 0.5, () => this.onLayoutChanged());
      const r = split.rect;
      ripple(r.x + r.w / 2, r.y + r.h / 2, 5);
    });
    this.el.appendChild(el);
    return { split, el };
  }

  // Drag one or more dividers with the mouse. The faster you move, the bigger the
  // ripples you leave behind.
  _dragSplits(e, el, splits) {
    if (e.button !== 0) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    let last = { x: e.clientX, y: e.clientY, t: performance.now() }, lastRipple = 0;
    const move = (ev) => {
      for (const split of splits) this.layout.dragDivider(split, ev.clientX, ev.clientY);
      const now = performance.now();
      const speed = Math.hypot(ev.clientX - last.x, ev.clientY - last.y) / Math.max(1, now - last.t) * 1000;
      last = { x: ev.clientX, y: ev.clientY, t: now };
      if (now - lastRipple > 70 && speed > 60) { ripple(ev.clientX, ev.clientY, Math.min(9, speed * 0.012)); lastRipple = now; }
      this.position();
      this.requestRender();
    };
    const up = (ev) => {
      el.classList.remove('dragging');
      ripple(ev.clientX, ev.clientY, 4);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.onLayoutChanged();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // Where dividers meet (a + or a T), a round handle moves all of them at once.
  _placeJunctions() {
    const boxes = this.layout.maximized ? [] : this.dividers.map(({ split, el }) => {
      const a = split.a.rect, r = split.rect;
      return split.dir === 'row'
        ? { split, x0: a.x + a.w, x1: a.x + a.w + GAP, y0: r.y, y1: r.y + r.h }
        : { split, x0: r.x, x1: r.x + r.w, y0: a.y + a.h, y1: a.y + a.h + GAP };
    });
    const touch = (b, x, y, pad) => x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
    const found = [];
    for (const v of boxes.filter((b) => b.split.dir === 'row')) {
      for (const h of boxes.filter((b) => b.split.dir === 'col')) {
        const x = (v.x0 + v.x1) / 2, y = (h.y0 + h.y1) / 2;
        if (!touch(v, x, y, 3) || !touch(h, x, y, 3)) continue;
        if (found.some((j) => Math.hypot(j.x - x, j.y - y) < 8)) continue;
        found.push({ x, y, splits: boxes.filter((b) => touch(b, x, y, 4)).map((b) => b.split) });
      }
    }
    while (this.junctions.length < found.length) {
      const el = document.createElement('div');
      el.className = 'junction';
      el.title = 'Drag to move these dividers together';
      const j = { el, splits: [] };
      el.addEventListener('pointerdown', (e) => this._dragSplits(e, el, j.splits));
      el.addEventListener('dblclick', () => { for (const sp of j.splits) this.springSplit(sp, sp.ratio, 0.5, () => this.onLayoutChanged()); ripple(j.x, j.y, 6); });
      this.junctions.push(j);
    }
    this.junctions.forEach((j, i) => {
      const f = found[i];
      if (!f) { j.el.remove(); return; }
      // While you're dragging one, keep the dividers it grabbed (they stay together).
      if (!j.el.classList.contains('dragging')) j.splits = f.splits;
      Object.assign(j, { x: f.x, y: f.y });
      j.el.style.left = `${f.x}px`;
      j.el.style.top = `${f.y}px`;
      if (j.el.parentNode !== this.el) this.el.appendChild(j.el);
    });
    this.junctions = this.junctions.filter((j, i) => found[i] || j.el.classList.contains('dragging'));
  }

  // Lay everything out for the current window size.
  position() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Panes start below the top bar.
    const top = document.getElementById('board-bar')?.offsetHeight || 0;
    this.layout.computeRects(w, h, top);
    const visible = new Set(this.layout.visiblePanes());
    const res = this.app.renderer.resolution;

    for (const [pane, view] of this.views) {
      const show = visible.has(pane);
      view.el.style.display = show ? '' : 'none';
      view.sprite.visible = show && pane.type === 'board';
      if (!show) continue;
      const r = pane.rect;
      Object.assign(view.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      view.editor?.layout?.(r);
      view.el.classList.toggle('narrow', r.w < 150 || r.h < 60);
      const lab = this.paneLabel(pane);
      view.label.hidden = !lab;
      if (lab) {
        view.label.textContent = lab.text;
        view.label.title = `Showing the board "${lab.text}"${lab.active ? ' (you\'re working on it)' : ''}. Click to show another board here`;
        view.label.classList.toggle('active', lab.active);
      }
      view.tools.querySelector('[data-action="maximize"]').innerHTML = this.layout.maximized ? ICONS.restore : ICONS.maximize;
      // Match the off-screen picture to the pane's size.
      const tw = Math.max(1, Math.round(r.w));
      const th = Math.max(1, Math.round(r.h));
      if (view.texture.width !== tw || view.texture.height !== th) {
        // Make a new picture at the new size. (Resizing the old one in place leaves
        // PixiJS drawing at the old size, which squashes the view.)
        const old = view.texture;
        view.texture = RenderTexture.create({ width: tw, height: th, resolution: res });
        view.sprite.texture = view.texture;
        old.destroy(true);
      }
      view.sprite.position.set(r.x, r.y);
    }

    for (const { split, el } of this.dividers) {
      el.style.display = this.layout.maximized ? 'none' : '';
      if (this.layout.maximized) continue;
      const a = split.a.rect;
      const r = split.rect;
      const box = split.dir === 'row'
        ? { left: a.x + a.w, top: r.y, width: GAP, height: r.h }
        : { left: r.x, top: a.y + a.h, width: r.w, height: GAP };
      for (const k in box) el.style[k] = `${box[k]}px`;
    }
    this._placeJunctions();
    this.drawEdges();
  }

  // ---------- Liquid edges ----------

  // Send ripples through the liquid edges: from the middle of these panes (or the window).
  wobble(amp = 5, panes = null) {
    const list = (panes || this.layout.visiblePanes()).filter((p) => p.rect);
    if (!list.length) return;
    const x0 = Math.min(...list.map((p) => p.rect.x)), x1 = Math.max(...list.map((p) => p.rect.x + p.rect.w));
    const y0 = Math.min(...list.map((p) => p.rect.y)), y1 = Math.max(...list.map((p) => p.rect.y + p.rect.h));
    ripple((x0 + x1) / 2, (y0 + y1) / 2, amp * 1.4);
  }

  // Still moving? (The app keeps redrawing the board while this is true. The liquid
  // edges have their own, much cheaper, loop below.)
  animating() {
    return this.springs > 0;
  }

  drawEdges(now = performance.now()) {
    const w = window.innerWidth, h = window.innerHeight;
    const t = motionOn() ? now / 1000 : 0;
    const parts = [`M-40 -40H${w + 40}V${h + 40}H-40Z`];
    for (const pane of this.layout.visiblePanes()) if (pane.rect) parts.push(paneOutline(pane.rect, t, now));
    this.edgePath.setAttribute('d', parts.join(''));
    const drops = this.junctions.filter((j) => j.el.isConnected).map((j, i) => {
      const r = (j.el.classList.contains('dragging') ? 13 : 9) + Math.sin(t * 1.7 + i) * 1.2;
      return `M${j.x - r} ${j.y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
    });
    this.dropPath.setAttribute('d', drops.join(''));
  }

  // The liquid keeps flowing slowly: redraw the edges about 20 times a second at rest,
  // and every frame while ripples are spreading. Only the outline is redrawn, not the board.
  _flow() {
    let last = 0;
    const tick = (now) => {
      requestAnimationFrame(tick);
      if (!motionOn() || document.body.dataset.mode !== 'board' || document.body.classList.contains('presenting')) return;
      const busy = rippling(now) || this.springs > 0;
      if (!busy && now - last < 50) return;
      last = now;
      this.drawEdges(now);
    };
    requestAnimationFrame(tick);
  }

  // Move a divider to a new ratio with a spring (it overshoots a little and settles).
  springSplit(split, from, to, onDone = () => {}) {
    this.springs++;
    split.ratio = from;
    spring(from, to, (v) => {
      split.ratio = Math.max(0.001, Math.min(0.999, v));
      this.position();
      this.requestRender();
    }, { onDone: () => { this.springs--; onDone(); } });
  }

  // Which pane is under this window position?
  paneAt(clientX, clientY) {
    for (const pane of this.layout.visiblePanes()) {
      const r = pane.rect;
      if (clientX >= r.x && clientX < r.x + r.w && clientY >= r.y && clientY < r.y + r.h) return pane;
    }
    return null;
  }

  paneFromElement(el) {
    const id = Number(el?.closest?.('.pane')?.dataset.pane);
    return this.layout.panes().find((p) => p.id === id) || null;
  }

  // A small picture of the whole board, for the home screen. Returns a Blob, or null if the board is empty.
  async snapshot(board = this.board, width = 480, height = 300) {
    const bounds = board.bounds();
    if (!bounds) return null;
    const cam = new Camera();
    cam.frame(bounds, width, height, 16);
    const texture = RenderTexture.create({ width, height, resolution: 1 });
    const selection = board.selection;
    board.selection = [];  // no blue outline in the preview
    board.drawOverlay(cam.zoom);
    this.matrix.set(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);
    this.app.renderer.render({ container: board.world, target: texture, clear: true, clearColor: this.background, transform: this.matrix });
    board.selection = selection;
    board.drawOverlay(cam.zoom);
    const canvas = this.app.renderer.extract.canvas(texture);
    texture.destroy(true);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
  }

  setColours({ board, dot }) {
    this.background = board;
    this.dotColour = dot;
  }

  // The dotted background: one dot every 24 board units, doubling or halving the spacing
  // as you zoom so the dots on screen always stay 17 to 34 pixels apart.
  drawDots(pane, target) {
    const cam = pane.camera;
    const level = Math.round(-Math.log2(cam.zoom));
    const spacing = 24 * 2 ** level * cam.zoom;    // on screen, in pixels
    const d = this.dots;
    d.width = pane.rect.w;
    d.height = pane.rect.h;
    d.tint = this.dotColour;
    d.alpha = this.hideDots ? 0 : 1;   // Present mode shows a plain background
    d.tileScale.set(spacing / DOT_CELL);
    // Keep the dots fixed to the board as you pan.
    d.tilePosition.set(cam.x % spacing, cam.y % spacing);
    this.app.renderer.render({ container: d, target, clear: true, clearColor: this.background });
  }

  // Draw the board into every visible pane, then put the panes on screen.
  render() {
    const renderer = this.app.renderer;
    for (const pane of this.layout.visiblePanes()) {
      if (pane.type !== 'board') continue;
      const view = this.views.get(pane);
      const cam = pane.camera;
      const board = this.boardOf(pane);
      board.drawOverlay(cam.zoom);
      this.drawDots(pane, view.texture);
      this.matrix.set(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);
      renderer.render({ container: board.world, target: view.texture, clear: false, transform: this.matrix });
      view.zoomEl.textContent = `${Math.round(cam.zoom * 100)}%`;
    }
    this.app.render();
  }
}

// One dot in the middle of a square tile, repeated across the pane.
const DOT_CELL = 64;
function makeDots() {
  const c = document.createElement('canvas');
  c.width = c.height = DOT_CELL;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(DOT_CELL / 2, DOT_CELL / 2, 2.4, 0, Math.PI * 2);  // small and subtle
  g.fill();
  return new TilingSprite({ texture: Texture.from(c), width: 1, height: 1 });
}
