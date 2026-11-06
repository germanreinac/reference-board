// The board is the shared infinite canvas: images, pen strokes and notes all live
// here, in "world" coordinates. Cameras only decide how it is shown, so every
// pane shows the same board.
//
// Layers, from back to front: images, pen strokes, notes, selection outline.

import { Container, Sprite, Texture, ImageSource, Graphics, Text } from '../vendor/pixi.min.mjs';
import { getStroke } from '../vendor/perfect-freehand.mjs';

let nextId = 1;
function takeId(id) {
  if (id === undefined || id === null) return nextId++;
  nextId = Math.max(nextId, id + 1);
  return id;
}

// How pen strokes are shaped. Pressure changes the width; with a mouse the
// speed of the stroke stands in for pressure.
const STROKE_SHAPE = { thinning: 0.6, smoothing: 0.5, streamline: 0.45 };

// Pick black or white text so a note is readable on its colour.
function textColourFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1b1b1d' : '#f5f5f5';
}

export class Board {
  constructor() {
    this.world = new Container();       // everything on the board
    this.imageLayer = new Container();  // the images, back to front
    this.strokeLayer = new Container(); // pen strokes, oldest first
    this.noteLayer = new Container();   // text notes
    this.overlay = new Graphics();      // selection outline, drawn on top
    this.world.addChild(this.imageLayer, this.strokeLayer, this.noteLayer, this.overlay);

    this.items = [];       // images, back to front
    this.strokes = [];     // pen strokes
    this.notes = [];       // text notes, back to front
    this.selected = null;  // the image or note that is selected, if any
  }

  isEmpty() {
    return this.items.length === 0 && this.strokes.length === 0 && this.notes.length === 0;
  }

  // ---------- Images ----------

  // Put a decoded image on the board, centred on (x, y).
  // `blob` is the original image file; we keep it so the board can be saved.
  // `index` puts it at a given place in the stack (used by undo).
  addImage(bitmap, x, y, { name = '', sourceUrl = '', blob = null, id, scaleX = 1, scaleY = 1, rotation = 0, alpha = 1, index, locked = false } = {}) {
    // Mipmaps are smaller pre-shrunk copies of the image. They keep big photos
    // looking smooth (not sparkly or jagged) when you zoom far out.
    const source = new ImageSource({ resource: bitmap, autoGenerateMipmaps: true });
    const sprite = new Sprite(new Texture({ source }));
    sprite.anchor.set(0.5);  // position, scale and rotation all work from the centre
    sprite.position.set(x, y);
    sprite.scale.set(scaleX, scaleY);
    sprite.rotation = rotation;
    sprite.alpha = alpha;

    const item = {
      kind: 'image',
      id: takeId(id),
      sprite,
      width: bitmap.width,   // original pixel size of the image
      height: bitmap.height,
      name,
      sourceUrl,             // where the image came from, when we know it
      blob,
      locked: !!locked,      // locked things can't be selected, moved or erased
    };
    const at = index === undefined ? this.items.length : Math.max(0, Math.min(index, this.items.length));
    this.items.splice(at, 0, item);
    this.imageLayer.addChildAt(sprite, at);
    return item;
  }

  imageJSON(item) {
    const s = item.sprite;
    return {
      id: item.id, name: item.name, sourceUrl: item.sourceUrl,
      x: s.x, y: s.y, scaleX: s.scale.x, scaleY: s.scale.y, rotation: s.rotation, alpha: s.alpha,
      ...(item.locked ? { locked: true } : {}),
    };
  }

  // ---------- Pen strokes ----------

  // A stroke is saved as the points you drew: [x, y, pressure, x, y, pressure, ...]
  // in board units, plus its colour and size. The outline is worked out from them.
  addStroke({ id, points, color = '#f5f5f5', size = 8, simulatePressure = false, locked = false }) {
    const stroke = { kind: 'stroke', id: takeId(id), points, color, size, simulatePressure, locked: !!locked, graphics: new Graphics() };
    this.redrawStroke(stroke);
    this.strokes.push(stroke);
    this.strokeLayer.addChild(stroke.graphics);
    return stroke;
  }

