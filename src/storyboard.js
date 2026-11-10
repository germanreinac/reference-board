// Storyboards: a sequence of panels that lives on the board and lays itself out.
//
// A storyboard is kept as data with the board (board.storyboards):
//   { id, name, ratio, cols, origin: { x, y }, panels: [{ id, art, shot, camera, duration,
//     action, dialogue, notes }] }
// `art` is the id of the panel's picture on the board: an image, or a blank sketch to draw
// in (double-click it, or Draw in the editor). Everything else you see (white pages,
// outlines, numbers, the shot line, action and dialogue) is drawn from the data, so it
// always stays in order: add, insert, move or delete a panel and the pages re-flow.
// Drag a page to move the whole storyboard.
//
// The Storyboard panel (on the right) edits it: the panels in order (drag to reorder),
// and for the chosen one its shot, camera move, duration, action, dialogue and notes.
// Play shows it as an animatic (each panel for its duration); PDF exports the pages.

export const SHOTS = ['Establishing', 'Wide', 'Full', 'Medium', 'Medium close-up', 'Close-up', 'Extreme close-up', 'Over the shoulder', 'POV', 'Insert', 'Two shot', 'Aerial'];
export const MOVES = ['Static', 'Pan', 'Tilt', 'Dolly in', 'Dolly out', 'Truck', 'Track', 'Zoom in', 'Zoom out', 'Crane', 'Handheld', 'Whip pan'];
export const RATIOS = [
  ['16:9 · screen', 16 / 9], ['2.39:1 · scope', 2.39], ['1.85:1 · cinema', 1.85],
  ['4:3', 4 / 3], ['1:1 · square', 1], ['4:5 · portrait', 4 / 5], ['9:16 · phone', 9 / 16],
];

const PW = 900;                 // panel width on the board
const GAP_X = 80, HEAD = 74, TEXT = 230, MARGIN = 110, PAGE_GAP = 180;
const INK = '#1b1b1d', SOFT = '#55555c';
const SHEET = 1920;             // pixels across a blank panel's sketch

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newPanel = (art = null) => ({ id: uid('pn'), art, shot: 'Wide', camera: 'Static', duration: 2, action: '', dialogue: '', notes: '' });

export class Storyboards {
  // api: { board(), addSheet(w, h, paper, opts), removeImage(id), thingData(item),
  //        restoreThing(data), push(undoStep), changed(), render(), paint(item),
  //        focus(bounds), exportFrames(frames), toast(msg), selectedImages() }
  constructor(api) {
    this.api = api;
    this.el = null;
    this.open = null;       // the storyboard being edited
    this.chosen = null;     // the panel chosen in the editor
    this.player = null;
  }

  get board() { return this._board || this.api.board(); }

  // Draw the storyboards of a board that's just been opened.
  layoutAllOn(b) {
    const prev = this._board;
    this._board = b;
    try { this.layoutAll(); } finally { this._board = prev; }
  }

  // Its pages were dragged somewhere: it lives there now (one undo step).
  moved(ids) {
    for (const id of ids) {
      const sb = this.find(id);
      if (!sb) continue;
      const before = JSON.stringify(sb);
      this.layout(sb);
      const after = JSON.stringify(sb);
      if (before === after) continue;
      const set = (json) => { const now = this.find(id); if (!now) return; this.clearDrawn(id); Object.assign(now, JSON.parse(json)); this.layoutFrom(now); this.api.render(); };
      this.api.push({ undo: () => set(before), redo: () => set(after) });
      this.api.changed();
    }
    this.api.render();
  }

  // Lay out at the position in the data (not where the pages are now).
  layoutFrom(sb) {
    this.clearDrawn(sb.id);
    this.layout(sb);
  }
  get list() { return (this.board.storyboards ||= []); }
  find(id) { return this.list.find((s) => s.id === id) || null; }

  // ---------- Making one ----------

