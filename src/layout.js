// The pane layout: how the window is divided into viewports, Blender-style.
//
// The layout is a tree. Each node is either
//   - a pane:  { type: 'pane', pane }                  one view onto the board
//   - a split: { type: 'split', dir, ratio, a, b }     two parts side by side ('row')
//                                                      or stacked on top of each other ('col')
// Splitting a pane turns it into a split with two panes inside. Closing a pane
// lets its neighbour take over the space again.

import { Camera } from './camera.js';

export const GAP = 2;          // pixels of dark line between panes
export const MIN_PANE = 80;    // panes can't be dragged smaller than this
export const MAX_PANES = 16;

let nextPaneId = 1;

// What a pane can show. 'board' is the reference board itself; the others are tools
// that sit next to it (see src/editors.js).
export const PANE_TYPES = ['board', 'search', 'mannequin'];

export class Pane {
  constructor(camera = new Camera()) {
    this.id = nextPaneId++;
    this.type = 'board';
    this.state = {};   // what a tool pane remembers (e.g. the search words), saved with the board
    this.camera = camera;
    this.rect = null;  // where the pane is in the window: { x, y, w, h }
    this.pendingView = null;  // a saved { cx, cy, zoom } to apply once we know the size
  }

  // The board position at the middle of this pane.
  centre() {
    return this.rect ? this.camera.toWorld(this.rect.w / 2, this.rect.h / 2) : { x: 0, y: 0 };
  }
}

export class Layout {
  constructor() {
    this.root = { type: 'pane', pane: new Pane() };
    this.maximized = null;  // a pane that temporarily fills the whole window
  }

  // All panes, in reading order.
  panes(node = this.root, out = []) {
    if (node.type === 'pane') out.push(node.pane);
    else { this.panes(node.a, out); this.panes(node.b, out); }
    return out;
  }

  // The panes that are on screen right now (only one while maximized).
  visiblePanes() {
    return this.maximized ? [this.maximized] : this.panes();
  }

  // Work out where every pane and divider goes for a window of this size.
  computeRects(width, height) {
    for (const p of this.panes()) p.nextRect = null;
    if (this.maximized) this.maximized.nextRect = { x: 0, y: 0, w: width, h: height };
    else this._place(this.root, { x: 0, y: 0, w: width, h: height });

    for (const p of this.panes()) {
      const next = p.nextRect;
      delete p.nextRect;
      if (!next) continue;  // hidden behind a maximized pane: keep its last size
      if (p.pendingView) {
        // Restore a saved view: put the saved board position in the middle of the pane.
        const { cx, cy, zoom } = p.pendingView;
        p.camera.zoom = zoom;
        p.camera.x = next.w / 2 - cx * zoom;
        p.camera.y = next.h / 2 - cy * zoom;
        p.pendingView = null;
      } else if (p.rect) {
        // When a pane changes size, keep whatever was in its middle in the middle.
        p.camera.panBy((next.w - p.rect.w) / 2, (next.h - p.rect.h) / 2);
      }
      p.rect = next;
    }
  }

  _place(node, r) {
    node.rect = r;
    if (node.type === 'pane') { node.pane.nextRect = r; return; }
    if (node.dir === 'row') {
      const aw = Math.round((r.w - GAP) * node.ratio);
      this._place(node.a, { x: r.x, y: r.y, w: aw, h: r.h });
      this._place(node.b, { x: r.x + aw + GAP, y: r.y, w: r.w - aw - GAP, h: r.h });
    } else {
      const ah = Math.round((r.h - GAP) * node.ratio);
      this._place(node.a, { x: r.x, y: r.y, w: r.w, h: ah });
      this._place(node.b, { x: r.x, y: r.y + ah + GAP, w: r.w, h: r.h - ah - GAP });
    }
  }

