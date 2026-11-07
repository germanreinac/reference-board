// Light and dark mode. Dark is the default. The choice is remembered in this browser.
//
// The page's own colours live in style.css (body[data-theme]). The drawn parts (the
// board's background and dots, the lines between panes, the 3D scene) read their
// colours from here, and redraw when the 'themechange' event fires.

export const THEMES = {
  dark: { text: '#f2f2f4', board: '#1b1b1d', gap: '#08080a', dot: '#4a4a52', scene: 0x232327, floor: 0x2e2e33, grid: [0x3a3a40, 0x323237] },
  light: { text: '#1f1f22', board: '#f1f1ef', gap: '#c9c9c6', dot: '#c2c2be', scene: 0xe6e6e3, floor: 0xd6d6d2, grid: [0xbdbdb8, 0xc9c9c5] },
};

const STORAGE = 'refboard-theme';

export function currentTheme() {
  return document.body.dataset.theme === 'light' ? 'light' : 'dark';
}

export function themeColours() {
  return THEMES[currentTheme()];
}

export function setTheme(name) {
  document.body.dataset.theme = name === 'light' ? 'light' : 'dark';
  try { localStorage.setItem(STORAGE, document.body.dataset.theme); } catch {}
  window.dispatchEvent(new CustomEvent('themechange', { detail: THEMES[currentTheme()] }));
}

export function toggleTheme() {
  setTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

// Call once at start-up.
export function loadTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem(STORAGE) || 'dark'; } catch {}
  document.body.dataset.theme = saved === 'light' ? 'light' : 'dark';
}
