// Palettes: colour sets kept with the board (saved in the board, synced, in board files).
//
// The panel lists the board's palettes. In each one:
//   - click a colour to choose it: see its code (click to copy), change it, or remove it
//   - harmonies of the chosen colour (complementary, analogous, triadic, split) to add
//   - the value bar: each colour's lightness in grey, to check the contrast reads
//   - use a colour for drawing, or put the palette on the board as a card
//
// new PalettePanel(host) where host = {
//   list()                 the board's palettes: [{ id, name, colours: ['#rrggbb'…] }]
//   changed()              something was edited (save the board)
//   useColour(hex)         set the drawing colour
//   putOnBoard(palette)    add a picture of the palette to the board
//   fromSelection()        a palette from the selected image's colours (or null)
//   toast(message) }

export class PalettePanel {
  constructor(host) {
    this.host = host;
    this.el = null;
    this.chosen = null;   // { palette, index }
  }

  get open() { return !!this.el; }

  toggle() { if (this.el) this.close(); else this.show(); }

  show() {
    if (this.el) { this.render(); return; }
    const el = document.createElement('div');
    el.className = 'pal-panel';
    el.innerHTML = `
      <div class="pal-head"><strong>Palettes</strong><span></span>
        <button data-a="from" title="A palette from the selected image's colours">From image</button>
        <button data-a="new" title="New palette">+ New</button>
        <button data-a="close" title="Close">✕</button></div>
      <div class="pal-list"></div>`;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.querySelector('[data-a="close"]').addEventListener('click', () => this.close());
    el.querySelector('[data-a="new"]').addEventListener('click', () => {
      const p = { id: `p${Date.now().toString(36)}`, name: `Palette ${this.host.list().length + 1}`, colours: ['#1b1b1d', '#f2f2f4'] };
      this.host.list().push(p);
      this.chosen = { palette: p, index: 0 };
      this.host.changed();
      this.render();
    });
    el.querySelector('[data-a="from"]').addEventListener('click', async () => {
      const p = await this.host.fromSelection();
      if (!p) { this.host.toast('Select an image first.'); return; }
      this.chosen = { palette: p, index: 0 };
      this.render();
    });
    document.body.appendChild(el);
    this.el = el;
    // One colour picker, shared.
    this.picker = Object.assign(document.createElement('input'), { type: 'color' });
    this.picker.className = 'pal-picker';
    this.picker.addEventListener('input', () => {
      const c = this.chosen;
      if (!c) return;
      c.palette.colours[c.index] = this.picker.value;
      this.host.changed();
      this.render();
    });
    el.appendChild(this.picker);
    this.render();
  }

  close() {
    this.el?.remove();
    this.el = null;
  }

  render() {
    if (!this.el) return;
    const list = this.el.querySelector('.pal-list');
    list.replaceChildren();
    const palettes = this.host.list();
    if (!palettes.length) {
      const p = document.createElement('p');
      p.className = 'pal-empty';
      p.textContent = 'No palettes yet. Make one from an image (select it, then From image), or start a new one.';
      list.appendChild(p);
    }
    for (const pal of palettes) list.appendChild(this.card(pal));
  }