  // Split a pane in two. 'row' = side by side, 'col' = top and bottom.
  // The new pane starts with the same view as the old one.
  split(pane, dir) {
    if (this.panes().length >= MAX_PANES) return null;
    const node = this._findNode(pane);
    if (!node) return null;
    const r = pane.rect;
    if (r && (dir === 'row' ? r.w : r.h) < MIN_PANE * 2 + GAP) return null;  // too small to split

    const copy = new Pane();
    copy.type = pane.type;
    copy.state = JSON.parse(JSON.stringify(pane.state || {}));
    copy.camera.zoom = pane.camera.zoom;
    copy.camera.x = pane.camera.x;
    copy.camera.y = pane.camera.y;
    copy.rect = r && { ...r };

    // Turn this pane node into a split node in place.
    delete node.pane;
    Object.assign(node, {
      type: 'split', dir, ratio: 0.5,
      a: { type: 'pane', pane },
      b: { type: 'pane', pane: copy },
    });
    this.maximized = null;
    return copy;
  }

  // Close a pane; its neighbour grows to fill the space. The last pane can't be closed.
  close(pane) {
    const parent = this._findParent(pane);
    if (!parent) return false;
    const sibling = parent.a.pane === pane ? parent.b : parent.a;
    for (const k of Object.keys(parent)) delete parent[k];
    Object.assign(parent, sibling);
    if (this.maximized === pane) this.maximized = null;
    return true;
  }

  toggleMaximize(pane) {
    if (this.panes().length < 2) return;
    this.maximized = this.maximized ? null : pane;
  }

  // The split nodes (each one has a divider you can drag).
  splits(node = this.root, out = []) {
    if (node.type === 'split') { out.push(node); this.splits(node.a, out); this.splits(node.b, out); }
    return out;
  }

  // Move a divider to a window position, keeping both sides at least MIN_PANE big.
  dragDivider(split, clientX, clientY) {
    const r = split.rect;
    const size = (split.dir === 'row' ? r.w : r.h) - GAP;
    const pos = split.dir === 'row' ? clientX - r.x : clientY - r.y;
    const min = Math.min(0.5, MIN_PANE / size);
    split.ratio = Math.min(1 - min, Math.max(min, pos / size));
  }

  _findNode(pane, node = this.root) {
    if (node.type === 'pane') return node.pane === pane ? node : null;
    return this._findNode(pane, node.a) || this._findNode(pane, node.b);
  }

  _findParent(pane, node = this.root) {
    if (node.type !== 'split') return null;
    if (node.a.pane === pane || node.b.pane === pane) return node;
    return this._findParent(pane, node.a) || this._findParent(pane, node.b);
  }

  // ---------- Saving and loading the layout ----------

  // A plain description of the layout, for board files and autosave.
  toJSON() {
    const walk = (node) => {
      if (node.type === 'pane') {
        const c = node.pane.centre();
        const p = node.pane;
        return { pane: { cx: c.x, cy: c.y, zoom: p.camera.zoom, maximized: this.maximized === p, type: p.type, state: p.state } };
      }
      return { dir: node.dir, ratio: node.ratio, a: walk(node.a), b: walk(node.b) };
    };
    return walk(this.root);
  }

  static fromJSON(data) {
    const layout = new Layout();
    const walk = (d) => {
      if (d.pane) {
        const pane = new Pane();
        pane.pendingView = { cx: d.pane.cx || 0, cy: d.pane.cy || 0, zoom: d.pane.zoom || 1 };
        if (PANE_TYPES.includes(d.pane.type)) pane.type = d.pane.type;
        pane.state = d.pane.state || {};
        if (d.pane.maximized) layout.maximized = pane;
        return { type: 'pane', pane };
      }
      return { type: 'split', dir: d.dir === 'col' ? 'col' : 'row', ratio: d.ratio ?? 0.5, a: walk(d.a), b: walk(d.b) };
    };
    try {
      layout.root = walk(data);
    } catch {
      layout.root = { type: 'pane', pane: new Pane() };  // damaged layout: fall back to one pane
      layout.maximized = null;
    }
    return layout;
  }
}
