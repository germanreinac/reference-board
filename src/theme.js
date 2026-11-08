// Light mode, dark mode, and "alien" colour mode: a random soft, desaturated palette
// (sage, lavender, peach…) for when you want something colourful but calm. The choice is
// remembered in this browser.
//
// The page's own colours live in style.css (body[data-theme]); colour mode sets them on
// the page directly. The drawn parts (the board's background and dots, the lines between
// panes, the 3D scene) read their colours from here, and redraw on 'themechange'.

export const THEMES = {
  dark: { text: '#f2f2f4', board: '#1b1b1d', gap: '#08080a', dot: '#4a4a52', scene: 0x232327, floor: 0x2e2e33, grid: [0x3a3a40, 0x323237] },
  light: { text: '#1f1f22', board: '#f1f1ef', gap: '#c9c9c6', dot: '#c2c2be', scene: 0xe6e6e3, floor: 0xd6d6d2, grid: [0xbdbdb8, 0xc9c9c5] },
};

// Colour mode palettes: soft and muted, never loud. [name, background, gap between panes,
// accent, darkest text]. The rest is mixed from these.
export const PASTELS = [
  ['Sage', '#e2e8dd', '#b6c1af', '#6f9a6a', '#2c3529'],
  ['Lavender', '#e6e2ef', '#bfb7d2', '#8a78c2', '#2f2a3c'],
  ['Peach', '#f1e4dd', '#d6bfb2', '#cf8467', '#3b2c25'],
  ['Dusty blue', '#dfe6ed', '#b3c0cd', '#5f8ab5', '#26323f'],
  ['Sand', '#ece5d6', '#cfc4aa', '#b0893a', '#352f20'],
  ['Mint', '#dfece7', '#b1cbc2', '#4f9c88', '#233a33'],
  ['Rose', '#efe0e4', '#d4b7bf', '#c4707f', '#3c262d'],
  ['Lilac grey', '#e4e3e8', '#bcbac6', '#7b7a9e', '#2a2933'],
];

const STORAGE = 'refboard-theme';
const PASTEL_STORAGE = 'refboard-pastel';

const hex = (h) => parseInt(h.slice(1), 16);
const toHex = (n) => `#${n.toString(16).padStart(6, '0')}`;
// Mix two colours: t = 0 is a, 1 is b.
function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  const ch = (s) => Math.round(((A >> s) & 255) * (1 - t) + ((B >> s) & 255) * t);
  return toHex((ch(16) << 16) | (ch(8) << 8) | ch(0));
}

function pastelColours(i) {
  const [name, bg, gap, accent, ink] = PASTELS[i % PASTELS.length];
  return {
    name,
    css: {
      '--bg': bg, '--gap': gap, '--line': mix(bg, gap, 0.45), '--input': mix(bg, '#ffffff', 0.6),
      '--card': mix(bg, '#ffffff', 0.45), '--panel': mix(bg, '#ffffff', 0.65), '--panel-2': mix(bg, '#ffffff', 0.3),
      '--panel-border': mix(bg, gap, 0.7), '--border-strong': mix(gap, ink, 0.25),
      '--overlay': `${mix(bg, '#ffffff', 0.65)}eb`, '--dot': mix(bg, gap, 0.8),
      '--text': mix(ink, bg, 0.38), '--text-strong': ink, '--accent': accent,
    },
    drawn: { text: ink, board: bg, gap, dot: mix(bg, gap, 0.85), scene: hex(mix(bg, gap, 0.25)), floor: hex(mix(bg, gap, 0.6)), grid: [hex(mix(bg, gap, 1)), hex(mix(bg, gap, 0.75))] },
  };
}

let pastel = 0;

export function currentTheme() {
  const t = document.body.dataset.theme;
  return t === 'light' || t === 'pastel' ? t : 'dark';
}
// Light or dark background? (Colour mode is light.)
export const isLightTone = () => currentTheme() !== 'dark';
// The colour lines and text are drawn in on the board.
export const themeInk = () => (currentTheme() === 'pastel' ? hex(pastelColours(pastel).drawn.text) : isLightTone() ? 0x1f1f22 : 0xffffff);
export const pastelName = () => pastelColours(pastel).name;

export function themeColours() {
  return currentTheme() === 'pastel' ? pastelColours(pastel).drawn : THEMES[currentTheme()];
}

function apply(name) {
  const body = document.body;
  body.dataset.theme = name;
  body.dataset.tone = name === 'dark' ? 'dark' : 'light';
  const vars = pastelColours(pastel).css;
  for (const k of Object.keys(vars)) {
    if (name === 'pastel') body.style.setProperty(k, vars[k]);
    else body.style.removeProperty(k);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColours().board);
}

export function setTheme(name) {
  apply(name === 'light' || name === 'pastel' ? name : 'dark');
  try { localStorage.setItem(STORAGE, currentTheme()); localStorage.setItem(PASTEL_STORAGE, String(pastel)); } catch {}
  window.dispatchEvent(new CustomEvent('themechange', { detail: themeColours() }));
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// Colour mode: a different random palette each time.
export function randomColours() {
  let next = pastel;
  if (PASTELS.length > 1) while (next === pastel && currentTheme() === 'pastel') next = Math.floor(Math.random() * PASTELS.length);
  if (currentTheme() !== 'pastel') next = Math.floor(Math.random() * PASTELS.length);
  pastel = next;
  setTheme('pastel');
  return pastelName();
}

// Call once at start-up.
export function loadTheme() {
  let saved = 'dark';
  try {
    saved = localStorage.getItem(STORAGE) || 'dark';
    pastel = Number(localStorage.getItem(PASTEL_STORAGE)) || 0;
  } catch {}
  apply(saved === 'light' || saved === 'pastel' ? saved : 'dark');
}
