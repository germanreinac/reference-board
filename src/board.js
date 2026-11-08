// The board is the shared infinite canvas: images, pen strokes and notes all live
// here, in "world" coordinates. Cameras only decide how it is shown, so every
// pane shows the same board.
//
// Layers, from back to front: images, pen strokes, notes, selection outline.

import { Container, Sprite, Texture, ImageSource, Graphics, Text, Rectangle, ColorMatrixFilter, CanvasTextMetrics } from '../vendor/pixi.min.mjs';
import { getStroke } from '../vendor/perfect-freehand.mjs';
import { fontStack } from './fonts.js';

// Text levels: size as a multiple of Body text, and default weight.
export const LEVELS = {
  title: { label: 'Title', size: 3.2, weight: 700 },
  h1: { label: 'Heading 1', size: 2.2, weight: 700 },
  h2: { label: 'Heading 2', size: 1.6, weight: 600 },
  h3: { label: 'Heading 3', size: 1.25, weight: 600 },
  body: { label: 'Body', size: 1, weight: 400 },
  caption: { label: 'Caption', size: 0.78, weight: 400 },
};

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

// Captions are laid out at this size and wrap width (see setCaption).
const CAPTION_SIZE = 32;
const CAPTION_WRAP = 711;
const CAPTION_AREA = 615;  // a 4:3 image 711 units wide gets 32-unit text

export class Board {
  constructor() {
    this.world = new Container();       // everything on the board
    this.imageLayer = new Container();  // the images, back to front
    this.strokeLayer = new Container(); // pen strokes, oldest first
    this.noteLayer = new Container();   // text notes
    this.frameLayer = new Container();  // frames, behind everything
    this.shapeLayer = new Container();  // rectangles, ellipses, lines and arrows
    this.captionLayer = new Container(); // the text under images
    this.overlay = new Graphics();      // selection outline, drawn on top
    this.fxLayer = new Container();      // things burning away (see burn())
    this.fx = new Graphics();            // flames, smoke, ash piles and the sweeper
    this.world.addChild(this.frameLayer, this.imageLayer, this.captionLayer, this.shapeLayer, this.strokeLayer, this.noteLayer, this.fxLayer, this.fx, this.overlay);
    this.burning = [];     // { box, thing, mask, glow, b, start, dur }
    this.particles = [];   // { x, y, vx, vy, life, age, r, colour, alpha, kind }
    this.piles = [];       // ash left behind: { x, y, w, left (1 → 0 as it's swept), start }
    this.sweeper = null;   // the little cleaner with the broom (only ever one)
    this.focus = false;    // Focus on starred: everything that isn't starred fades back
    this.splashes = [];    // little splashes where images land: { x, y, r, colour, start }

    this.items = [];       // images, back to front
    this.strokes = [];     // pen strokes
    this.notes = [];       // text notes, back to front
    this.shapes = [];      // shapes, back to front
    this.frames = [];      // frames, in the order they're presented
    this.ink = 0xffffff;   // the colour frame outlines and titles are drawn in (changes with the theme)
    this.selection = [];   // the images and notes that are selected
    this.marquee = null;   // the selection box being dragged: { x0, y0, x1, y1 } in board units
  }

  // The selected thing when exactly one is selected (null otherwise). Setting it
  // selects just that one (or nothing).
  get selected() { return this.selection.length === 1 ? this.selection[0] : null; }
  set selected(item) { this.selection = item ? [item] : []; }
  isSelected(item) { return this.selection.includes(item); }
  toggleSelected(item) {
    this.selection = this.isSelected(item) ? this.selection.filter((x) => x !== item) : [...this.selection, item];
  }

  isEmpty() {
    return !this.items.length && !this.strokes.length && !this.notes.length && !this.shapes.length && !this.frames.length;
  }

  // Everything you can select, front to back by layer: notes, shapes, images, frames.
  get selectable() { return [...this.notes, ...this.shapes, ...this.items, ...this.frames]; }
  listOf(kind) {
    return { note: this.notes, shape: this.shapes, frame: this.frames, stroke: this.strokes }[kind] || this.items;
  }

  // Things in the same group as this one (just itself when it isn't grouped).
  groupOf(item) {
    return item.group ? this.selectable.filter((x) => x.group === item.group) : [item];
  }

  // ---------- Shapes ----------
  //
  // shape: 'rect', 'ellipse', 'line' or 'arrow'. Rectangles and ellipses are w x h;
  // lines and arrows go from -(dx, dy)/2 to +(dx, dy)/2 around their centre.

  addShape({ id, shape = 'rect', x, y, w = 160, h = 110, dx = 160, dy = 0, color = '#f5f5f5', fill = false, strokeWidth = 3,
    rotation = 0, scaleX = 1, scaleY = 1, locked = false, group = null, index }) {
    const g = new Graphics();
    g.position.set(x, y);
    g.rotation = rotation;
    g.scale.set(scaleX, scaleY);
    const item = { kind: 'shape', id: takeId(id), sprite: g, shape, w, h, dx, dy, color, fill: !!fill, strokeWidth, locked: !!locked, group, width: 0, height: 0 };
    this.drawShape(item);
    const at = index === undefined ? this.shapes.length : Math.max(0, Math.min(index, this.shapes.length));
    this.shapes.splice(at, 0, item);
    this.shapeLayer.addChildAt(g, at);
    return item;
  }