  card(pal) {
    const card = document.createElement('div');
    card.className = 'pal-card';
    const head = document.createElement('div');
    head.className = 'pal-card-head';
    const name = document.createElement('input');
    name.value = pal.name;
    name.addEventListener('change', () => { pal.name = name.value.trim() || pal.name; this.host.changed(); });
    name.addEventListener('keydown', (e) => e.stopPropagation());
    const toBoard = button('Put on board', () => this.host.putOnBoard(pal));
    const del = button('✕', () => {
      if (!confirm(`Delete the palette "${pal.name}"?`)) return;
      const all = this.host.list();
      all.splice(all.indexOf(pal), 1);
      if (this.chosen?.palette === pal) this.chosen = null;
      this.host.changed();
      this.render();
    });
    del.title = 'Delete palette';
    head.append(name, toBoard, del);

    // The colours, and their values (lightness) underneath.
    const row = document.createElement('div');
    row.className = 'pal-swatches';
    const values = document.createElement('div');
    values.className = 'pal-values';
    values.title = 'Value: how light or dark each colour is';
    pal.colours.forEach((hex, i) => {
      const sw = document.createElement('button');
      sw.className = 'pal-swatch';
      sw.style.background = hex;
      sw.title = hex.toUpperCase();
      if (this.chosen?.palette === pal && this.chosen.index === i) sw.classList.add('on');
      sw.addEventListener('click', () => { this.chosen = { palette: pal, index: i }; this.render(); });
      row.appendChild(sw);
      const v = document.createElement('span');
      const L = lightness(hex);
      const grey = Math.round(L * 255);
      v.style.background = `rgb(${grey},${grey},${grey})`;
      v.textContent = Math.round(L * 100);
      v.style.color = L > 0.55 ? '#111' : '#eee';
      values.appendChild(v);
    });
    const add = document.createElement('button');
    add.className = 'pal-swatch add';
    add.textContent = '+';
    add.title = 'Add a colour';
    add.addEventListener('click', () => {
      pal.colours.push(pal.colours[pal.colours.length - 1] || '#888888');
      this.chosen = { palette: pal, index: pal.colours.length - 1 };
      this.host.changed();
      this.render();
      this.picker.value = pal.colours[this.chosen.index];
      this.picker.click();
    });
    row.appendChild(add);
    card.append(head, row, values);

    // The chosen colour: its code, change it, use it, and its harmonies.
    if (this.chosen?.palette === pal && pal.colours[this.chosen.index]) {
      const hex = pal.colours[this.chosen.index];
      const tools = document.createElement('div');
      tools.className = 'pal-tools';
      const code = button(hex.toUpperCase(), () => {
        navigator.clipboard?.writeText(hex.toUpperCase()).then(() => this.host.toast(`Copied ${hex.toUpperCase()}`, 1200)).catch(() => {});
      });
      code.className = 'pal-code';
      code.title = 'Copy the colour code';
      const rgb = hexToRgb(hex);
      const info = document.createElement('small');
      info.textContent = `RGB ${rgb.join(', ')}`;
      tools.append(
        code, info,
        button('Change', () => { this.picker.value = hex; this.picker.click(); }),
        button('Draw with it', () => { this.host.useColour(hex); this.host.toast(`Drawing in ${hex.toUpperCase()}`, 1200); }),
        button('Remove', () => {
          pal.colours.splice(this.chosen.index, 1);
          this.chosen = pal.colours.length ? { palette: pal, index: Math.min(this.chosen.index, pal.colours.length - 1) } : null;
          this.host.changed();
          this.render();
        }),
      );
      card.appendChild(tools);
      const harm = document.createElement('div');
      harm.className = 'pal-harmonies';
      for (const [label, colours] of harmonies(hex)) {
        const r = document.createElement('div');
        r.className = 'pal-harmony';
        const l = document.createElement('span');
        l.textContent = label;
        r.appendChild(l);
        for (const c of colours) {
          const b = document.createElement('button');
          b.className = 'pal-swatch small';
          b.style.background = c;
          b.title = `Add ${c.toUpperCase()}`;
          b.addEventListener('click', () => { pal.colours.push(c); this.host.changed(); this.render(); });
          r.appendChild(b);
        }
        harm.appendChild(r);
      }
      card.appendChild(harm);
    }
    return card;
  }
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ---------- Colour maths ----------

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

// How light a colour looks, 0 (black) to 1 (white): CIE lightness, as eyes see it.
export function lightness(hex) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex);
  const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y) / 100;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// Colours that go with this one, by their place on the colour wheel.
export function harmonies(hex) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const at = (d) => hslToHex(h + d, s, l);
  return [
    ['Complementary', [at(180)]],
    ['Analogous', [at(-30), at(30)]],
    ['Triadic', [at(120), at(240)]],
    ['Split', [at(150), at(210)]],
    ['Shades', [hslToHex(h, s, Math.max(0.08, l - 0.22)), hslToHex(h, s, Math.min(0.94, l + 0.22))]],
  ];
}
