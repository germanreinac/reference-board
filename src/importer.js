// Getting images into the app: files dragged from your computer, images dragged
// from other browser tabs, and images pasted from the clipboard.
//
// Each function returns a list of { blob, name, sourceUrl } ready to be decoded.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;

// From a drag-and-drop.
export async function imagesFromDrop(dataTransfer) {
  // 1. Real files (from Finder / Explorer, or sometimes from another tab).
  const files = [...dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return files.map((f) => ({ blob: f, name: f.name, sourceUrl: '' }));

  // 2. An image dragged from a web page arrives as a link, not a file.
  const url = urlFromDrop(dataTransfer);
  if (url) return [await fetchImage(url)];

  return [];
}

// From a paste (Ctrl/Cmd + V).
export async function imagesFromPaste(clipboardData) {
  const files = [...clipboardData.items]
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length) return files.map((f) => ({ blob: f, name: f.name || 'pasted image', sourceUrl: '' }));

  // A copied link to an image also works.
  const text = clipboardData.getData('text/plain').trim();
  if (/^https?:\/\/\S+$/.test(text)) return [await fetchImage(text)];

  return [];
}

// Look for an image address in what was dropped.
function urlFromDrop(dt) {
  // Prefer the <img src="..."> of the dragged picture: the plain link is often the
  // page it links to, not the image itself.
  const html = dt.getData('text/html');
  if (html) {
    const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
    if (img) return img.src;
  }
  const uri = dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
  if (uri && (IMAGE_EXT.test(uri) || uri.startsWith('data:image/'))) return uri.trim();
  return uri ? uri.trim() : '';
}

// Download an image from the web. Many websites refuse to let other pages
// download their images; when that happens we explain the workaround.
async function fetchImage(url) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors' });
  } catch {
    throw new Error("That website doesn't let other pages load its images. Right-click the image, choose Copy Image, then paste it here.");
  }
  if (!res.ok) throw new Error(`Couldn't load that image (error ${res.status}).`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error("That link isn't an image. Try dragging the picture itself, or copy and paste it.");
  const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'image');
  return { blob, name, sourceUrl: url.startsWith('data:') ? '' : url };
}