  async create({ name, ratio, cols, count, images = [], at }) {
    const sb = { id: uid('sb'), name: name || `Storyboard ${this.list.length + 1}`, ratio, cols, origin: { x: 0, y: 0 }, panels: [] };
    const n = images.length || count;
    const size = this.pageSize(sb, n);
    const spot = this.board.freeSpot(size.w, size.h, at.x, at.y);
    sb.origin = { x: spot.x - size.w / 2, y: spot.y - size.h / 2 };
    for (let i = 0; i < n; i++) sb.panels.push(newPanel(images[i]?.id ?? null));
    const before = images.map((it) => this.api.stateOf(it));
    this.list.push(sb);
    await this.fillArt(sb);
    this.layout(sb);
    const made = sb.panels.filter((p, i) => !images[i]).map((p) => this.board.find('image', p.art)).filter(Boolean).map((x) => this.api.thingData(x));
    const model = JSON.stringify(sb);
    this.api.push({
      undo: () => {
        made.forEach((d) => this.api.removeImage(d.data.id));
        this.removeModel(sb.id);
        before.forEach((st) => this.api.applyState(st));
        this.api.render();
      },
      redo: async () => {
        for (const d of made) await this.api.restoreThing(d);
        this.list.push(JSON.parse(model));
        this.layout(this.find(sb.id));
        this.api.render();
      },
    });
    this.api.changed();
    this.edit(sb, sb.panels[0]);
    this.api.focus(this.bounds(sb));
    return sb;
  }

  // Panels with no picture get a blank sketch to draw in.
  async fillArt(sb) {
    for (const p of sb.panels) {
      if (p.art != null && this.board.find('image', p.art)) continue;
      const W = SHEET, H = Math.round(SHEET / sb.ratio);
      const k = PW / W;
      const item = await this.api.addSheet(W, H, '#ffffff', { x: sb.origin.x, y: sb.origin.y, scaleX: k, scaleY: k, name: 'Panel' });
      p.art = item.id;
    }
  }

  removeModel(id) {
    const i = this.list.findIndex((s) => s.id === id);
    if (i >= 0) this.list.splice(i, 1);
    this.clearDrawn(id);
    if (this.open?.id === id) this.close();
  }

  // ---------- Laying it out ----------

  rows(sb) { return sb.ratio < 1 ? 2 : 3; }
  pageSize(sb, n = sb.panels.length) {
    const cols = Math.min(sb.cols, Math.max(1, n));
    const rows = Math.max(1, Math.min(this.rows(sb), Math.ceil(n / sb.cols)));
    const ph = PW / sb.ratio;
    const w = MARGIN * 2 + cols * PW + (cols - 1) * GAP_X;
    const h = MARGIN * 2 + rows * (HEAD + ph + TEXT);
    const pages = Math.max(1, Math.ceil(n / (sb.cols * this.rows(sb))));
    return { w: MARGIN * 2 + sb.cols * PW + (sb.cols - 1) * GAP_X, pageH: h, h: pages * h + (pages - 1) * PAGE_GAP, pages, w0: w };
  }

  drawn(id) {
    const b = this.board;
    return [...b.frames, ...b.notes, ...b.shapes].filter((x) => x.sbGen === id);
  }
  clearDrawn(id) { for (const x of this.drawn(id)) this.board.remove(x); }

