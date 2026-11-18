// Dark mode, light mode, and colour mode: a soft, desaturated palette (mint, pink or
// apricot, picked at random) for when you want something colourful but calm.
//
// Each board keeps its own look (record.look = { theme, pastel }), set from inside the
// board. The home screen is always dark. The last look you picked is remembered in this
// browser and given to new boards.
//
// The page's own colours live in style.css (body[data-theme]); colour mode sets them on
// the page directly. The drawn parts (the board's background and dots, the lines between
// panes, the 3D scene) read their colours from here, and redraw on 'themechange'.

export const THEMES = {
  // The Melti brand: a calm board (so references read true) with fluor pink between the
  // panes. Dark is the main look; light is the same idea, softer.
  dark: { text: '#f6f3ff', board: '#16151c', gap: '#322f47', dot: '#3d3a5c', scene: 0x1f1d2a, floor: 0x2a2740, grid: [0x3d3a5c, 0x322f4b] },
  light: { text: '#1f1f22', board: '#f3f1f4', gap: '#d6cfe0', dot: '#c2c2be', scene: 0xe6e6e3, floor: 0xd6d6d2, grid: [0xbdbdb8, 0xc9c9c5] },
};

// Colour mode palettes: soft and muted, never loud. [name, background, gap between panes,
// accent, darkest text]. The rest is mixed from these.
export const PASTELS = [
  ['Mint', '#dfece7', '#b1cbc2', '#4f9c88', '#233a33'],
  ['Pink', '#efe0e4', '#d4b7bf', '#c4707f', '#3c262d'],
  ['Apricot', '#f2e6d6', '#d8c3a5', '#c98a3a', '#3a2e1f'],
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
const NAMES = ['dark', 'light'];
// (Boards saved in the old colour mode open in light.)
const named = (n) => (n === 'pastel' ? 'light' : NAMES.includes(n) ? n : 'dark');

export function currentTheme() {
  const t = document.body.dataset.theme;
  return NAMES.includes(t) ? t : 'dark';
}
// Light or dark background? (Colour mode is light.)
export const isLightTone = () => currentTheme() === 'light' || currentTheme() === 'pastel';
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
  apply(named(name));
  try { localStorage.setItem(STORAGE, currentTheme()); localStorage.setItem(PASTEL_STORAGE, String(pastel)); } catch {}
  window.dispatchEvent(new CustomEvent('themechange', { detail: themeColours() }));
}

// The theme button switches between dark and light.
export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
export const nextTheme = () => (currentTheme() === 'dark' ? 'light' : 'dark');

// A board's look, and the look new boards start with (the last one picked).
export const currentLook = () => ({ theme: currentTheme(), pastel });
export function defaultLook() {
  try {
    return { theme: named(localStorage.getItem(STORAGE)), pastel: Number(localStorage.getItem(PASTEL_STORAGE)) || 0 };
  } catch {
    return { theme: 'dark', pastel: 0 };
  }
}

// Show a look (a board's, or the home screen's) without remembering it as the last pick.
export function applyLook(look = defaultLook()) {
  const name = named(look.theme);
  const p = Number(look.pastel) || 0;
  if (name === currentTheme() && p === pastel && document.body.dataset.theme) return;
  pastel = p;
  apply(name);
  window.dispatchEvent(new CustomEvent('themechange', { detail: themeColours() }));
}

// The background colour of a board with this look (for its preview on the home screen).
export function lookBackground(look) {
  if (look?.theme === 'pastel') return pastelColours(Number(look.pastel) || 0).drawn.board;
  return THEMES[look?.theme === 'light' || look?.theme === 'pastel' ? 'light' : 'dark'].board;
}

// Call once at start-up.
export function loadTheme() {
  let saved = 'dark';
  try {
    saved = localStorage.getItem(STORAGE) || 'dark';
    pastel = Number(localStorage.getItem(PASTEL_STORAGE)) || 0;
  } catch {}
  apply(named(saved));
}