  // Recalculate a stroke's shape (also used while you're still drawing it).
  redrawStroke(stroke, finished = true) {
    const pts = [];
    for (let i = 0; i < stroke.points.length; i += 3) pts.push([stroke.points[i], stroke.points[i + 1], stroke.points[i + 2]]);
    const outline = getStroke(pts, { ...STROKE_SHAPE, size: stroke.size, simulatePressure: stroke.simulatePressure, last: finished });
    const g = stroke.graphics;
    g.clear();
    if (outline.length < 3) return;
    g.poly(outline.flat()).fill(stroke.color);
    // Remember a box around the stroke, for the eraser.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of outline) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    stroke.box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  removeStroke(stroke) {
    const i = this.strokes.indexOf(stroke);
    if (i === -1) return;
    this.strokes.splice(i, 1);
    stroke.graphics.destroy();
  }

  // Strokes touched by a circle at (x, y): what the eraser removes.
  strokesAt(x, y, radius) {
    return this.strokes.filter((s) => {
      if (s.locked) return false;
      const b = s.box;
      const reach = radius + s.size / 2;
      if (!b || x < b.x - radius || x > b.x + b.width + radius || y < b.y - radius || y > b.y + b.height + radius) return false;
      const p = s.points;
      if (p.length <= 3) return Math.hypot(p[0] - x, p[1] - y) <= reach;
      for (let i = 0; i + 5 < p.length; i += 3) {
        if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach) return true;
      }
      return false;
    });
  }

  strokeJSON(s) {
    return { id: s.id, color: s.color, size: s.size, simulatePressure: s.simulatePressure, ...(s.locked ? { locked: true } : {}), points: s.points.map((v) => Math.round(v * 100) / 100) };
  }

  // ---------- Notes ----------

  // A note is a coloured label with text, centred on (x, y).
  addNote({ id, x, y, text = '', color = '#ffb547', fontSize = 20, index, locked = false }) {
    const container = new Container();
    const bg = new Graphics();
    const label = new Text({ text: '', style: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize, lineHeight: fontSize * 1.3, wordWrap: true, breakWords: true } });
    container.addChild(bg, label);
    container.position.set(x, y);
    const note = { kind: 'note', id: takeId(id), sprite: container, bg, label, text, color, fontSize, width: 0, height: 0, locked: !!locked };
    this.setNoteText(note, text);
    const at = index === undefined ? this.notes.length : Math.max(0, Math.min(index, this.notes.length));
    this.notes.splice(at, 0, note);
    this.noteLayer.addChildAt(container, at);
    return note;
  }

  setNoteText(note, text, color = note.color) {
    note.text = text;
    note.color = color;
    const pad = note.fontSize * 0.55;
    note.label.style.wordWrapWidth = note.fontSize * 16;
    note.label.style.fill = textColourFor(color);
    note.label.text = text || ' ';
    note.width = Math.max(note.fontSize * 2, note.label.width + pad * 2);
    note.height = note.label.height + pad * 2;
    note.label.position.set(pad, pad);
    note.bg.clear();
    note.bg.roundRect(0, 0, note.width, note.height, note.fontSize * 0.35).fill(color);
    // Position, like images, is the centre of the note.
    note.sprite.pivot.set(note.width / 2, note.height / 2);
  }

  noteJSON(n) {
    return { id: n.id, x: n.sprite.x, y: n.sprite.y, text: n.text, color: n.color, fontSize: n.fontSize, ...(n.locked ? { locked: true } : {}) };
  }

  // Text is drawn as a picture, so it gets blurry when you zoom in. This redraws
  // each note's text sharp enough for the most zoomed-in pane, within limits.
  updateTextSharpness(maxZoom, pixelRatio) {
    for (const n of this.notes) {
      const want = Math.min(maxZoom * pixelRatio, 4096 / Math.max(n.width, n.height, 1));
      const res = 2 ** Math.ceil(Math.log2(Math.max(0.25, want)));
      if (n.label.resolution !== res) n.label.resolution = res;
    }
  }

  // ---------- Things you can select and move: images and notes ----------

  remove(item) {
    const list = item.kind === 'note' ? this.notes : this.items;
    const i = list.indexOf(item);
    if (i === -1) return -1;
    list.splice(i, 1);
    if (this.selected === item) this.selected = null;
    // Also free the picture from graphics memory.
    if (item.kind === 'note') item.sprite.destroy({ children: true });
    else item.sprite.destroy({ texture: true, textureSource: true });
    return i;
  }

  find(kind, id) {
    const list = kind === 'note' ? this.notes : kind === 'stroke' ? this.strokes : this.items;
    return list.find((x) => x.id === id) || null;
  }

  // Lock or unlock one thing, or everything on the board. Returns what changed.
  setLocked(target, locked) {
    const all = target === 'all' ? [...this.items, ...this.notes, ...this.strokes] : [target];
    const changed = all.filter((x) => !!x.locked !== locked);
    for (const x of changed) x.locked = locked;
    if (locked && changed.includes(this.selected)) this.selected = null;
    return changed;
  }

  // Remove everything (used when leaving a board).
  clear() {
    for (const item of [...this.items]) this.remove(item);
    for (const note of [...this.notes]) this.remove(note);
    for (const stroke of [...this.strokes]) this.removeStroke(stroke);
    this.selected = null;
  }

  // Draw it above the others of its kind.
  bringToFront(item) {
    const list = item.kind === 'note' ? this.notes : this.items;
    const i = list.indexOf(item);
    if (i === -1 || i === list.length - 1) return;
    list.splice(i, 1);
    list.push(item);
    const layer = item.sprite.parent;
    layer.setChildIndex(item.sprite, layer.children.length - 1);
  }

  // Which note or image is at this board position? Notes are on top, so they're checked first.
  // Written to also work once images can be rotated, scaled and flipped.
  // Locked things are skipped unless includeLocked is set (the right-click menu uses it to unlock).
  hitTest(wx, wy, { includeLocked = false } = {}) {
    const lists = [this.notes, this.items];
    for (const list of lists) {
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (item.locked && !includeLocked) continue;
        const s = item.sprite;
        // Undo the item's position, rotation and scale to get a point inside it.
        const dx = wx - s.x;
        const dy = wy - s.y;
        const cos = Math.cos(-s.rotation);
        const sin = Math.sin(-s.rotation);
        const lx = (dx * cos - dy * sin) / s.scale.x;
        const ly = (dx * sin + dy * cos) / s.scale.y;
        if (Math.abs(lx) <= item.width / 2 && Math.abs(ly) <= item.height / 2) return item;
      }
    }
    return null;
  }

  // The four corners of an image or note on the board, after rotation and scale.
  corners(item) {
    const s = item.sprite;
    const hw = (item.width / 2) * s.scale.x;
    const hh = (item.height / 2) * s.scale.y;
    const cos = Math.cos(s.rotation);
    const sin = Math.sin(s.rotation);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
      x: s.x + x * cos - y * sin,
      y: s.y + x * sin + y * cos,
    }));
  }

  // A rectangle around the given images and notes. With nothing given: everything on the board.
  bounds(items = null) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const item of items || [...this.items, ...this.notes]) for (const p of this.corners(item)) add(p.x, p.y);
    if (!items) for (const s of this.strokes) if (s.box) { add(s.box.x, s.box.y); add(s.box.x + s.box.width, s.box.y + s.box.height); }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Redraw the blue outline around the selected image or note.
  // The line width is divided by zoom so it always looks 2 pixels thick on screen.
  drawOverlay(zoom) {
    this.overlay.clear();
    if (!this.selected) return;
    const pts = this.corners(this.selected).flatMap((p) => [p.x, p.y]);
    this.overlay.poly(pts).stroke({ width: 2 / zoom, color: 0x4da3ff, alignment: 0 });
  }

  // ---------- Saving ----------

  toJSON() {
    return {
      items: this.items.map((i) => this.imageJSON(i)),
      strokes: this.strokes.map((s) => this.strokeJSON(s)),
      notes: this.notes.map((n) => this.noteJSON(n)),
    };
  }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
