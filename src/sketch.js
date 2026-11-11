// Advanced drawing: proper drawing tools, used right where the sketch sits on the
// board (no separate screen). The board keeps working around it: scroll to zoom, Space or
// middle-drag to move, and everything else stays in view.
//
//   Brushes   Pencil, Ink, Marker, Soft brush and Eraser, with pen pressure and smoothing
//   Layers    add, hide, reorder, see-through, merge
//   Colour    any colour, recent colours, and the eyedropper (I, or hold Alt)
//   Undo      Ctrl/⌘+Z and Ctrl/⌘+Shift+Z
//
// openSketch({ width, height, layers, paper, title, host, reference }) resolves with
//   { blob, layers, paper, width, height } when you press Done, or null if you cancel.
// `host` places the sheet on screen:
//   rect()            the board pane, in screen pixels { x, y, w, h }
//   matrix()          a DOMMatrix from sheet pixels to pane pixels (follows the board's zoom)
//   zoomAt(x, y, f)   panBy(dx, dy)   fit()     move the board's view
// `reference` (a picture the sheet is painted over) is only used by the eyedropper: the
// board shows it underneath anyway.

const BRUSHES = {
  pencil: { label: 'Pencil', key: 'P', size: 4, hardness: 0.85, flow: 0.55, spacing: 0.18, sizePressure: 0.5, flowPressure: 0.8, grain: 0.35, wash: false },
  ink: { label: 'Ink', key: 'N', size: 6, hardness: 1, flow: 1, spacing: 0.08, sizePressure: 0.85, flowPressure: 0, grain: 0, wash: true },
  marker: { label: 'Marker', key: 'M', size: 24, hardness: 0.75, flow: 1, spacing: 0.08, sizePressure: 0.15, flowPressure: 0, grain: 0, wash: true, opacity: 0.55 },
  soft: { label: 'Soft brush', key: 'S', size: 60, hardness: 0, flow: 0.12, spacing: 0.12, sizePressure: 0.3, flowPressure: 1, grain: 0, wash: false },
  eraser: { label: 'Eraser', key: 'E', size: 30, hardness: 0.8, flow: 1, spacing: 0.1, sizePressure: 0.4, flowPressure: 0, grain: 0, wash: false, erase: true },
};

const ICONS = {
  pencil: '<svg viewBox="0 0 16 16"><path d="M11 2.5l2.5 2.5-8 8-3.2.7.7-3.2z"/><path d="M9.5 4l2.5 2.5"/></svg>',
  ink: '<svg viewBox="0 0 16 16"><path d="M8 1.5l3 5.5-3 7.5-3-7.5z"/><circle cx="8" cy="8" r="1"/></svg>',
  marker: '<svg viewBox="0 0 16 16"><path d="M10 2l4 4-6.5 6.5H3.5v-4z"/><path d="M3 14.5h10" stroke-width="2.4" opacity=".5"/></svg>',
  soft: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" stroke-dasharray="1.6 1.6"/><circle cx="8" cy="8" r="2.5" fill="currentColor" opacity=".45" stroke="none"/></svg>',
  eraser: '<svg viewBox="0 0 16 16"><path d="M9.5 2.8l3.7 3.7-6.3 6.3H4.2L2.5 11.1z M6.2 6.1l3.7 3.7 M7 12.8h6.5"/></svg>',
  picker: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5a1.6 1.6 0 012.3 0l.7.7a1.6 1.6 0 010 2.3L12 7l-3-3z"/><path d="M9 4L3 10v3h3l6-6"/></svg>',
  hand: '<svg viewBox="0 0 16 16"><path d="M5.5 8V3.8a1 1 0 012 0V7.5M7.5 7V3a1 1 0 012 0v4M9.5 7V3.6a1 1 0 012 0V8.5M11.5 6.5a1 1 0 012 0V10a4.5 4.5 0 01-4.5 4.5H8.6a4.5 4.5 0 01-3.5-1.7L2.8 10a1.1 1.1 0 011.7-1.4l1 1.1"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M5.5 4L2.5 7l3 3M3 7h7a3.5 3.5 0 010 7H8"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="M10.5 4l3 3-3 3M13 7H6a3.5 3.5 0 000 7h2"/></svg>',
  rotL: '<svg viewBox="0 0 16 16"><path d="M3 6.5A5.5 5.5 0 1 1 3.5 11"/><path d="M2.5 2.5v4h4"/></svg>',
  rotR: '<svg viewBox="0 0 16 16"><path d="M13 6.5A5.5 5.5 0 1 0 12.5 11"/><path d="M13.5 2.5v4h-4"/></svg>',
  fit: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
  eye: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg>',
  up: '<svg viewBox="0 0 16 16"><path d="M4 9.5l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="M4 6.5l4 4 4-4"/></svg>',
  merge: '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10"/></svg>',
};

