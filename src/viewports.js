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

import { RenderTexture, Sprite, Matrix } from '../vendor/pixi.min.mjs';
import { GAP } from './layout.js';
import { Camera } from './camera.js';

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
  constructor({ app, board, layout, element, background, requestRender, onPaneAction, onLayoutChanged, createEditor }) {
    this.createEditor = createEditor;
    this.app = app;
    this.board = board;
    this.el = element;              // the HTML layer above the canvas
    this.background = background;   // board colour
    this.requestRender = requestRender;
    this.onPaneAction = onPaneAction;
    this.onLayoutChanged = onLayoutChanged;
    this.views = new Map();         // pane -> { el, zoomEl, texture, sprite }
    this.dividers = [];             // { split, el }
    this.matrix = new Matrix();
    this.setLayout(layout);
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
    // Tools such as image search are put in here.
    const host = document.createElement('div');
    host.className = 'pane-editor';
    el.append(host, tools, zoomEl);
    this.el.appendChild(el);

    const texture = RenderTexture.create({ width: 1, height: 1, resolution: this.app.renderer.resolution });
    const sprite = new Sprite(texture);
    this.app.stage.addChild(sprite);
    return { el, zoomEl, tools, host, texture, sprite, editor: null, editorType: 'board' };
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

  editorOf(pane) {
    return this.views.get(pane)?.editor || null;
  }

  _createDivider(split) {
    const el = document.createElement('div');
    el.className = `divider ${split.dir}`;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const move = (ev) => {
        this.layout.dragDivider(split, ev.clientX, ev.clientY);
        this.position();
        this.requestRender();
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this.onLayoutChanged();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    // Double-click a divider to make both sides equal again.
    el.addEventListener('dblclick', () => {
      split.ratio = 0.5;
      this.position();
      this.requestRender();
      this.onLayoutChanged();
    });
    this.el.appendChild(el);
    return { split, el };
  }

  // Lay everything out for the current window size.
  position() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.layout.computeRects(w, h);
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
  async snapshot(width = 480, height = 300) {
    const bounds = this.board.bounds();
    if (!bounds) return null;
    const cam = new Camera();
    cam.frame(bounds, width, height, 16);
    const texture = RenderTexture.create({ width, height, resolution: 1 });
    const selected = this.board.selected;
    this.board.selected = null;  // no blue outline in the preview
    this.board.drawOverlay(cam.zoom);
    this.matrix.set(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);
    this.app.renderer.render({ container: this.board.world, target: texture, clear: true, clearColor: this.background, transform: this.matrix });
    this.board.selected = selected;
    const canvas = this.app.renderer.extract.canvas(texture);
    texture.destroy(true);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
  }

  // Draw the board into every visible pane, then put the panes on screen.
  render() {
    const renderer = this.app.renderer;
    for (const pane of this.layout.visiblePanes()) {
      if (pane.type !== 'board') continue;
      const view = this.views.get(pane);
      const cam = pane.camera;
      this.board.drawOverlay(cam.zoom);
      this.matrix.set(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);
      renderer.render({ container: this.board.world, target: view.texture, clear: true, clearColor: this.background, transform: this.matrix });
      view.zoomEl.textContent = `${Math.round(cam.zoom * 100)}%`;
    }
    this.app.render();
  }
}