  // Where everything goes: pages, then panels in reading order.
  layout(sb) {
    if (!sb) return;
    const b = this.board;
    // Moved the pages? Follow them.
    const first = b.frames.find((f) => f.sbGen === sb.id && f.sbPage === 0);
    if (first) sb.origin = { x: first.sprite.x - first.w / 2, y: first.sprite.y - first.h / 2 };
    this.clearDrawn(sb.id);
    const n = sb.panels.length;
    const size = this.pageSize(sb);
    const PH = Math.round(PW / sb.ratio);
    const perPage = sb.cols * this.rows(sb);
    const cellH = HEAD + PH + TEXT;
    const base = Math.round(PW / 32);
    const tag = (x) => { x.sbGen = sb.id; return x; };
    for (let pg = 0; pg < size.pages; pg++) {
      const top = sb.origin.y + pg * (size.pageH + PAGE_GAP);
      const f = b.addFrame({ x: sb.origin.x + size.w / 2, y: top + size.pageH / 2, w: size.w, h: size.pageH, name: size.pages > 1 ? `${sb.name} · ${pg + 1}/${size.pages}` : sb.name, titleSize: base * 1.4, fill: '#ffffff', index: pg });
      tag(f).sbPage = pg;
    }
    sb.panels.forEach((p, i) => {
      const pg = Math.floor(i / perPage), k = i % perPage, r = Math.floor(k / sb.cols), c = k % sb.cols;
      const x0 = sb.origin.x + MARGIN + c * (PW + GAP_X);
      const y0 = sb.origin.y + pg * (size.pageH + PAGE_GAP) + MARGIN + r * cellH + HEAD;
      const cx = x0 + PW / 2, cy = y0 + PH / 2;
      const art = b.find('image', p.art);
      if (art) {
        // The picture, cropped from its middle to the panel's shape (the whole of it is kept).
        const fw = art.fullWidth, fh = art.fullHeight;
        const want = fw / fh > sb.ratio ? { x: (fw - fh * sb.ratio) / 2, y: 0, w: fh * sb.ratio, h: fh } : { x: 0, y: (fh - fw / sb.ratio) / 2, w: fw, h: fw / sb.ratio };
        const now = art.crop;
        const same = now && Math.abs(now.w / now.h - sb.ratio) < 0.01;
        if (!same) b.setCrop(art, Math.abs(fw / fh - sb.ratio) < 0.01 ? null : want, { keepPlace: false });
        const s = art.sprite;
        const kx = PW / art.width;
        s.rotation = 0;
        s.scale.set(Math.sign(s.scale.x || 1) * kx, Math.sign(s.scale.y || 1) * kx);
        s.position.set(cx, cy);
        art.group = null;
      }
      const chosen = this.open === sb && this.chosen?.id === p.id;
      tag(b.addShape({ shape: 'rect', x: cx, y: cy, w: PW, h: PH, color: chosen ? '#3b82f6' : INK, strokeWidth: chosen ? 7 : 3, locked: true }));
      // The shot line: number, shot, camera move, duration.
      const head = [String(i + 1), p.shot, p.camera !== 'Static' ? p.camera : '', `${+p.duration || 0}s`].filter(Boolean).join('   ·   ');
      const h = b.addNote({ x: x0, y: y0 - HEAD / 2, text: head, style: 'text', level: 'body', base, weight: 600, color: INK, locked: true });
      h.sprite.x = x0 + h.width / 2;
      tag(h);
      let ty = y0 + PH + 26;
      for (const [label, text, colour, italic] of [['', p.action, INK, false], ['', p.dialogue ? `“${p.dialogue}”` : '', SOFT, true], ['Notes: ', p.notes, SOFT, false]]) {
        if (!text) continue;
        const t = b.addNote({ x: x0, y: ty, text: label + text, style: 'text', level: 'body', base: base * 0.82, color: colour, italic, locked: true });
        t.sprite.x = x0 + t.width / 2;
        t.sprite.y = ty + t.height / 2;
        ty += t.height + base * 0.3;
        tag(t);
      }
    });
    b.syncImages?.();
  }

  layoutAll() {
    for (const sb of this.list) this.layout(sb);
  }

  bounds(sb) {
    const frames = this.board.frames.filter((f) => f.sbGen === sb.id);
    return this.board.bounds(frames);
  }

  // The storyboard (and panel) something on the board belongs to.
  ownerOf(item) {
    if (!item) return null;
    if (item.sbGen) return { sb: this.find(item.sbGen), panel: null };
    for (const sb of this.list) {
      const panel = sb.panels.find((p) => p.art === item.id);
      if (panel) return { sb, panel };
    }
    return null;
  }

  // ---------- Changing it (each change is one undo step) ----------

  change(sb, fn, { relayout = true } = {}) {
    const before = JSON.stringify(sb);
    fn(sb);
    const after = JSON.stringify(sb);
    if (before === after) return;
    const set = (json) => {
      const now = this.find(sb.id);
      const data = JSON.parse(json);
      if (now) Object.assign(now, data); else this.list.push(data);
      this.layoutFrom(this.find(sb.id));
      this.renderEditor();
      this.api.render();
    };
    this.api.push({ undo: () => set(before), redo: () => set(after) });
    if (relayout) this.layout(sb);
    this.api.changed();
    this.api.render();
  }

