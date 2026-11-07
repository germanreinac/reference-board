// Fonts for text on the board.
//
// Built in (the board's own look): a few free fonts chosen to work together, from a
// clean Notion-like sans to comic lettering. They're in vendor/fonts.
// Your own: upload a .ttf, .otf, .woff or .woff2 file. It's kept in this browser for
// all your boards, and packed into board files that use it, so a board you send
// someone shows the same font.

import { store } from './storage.js';

export const BRAND_FONTS = [
  { name: 'Inter', note: 'Clean, for everything' },
  { name: 'Space Grotesk', note: 'Modern and fresh' },
  { name: 'Instrument Serif', note: 'Elegant headlines' },
  { name: 'Bebas Neue', note: 'Tall poster titles' },
  { name: 'Bangers', note: 'Comic lettering' },
  { name: 'JetBrains Mono', note: 'Code and labels' },
];
const BRAND = new Set(BRAND_FONTS.map((f) => f.name));
export const isBrandFont = (name) => BRAND.has(name);

// The CSS font list for a family, with sensible fallbacks.
export const fontStack = (name) => `"${name}", Inter, system-ui, -apple-system, "Segoe UI", sans-serif`;

const custom = new Map();  // name -> Blob, for uploaded fonts

export function customFonts() {
  return [...custom.keys()].sort();
}
export function customFontBlob(name) {
  return custom.get(name) || null;
}

// Make a font file usable by name.
async function register(name, blob) {
  const face = new FontFace(name, await blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  custom.set(name, blob);
}

// Load every uploaded font at start-up.
export async function loadCustomFonts() {
  try {
    for (const { name, blob } of await store.listFonts()) {
      try { await register(name, blob); } catch (err) { console.warn('Font failed to load', name, err); }
    }
  } catch (err) {
    console.warn('Could not read saved fonts', err);
  }
}

// Add a font from a file (e.g. dropped in, or from a board file). Returns its name.
export async function addFontFile(blob, fileName) {
  const name = String(fileName || 'My font').replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'My font';
  if (!custom.has(name)) {
    await register(name, blob);
    await store.saveFont(name, blob);
  }
  return name;
}

// Ask for a font file to upload. Returns its name, or null if cancelled.
export function uploadFont() {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.ttf,.otf,.woff,.woff2,font/*' });
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try { resolve(await addFontFile(file, file.name)); } catch { reject(new Error("That file couldn't be read as a font. Try a .ttf, .otf or .woff file.")); }
    };
    input.click();
  });
}

// Wait until a font (in this weight and style) is ready to draw.
export function ensureFont(name, weight = 400, italic = false) {
  return document.fonts.load(`${italic ? 'italic ' : ''}${weight} 32px "${name}"`).catch(() => []);
}

export const isFontFile = (file) => /\.(ttf|otf|woff2?)$/i.test(file?.name || '');