const STORE = 'refboard.sketch';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch {} };

let current = null;   // the open studio (one at a time)
export const sketchOpen = () => !!current;

// The board moved (zoom, pan, window size): put the sheet back in step with it.
export function refreshSketch() {
  if (current) { current.resize(); current.draw(); }
}

export function openSketch(options) {
  if (current) return Promise.resolve(null);
  return new Promise((resolve) => { current = new Studio(options, resolve); });
}

const makeCanvas = (w, h) => {
  const c = new OffscreenCanvas(w, h);
  return c;
};

class Studio {
  constructor({ width, height, reference = null, layers = null, paper = '#ffffff', title = 'Sketch', host }, resolve) {
    this.host = host;
    this.W = width;
    this.H = height;
    this.resolve = resolve;
    this.paper = paper;
    this.prefs = { brush: 'pencil', color: '#1b1b1d', sizes: {}, opacity: {}, smoothing: 0.45, recent: [], ...loadPrefs() };
    this.layers = [];
    this.active = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.changed = false;
    this.reference = null;
    this.refShown = true;
    this.buildUI(title);
    this.setup(layers, reference).then(() => this.draw());
  }

  async setup(saved, reference) {
    if (reference) {
      try {
        this.reference = await createImageBitmap(reference, { resizeWidth: this.W, resizeHeight: this.H, resizeQuality: 'high' });
        this.refShown = false;
      } catch { this.reference = null; }
    }
    if (saved?.length) {
      for (const l of saved) {
        const layer = this.newLayer(l.name);
        layer.visible = l.visible !== false;
        layer.opacity = l.opacity ?? 1;
        if (l.blob) {
          try { layer.ctx.drawImage(await createImageBitmap(l.blob), 0, 0, this.W, this.H); } catch {}
        }
        this.layers.push(layer);
      }
      this.active = this.layers.length - 1;
    } else {
      this.layers.push(this.newLayer('Layer 1'));
    }
    this.renderLayers();
    this.draw();
  }

  newLayer(name) {
    const canvas = makeCanvas(this.W, this.H);
    return { name, canvas, ctx: canvas.getContext('2d', { willReadFrequently: false }), visible: true, opacity: 1 };
  }

  // ---------- The screen ----------