  async addPanels(sb, at, images = []) {
    const n = images.length || 1;
    const added = [];
    const before = JSON.stringify(sb);
    for (let i = 0; i < n; i++) added.push(newPanel(images[i]?.id ?? null));
    sb.panels.splice(at, 0, ...added);
    await this.fillArt(sb);
    const sheets = added.filter((p, i) => !images[i]).map((p) => this.api.thingData(this.board.find('image', p.art)));
    const after = JSON.stringify(sb);
    const set = async (json, withSheets) => {
      const now = this.find(sb.id);
      if (withSheets) { for (const d of sheets) if (!this.board.find('image', d.data.id)) await this.api.restoreThing(d); } else sheets.forEach((d) => this.api.removeImage(d.data.id));
      Object.assign(now, JSON.parse(json));
      this.layout(now);
      this.renderEditor();
      this.api.render();
    };
    this.api.push({ undo: () => set(before, false), redo: () => set(after, true) });
    this.chosen = added[0];
    this.layout(sb);
    this.renderEditor();
    this.api.changed();
    this.api.render();
  }

  deletePanel(sb, panel) {
    const art = this.board.find('image', panel.art);
    const artData = art ? this.api.thingData(art) : null;
    const before = JSON.stringify(sb);
    const i = sb.panels.indexOf(panel);
    sb.panels.splice(i, 1);
    if (art) this.api.removeImage(art.id);
    const after = JSON.stringify(sb);
    const set = async (json, restore) => {
      const now = this.find(sb.id);
      if (restore && artData) await this.api.restoreThing(artData);
      if (!restore && artData) this.api.removeImage(artData.data.id);
      Object.assign(now, JSON.parse(json));
      this.layout(now);
      this.renderEditor();
      this.api.render();
    };
    this.api.push({ undo: () => set(before, true), redo: () => set(after, false) });
    this.chosen = sb.panels[Math.min(i, sb.panels.length - 1)] || null;
    this.layout(sb);
    this.renderEditor();
    this.api.changed();
    this.api.render();
  }

  async duplicatePanel(sb, panel) {
    const art = this.board.find('image', panel.art);
    let copyId = null;
    if (art) {
      const d = this.api.thingData(art);
      const copy = await this.api.copyImage(art);
      copyId = copy?.id ?? null;
      void d;
    }
    const before = JSON.stringify(sb);
    const p = { ...panel, id: uid('pn'), art: copyId };
    sb.panels.splice(sb.panels.indexOf(panel) + 1, 0, p);
    await this.fillArt(sb);
    const copyData = this.api.thingData(this.board.find('image', p.art));
    const after = JSON.stringify(sb);
    const set = async (json, withCopy) => {
      const now = this.find(sb.id);
      if (withCopy) { if (!this.board.find('image', copyData.data.id)) await this.api.restoreThing(copyData); } else this.api.removeImage(copyData.data.id);
      Object.assign(now, JSON.parse(json));
      this.layout(now);
      this.renderEditor();
      this.api.render();
    };
    this.api.push({ undo: () => set(before, false), redo: () => set(after, true) });
    this.chosen = p;
    this.layout(sb);
    this.renderEditor();
    this.api.changed();
    this.api.render();
  }

  deleteStoryboard(sb) {
    const arts = sb.panels.map((p) => this.board.find('image', p.art)).filter(Boolean).map((x) => this.api.thingData(x));
    const model = JSON.stringify(sb);
    arts.forEach((d) => this.api.removeImage(d.data.id));
    this.removeModel(sb.id);
    this.api.push({
      undo: async () => { for (const d of arts) await this.api.restoreThing(d); this.list.push(JSON.parse(model)); this.layout(this.find(sb.id)); this.api.render(); },
      redo: () => { arts.forEach((d) => this.api.removeImage(d.data.id)); this.removeModel(sb.id); this.api.render(); },
    });
    this.api.changed();
    this.api.render();
  }

  // ---------- The editor (on the right) ----------

  edit(sb, panel = null) {
    this.open = sb;
    this.chosen = panel || sb.panels[0] || null;
    if (!this.el) this.build();
    this.renderEditor();
    this.layout(sb);
    this.api.render();
  }

  close() {
    const sb = this.open;
    this.el?.remove();
    this.el = null;
    this.open = null;
    this.chosen = null;
    if (sb && this.find(sb.id)) { this.layout(sb); this.api.render(); }
  }

  build() {
    const el = document.createElement('div');
    el.className = 'sb-panel';
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(el);
    this.el = el;
  }