  drawShape(item) {
    const g = item.sprite;
    const sw = item.strokeWidth;
    g.clear();
    const stroke = { width: sw, color: item.color, cap: 'round', join: 'round' };
    if (item.shape === 'rect' || item.shape === 'ellipse') {
      const { w, h } = item;
      if (item.shape === 'rect') g.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h, 60) * 0.12);
      else g.ellipse(0, 0, w / 2, h / 2);
      if (item.fill) g.fill({ color: item.color, alpha: 0.22 });
      g.stroke(stroke);
      item.width = w + sw;
      item.height = h + sw;
    } else {
      const { dx, dy } = item;
      g.moveTo(-dx / 2, -dy / 2).lineTo(dx / 2, dy / 2).stroke(stroke);
      if (item.shape === 'arrow') {
        const len = Math.hypot(dx, dy) || 1;
        const head = Math.min(len * 0.45, Math.max(sw * 4.5, 16));
        const a = Math.atan2(dy, dx);
        for (const side of [-1, 1]) {
          const b = a + Math.PI - side * 0.45;
          g.moveTo(dx / 2, dy / 2).lineTo(dx / 2 + Math.cos(b) * head, dy / 2 + Math.sin(b) * head);
        }
        g.stroke(stroke);
      }
      // A comfortable box to click on, even for thin straight lines.
      item.width = Math.max(Math.abs(dx), sw * 4, 14);
      item.height = Math.max(Math.abs(dy), sw * 4, 14);
    }
  }

  shapeJSON(s) {
    const g = s.sprite;
    return {
      id: s.id, shape: s.shape, x: g.x, y: g.y, w: s.w, h: s.h, dx: s.dx, dy: s.dy, color: s.color, fill: s.fill, strokeWidth: s.strokeWidth,
      ...(g.rotation ? { rotation: g.rotation } : {}), ...(g.scale.x !== 1 || g.scale.y !== 1 ? { scaleX: g.scale.x, scaleY: g.scale.y } : {}),
      ...(s.locked ? { locked: true } : {}), ...(s.group ? { group: s.group } : {}),
    };
  }

  // ---------- Frames ----------
  //
  // A frame marks an area of the board, with a name above it. Frames are the slides
  // of Present mode, and moving a frame moves what's inside it.

  addFrame({ id, x, y, w = 1600, h = 900, name = 'Frame', titleSize = 18, locked = false, index }) {
    const c = new Container();
    const bg = new Graphics();
    const title = new Text({ text: name, style: { fontFamily: 'Inter, system-ui, sans-serif', fontWeight: '600', fontSize: titleSize } });
    c.addChild(bg, title);
    c.position.set(x, y);
    const item = { kind: 'frame', id: takeId(id), sprite: c, bg, title, w, h, name, titleSize, locked: !!locked, width: w, height: h };
    this.drawFrame(item);
    const at = index === undefined ? this.frames.length : Math.max(0, Math.min(index, this.frames.length));
    this.frames.splice(at, 0, item);
    this.frameLayer.addChildAt(c, Math.min(at, this.frameLayer.children.length));
    return item;
  }

  drawFrame(f) {
    f.width = f.w;
    f.height = f.h;
    f.bg.clear();
    f.bg.roundRect(-f.w / 2, -f.h / 2, f.w, f.h, Math.min(f.w, f.h) * 0.012)
      .fill({ color: this.ink, alpha: 0.035 })
      .stroke({ width: f.titleSize * 0.08, color: this.ink, alpha: 0.22 });
    f.title.text = f.name || 'Frame';
    f.title.style.fill = this.ink;
    f.title.alpha = 0.7;
    f.title.position.set(-f.w / 2, -f.h / 2 - f.titleSize * 1.5);
    this._wrapTitle(f);
  }

  // A title longer than the frame is wide carries on round the frame: along the top, then
  // it turns the corner and runs down the right side, along the bottom, up the left side,
  // and stops when it gets back to where it started. If even that isn't enough room, the
  // letters get smaller so it all fits in one lap.
  _wrapTitle(f) {
    const text = f.name || 'Frame';
    const style = f.title.style;
    const full = CanvasTextMetrics.measureText(text, style).width;
    if (full <= f.w) {
      f.title.visible = true;
      if (f.wrap) { f.wrap.destroy({ children: true }); f.wrap = null; f.wrapKey = null; }
      return;
    }
    f.title.visible = false;
    const lap = 2 * (f.w + f.h);
    const k = Math.min(1, (lap * 0.97) / full);   // shrink to fit one lap
    const size = f.titleSize * k;
    const key = `${text}|${size.toFixed(2)}|${this.ink}`;
    if (!f.wrap) { f.wrap = new Container(); f.sprite.addChild(f.wrap); }
    if (f.wrapKey !== key) {
      // One small text per letter (only when the words or size change).
      f.wrap.removeChildren().forEach((c) => c.destroy());
      const st = { fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontSize: size, fill: this.ink };
      for (const ch of [...text]) {
        const t = new Text({ text: ch, style: st });
        t.anchor.set(0.5, 1);
        t.alpha = 0.7;
        t.advance = CanvasTextMetrics.measureText(ch === ' ' ? '\u00a0' : ch, f.title.style).width * k;
        f.wrap.addChild(t);
      }
      f.wrapKey = key;
    }
    // Lay the letters along the path, just outside the frame's edge.
    const g = f.titleSize * 0.35, w = f.w, h = f.h;
    const sides = [
      { len: w, at: (d) => [-w / 2 + d, -h / 2 - g], rot: 0 },
      { len: h, at: (d) => [w / 2 + g, -h / 2 + d], rot: Math.PI / 2 },
      { len: w, at: (d) => [w / 2 - d, h / 2 + g], rot: Math.PI },
      { len: h, at: (d) => [-w / 2 - g, h / 2 - d], rot: -Math.PI / 2 },
    ];
    let pos = 0;
    for (const t of f.wrap.children) {
      let mid = pos + t.advance / 2;
      let i = 0;
      while (i < 3 && mid > sides[i].len) { mid -= sides[i].len; i++; }
      const [x, y] = sides[i].at(Math.min(mid, sides[i].len));
      t.position.set(x, y);
      t.rotation = sides[i].rot;
      pos += t.advance;
    }
  }

  // The frame whose name label is at this point (names sit just above the frame).
  frameTitleAt(wx, wy) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      const t = f.title;
      const x = f.sprite.x + t.x, y = f.sprite.y + t.y;
      if (wx >= x && wx <= x + Math.max(t.width, f.titleSize * 4) && wy >= y && wy <= y + t.height) return f;
    }
    return null;
  }

  setInk(colour) {
    this.ink = colour;
    for (const f of this.frames) this.drawFrame(f);
    for (const i of this.items) if (i.captionText) i.captionText.style.fill = colour;
  }

  frameJSON(f) {
    return { id: f.id, x: f.sprite.x, y: f.sprite.y, w: f.w, h: f.h, name: f.name, titleSize: f.titleSize, ...(f.locked ? { locked: true } : {}) };
  }

  // What's inside a frame (its middle is within the frame): moves with it.
  contentsOf(frame) {
    const l = frame.sprite.x - frame.w / 2, t = frame.sprite.y - frame.h / 2;
    return [...this.notes, ...this.shapes, ...this.items].filter((x) => {
      if (x.locked) return false;
      return x.sprite.x >= l && x.sprite.x <= l + frame.w && x.sprite.y >= t && x.sprite.y <= t + frame.h;
    });
  }

  // ---------- Images ----------

  // Put a decoded image on the board, centred on (x, y).
  // `blob` is the original image file; we keep it so the board can be saved.
  // `index` puts it at a given place in the stack (used by undo).
  addImage(bitmap, x, y, { name = '', sourceUrl = '', blob = null, id, scaleX = 1, scaleY = 1, rotation = 0, alpha = 1, index, locked = false, crop = null, grey = false, group = null, caption = '', star = false } = {}) {
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
      group,                 // things with the same group move and select together
      source,                // the full picture on the graphics card
      fullWidth: bitmap.width,
      fullHeight: bitmap.height,
      crop: null,            // { x, y, w, h } in the picture's own pixels, when cropped
      grey: false,           // shown in greyscale
      opacity: alpha,        // how see-through it is (1 = solid); Focus mode fades it on top of this
      caption: '',           // text shown under the image, that moves with it
      captionText: null,
      star: !!star,          // starred as a favourite
    };
    if (crop) this.setCrop(item, crop, { keepPlace: false });
    if (grey) this.setGrey(item, true);
    if (caption) this.setCaption(item, caption);
    const at = index === undefined ? this.items.length : Math.max(0, Math.min(index, this.items.length));
    this.items.splice(at, 0, item);
    this.imageLayer.addChildAt(sprite, at);
    return item;
  }

  imageJSON(item) {
    const s = item.sprite;
    return {
      id: item.id, name: item.name, sourceUrl: item.sourceUrl,
      x: s.x, y: s.y, scaleX: item.anim?.sx ?? s.scale.x, scaleY: item.anim?.sy ?? s.scale.y, rotation: s.rotation, alpha: item.opacity ?? 1,
      ...(item.locked ? { locked: true } : {}),
      ...(item.crop ? { crop: item.crop } : {}),
      ...(item.grey ? { grey: true } : {}),
      ...(item.group ? { group: item.group } : {}),
      ...(item.caption ? { caption: item.caption } : {}),
      ...(item.star ? { star: true } : {}),
    };
  }

  // ---------- Captions: text under an image ----------
  //
  // The text is sized from the image's area, so it keeps the same size relative to the
  // image (like a storyboard panel), and panels of different shapes get matching text.
  // It's laid out at a fixed size and then scaled, so zooming never has to lay it out again.

  setCaption(item, text) {
    item.caption = (text || '').trim();
    if (!item.caption) {
      item.captionText?.destroy();
      item.captionText = null;
      return;
    }
    if (!item.captionText) {
      item.captionText = new Text({
        text: '',
        style: { fontFamily: fontStack('Inter'), fontSize: CAPTION_SIZE, fill: this.ink, wordWrap: true, wordWrapWidth: CAPTION_WRAP, lineHeight: CAPTION_SIZE * 1.3, breakWords: true },
      });
      item.captionText.alpha = 0.85;
      this.captionLayer.addChild(item.captionText);
    }
    item.captionText.text = item.caption;
    this.placeCaption(item);
  }

  // Where the caption sits: just under the image, turning with it.
  captionFrame(item) {
    const s = item.sprite;
    const w = Math.abs(item.width * s.scale.x);
    const h = Math.abs(item.height * s.scale.y);
    const k = Math.sqrt(w * h) / CAPTION_AREA;   // board units per caption unit
    const t = item.captionText;
    if (t && Math.abs(t.style.wordWrapWidth - w / k) > 1) t.style.wordWrapWidth = w / k;  // as wide as the image
    return { w, h, k, gap: CAPTION_SIZE * 0.45 * k, textH: t ? t.height / (t.scale.y || 1) * k : 0 };
  }

  placeCaption(item) {
    const t = item.captionText;
    if (!t) return;
    const s = item.sprite;
    const f = this.captionFrame(item);
    const cos = Math.cos(s.rotation), sin = Math.sin(s.rotation);
    const lx = -f.w / 2, ly = f.h / 2 + f.gap;
    t.position.set(s.x + lx * cos - ly * sin, s.y + lx * sin + ly * cos);
    t.rotation = s.rotation;
    t.scale.set(f.k);
    t.visible = s.visible;
  }

  // The four corners of the caption on the board (null when there's none).
  captionCorners(item) {
    if (!item.captionText) return null;
    const s = item.sprite;
    const f = this.captionFrame(item);
    const cos = Math.cos(s.rotation), sin = Math.sin(s.rotation);
    const y0 = f.h / 2, y1 = f.h / 2 + f.gap + f.textH;
    return [[-f.w / 2, y0], [f.w / 2, y0], [f.w / 2, y1], [-f.w / 2, y1]].map(([x, y]) => ({ x: s.x + x * cos - y * sin, y: s.y + x * sin + y * cos }));
  }

  // ---------- Landing: images pop in with a splash ----------

  // The image grows in from smaller, overshoots a touch and settles (like a drop
  // landing in water), with a ring and droplets in its own colour. `delay` in ms.
  popIn(item, colour = 0x4da3ff, delay = 0) {
    const s = item.sprite;
    item.anim = { start: performance.now() + delay, sx: s.scale.x, sy: s.scale.y };
    const b = this.bounds([item]);
    s.scale.set(item.anim.sx * 0.001, item.anim.sy * 0.001);
    this.splashes.push({ x: s.x, y: s.y, r: Math.hypot(b.width, b.height) / 2, colour, start: item.anim.start });
  }

  animating() {
    return this.splashes.length > 0 || this.items.some((i) => i.anim)
      || this.burning.length > 0 || this.particles.length > 0 || this.piles.length > 0 || !!this.sweeper;
  }

  // ---------- Burning things away, and the sweeper ----------
  //
  // Deleting something sets it alight: a glowing, ragged edge eats it from the bottom up,
  // with flames and smoke, and leaves a little pile of ash. A small character with a broom
  // walks over and sweeps the piles away, one at a time, at their own pace — you can
  // delete as fast as you like, there's only ever one sweeper.

  // Take a thing off the board and burn it (instead of removing it in one go).
  burn(item) {
    const list = this.listOf(item.kind);
    const i = list.indexOf(item);
    if (i === -1) return;
    list.splice(i, 1);
    this.selection = this.selection.filter((x) => x !== item);
    if (item.captionText) { item.captionText.destroy(); item.captionText = null; }
    const thing = item.sprite;
    const b = thing.getLocalBounds();
    const box = new Container();
    box.position.set(thing.x, thing.y);
    box.rotation = thing.rotation;
    box.scale.set(item.anim?.sx ?? thing.scale.x, item.anim?.sy ?? thing.scale.y);
    thing.removeFromParent();
    thing.position.set(0, 0);
    thing.rotation = 0;
    thing.scale.set(1);
    const mask = new Graphics();
    const glow = new Graphics();
    box.addChild(thing, mask, glow);
    thing.mask = mask;
    this.fxLayer.addChild(box);
    this.burning.push({ box, thing, mask, glow, image: item.kind === 'image', b: { x: b.x, y: b.y, w: b.width, h: b.height }, start: performance.now(), dur: 850 + Math.random() * 300, seed: Math.random() * 10 });
  }

  // A point in a burning thing's own space → the board.
  _toBoard(f, lx, ly) {
    const c = f.box;
    const x = lx * c.scale.x, y = ly * c.scale.y;
    const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
    return { x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos };
  }

  _stepFx(now) {
    if (now === this._fxNow) return;     // several panes draw each frame: move things once
    const dt = Math.min(0.1, ((now - (this._fxNow || now)) / 1000) || 0.016);
    this._fxNow = now;

    // Burning: the front moves up from the bottom with a ragged, glowing edge.
    for (const f of [...this.burning]) {
      const p = Math.min(1, (now - f.start) / f.dur);
      const { x, y, w, h } = f.b;
      const front = y + h * (1 - p);
      const edge = [];
      const n = 18;
      for (let k = 0; k <= n; k++) {
        const ex = x + w - (w * k) / n;   // right to left
        const ragged = Math.sin(ex * 0.05 + f.seed + now * 0.012) * 0.5 + Math.sin(ex * 0.13 - now * 0.02 + f.seed * 2) * 0.35;
        edge.push(ex, front + ragged * h * 0.05);
      }
      f.mask.clear().poly([x - 2, y - h, x + w + 2, y - h, x + w + 2, edge[1], ...edge, x - 2, edge[edge.length - 1]]).fill(0xffffff);
      // Scorched band, then the glowing edge.
      const scorch = [];
      for (let k = 0; k < edge.length; k += 2) scorch.push(edge[k], edge[k + 1] - h * 0.07);
      const rev = [];
      for (let k = edge.length - 2; k >= 0; k -= 2) rev.push(edge[k], edge[k + 1]);
      f.glow.clear();
      if (p < 1) {
        f.glow.poly([...scorch, ...rev]).fill({ color: 0x1a0e08, alpha: 0.55 });
        f.glow.poly(edge, false).stroke({ width: h * 0.03, color: 0xff6a1a, alpha: 0.9, join: 'round', cap: 'round' });
        f.glow.poly(edge, false).stroke({ width: h * 0.012, color: 0xffe08a, join: 'round', cap: 'round' });
        // Flames, embers and smoke rise from the edge.
        const size = Math.max(w * Math.abs(f.box.scale.x), h * Math.abs(f.box.scale.y));
        for (let k = 0; k < 3; k++) {
          const j = Math.floor(Math.random() * (edge.length / 2)) * 2;
          const pt = this._toBoard(f, edge[j], edge[j + 1]);
          const kind = Math.random() < 0.6 ? 'flame' : Math.random() < 0.5 ? 'ember' : 'smoke';
          this.particles.push({
            x: pt.x, y: pt.y, kind, age: 0,
            vx: (Math.random() - 0.5) * size * 0.08,
            vy: -size * (kind === 'smoke' ? 0.35 : kind === 'ember' ? 0.7 : 0.6) * (0.6 + Math.random()),
            life: kind === 'smoke' ? 1.2 : kind === 'ember' ? 0.8 : 0.35,
            r: size * (kind === 'smoke' ? 0.035 : kind === 'ember' ? 0.006 : 0.022) * (0.6 + Math.random() * 0.8),
          });
        }
      } else {
        // Burnt out: what's left is a little pile of ash where its bottom was.
        const base = this._toBoard(f, x + w / 2, y + h);
        const width = Math.max(w * Math.abs(f.box.scale.x), 20);
        this.piles.push({ x: base.x, y: base.y, w: Math.max(40, Math.min(420, width * 0.3)), left: 1, start: now });
        f.box.destroy({ children: true, texture: f.image, textureSource: f.image });
        this.burning.splice(this.burning.indexOf(f), 1);
      }
    }

    // Particles drift and fade.
    for (const q of this.particles) {
      q.age += dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= 0.98;
      if (q.kind === 'smoke') q.r *= 1 + dt * 0.8;
    }
    this.particles = this.particles.filter((q) => q.age < q.life);
    if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);

    this._stepSweeper(now, dt);
    this._drawFx(now);
  }

  _stepSweeper(now, dt) {
    let s = this.sweeper;
    const piles = this.piles.filter((pl) => pl.left > 0);
    if (!s && piles.length && now - (this._lastSweeperGone || 0) > 600) {
      // A sweeper walks in from the left of the first pile, about 6 of its sizes away.
      const pl = piles[0];
      const size = pl.w * 0.8;
      s = this.sweeper = { x: pl.x - size * 4, y: pl.y, size, state: 'walk', target: pl, facing: 1, t: 0, phase: 0 };
    }
    if (!s) return;
    s.t += dt;
    const speed = s.size * 2.2;
    if (s.state === 'walk') {
      const pl = s.target;
      if (!pl || pl.left <= 0) { s.target = piles[0] || null; if (!s.target) { s.state = 'leave'; s.t = 0; } return; }
      s.size += (pl.w * 0.8 - s.size) * Math.min(1, dt * 3);
      const goal = pl.x - pl.w * 0.55 - s.size * 0.45;   // stand just left of the pile
      const dx = goal - s.x, dy = pl.y - s.y;
      const dist = Math.hypot(dx, dy);
      const v = Math.max(speed, dist / 2.5);              // far piles: hurry a bit
      s.facing = dx >= 0 ? 1 : -1;
      if (dist < v * dt) { s.x = goal; s.y = pl.y; s.state = 'sweep'; s.t = 0; s.facing = 1; }
      else { s.x += (dx / dist) * v * dt; s.y += (dy / dist) * v * dt; s.phase += dt * 9; }
    } else if (s.state === 'sweep') {
      const pl = s.target;
      pl.left = Math.max(0, pl.left - dt / 1.8);
      s.phase += dt * 11;
      if (Math.random() < 0.5) {
        this.particles.push({ kind: 'dust', x: pl.x - pl.w * 0.3 + Math.random() * pl.w * 0.4, y: pl.y - Math.random() * pl.w * 0.1, vx: pl.w * (0.5 + Math.random()), vy: -pl.w * 0.25 * Math.random(), age: 0, life: 0.8, r: pl.w * 0.06 * (0.5 + Math.random()) });
      }
      if (pl.left <= 0) {
        this.piles.splice(this.piles.indexOf(pl), 1);
        // The next pile (nearest first), or off they go.
        const rest = this.piles.filter((x) => x.left > 0).sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
        s.target = rest[0] || null;
        s.state = s.target ? 'walk' : 'leave';
        s.t = 0;
      }
    } else if (s.state === 'leave') {
      s.facing = -1;
      s.x -= speed * dt;
      s.phase += dt * 9;
      if (s.t > 1.6) { this.sweeper = null; this._lastSweeperGone = now; }
      if (piles.length) { s.target = piles[0]; s.state = 'walk'; }
    }
  }

  _drawFx(now) {
    const g = this.fx;
    g.clear();
    for (const q of this.particles) {
      const k = 1 - q.age / q.life;
      if (q.kind === 'flame') g.circle(q.x, q.y, q.r * (0.4 + k * 0.6)).fill({ color: k > 0.5 ? 0xffd166 : 0xff7a1a, alpha: 0.85 * k });
      else if (q.kind === 'ember') g.circle(q.x, q.y, q.r).fill({ color: 0xffb347, alpha: k });
      else g.circle(q.x, q.y, q.r).fill({ color: q.kind === 'dust' ? 0x8a8580 : 0x55524f, alpha: (q.kind === 'dust' ? 0.5 : 0.28) * k });
    }
    // Ash piles: a soft grey mound with darker specks; fresh ones still glow a little.
    for (const pl of this.piles) {
      const w = pl.w * (0.35 + 0.65 * pl.left), h = w * 0.32;
      if (w < 0.5) continue;
      g.ellipse(pl.x, pl.y, w * 0.5, h * 0.5).fill({ color: 0x4a4644, alpha: 0.95 });
      g.ellipse(pl.x - w * 0.05, pl.y - h * 0.18, w * 0.32, h * 0.32).fill({ color: 0x6b6662 });
      for (let k = 0; k < 7; k++) {
        const a = k * 2.4 + pl.start * 0.001;
        g.circle(pl.x + Math.cos(a) * w * 0.33, pl.y + Math.sin(a) * h * 0.25, w * 0.025).fill(0x2c2a29);
      }
      const hot = 1 - Math.min(1, (now - pl.start) / 2500);
      if (hot > 0) g.circle(pl.x + w * 0.08, pl.y - h * 0.1, w * 0.04).fill({ color: 0xff8a2a, alpha: hot * (0.6 + 0.4 * Math.sin(now * 0.02)) });
    }
    if (this.sweeper) this._drawSweeper(g, this.sweeper, now);
  }

  // The sweeper: a little round character in a red bandana, with a broom.
  // (Placeholder art: swap in your own character later.)
  _drawSweeper(g, s, now) {
    const S = s.size, f = s.facing, x = s.x, y = s.y;
    const walking = s.state !== 'sweep';
    const step = Math.sin(s.phase);
    const bob = walking ? Math.abs(step) * S * 0.05 : Math.abs(Math.sin(s.phase)) * S * 0.02;
    const ink = 0x2b2b30, line = { width: S * 0.05, color: ink, join: 'round', cap: 'round' };
    const fade = s.state === 'leave' ? Math.max(0, 1 - s.t / 1.6) : 1;
    g.ellipse(x, y + S * 0.02, S * 0.42, S * 0.08).fill({ color: 0x000000, alpha: 0.25 * fade });
    // Feet.
    for (const side of [-1, 1]) {
      const lift = walking ? Math.max(0, side * step) * S * 0.08 : 0;
      g.ellipse(x + side * S * 0.14 + (walking ? side * step * S * 0.06 : 0), y - S * 0.04 - lift, S * 0.11, S * 0.06).fill({ color: ink, alpha: fade });
    }
    // Broom: the handle from the hands down to the bristles on the ground.
    const swing = s.state === 'sweep' ? Math.sin(s.phase) * 0.55 : 0.25;
    const hx = x + f * S * 0.22, hy = y - S * 0.55 - bob;
    const bx = x + f * (S * 0.55 + Math.sin(swing) * S * 0.35), by = y - S * 0.06;
    g.moveTo(hx, hy).lineTo(bx, by).stroke({ width: S * 0.06, color: 0x8b5a2b, cap: 'round', alpha: fade });
    g.poly([bx - S * 0.18, by + S * 0.05, bx + S * 0.18, by + S * 0.05, bx + S * 0.08, by - S * 0.12, bx - S * 0.08, by - S * 0.12]).fill({ color: 0xd9a441, alpha: fade }).stroke({ ...line, width: S * 0.035, alpha: fade });
    // Body.
    g.roundRect(x - S * 0.3, y - S * 0.95 - bob, S * 0.6, S * 0.86, S * 0.28).fill({ color: 0xf2e6cf, alpha: fade }).stroke({ ...line, alpha: fade });
    // Bandana.
    g.roundRect(x - S * 0.31, y - S * 0.97 - bob, S * 0.62, S * 0.2, S * 0.1).fill({ color: 0xe8573f, alpha: fade });
    g.poly([x - f * S * 0.3, y - S * 0.88 - bob, x - f * S * 0.48, y - S * 0.8 - bob + Math.sin(now * 0.012) * S * 0.04, x - f * S * 0.3, y - S * 0.8 - bob]).fill({ color: 0xe8573f, alpha: fade });
    // Eyes (they blink now and then) and rosy cheeks.
    const blink = (now % 3200) < 120 ? 0.15 : 1;
    for (const ex of [0.02, 0.16]) {
      g.ellipse(x + f * S * ex, y - S * 0.62 - bob, S * 0.035, S * 0.055 * blink).fill({ color: ink, alpha: fade });
    }
    g.circle(x + f * S * 0.22, y - S * 0.52 - bob, S * 0.04).fill({ color: 0xf08a7a, alpha: 0.7 * fade });
    // Arm reaching for the broom.
    g.moveTo(x + f * S * 0.05, y - S * 0.45 - bob).lineTo(hx, hy).stroke({ ...line, alpha: fade });
  }

  // Let any burning finish instantly and clear the ash (e.g. when leaving a board).
  clearFx() {
    for (const f of this.burning) f.box.destroy({ children: true, texture: f.image, textureSource: f.image });
    this.burning = [];
    this.particles = [];
    this.piles = [];
    this.sweeper = null;
    this.fx.clear();
  }

  // Finish any landing animations right away (e.g. when you grab an image mid-pop).
  settleAll() {
    for (const item of this.items) if (item.anim) { item.sprite.scale.set(item.anim.sx, item.anim.sy); delete item.anim; }
  }

  _stepAnimations(now) {
    for (const item of this.items) {
      const a = item.anim;
      if (!a) continue;
      const t = (now - a.start) / 1000;
      if (t < 0) { item.sprite.scale.set(a.sx * 0.001, a.sy * 0.001); continue; }
      if (t > 0.7) { item.sprite.scale.set(a.sx, a.sy); delete item.anim; continue; }
      // From 55 % to a little over full size and back: a damped spring.
      const f = 1 - 0.45 * Math.exp(-7 * t) * Math.cos(15 * t);
      item.sprite.scale.set(a.sx * f, a.sy * f);
    }
    this.splashes = this.splashes.filter((sp) => now - sp.start < 650);
  }

  _drawSplashes(o, zoom, now) {
    for (const sp of this.splashes) {
      const t = (now - sp.start) / 650;
      if (t < 0) continue;
      const ease = 1 - (1 - t) ** 3;
      const fade = 1 - t;
      // A ring spreading out…
      o.circle(sp.x, sp.y, sp.r * (0.62 + 0.3 * ease)).stroke({ width: (2.5 / zoom) * fade + 0.5 / zoom, color: sp.colour, alpha: 0.35 * fade });
      // …and droplets thrown outward.
      for (let i = 0; i < 9; i++) {
        const ang = i * 0.698 + (sp.start % 1000) * 0.006;
        const dist = sp.r * (0.7 + 0.4 * ease + (i % 3) * 0.06);
        const size = (6 - (i % 3) * 1.5) / zoom * fade + sp.r * 0.012 * fade;
        o.circle(sp.x + Math.cos(ang) * dist, sp.y + Math.sin(ang) * dist, size).fill({ color: sp.colour, alpha: 0.85 * fade });
      }
    }
  }

  // Keep captions under their images, and apply Focus mode. Cheap, so it runs every frame.
  syncImages() {
    for (const item of this.items) {
      this.placeCaption(item);
      const faded = this.focus && !item.star;
      item.sprite.alpha = (item.opacity ?? 1) * (faded ? 0.12 : 1);
      if (item.captionText) item.captionText.alpha = faded ? 0.1 : 0.85;
    }
    const fade = this.focus ? 0.15 : 1;
    this.noteLayer.alpha = this.shapeLayer.alpha = this.strokeLayer.alpha = fade;
  }

  get starred() { return this.items.filter((i) => i.star); }

  // Show only part of a picture. `crop` is { x, y, w, h } in the picture's own pixels
  // (null shows all of it). With keepPlace the visible part stays where it was on the board.
  setCrop(item, crop, { keepPlace = true } = {}) {
    const s = item.sprite;
    const old = item.crop || { x: 0, y: 0, w: item.fullWidth, h: item.fullHeight };
    let c = crop;
    if (c) {
      const x = Math.max(0, Math.min(item.fullWidth - 1, Math.round(c.x)));
      const y = Math.max(0, Math.min(item.fullHeight - 1, Math.round(c.y)));
      c = { x, y, w: Math.max(1, Math.min(item.fullWidth - x, Math.round(c.w))), h: Math.max(1, Math.min(item.fullHeight - y, Math.round(c.h))) };
      if (c.x === 0 && c.y === 0 && c.w === item.fullWidth && c.h === item.fullHeight) c = null;
    }
    const now = c || { x: 0, y: 0, w: item.fullWidth, h: item.fullHeight };
    if (keepPlace) {
      // Move the centre so the part that stays visible doesn't jump.
      const dx = (now.x + now.w / 2) - (old.x + old.w / 2);
      const dy = (now.y + now.h / 2) - (old.y + old.h / 2);
      const cos = Math.cos(s.rotation), sin = Math.sin(s.rotation);
      const lx = dx * s.scale.x, ly = dy * s.scale.y;
      s.position.set(s.x + lx * cos - ly * sin, s.y + lx * sin + ly * cos);
    }
    const old_texture = s.texture;
    s.texture = new Texture({ source: item.source, frame: new Rectangle(now.x, now.y, now.w, now.h) });
    if (old_texture !== s.texture) old_texture.destroy(false);
    item.crop = c;
    item.width = now.w;
    item.height = now.h;
  }

  // Greyscale on or off, to check values.
  setGrey(item, on) {
    item.grey = !!on;
    if (on) {
      const f = new ColorMatrixFilter();
      f.desaturate();
      item.sprite.filters = [f];
    } else {
      item.sprite.filters = null;
    }
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

  // ---------- Notes and text ----------
  //
  // Two kinds, made the same way:
  //   sticky  a coloured label with text on it (the Note tool)
  //   text    free text with no background, in levels (the Text tool)
  // Text has a font, a level (Title, Heading 1-3, Body, Caption), bold, italic and
  // alignment. `base` is the size Body text would have; each level is a multiple of it.

  addNote({ id, x, y, text = '', color = '#ffb547', fontSize = 20, index, locked = false,
    style = 'sticky', font = 'Inter', level = 'body', base, weight, italic = false, align = 'left', scale = 1, rotation = 0, group = null, box = 'none' }) {
    const container = new Container();
    const bg = new Graphics();
    const label = new Text({ text: '', style: { wordWrap: true, breakWords: true } });
    container.addChild(bg, label);
    container.position.set(x, y);
    container.scale.set(scale);
    container.rotation = rotation;
    if (!LEVELS[level]) level = 'body';
    const note = {
      kind: 'note', id: takeId(id), sprite: container, bg, label, text, color, locked: !!locked, group, box,
      style: style === 'text' ? 'text' : 'sticky', font, level, italic: !!italic, align,
      base: base || (style === 'text' ? fontSize / LEVELS[level].size : fontSize),
      weight: weight || (style === 'text' ? LEVELS[level].weight : 400),
      fontSize, width: 0, height: 0,
    };
    this.setNoteText(note, text);
    const at = index === undefined ? this.notes.length : Math.max(0, Math.min(index, this.notes.length));
    this.notes.splice(at, 0, note);
    this.noteLayer.addChildAt(container, at);
    return note;
  }

  // Change a note's text (and colour), and lay it out again.
  setNoteText(note, text, color = note.color) {
    note.text = text;
    note.color = color;
    this.layoutNote(note);
  }

  // Lay a note or text out again after any change to its words or style.
  layoutNote(note) {
    const text = note.style === 'text';
    if (text) note.fontSize = note.base * LEVELS[note.level].size;
    const fs = note.fontSize;
    const boxed = text && note.box && note.box !== 'none';
    const pad = text ? (boxed ? fs * 0.45 : fs * 0.12) : fs * 0.55;
    const st = note.label.style;
    st.fontFamily = fontStack(note.font || 'Inter');
    st.fontSize = fs;
    st.fontWeight = String(note.weight || 400);
    st.fontStyle = note.italic ? 'italic' : 'normal';
    st.lineHeight = fs * (text ? 1.2 : 1.3);
    st.align = note.align || 'left';
    st.wordWrapWidth = text ? note.base * 34 : fs * 16;
    st.fill = text ? note.color : textColourFor(note.color);
    st.letterSpacing = text && note.level === 'title' ? -fs * 0.02 : 0;
    note.label.text = note.text || ' ';
    note.width = Math.max(fs * (text ? 1 : 2), note.label.width + pad * 2);
    note.height = note.label.height + pad * 2;
    // Line the text up inside its box by its alignment.
    const inner = note.width - pad * 2;
    const offset = note.align === 'center' ? (inner - note.label.width) / 2 : note.align === 'right' ? inner - note.label.width : 0;
    note.label.position.set(pad + offset, pad);
    note.bg.clear();
    if (!text) note.bg.roundRect(0, 0, note.width, note.height, fs * 0.35).fill(note.color);
    // Text can sit on a soft box or inside an outline, to stay readable over images.
    if (boxed) {
      note.bg.roundRect(0, 0, note.width, note.height, fs * 0.3);
      if (note.box === 'fill') note.bg.fill({ color: textColourFor(note.color) === '#1b1b1d' ? 0x1b1b1d : 0xffffff, alpha: 0.82 });
      else note.bg.stroke({ width: Math.max(1, fs * 0.06), color: note.color });
    }
    // Position, like images, is the centre of the note.
    note.sprite.pivot.set(note.width / 2, note.height / 2);
  }

  // Draw every note again (e.g. once a font has finished loading).
  relayoutNotes() {
    for (const n of this.notes) {
      n.label.style = n.label.style.clone();
      this.layoutNote(n);
    }
  }

  noteJSON(n) {
    const s = n.sprite;
    return {
      id: n.id, x: s.x, y: s.y, text: n.text, color: n.color, fontSize: n.fontSize,
      ...(n.style === 'text' ? { style: 'text', level: n.level, base: n.base } : {}),
      ...(n.font && n.font !== 'Inter' ? { font: n.font } : {}),
      ...(n.weight && n.weight !== (n.style === 'text' ? LEVELS[n.level].weight : 400) ? { weight: n.weight } : {}),
      ...(n.italic ? { italic: true } : {}),
      ...(n.box && n.box !== 'none' ? { box: n.box } : {}),
      ...(n.align && n.align !== 'left' ? { align: n.align } : {}),
      ...(s.scale.x !== 1 ? { scale: s.scale.x } : {}),
      ...(s.rotation ? { rotation: s.rotation } : {}),
      ...(n.locked ? { locked: true } : {}),
      ...(n.group ? { group: n.group } : {}),
    };
  }

  // Text is drawn as a picture, so it gets blurry when you zoom in. This redraws
  // each note's text sharp enough for the most zoomed-in pane, within limits.
  updateTextSharpness(maxZoom, pixelRatio) {
    for (const n of this.notes) {
      const want = Math.min(maxZoom * pixelRatio, 4096 / Math.max(n.width, n.height, 1));
      const res = 2 ** Math.ceil(Math.log2(Math.max(0.25, want)));
      if (n.label.resolution !== res) n.label.resolution = res;
    }
    for (const i of this.items) {
      const t = i.captionText;
      if (!t) continue;
      const want = Math.min(maxZoom * pixelRatio * t.scale.x, 4096 / Math.max(CAPTION_WRAP, t.height / (t.scale.y || 1), 1));
      const res = 2 ** Math.ceil(Math.log2(Math.max(0.25, want)));
      if (t.resolution !== res) t.resolution = res;
    }
  }

  // ---------- Things you can select and move: images and notes ----------

  remove(item) {
    const list = this.listOf(item.kind);
    const i = list.indexOf(item);
    if (i === -1) return -1;
    if (item.captionText) { item.captionText.destroy(); item.captionText = null; }
    list.splice(i, 1);
    this.selection = this.selection.filter((x) => x !== item);
    // Also free the picture from graphics memory.
    if (item.kind === 'image') item.sprite.destroy({ texture: true, textureSource: true });
    else item.sprite.destroy({ children: true });
    return i;
  }

  find(kind, id) {
    return this.listOf(kind).find((x) => x.id === id) || null;
  }

  // Lock or unlock one thing, or everything on the board. Returns what changed.
  setLocked(target, locked) {
    const all = target === 'all' ? [...this.selectable, ...this.strokes] : [target];
    const changed = all.filter((x) => !!x.locked !== locked);
    for (const x of changed) x.locked = locked;
    if (locked) this.selection = this.selection.filter((x) => !changed.includes(x));
    return changed;
  }

  // Remove everything (used when leaving a board).
  clear() {
    this.clearFx();
    for (const item of [...this.items]) this.remove(item);
    for (const note of [...this.notes]) this.remove(note);
    for (const shape of [...this.shapes]) this.remove(shape);
    for (const frame of [...this.frames]) this.remove(frame);
    for (const stroke of [...this.strokes]) this.removeStroke(stroke);
    this.selection = [];
  }

  // Draw it above the others of its kind.
  bringToFront(item) {
    if (item.kind === 'frame') return;  // frames keep their slide order
    const list = this.listOf(item.kind);
    const i = list.indexOf(item);
    if (i === -1 || i === list.length - 1) return;
    list.splice(i, 1);
    list.push(item);
    const layer = item.sprite.parent;
    layer.setChildIndex(item.sprite, layer.children.length - 1);
  }

  // Draw it below the others of its kind.
  sendToBack(item) {
    if (item.kind === 'frame') return;
    const list = this.listOf(item.kind);
    const i = list.indexOf(item);
    if (i <= 0) return;
    list.splice(i, 1);
    list.unshift(item);
    item.sprite.parent.setChildIndex(item.sprite, 0);
  }

  // Which note or image is at this board position? Notes are on top, so they're checked first.
  // Written to also work once images can be rotated, scaled and flipped.
  // Locked things are skipped unless includeLocked is set (the right-click menu uses it to unlock).
  hitTest(wx, wy, { includeLocked = false } = {}) {
    const lists = [this.notes, this.shapes, this.items, this.frames];
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
        const lx = (dx * cos - dy * sin) / (item.anim?.sx ?? s.scale.x);
        const ly = (dx * sin + dy * cos) / (item.anim?.sy ?? s.scale.y);
        if (Math.abs(lx) <= item.width / 2 && Math.abs(ly) <= item.height / 2) return item;
        if (item.captionText) {
          // The caption counts as part of its image.
          const f = this.captionFrame(item);
          const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
          if (Math.abs(rx) <= f.w / 2 && ry >= f.h / 2 && ry <= f.h / 2 + f.gap + f.textH) return item;
        }
      }
    }
    return null;
  }

  // The four corners of an image or note on the board, after rotation and scale.
  corners(item) {
    const s = item.sprite;
    // (While an image is popping in, use the size it's settling to.)
    const hw = (item.width / 2) * (item.anim?.sx ?? s.scale.x);
    const hh = (item.height / 2) * (item.anim?.sy ?? s.scale.y);
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
    for (const item of items || this.selectable) {
      for (const p of this.corners(item)) add(p.x, p.y);
      if (item.captionText) for (const p of this.captionCorners(item)) add(p.x, p.y);
    }
    if (!items) for (const s of this.strokes) if (s.box) { add(s.box.x, s.box.y); add(s.box.x + s.box.width, s.box.y + s.box.height); }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Images and notes inside a rectangle of the board (for the selection box).
  inRect(x0, y0, x1, y1) {
    const [l, r, t, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    return this.selectable.filter((item) => {
      if (item.locked) return false;
      const box = this.bounds([item]);
      // Frames only when the box goes all the way round them.
      if (item.kind === 'frame') return box.x >= l && box.x + box.width <= r && box.y >= t && box.y + box.height <= b;
      return box.x < r && box.x + box.width > l && box.y < b && box.y + box.height > t;
    });
  }

  // The box the scale and rotate handles sit on: the item itself (turned with it) for
  // one selected thing, or a straight box around several.
  // { cx, cy, w, h, rotation, corners: [4 points] }
  selectionBox() {
    if (!this.selection.length) return null;
    if (this.selection.length === 1) {
      const item = this.selection[0];
      const s = item.sprite;
      return { cx: s.x, cy: s.y, w: Math.abs(item.width * s.scale.x), h: Math.abs(item.height * s.scale.y), rotation: s.rotation, corners: this.corners(item) };
    }
    const b = this.bounds(this.selection);
    const corners = [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height, rotation: 0, corners };
  }

  // Where the handles are, in board units, for a pane at this zoom.
  // corners: scale from that corner; rotate: the round handle above the top edge.
  handles(zoom) {
    const box = this.selectionBox();
    if (!box) return null;
    const up = { x: Math.sin(box.rotation), y: -Math.cos(box.rotation) };
    const topMid = { x: (box.corners[0].x + box.corners[1].x) / 2, y: (box.corners[0].y + box.corners[1].y) / 2 };
    return {
      box,
      corners: box.corners,
      rotate: { x: topMid.x + up.x * 26 / zoom, y: topMid.y + up.y * 26 / zoom },
      topMid,
    };
  }

  // Redraw the blue outlines, the handles and the selection box. Sizes are divided
  // by zoom so they look the same on screen at any zoom.
  drawOverlay(zoom, { handles = true } = {}) {
    const o = this.overlay;
    o.clear();
    const now = performance.now();
    this._stepAnimations(now);
    this._stepFx(now);
    this.syncImages();
    this._drawSplashes(o, zoom, now);
    // A small star at the top-right corner of starred images (the same size at any zoom).
    for (const item of this.items) {
      if (!item.star || !item.sprite.visible) continue;
      const c = this.corners(item);
      const x = Math.max(...c.map((p) => p.x)), y = Math.min(...c.map((p) => p.y));
      const R = 9 / zoom, cx = x - R * 1.6, cy = y + R * 1.6;
      const pts = [];
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? R * 0.45 : R;
        pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      o.circle(cx, cy, R * 1.35).fill({ color: 0x000000, alpha: 0.45 });
      o.poly(pts).fill(0xffc83d);
    }
    const line = 1.5 / zoom;
    for (const item of this.selection) {
      o.poly(this.corners(item).flatMap((p) => [p.x, p.y])).stroke({ width: line, color: 0x4da3ff, alignment: 0.5 });
    }
    const h = handles && this.handles(zoom);
    if (h) {
      if (this.selection.length > 1) o.poly(h.corners.flatMap((p) => [p.x, p.y])).stroke({ width: line, color: 0x4da3ff, alpha: 0.6 });
      if (!this.selection.some((x) => x.locked)) {
        o.moveTo(h.topMid.x, h.topMid.y).lineTo(h.rotate.x, h.rotate.y).stroke({ width: line, color: 0x4da3ff });
        o.circle(h.rotate.x, h.rotate.y, 5 / zoom).fill(0xffffff).stroke({ width: line, color: 0x4da3ff });
        const r = 4.5 / zoom;
        for (const c of h.corners) o.roundRect(c.x - r, c.y - r, r * 2, r * 2, r * 0.5).fill(0xffffff).stroke({ width: line, color: 0x4da3ff });
      }
    }
    // Snapping guides: thin pink lines where edges or middles line up.
    for (const g of this.guides || []) {
      o.moveTo(g.x1, g.y1).lineTo(g.x2, g.y2).stroke({ width: 1 / zoom, color: 0xff3d8b });
      const r = 2.5 / zoom;
      for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) o.moveTo(x - r, y - r).lineTo(x + r, y + r).moveTo(x + r, y - r).lineTo(x - r, y + r).stroke({ width: 1 / zoom, color: 0xff3d8b });
    }
    if (this.marquee) {
      const m = this.marquee;
      o.rect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0))
        .fill({ color: 0x4da3ff, alpha: 0.08 }).stroke({ width: 1 / zoom, color: 0x4da3ff });
    }
  }

  // Where a new picture of this size can go near (x, y) without covering anything:
  // tries spots in widening rings around the point and takes the closest free one.
  freeSpot(w, h, x, y, gap = 30) {
    const boxes = [...this.items, ...this.notes, ...this.shapes].map((i) => this.bounds([i]));
    const free = (cx, cy) => boxes.every((b) => cx + w / 2 + gap <= b.x || cx - w / 2 - gap >= b.x + b.width || cy + h / 2 + gap <= b.y || cy - h / 2 - gap >= b.y + b.height);
    if (free(x, y)) return { x, y };
    const step = Math.max(40, Math.min(w, h) / 3);
    for (let ring = 1; ring < 60; ring++) {
      let best = null;
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
          const cx = x + dx * step, cy = y + dy * step;
          const d = Math.hypot(dx, dy);
          if ((!best || d < best.d) && free(cx, cy)) best = { x: cx, y: cy, d };
        }
      }
      if (best) return best;
    }
    return { x, y };
  }

  // ---------- Saving ----------

  toJSON() {
    return {
      items: this.items.map((i) => this.imageJSON(i)),
      strokes: this.strokes.map((s) => this.strokeJSON(s)),
      notes: this.notes.map((n) => this.noteJSON(n)),
      shapes: this.shapes.map((x) => this.shapeJSON(x)),
      frames: this.frames.map((f) => this.frameJSON(f)),
    };
  }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
