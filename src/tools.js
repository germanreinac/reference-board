// The drawing toolbar at the bottom middle of the window: Select, Pen, Eraser, Note,
// the colour (click it for the palette), size, undo/redo, and a button to fold the
// toolbar away into a small pill. Also the round brush outline that follows the mouse.

export const COLOURS = ['#f5f5f5', '#1b1b1d', '#ff5a5a', '#ffb547', '#ffe14d', '#4cd07d', '#4da3ff', '#b57bff'];

export const TOOL_KEYS = { KeyV: 'select', KeyB: 'pen', KeyP: 'pen', KeyE: 'eraser', KeyT: 'note' };

const ICONS = {
  select: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5l9 5-4 1.2-1.8 3.8z"/></svg>',
  pen: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3-7.5 7.5-3.8.8.8-3.8z M9 4l3 3"/></svg>',
  eraser: '<svg viewBox="0 0 16 16"><path d="M9.5 2.8l3.7 3.7-6.3 6.3H4.2L2.5 11.1z M6.2 6.1l3.7 3.7 M7 12.8h6.5"/></svg>',
  note: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 6h6M5 8.5h6M5 11h3.5"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M5.5 4L2.5 7l3 3M3 7h7a3.5 3.5 0 010 7H8"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="M10.5 4l3 3-3 3M13 7H6a3.5 3.5 0 000 7h2"/></svg>',
  collapse: '<svg viewBox="0 0 16 16"><path d="M4 6.5l4 4 4-4"/></svg>',
  expand: '<svg viewBox="0 0 16 16"><path d="M4 9.5l4-4 4 4"/></svg>',
};

const TITLES = {
  select: 'Select and move (V)',
  pen: 'Pen (B)',
  eraser: 'Eraser (E), or flip your tablet pen over',
  note: 'Note (T): click to add a note',
};

export class Toolbar {
  // onChange() is called whenever the tool, colour or size changes.
  constructor(element, { onChange, onUndo, onRedo }) {
    this.el = element;
    this.onChange = onChange;
    this.state = { tool: 'select', color: '#ff5a5a', penSize: 6, eraserSize: 30, collapsed: false };
    this.load();

    const toolGroup = this.group();
    this.toolButtons = {};
    for (const tool of ['select', 'pen', 'eraser', 'note']) {
      const b = this.button(ICONS[tool], TITLES[tool], () => this.setTool(tool));
      this.toolButtons[tool] = b;
      toolGroup.appendChild(b);
    }

    // The colour: one swatch; clicking it opens the palette above the toolbar.
    const colourGroup = this.group('colours');
    this.colourButton = document.createElement('button');
    this.colourButton.className = 'swatch current-colour';
    this.colourButton.title = 'Colour';
    colourGroup.appendChild(this.colourButton);
    this.palette = document.createElement('div');
    this.palette.className = 'colour-palette';
    this.palette.hidden = true;
    element.appendChild(this.palette);
    this.colourButton.addEventListener('click', () => { this.palette.hidden = !this.palette.hidden; });
    document.addEventListener('pointerdown', (e) => {
      if (!this.palette.hidden && !this.palette.contains(e.target) && e.target !== this.colourButton) this.palette.hidden = true;
    }, true);
    const paletteRow = this.palette;
    this.swatches = COLOURS.map((c) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.setProperty('--c', c);
      b.title = c;
      b.addEventListener('click', () => { this.setColour(c); this.palette.hidden = true; });
      paletteRow.appendChild(b);
      return b;
    });
    // Any other colour, with Chrome's colour picker.
    const custom = document.createElement('label');
    custom.className = 'swatch custom';
    custom.title = 'Pick any colour';
    this.colourInput = document.createElement('input');
    this.colourInput.type = 'color';
    this.colourInput.addEventListener('input', () => this.setColour(this.colourInput.value));
    custom.appendChild(this.colourInput);
    paletteRow.appendChild(custom);

    const sizeGroup = this.group('size');
    this.sizeInput = document.createElement('input');
    this.sizeInput.type = 'range';
    this.sizeInput.min = 1;
    this.sizeInput.max = 80;
    this.sizeInput.title = 'Size ([ and ] keys)';
    this.sizeInput.addEventListener('input', () => this.setSize(Number(this.sizeInput.value)));
    sizeGroup.appendChild(this.sizeInput);