  renderEditor() {
    const sb = this.open;
    if (!this.el || !sb) return;
    if (!this.find(sb.id)) { this.close(); return; }
    const el = this.el;
    const focusField = document.activeElement?.closest?.('.sb-panel') ? document.activeElement.dataset.f : null;
    el.innerHTML = `
      <div class="sb-head">
        <input class="sb-name" value="">
        <button data-a="play" title="Play as an animatic">▶ Play</button>
        <button data-a="pdf" title="Export the pages as a PDF">PDF</button>
        <button data-a="more" title="More">⋯</button>
        <button data-a="close" title="Close">✕</button>
      </div>
      <div class="sb-settings">
        <label>Shape <select data-s="ratio">${RATIOS.map(([l, r]) => `<option value="${r}">${l}</option>`).join('')}</select></label>
        <label>Columns <select data-s="cols">${[2, 3, 4, 5, 6].map((n) => `<option>${n}</option>`).join('')}</select></label>
        <span class="sb-total"></span>
      </div>
      <div class="sb-list"></div>
      <div class="sb-add">
        <button data-a="add">+ Panel</button>
        <button data-a="addImages" title="Add the images selected on the board as panels">+ Selected images</button>
      </div>
      <div class="sb-edit"></div>`;
    el.querySelector('.sb-name').value = sb.name;
    el.querySelector('.sb-name').addEventListener('change', (e) => this.change(sb, (s) => { s.name = e.target.value.trim() || s.name; }));
    const ratio = el.querySelector('[data-s="ratio"]');
    ratio.value = String(RATIOS.find(([, r]) => Math.abs(r - sb.ratio) < 0.001)?.[1] ?? sb.ratio);
    ratio.addEventListener('change', () => this.change(sb, (s) => { s.ratio = Number(ratio.value); }));
    const cols = el.querySelector('[data-s="cols"]');
    cols.value = String(sb.cols);
    cols.addEventListener('change', () => this.change(sb, (s) => { s.cols = Number(cols.value); }));
    const total = sb.panels.reduce((a, p) => a + (+p.duration || 0), 0);
    el.querySelector('.sb-total').textContent = `${sb.panels.length} panels · ${total.toFixed(1).replace(/\.0$/, '')}s`;
    const on = (a, fn) => el.querySelector(`[data-a="${a}"]`)?.addEventListener('click', fn);
    on('close', () => this.close());
    on('play', () => this.play(sb));
    on('pdf', () => this.api.exportFrames(this.board.frames.filter((f) => f.sbGen === sb.id).sort((a, b) => a.sbPage - b.sbPage)));
    on('add', () => this.addPanels(sb, this.chosen ? sb.panels.indexOf(this.chosen) + 1 : sb.panels.length));
    on('addImages', () => {
      const imgs = this.api.selectedImages().filter((x) => !sb.panels.some((p) => p.art === x.id));
      if (!imgs.length) { this.api.toast('Select images on the board first.'); return; }
      this.addPanels(sb, this.chosen ? sb.panels.indexOf(this.chosen) + 1 : sb.panels.length, imgs);
    });
    on('more', (e) => this.api.menu(e.currentTarget, [
      { label: 'Zoom to the storyboard', action: () => this.api.focus(this.bounds(sb)) },
      { label: 'Delete the storyboard', action: () => { if (confirm(`Delete "${sb.name}" and its panels?`)) this.deleteStoryboard(sb); } },
    ]));

    // The panels, in order: click to choose, drag to reorder.
    const list = el.querySelector('.sb-list');
    sb.panels.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = `sb-item${this.chosen?.id === p.id ? ' on' : ''}`;
      row.draggable = true;
      const art = this.board.find('image', p.art);
      const thumb = document.createElement('canvas');
      thumb.width = 96;
      thumb.height = Math.round(96 / sb.ratio);
      if (art?.source?.resource) {
        const c = art.crop || { x: 0, y: 0, w: art.fullWidth, h: art.fullHeight };
        const r = art.source.resource;
        const k = r.width / art.fullWidth;
        try { thumb.getContext('2d').drawImage(r, c.x * k, c.y * k, c.w * k, c.h * k, 0, 0, thumb.width, thumb.height); } catch {}
      }
      const label = document.createElement('div');
      label.innerHTML = '<b></b><span></span>';
      label.querySelector('b').textContent = `${i + 1}`;
      label.querySelector('span').textContent = `${p.shot} · ${+p.duration || 0}s${p.action ? ` · ${p.action}` : ''}`;
      row.append(thumb, label);
      row.addEventListener('click', () => {
        this.chosen = p;
        this.renderEditor();
        this.layout(sb);
        const a = this.board.find('image', p.art);
        if (a) {
          // Show the panel with a little of its neighbours around it.
          const r = this.board.bounds([a]);
          this.api.focus({ x: r.x - r.width * 0.6, y: r.y - r.height * 0.5, width: r.width * 2.2, height: r.height * 2.4 }, true);
        }
        this.api.render();
      });
      row.addEventListener('dblclick', () => { const a = this.board.find('image', p.art); if (a) this.api.paint(a); });
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-sb-panel', p.id); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-sb-panel')) { e.preventDefault(); e.stopPropagation(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop');
        const id = e.dataTransfer.getData('application/x-sb-panel');
        if (!id || id === p.id) return;
        this.change(sb, (s) => {
          const from = s.panels.findIndex((x) => x.id === id);
          const [moved] = s.panels.splice(from, 1);
          s.panels.splice(s.panels.findIndex((x) => x.id === p.id) + (from < i ? 1 : 0), 0, moved);
        });
        this.renderEditor();
      });
      list.appendChild(row);
    });

    // The chosen panel.
    const box = el.querySelector('.sb-edit');
    const p = this.chosen && sb.panels.find((x) => x.id === this.chosen.id);
    if (!p) return;
    const n = sb.panels.indexOf(p) + 1;
    box.innerHTML = `
      <div class="sb-edit-head"><strong>Panel ${n}</strong>
        <button data-p="draw" title="Draw in this panel (or double-click it on the board)">Draw</button>
        <button data-p="up" title="Earlier">↑</button><button data-p="down" title="Later">↓</button>
        <button data-p="dup" title="Duplicate">Duplicate</button>
        <button data-p="del" title="Delete this panel">Delete</button></div>
      <div class="sb-row">
        <label>Shot <select data-f="shot">${SHOTS.map((s) => `<option>${s}</option>`).join('')}</select></label>
        <label>Camera <select data-f="camera">${MOVES.map((s) => `<option>${s}</option>`).join('')}</select></label>
        <label>Seconds <input type="number" data-f="duration" min="0.1" max="120" step="0.5"></label>
      </div>
      <label class="sb-text">Action <textarea data-f="action" rows="2" placeholder="What happens"></textarea></label>
      <label class="sb-text">Dialogue <textarea data-f="dialogue" rows="2" placeholder="What's said"></textarea></label>
      <label class="sb-text">Notes <textarea data-f="notes" rows="2" placeholder="Sound, lighting, effects…"></textarea></label>
      <button class="sb-use" data-p="use" title="Use the image selected on the board as this panel's picture">Use the selected image</button>`;
    for (const f of ['shot', 'camera', 'duration', 'action', 'dialogue', 'notes']) {
      const input = box.querySelector(`[data-f="${f}"]`);
      input.value = p[f];
      const commit = () => this.change(sb, () => { p[f] = f === 'duration' ? Math.max(0.1, Number(input.value) || 2) : input.value; });
      if (input.tagName === 'TEXTAREA') {
        let timer;
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(commit, 500); });
        input.addEventListener('blur', () => { clearTimeout(timer); commit(); });
      } else input.addEventListener('change', () => { commit(); this.renderEditor(); });
    }
    if (focusField) box.querySelector(`[data-f="${focusField}"]`)?.focus();
    const act = (a, fn) => box.querySelector(`[data-p="${a}"]`)?.addEventListener('click', fn);
    act('draw', () => { const a = this.board.find('image', p.art); if (a) this.api.paint(a); });
    act('up', () => { const i = sb.panels.indexOf(p); if (i > 0) { this.change(sb, (s) => { s.panels.splice(i, 1); s.panels.splice(i - 1, 0, p); }); this.renderEditor(); } });
    act('down', () => { const i = sb.panels.indexOf(p); if (i < sb.panels.length - 1) { this.change(sb, (s) => { s.panels.splice(i, 1); s.panels.splice(i + 1, 0, p); }); this.renderEditor(); } });
    act('dup', () => this.duplicatePanel(sb, p));
    act('del', () => { if (sb.panels.length > 1 || confirm('Delete the last panel?')) this.deletePanel(sb, p); });
    act('use', () => {
      const img = this.api.selectedImages().find((x) => x.id !== p.art);
      if (!img) { this.api.toast('Select an image on the board first.'); return; }
      const old = p.art;
      this.change(sb, () => { p.art = img.id; });
      // The old picture stays on the board, next to the storyboard.
      const o = this.board.find('image', old);
      if (o) { const b = this.bounds(sb); o.sprite.position.set(b.x + b.width + 600, o.sprite.y); }
      this.renderEditor();
      this.api.render();
    });
  }

  // ---------- Playing it (an animatic) ----------

  play(sb, from = 0) {
    this.player?.stop();
    const panels = sb.panels.map((p) => ({ p, art: this.board.find('image', p.art) }));
    const el = document.createElement('div');
    el.className = 'sb-player';
    el.innerHTML = `<canvas></canvas><div class="sb-sub"></div><div class="sb-info"></div><div class="sb-bar"><span></span></div>
      <div class="sb-controls"><button data-c="prev">◀◀</button><button data-c="pause">❚❚</button><button data-c="next">▶▶</button><button data-c="close">✕</button></div>`;
    document.body.appendChild(el);
    const canvas = el.querySelector('canvas');
    const g = canvas.getContext('2d');
    let i = from, start = performance.now(), paused = false, pausedAt = 0, raf = 0;
    const total = panels.reduce((a, x) => a + (+x.p.duration || 2), 0);
    const elapsedBefore = (k) => panels.slice(0, k).reduce((a, x) => a + (+x.p.duration || 2), 0);
    const sized = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; };
    sized();
    const draw = () => {
      const { p, art } = panels[i];
      g.fillStyle = '#000';
      g.fillRect(0, 0, canvas.width, canvas.height);
      const W = canvas.width, H = canvas.height * 0.8;
      let w = W, h = W / sb.ratio;
      if (h > H) { h = H; w = H * sb.ratio; }
      const x = (W - w) / 2, y = (canvas.height - h) / 2 - canvas.height * 0.03;
      const r = art?.source?.resource;
      if (r) {
        const c = art.crop || { x: 0, y: 0, w: art.fullWidth, h: art.fullHeight };
        const k = r.width / art.fullWidth;
        g.imageSmoothingQuality = 'high';
        g.drawImage(r, c.x * k, c.y * k, c.w * k, c.h * k, x, y, w, h);
      } else { g.fillStyle = '#fff'; g.fillRect(x, y, w, h); }
      el.querySelector('.sb-sub').textContent = p.dialogue || '';
      el.querySelector('.sb-info').textContent = `${i + 1} / ${panels.length}   ·   ${p.shot}${p.camera !== 'Static' ? ` · ${p.camera}` : ''}${p.action ? `   ·   ${p.action}` : ''}`;
    };
    const tick = (now) => {
      if (!paused) {
        const t = (now - start) / 1000;
        const d = +panels[i].p.duration || 2;
        if (t >= d) {
          if (i < panels.length - 1) { i++; start = now; draw(); } else { paused = true; pausedAt = d; }
        }
        el.querySelector('.sb-bar span').style.width = `${Math.min(100, ((elapsedBefore(i) + Math.min(t, d)) / total) * 100)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    const go = (k) => { i = Math.max(0, Math.min(panels.length - 1, k)); start = performance.now(); if (paused) pausedAt = 0; draw(); };
    const pause = () => {
      if (paused) { paused = false; start = performance.now() - pausedAt * 1000; if (pausedAt >= (+panels[i].p.duration || 2) && i === panels.length - 1) go(0); }
      else { paused = true; pausedAt = (performance.now() - start) / 1000; }
      el.querySelector('[data-c="pause"]').textContent = paused ? '▶' : '❚❚';
    };
    const stop = () => { cancelAnimationFrame(raf); el.remove(); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onResize); this.player = null; };
    const key = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') stop();
      else if (e.key === ' ') { e.preventDefault(); pause(); }
      else if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    };
    const onResize = () => { sized(); draw(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', onResize);
    el.querySelector('[data-c="prev"]').addEventListener('click', () => go(i - 1));
    el.querySelector('[data-c="next"]').addEventListener('click', () => go(i + 1));
    el.querySelector('[data-c="pause"]').addEventListener('click', pause);
    el.querySelector('[data-c="close"]').addEventListener('click', stop);
    draw();
    raf = requestAnimationFrame(tick);
    this.player = { stop };
  }
}