  buildUI(title) {
    const el = document.createElement('div');
    el.className = 'sketch';
    el.innerHTML = `
      <div class="sketch-top">
        <span class="sketch-title"></span>
        <div class="sketch-group">
          <label title="Size ([ and ])">Size <input type="range" data-k="size" min="1" max="400"><output data-o="size"></output></label>
          <label title="How see-through the strokes are">Opacity <input type="range" data-k="opacity" min="5" max="100"><output data-o="opacity"></output></label>
          <label title="Smoothing: steadier lines (the line trails the pen a little)">Smoothing <input type="range" data-k="smoothing" min="0" max="90"><output data-o="smoothing"></output></label>
        </div>
        <div class="sketch-group">
          <button data-a="undo" title="Undo (Ctrl/⌘+Z)">${ICONS.undo}</button>
          <button data-a="redo" title="Redo (Ctrl/⌘+Shift+Z)">${ICONS.redo}</button>
          <button data-a="fit" title="Zoom to the sheet (0)">${ICONS.fit}</button>
        </div>
        <div class="sketch-group end">
          <button class="text" data-a="cancel" title="Close without saving (Esc)">Cancel</button>
          <button class="text primary" data-a="done" title="Keep the drawing (Ctrl/⌘+Enter)">Done</button>
        </div>
      </div>
      <div class="sketch-left"></div>
      <div class="sketch-stage"><canvas></canvas><div class="sketch-cursor"></div></div>
      <div class="sketch-right">
        <div class="sketch-colour">
          <input type="color" title="Colour">
          <div class="sketch-recent"></div>
        </div>
        <div class="sketch-layers-head">
          <span>Layers</span>
          <button data-a="addLayer" title="New layer">${ICONS.plus}</button>
        </div>
        <div class="sketch-layers"></div>
        <div class="sketch-layer-tools">
          <label title="How see-through this layer is">Layer <input type="range" data-k="layerOpacity" min="0" max="100"></label>
          <button data-a="layerUp" title="Move layer up">${ICONS.up}</button>
          <button data-a="layerDown" title="Move layer down">${ICONS.down}</button>
          <button data-a="merge" title="Merge into the layer below">${ICONS.merge}</button>
          <button data-a="deleteLayer" title="Delete layer">${ICONS.trash}</button>
        </div>
        <div class="sketch-under"></div>
      </div>`;
    document.body.appendChild(el);
    document.body.classList.add('sketching');
    this.el = el;
    el.querySelector('.sketch-title').textContent = title;
    this.stage = el.querySelector('.sketch-stage');
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cursor = el.querySelector('.sketch-cursor');

    // Tools down the left.
    const left = el.querySelector('.sketch-left');
    this.toolButtons = {};
    for (const [id, b] of Object.entries(BRUSHES)) {
      const btn = document.createElement('button');
      btn.innerHTML = ICONS[id];
      btn.title = `${b.label} (${b.key})`;
      btn.addEventListener('click', () => this.setBrush(id));
      left.appendChild(btn);
      this.toolButtons[id] = btn;
    }
    left.appendChild(Object.assign(document.createElement('hr')));
    for (const [id, label] of [['picker', 'Eyedropper (I, or hold Alt)'], ['hand', 'Move the canvas (H, or hold Space)']]) {
      const btn = document.createElement('button');
      btn.innerHTML = ICONS[id];
      btn.title = label;
      btn.addEventListener('click', () => this.setBrush(id));
      left.appendChild(btn);
      this.toolButtons[id] = btn;
    }

    // Sliders.
    this.inputs = Object.fromEntries([...el.querySelectorAll('input[data-k]')].map((i) => [i.dataset.k, i]));
    this.inputs.size.addEventListener('input', () => { this.prefs.sizes[this.prefs.brush] = Number(this.inputs.size.value); this.syncControls(); });
    this.inputs.opacity.addEventListener('input', () => { this.prefs.opacity[this.prefs.brush] = Number(this.inputs.opacity.value) / 100; this.syncControls(); });
    this.inputs.smoothing.addEventListener('input', () => { this.prefs.smoothing = Number(this.inputs.smoothing.value) / 100; this.syncControls(); });
    this.inputs.layerOpacity.addEventListener('input', () => { const l = this.layers[this.active]; if (l) { l.opacity = Number(this.inputs.layerOpacity.value) / 100; this.changed = true; this.draw(); } });
    this.inputs.layerOpacity.addEventListener('change', () => this.renderLayers());

    // Colour.
    this.colourInput = el.querySelector('.sketch-colour input');
    this.colourInput.addEventListener('input', () => this.setColour(this.colourInput.value, false));
    this.colourInput.addEventListener('change', () => this.setColour(this.colourInput.value));

    // Buttons.
    const actions = {
      undo: () => this.undo(), redo: () => this.redo(),
      fit: () => this.host.fit(),
      cancel: () => this.close(false), done: () => this.close(true),
      addLayer: () => this.addLayer(), deleteLayer: () => this.deleteLayer(),
      layerUp: () => this.moveLayer(1), layerDown: () => this.moveLayer(-1), merge: () => this.mergeDown(),
    };
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a && actions[a]) actions[a]();
    });

    // Drawing and moving around.
    this.stage.addEventListener('pointerdown', (e) => this.down(e));
    this.stage.addEventListener('pointermove', (e) => this.move(e));
    this.stage.addEventListener('pointerup', (e) => this.up(e));
    this.stage.addEventListener('pointercancel', (e) => this.up(e));
    this.stage.addEventListener('pointerleave', () => { this.cursor.style.display = 'none'; });
    this.stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.stage.addEventListener('contextmenu', (e) => e.preventDefault());
    this.onKey = (e) => this.key(e);
    this.onKeyUp = (e) => { if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); } if (e.key === 'Alt') { this.altDown = false; this.updateCursor(); } };
    this.onResize = () => setTimeout(() => { this.resize(); this.draw(); }, 50);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.setBrush(this.prefs.brush in BRUSHES ? this.prefs.brush : 'pencil');
    this.setColour(this.prefs.color, false);
    this.renderRecent();
  }

  // The studio covers the board pane the sheet is in; the board stays visible through it.
  resize() {
    const r = this.host.rect();
    Object.assign(this.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.w * dpr), h = Math.round(r.h * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${r.w}px`;
    this.canvas.style.height = `${r.h}px`;
    this.dpr = dpr;
    this.updateCursor();
  }

  // Sheet pixels <-> pane pixels.
  get matrix() { return this.host.matrix(); }
  get scale() { const m = this.matrix; return Math.hypot(m.a, m.b); }
  toCanvas(sx, sy) {
    const p = this.matrix.inverse().transformPoint({ x: sx, y: sy });
    return { x: p.x, y: p.y };
  }

  // ---------- Tools and settings ----------

  get brush() { return BRUSHES[this.prefs.brush] || BRUSHES.pencil; }
  get size() { return this.prefs.sizes[this.prefs.brush] ?? this.brush.size; }
  get opacity() { return this.prefs.opacity[this.prefs.brush] ?? this.brush.opacity ?? 1; }

  setBrush(id) {
    if (id === 'picker' || id === 'hand') this.mode = id;
    else { this.mode = 'paint'; this.prefs.brush = id; }
    for (const [k, b] of Object.entries(this.toolButtons)) b.classList.toggle('on', k === (this.mode === 'paint' ? this.prefs.brush : this.mode));
    this.syncControls();
  }

  syncControls() {
    this.inputs.size.value = this.size;
    this.inputs.opacity.value = Math.round(this.opacity * 100);
    this.inputs.smoothing.value = Math.round(this.prefs.smoothing * 100);
    this.el.querySelector('[data-o="size"]').textContent = `${this.size}`;
    this.el.querySelector('[data-o="opacity"]').textContent = `${Math.round(this.opacity * 100)}%`;
    this.el.querySelector('[data-o="smoothing"]').textContent = `${Math.round(this.prefs.smoothing * 100)}%`;
    savePrefs(this.prefs);
    this.updateCursor();
  }

  setColour(c, remember = true) {
    this.prefs.color = c;
    this.colourInput.value = c;
    if (remember) {
      this.prefs.recent = [c, ...this.prefs.recent.filter((x) => x !== c)].slice(0, 12);
      this.renderRecent();
    }
    savePrefs(this.prefs);
    this.stamp = null;
  }

  renderRecent() {
    const box = this.el.querySelector('.sketch-recent');
    box.replaceChildren();
    for (const c of ['#1b1b1d', '#ffffff', ...this.prefs.recent.filter((x) => x !== '#1b1b1d' && x !== '#ffffff')].slice(0, 14)) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.setProperty('--c', c);
      b.title = c;
      b.addEventListener('click', () => this.setColour(c));
      box.appendChild(b);
    }
  }

  updateCursor() {
    const hand = this.mode === 'hand' || this.spaceDown;
    const picker = this.mode === 'picker' || this.altDown;
    this.stage.style.cursor = hand ? (this.panning ? 'grabbing' : 'grab') : picker ? 'crosshair' : 'none';
    this.cursor.hidden = hand || picker;
    const d = Math.max(4, this.size * this.scale);
    Object.assign(this.cursor.style, { width: `${d}px`, height: `${d}px` });
  }

  // ---------- Layers ----------

  renderLayers() {
    const box = this.el.querySelector('.sketch-layers');
    box.replaceChildren();
    // Top layer first, like other drawing apps.
    [...this.layers].reverse().forEach((l) => {
      const i = this.layers.indexOf(l);
      const row = document.createElement('div');
      row.className = `sketch-layer${i === this.active ? ' on' : ''}${l.visible ? '' : ' hidden-layer'}`;
      const eye = document.createElement('button');
      eye.innerHTML = ICONS.eye;
      eye.title = l.visible ? 'Hide' : 'Show';
      eye.addEventListener('click', (e) => { e.stopPropagation(); l.visible = !l.visible; this.changed = true; this.renderLayers(); this.draw(); });
      const thumb = document.createElement('canvas');
      thumb.width = 44; thumb.height = Math.max(8, Math.round(44 * this.H / this.W));
      thumb.getContext('2d').drawImage(l.canvas, 0, 0, thumb.width, thumb.height);
      const name = document.createElement('span');
      name.textContent = l.name;
      name.title = 'Double-click to rename';
      name.addEventListener('dblclick', () => {
        const v = prompt('Layer name:', l.name)?.trim();
        if (v) { l.name = v; this.renderLayers(); }
      });
      const pct = document.createElement('small');
      pct.textContent = l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '';
      row.append(eye, thumb, name, pct);
      row.addEventListener('click', () => { this.active = i; this.renderLayers(); });
      box.appendChild(row);
    });
    const l = this.layers[this.active];
    if (l) this.inputs.layerOpacity.value = Math.round(l.opacity * 100);
    // What's underneath: the paper colour and the reference picture.
    const under = this.el.querySelector('.sketch-under');
    under.replaceChildren();
    const p = document.createElement('label');
    p.innerHTML = '<input type="checkbox"> Paper <input type="color">';
    const [check, col] = p.querySelectorAll('input');
    check.checked = !!this.paper;
    col.value = this.paper || '#ffffff';
    check.addEventListener('change', () => { this.paper = check.checked ? col.value : null; this.changed = true; this.draw(); });
    col.addEventListener('input', () => { if (check.checked) { this.paper = col.value; this.changed = true; this.draw(); } });
    p.title = 'A background colour behind the drawing (off: see-through)';
    under.appendChild(p);
  }

  addLayer() {
    const layer = this.newLayer(`Layer ${this.layers.length + 1}`);
    const at = this.active + 1;
    this.layers.splice(at, 0, layer);
    this.active = at;
    this.pushUndo({ type: 'add', layer, at });
    this.renderLayers();
  }

  deleteLayer() {
    if (this.layers.length < 2) { this.layers[0].ctx.clearRect(0, 0, this.W, this.H); this.changed = true; this.draw(); this.renderLayers(); return; }
    const at = this.active;
    const [layer] = this.layers.splice(at, 1);
    this.active = Math.max(0, at - 1);
    this.pushUndo({ type: 'delete', layer, at });
    this.renderLayers();
    this.draw();
  }

  moveLayer(dir) {
    const to = this.active + dir;
    if (to < 0 || to >= this.layers.length) return;
    const [l] = this.layers.splice(this.active, 1);
    this.layers.splice(to, 0, l);
    this.pushUndo({ type: 'move', from: this.active, to });
    this.active = to;
    this.renderLayers();
    this.draw();
  }

  mergeDown() {
    if (this.active === 0) return;
    const top = this.layers[this.active], below = this.layers[this.active - 1];
    const before = this.snapshot(below);
    below.ctx.globalAlpha = top.visible ? top.opacity : 0;
    below.ctx.drawImage(top.canvas, 0, 0);
    below.ctx.globalAlpha = 1;
    const at = this.active;
    this.layers.splice(at, 1);
    this.active = at - 1;
    this.pushUndo({ type: 'merge', top, below, at, before });
    this.renderLayers();
    this.draw();
  }

  snapshot(layer) {
    const c = makeCanvas(this.W, this.H);
    c.getContext('2d').drawImage(layer.canvas, 0, 0);
    return c;
  }

  // ---------- Undo ----------

  pushUndo(step) {
    this.undoStack.push(step);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.changed = true;
  }

  undo() { this.step(this.undoStack, this.redoStack, true); }
  redo() { this.step(this.redoStack, this.undoStack, false); }

  step(from, to, back) {
    const s = from.pop();
    if (!s) return;
    if (s.type === 'paint') {
      s.layer.ctx.putImageData(back ? s.before : s.after, s.x, s.y);
    } else if (s.type === 'add') {
      if (back) this.layers.splice(this.layers.indexOf(s.layer), 1); else this.layers.splice(s.at, 0, s.layer);
    } else if (s.type === 'delete') {
      if (back) this.layers.splice(s.at, 0, s.layer); else this.layers.splice(this.layers.indexOf(s.layer), 1);
    } else if (s.type === 'move') {
      const [a, b] = back ? [s.to, s.from] : [s.from, s.to];
      const [l] = this.layers.splice(a, 1);
      this.layers.splice(b, 0, l);
    } else if (s.type === 'merge') {
      if (back) {
        const now = this.snapshot(s.below);
        s.below.ctx.clearRect(0, 0, this.W, this.H);
        s.below.ctx.drawImage(s.before, 0, 0);
        s.after = now;
        this.layers.splice(s.at, 0, s.top);
      } else {
        s.below.ctx.clearRect(0, 0, this.W, this.H);
        s.below.ctx.drawImage(s.after, 0, 0);
        this.layers.splice(this.layers.indexOf(s.top), 1);
      }
    }
    to.push(s);
    this.active = Math.min(this.active, this.layers.length - 1);
    this.changed = true;
    this.renderLayers();
    this.draw();
  }

  // ---------- Painting ----------

  // The brush tip: a round dab in the current colour, hard or soft, drawn once and stamped.
  dab() {
    const b = this.brush;
    const key = `${this.prefs.color}|${b.hardness}|${b.erase}`;
    if (this.stamp?.key === key) return this.stamp.canvas;
    const S = 128;
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    const col = b.erase ? '#000000' : this.prefs.color;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, col);
    grad.addColorStop(Math.min(0.98, Math.max(0, b.hardness)), col);
    grad.addColorStop(1, `${col}00`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    g.fill();
    this.stamp = { key, canvas: c };
    return c;
  }

  down(e) {
    if (e.button === 1 || e.button === 2 || this.mode === 'hand' || this.spaceDown) {
      this.panning = { x: e.clientX, y: e.clientY };
      try { this.stage.setPointerCapture(e.pointerId); } catch {}
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const p = this.local(e);
    if (this.mode === 'picker' || e.altKey) { this.pick(p); return; }
    const layer = this.layers[this.active];
    if (!layer) return;
    if (!layer.visible) { layer.visible = true; this.renderLayers(); }
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
    const b = this.brush;
    // Wash brushes (ink, marker) paint into a separate sheet first, so a stroke has one
    // even see-through look; the others build up as you go over them.
    this.stroke = {
      layer, b, last: null, smooth: null, left: 0, box: [Infinity, Infinity, -Infinity, -Infinity],
      before: this.snapshot(layer),
      target: b.wash ? makeCanvas(this.W, this.H) : layer.canvas,
      pen: e.pointerType === 'pen',
    };
    this.stroke.ctx = this.stroke.target.getContext('2d');
    this.addPoint(p, e.pressure);
    this.draw();
  }

  local(e) {
    const r = this.stage.getBoundingClientRect();
    return this.toCanvas(e.clientX - r.left, e.clientY - r.top);
  }

  move(e) {
    const r = this.stage.getBoundingClientRect();
    Object.assign(this.cursor.style, { display: '', left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px` });
    if (this.panning) {
      this.host.panBy(e.clientX - this.panning.x, e.clientY - this.panning.y);
      this.panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!this.stroke) return;
    const coalesced = e.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [e];
    for (const ev of events) this.addPoint(this.local(ev), ev.pressure);
    this.draw();
  }

  up() {
    if (this.panning) { this.panning = null; this.updateCursor(); return; }
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    if (s.b.wash) {
      // Put the finished stroke on the layer, at the brush's opacity.
      s.layer.ctx.globalAlpha = this.opacity;
      s.layer.ctx.drawImage(s.target, 0, 0);
      s.layer.ctx.globalAlpha = 1;
    }
    // Undo keeps just the area the stroke touched, before and after.
    const [x0, y0, x1, y1] = s.box.map((v, i) => (i < 2 ? Math.max(0, Math.floor(v)) : Math.min(i === 2 ? this.W : this.H, Math.ceil(v))));
    if (x1 > x0 && y1 > y0) {
      const w = x1 - x0, h = y1 - y0;
      const before = s.before.getContext('2d').getImageData(x0, y0, w, h);
      const after = s.layer.ctx.getImageData(x0, y0, w, h);
      this.pushUndo({ type: 'paint', layer: s.layer, x: x0, y: y0, before, after });
    }
    this.renderLayers();
    this.draw();
  }

  addPoint(raw, pressure) {
    const s = this.stroke;
    const b = s.b;
    // Pen pressure (a mouse has none: it draws at a steady middle pressure).
    const p = s.pen ? Math.max(0.02, pressure || 0) : 0.65;
    // Smoothing: the line follows the pen at a little distance, ironing out wobbles.
    const k = this.prefs.smoothing * 0.92;
    s.smooth = s.smooth ? { x: s.smooth.x + (raw.x - s.smooth.x) * (1 - k), y: s.smooth.y + (raw.y - s.smooth.y) * (1 - k), p: s.smooth.p + (p - s.smooth.p) * 0.5 } : { ...raw, p };
    const pt = s.smooth;
    const g = s.ctx;
    const tip = this.dab();
    const base = this.size;
    const stampAt = (x, y, pr) => {
      const size = Math.max(0.5, base * (1 - b.sizePressure + b.sizePressure * pr));
      let alpha = b.flow * (1 - b.flowPressure + b.flowPressure * pr);
      if (!b.wash && !b.erase) alpha *= this.opacity;
      if (b.grain) alpha *= 1 - b.grain * Math.random();
      g.globalAlpha = Math.min(1, alpha);
      g.globalCompositeOperation = b.erase ? 'destination-out' : 'source-over';
      g.drawImage(tip, x - size / 2, y - size / 2, size, size);
      const bx = s.box;
      bx[0] = Math.min(bx[0], x - size); bx[1] = Math.min(bx[1], y - size);
      bx[2] = Math.max(bx[2], x + size); bx[3] = Math.max(bx[3], y + size);
    };
    if (!s.last) {
      stampAt(pt.x, pt.y, pt.p);
    } else {
      // Dabs along the way, close enough together to read as a line.
      const dx = pt.x - s.last.x, dy = pt.y - s.last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(0.4, base * b.spacing);
      let t = s.left;
      while (t <= dist) {
        const u = dist ? t / dist : 0;
        stampAt(s.last.x + dx * u, s.last.y + dy * u, s.last.p + (pt.p - s.last.p) * u);
        t += step;
      }
      s.left = t - dist;
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    s.last = { ...pt };
  }

  // The eyedropper: the colour of everything visible at that point.
  pick(p) {
    const c = makeCanvas(1, 1).getContext('2d');
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    if (this.paper) { c.fillStyle = this.paper; c.fillRect(0, 0, 1, 1); }
    if (this.reference) c.drawImage(this.reference, x, y, 1, 1, 0, 0, 1, 1);
    for (const l of this.layers) {
      if (!l.visible) continue;
      c.globalAlpha = l.opacity;
      c.drawImage(l.canvas, x, y, 1, 1, 0, 0, 1, 1);
    }
    const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
    if (!a) return;
    this.setColour(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  }

  wheel(e) {
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;
    const f = Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015));
    this.host.zoomAt(sx, sy, f);
  }

  key(e) {
    if (e.target.closest?.('input[type="text"], textarea')) return;
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); this.spaceDown = true; this.updateCursor(); return; }
    if (e.key === 'Alt') { e.preventDefault(); this.altDown = true; this.updateCursor(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); this.close(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); this.close(false); return; }
    if (mod) return;
    const k = e.key.toLowerCase();
    if (e.key === '[' || e.key === ']') {
      const s = this.size;
      this.prefs.sizes[this.prefs.brush] = Math.max(1, Math.min(400, Math.round(e.key === '[' ? s / 1.2 : s * 1.2 + 0.5)));
      this.syncControls();
      return;
    }
    if (k === '0') { this.host.fit(); return; }
    if (k === 'i') { this.setBrush('picker'); return; }
    if (k === 'h') { this.setBrush('hand'); return; }
    if (k === 'b') { this.setBrush(this.prefs.brush === 'eraser' ? 'pencil' : this.prefs.brush); return; }
    for (const [id, b] of Object.entries(BRUSHES)) if (k === b.key.toLowerCase()) { this.setBrush(id); return; }
  }

  // ---------- Drawing it on screen ----------

  draw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      const g = this.ctx;
      const m = this.matrix;
      const zoom = this.scale;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
      g.setTransform(this.dpr * m.a, this.dpr * m.b, this.dpr * m.c, this.dpr * m.d, this.dpr * m.e, this.dpr * m.f);
      g.imageSmoothingQuality = 'high';
      g.imageSmoothingEnabled = zoom < 2;
      if (this.paper) {
        g.fillStyle = this.paper;
        g.fillRect(0, 0, this.W, this.H);
      }
      for (const l of this.layers) {
        if (!l.visible) continue;
        const s = this.stroke;
        if (s?.b.wash && s.layer === l) {
          // The stroke in progress, shown as it will look once it's put down.
          const tmp = this.tmp ||= makeCanvas(this.W, this.H);
          const t = tmp.getContext('2d');
          t.clearRect(0, 0, this.W, this.H);
          t.drawImage(l.canvas, 0, 0);
          t.globalAlpha = this.opacity;
          t.drawImage(s.target, 0, 0);
          t.globalAlpha = 1;
          g.globalAlpha = l.opacity;
          g.drawImage(tmp, 0, 0);
        } else {
          g.globalAlpha = l.opacity;
          g.drawImage(l.canvas, 0, 0);
        }
        g.globalAlpha = 1;
      }
      // The edge of the sheet, so you can see where you can paint.
      g.lineWidth = 1.5 / zoom;
      g.setLineDash([6 / zoom, 5 / zoom]);
      g.strokeStyle = 'rgba(127, 127, 127, 0.9)';
      g.strokeRect(0, 0, this.W, this.H);
      g.setLineDash([]);
    });
  }

  checkerTile() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16);
    return c;
  }

  // ---------- Finishing ----------

  async close(save) {
    if (this.closing) return;
    if (!save && this.changed && !confirm('Close without keeping your changes?')) return;
    this.closing = true;
    let result = null;
    if (save) {
      const flat = makeCanvas(this.W, this.H);
      const g = flat.getContext('2d');
      if (this.paper) { g.fillStyle = this.paper; g.fillRect(0, 0, this.W, this.H); }
      for (const l of this.layers) {
        if (!l.visible) continue;
        g.globalAlpha = l.opacity;
        g.drawImage(l.canvas, 0, 0);
      }
      g.globalAlpha = 1;
      const blob = await flat.convertToBlob({ type: 'image/png' });
      const layers = await Promise.all(this.layers.map(async (l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blob: await l.canvas.convertToBlob({ type: 'image/png' }) })));
      result = { blob, layers, paper: this.paper, width: this.W, height: this.H };
    }
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
    document.body.classList.remove('sketching');
    this.reference?.close?.();
    current = null;
    this.resolve(result);
  }
}