    const historyGroup = this.group();
    this.undoButton = this.button(ICONS.undo, 'Undo (Ctrl/⌘+Z)', onUndo);
    this.redoButton = this.button(ICONS.redo, 'Redo (Ctrl/⌘+Shift+Z)', onRedo);
    historyGroup.append(this.undoButton, this.redoButton);

    // Fold the toolbar away into a small pill (showing the tool in use), and back.
    const foldGroup = this.group('fold');
    foldGroup.appendChild(this.button(ICONS.collapse, 'Hide the toolbar', () => this.setCollapsed(true)));
    this.mini = document.createElement('button');
    this.mini.className = 'tool mini';
    this.mini.title = 'Show the toolbar';
    this.mini.addEventListener('click', () => this.setCollapsed(false));
    element.appendChild(this.mini);

    // Clicking the toolbar must not start drawing or panning on the board.
    element.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.refresh();
  }

  group(extra = '') {
    const g = document.createElement('div');
    g.className = `tool-group ${extra}`;
    this.el.appendChild(g);
    return g;
  }

  button(icon, title, onClick) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.title = title;
    b.innerHTML = icon;
    b.addEventListener('click', onClick);
    return b;
  }

  setCollapsed(on) {
    this.state.collapsed = on;
    this.palette.hidden = true;
    this.save();
    this.refresh();
  }

  get tool() { return this.state.tool; }
  get color() { return this.state.color; }
  // Size in screen pixels for the current tool.
  get size() { return this.state.tool === 'eraser' ? this.state.eraserSize : this.state.penSize; }

  setTool(tool) { this.state.tool = tool; this.changed(); }
  setColour(c) {
    this.state.color = c;
    if (this.state.tool === 'eraser' || this.state.tool === 'select') this.state.tool = 'pen';
    this.changed();
  }
  setSize(n) {
    n = Math.max(1, Math.min(80, Math.round(n)));
    if (this.state.tool === 'eraser') this.state.eraserSize = n;
    else this.state.penSize = n;
    this.changed();
  }
  // [ and ] make the brush smaller or bigger, in bigger jumps for big brushes.
  nudgeSize(dir) { this.setSize(this.size + dir * Math.max(1, Math.round(this.size * 0.15))); }

  changed() {
    this.save();
    this.refresh();
    this.onChange();
  }

  setHistory(canUndo, canRedo) {
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }

  refresh() {
    const { tool, color } = this.state;
    for (const [t, b] of Object.entries(this.toolButtons)) b.classList.toggle('active', t === tool);
    for (const s of this.swatches) s.classList.toggle('active', s.style.getPropertyValue('--c') === color);
    this.colourInput.value = color;
    this.colourInput.parentElement.style.setProperty('--c', COLOURS.includes(color) ? 'transparent' : color);
    this.sizeInput.value = this.size;
    this.el.dataset.tool = tool;
    this.colourButton.style.setProperty('--c', color);
    this.el.classList.toggle('collapsed', this.state.collapsed);
    this.mini.innerHTML = `${ICONS[tool]}<span class="mini-colour" style="--c:${color}"></span>${ICONS.expand}`;
  }

  // Remember the tool settings between visits (only a convenience, so failures are ignored).
  save() {
    try { localStorage.setItem('refboard-tools', JSON.stringify({ ...this.state, tool: undefined })); } catch {}
  }
  load() {
    try { Object.assign(this.state, JSON.parse(localStorage.getItem('refboard-tools')) || {}, { tool: 'select' }); } catch {}
    this.state.collapsed = !!this.state.collapsed;
  }
}

// The round outline that shows how big the pen or eraser is.
export class BrushCursor {
  constructor(element) { this.el = element; }
  show(x, y, size, eraser) {
    const d = Math.max(4, size);
    Object.assign(this.el.style, { display: 'block', width: `${d}px`, height: `${d}px`, transform: `translate(${x - d / 2}px, ${y - d / 2}px)` });
    this.el.classList.toggle('eraser', eraser);
  }
  hide() { this.el.style.display = 'none'; }
}
