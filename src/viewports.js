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

import { RenderTexture, Sprite, Matrix, TilingSprite, Texture, Graphics } from '../vendor/pixi.min.mjs';
import { GAP } from './layout.js';
import { Camera } from './camera.js';
import { paneOutline, paneOutlinePoints, BLEED, ripple, rippling, spring, motionOn, push } from './liquid.js';

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
    // The highlight on a divider you point at or drag: it follows the wavy gap.
    this.hoverPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.hoverPath.classList.add('divider-glow');
    this.edges.append(this.edgePath, this.dropPath, this.hoverPath);
    this.hoverSplit = null;
    this.springs = 0;    // springs moving dividers right now
    this.junctions = []; // handles where dividers meet: drag one to move them all
    // Stirring the dots: the mouse leaves a gentle wake in the dotted background.
    this.stirG = new Graphics();
    this.stirState = { pane: null, x: 0, y: 0, vx: 0, vy: 0, trail: [], last: 0, raf: 0 };
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
        view.mask.destroy();
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
    // The pane's picture is cut to its liquid outline, so the edge itself moves with the waves.
    const mask = new Graphics();
    this.app.stage.addChild(sprite, mask);
    sprite.mask = mask;
    return { el, zoomEl, tools, host, label, texture, sprite, mask, editor: null, editorType: 'board' };
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
    el.addEventListener('pointerenter', () => { this.hoverSplit = split; this.drawEdges(); });
    el.addEventListener('pointerleave', () => { if (!el.classList.contains('dragging')) { this.hoverSplit = null; this.drawEdges(); } });
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
      if (!el.matches(':hover')) { this.hoverSplit = null; this.drawEdges(); }
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
      // Drawn BLEED pixels past the pane's box on every side (under the gaps), so when a
      // wave pushes the edge outward there's board to show, not the end of the picture.
      const tw = Math.max(1, Math.round(r.w + BLEED * 2));
      const th = Math.max(1, Math.round(r.h + BLEED * 2));
      if (view.texture.width !== tw || view.texture.height !== th) {
        // Make a new picture at the new size. (Resizing the old one in place leaves
        // PixiJS drawing at the old size, which squashes the view.)
        const old = view.texture;
        view.texture = RenderTexture.create({ width: tw, height: th, resolution: res });
        view.sprite.texture = view.texture;
        old.destroy(true);
      }
      // On whole screen pixels: a picture placed between pixels gets softened.
      view.sprite.position.set(Math.round((r.x - BLEED) * res) / res, Math.round((r.y - BLEED) * res) / res);
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
    for (const pane of this.layout.visiblePanes()) {
      if (!pane.rect) continue;
      const pts = paneOutlinePoints(pane.rect, t, now);
      let d = `M${pts[0].toFixed(1)} ${pts[1].toFixed(1)}`;
      for (let i = 2; i < pts.length; i += 2) d += `L${pts[i].toFixed(1)} ${pts[i + 1].toFixed(1)}`;
      parts.push(`${d}Z`);
      const view = this.views.get(pane);
      if (!view) continue;
      // Presenting: plain, full-size slides (no liquid edges).
      if (document.body.classList.contains('presenting')) view.mask.clear().rect(pane.rect.x, pane.rect.y, pane.rect.w, pane.rect.h).fill(0xffffff);
      else view.mask.clear().poly(pts).fill(0xffffff);
    }
    this.edgePath.setAttribute('d', parts.join(''));
    // The divider highlight: the middle of the gap, bending with the same waves.
    let glow = '';
    const sp = this.hoverSplit;
    if (sp && !this.layout.maximized && this.layout.splits().includes(sp) && sp.a.rect && sp.rect) {
      const a = sp.a.rect, r = sp.rect;
      const pts = [];
      if (sp.dir === 'row') {
        const x = a.x + a.w + GAP / 2;
        for (let y = r.y + 10; y <= r.y + r.h - 10; y += 14) pts.push([x + push('x', x, y, t, now), y]);
      } else {
        const y = a.y + a.h + GAP / 2;
        for (let x = r.x + 10; x <= r.x + r.w - 10; x += 14) pts.push([x, y + push('y', x, y, t, now)]);
      }
      if (pts.length > 1) glow = `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}`;
    }
    this.hoverPath.setAttribute('d', glow);
    this.app.render();   // put the panes back on screen with their new edges (cheap: no board redraw)
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
    d.width = pane.rect.w + BLEED * 2;
    d.height = pane.rect.h + BLEED * 2;
    d.tint = this.dotColour;
    d.alpha = this.hideDots ? 0 : 1;   // Present mode shows a plain background
    d.tileScale.set(spacing / DOT_CELL);
    // Keep the dots fixed to the board as you pan.
    d.tilePosition.set((cam.x + BLEED) % spacing, (cam.y + BLEED) % spacing);
    this.app.renderer.render({ container: d, target, clear: true, clearColor: this.background });
    if (this.stirState.pane === pane && this.stirState.trail?.length && !this.hideDots) this._drawStir(pane, target, spacing);
  }

  // ---------- Stirring the dots ----------
  //
  // Moving the mouse over the background is like moving through water or fog: the dots near
  // the mouse are pushed aside and carried a little the way you're going, and the path you've
  // just moved through stays disturbed for a while (a wake), slowly settling back into the
  // grid. Only the area of the wake is redrawn, and only in that pane.

  stir(pane, x, y) {
    const st = this.stirState;
    if (!motionOn() || pane?.type !== 'board') { st.pane = null; st.trail = []; return; }
    const now = performance.now();
    if (st.pane !== pane) { st.trail = []; st.vx = st.vy = 0; }
    else if (st.last) {
      const dt = Math.max(0.008, (now - st.last) / 1000);
      st.vx = st.vx * 0.7 + ((x - st.x) / dt) * 0.3;
      st.vy = st.vy * 0.7 + ((y - st.y) / dt) * 0.3;
    }
    Object.assign(st, { pane, x, y, last: now });
    st.trail ??= [];
    // Drop a point of the wake every 14 px or so.
    const tip = st.trail[st.trail.length - 1];
    if (!tip || Math.hypot(tip.x - x, tip.y - y) > 14) {
      st.trail.push({ x, y, vx: st.vx, vy: st.vy, e: 1 });
      if (st.trail.length > 40) st.trail.shift();
    } else {
      Object.assign(tip, { x, y, vx: st.vx, vy: st.vy, e: 1 });
    }
    if (!st.raf) st.raf = requestAnimationFrame((t) => this._stirFrame(t));
  }

  _stirFrame(now) {
    const st = this.stirState;
    st.raf = 0;
    if (!st.pane || !this.views.has(st.pane) || st.pane.type !== 'board') { st.trail = []; return; }
    const dt = Math.min(0.05, (now - (st.frame || now)) / 1000 || 0.016);
    st.frame = now;
    // The wake fades slowly: about two seconds to settle.
    for (const p of st.trail) p.e *= Math.exp(-dt * 1.5);
    st.trail = st.trail.filter((p) => p.e > 0.01);
    this.renderPane(st.pane);
    if (st.trail.length) st.raf = requestAnimationFrame((t) => this._stirFrame(t));
    else { st.frame = 0; this.renderPane(st.pane); }
  }

  _drawStir(pane, target, spacing) {
    const st = this.stirState;
    const trail = st.trail || [];
    if (!trail.length) return;
    const R = 120;                                   // how far each bit of the wake reaches
    const cam = pane.camera;
    const ox = (cam.x % spacing) + spacing / 2, oy = (cam.y % spacing) + spacing / 2;
    const r = 2.4 * spacing / DOT_CELL;              // dot radius on screen
    const g = this.stirG;
    g.clear();
    // Hide the still dots under the wake, then draw them where the water has moved them.
    for (const p of trail) g.circle(p.x, p.y, R + r * 2).fill(this.background);
    const t = performance.now() / 1000;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of trail) { x0 = Math.min(x0, p.x - R); y0 = Math.min(y0, p.y - R); x1 = Math.max(x1, p.x + R); y1 = Math.max(y1, p.y + R); }
    const i0 = Math.floor((x0 - ox) / spacing) - 1, i1 = Math.ceil((x1 - ox) / spacing) + 1;
    const j0 = Math.floor((y0 - oy) / spacing) - 1, j1 = Math.ceil((y1 - oy) / spacing) + 1;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const px = ox + i * spacing, py = oy + j * spacing;
        let dx = 0, dy = 0, near = 0, covered = false;
        for (const p of trail) {
          const ex = px - p.x, ey = py - p.y;
          const d = Math.hypot(ex, ey);
          if (d > R + r * 3) continue;
          covered = true;
          if (d >= R) continue;
          const f = (1 - d / R) ** 2 * p.e;          // strongest at the point, 0 at the edge
          const nx = d ? ex / d : 0, ny = d ? ey / d : 0;
          const swirl = 2.4 * f * Math.sin(t * 2 + d * 0.05);
          dx += nx * 9 * f + p.vx * 0.008 * f - ny * swirl;
          dy += ny * 9 * f + p.vy * 0.008 * f + nx * swirl;
          near = Math.max(near, f);
        }
        if (!covered) continue;
        // Never more than a gentle drift, however many bits of the wake overlap.
        const m = Math.hypot(dx, dy), cap = 13;
        if (m > cap) { dx *= cap / m; dy *= cap / m; }
        g.circle(px + dx, py + dy, r * (1 + 0.45 * near)).fill({ color: this.dotColour, alpha: 1 - 0.22 * near });
      }
    }
    g.position.set(BLEED, BLEED);   // the picture starts BLEED before the pane's box
    this.app.renderer.render({ container: g, target, clear: false });
  }

  // Redraw just one pane (used for the stirring, so the rest of the window isn't redrawn).
  renderPane(pane) {
    const view = this.views.get(pane);
    if (!view || pane.type !== 'board' || !this.layout.visiblePanes().includes(pane)) return;
    const cam = pane.camera;
    const board = this.boardOf(pane);
    board.drawOverlay(cam.zoom);
    this.drawDots(pane, view.texture);
    this.matrix.set(cam.zoom, 0, 0, cam.zoom, cam.x + BLEED, cam.y + BLEED);
    this.app.renderer.render({ container: board.world, target: view.texture, clear: false, transform: this.matrix });
    this.app.render();
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
      this.matrix.set(cam.zoom, 0, 0, cam.zoom, cam.x + BLEED, cam.y + BLEED);
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
