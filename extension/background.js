// The extension's background worker. It:
//   - adds "Send image to Reference Board" and "Capture part of this page" to the right-click menu
//   - downloads images (an extension can download from any site, so nothing is blocked)
//   - takes screenshots of the visible page and crops them to the box you drew
//   - hands everything to the Reference Board tab, opening it if needed. While the app
//     isn't open yet, images wait in the extension's own storage.

const APP_URL = 'https://artdirection.io/';
const APP_TABS = ['https://artdirection.io/*', 'https://www.artdirection.io/*', 'https://germanreinac.github.io/reference-board/*', 'http://localhost:8765/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'send-image', title: 'Send image to Reference Board', contexts: ['image'] });
  chrome.contextMenus.create({ id: 'capture-area', title: 'Capture part of this page to Reference Board', contexts: ['page', 'selection', 'link', 'image', 'video'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'send-image') sendImage(info.srcUrl, tab);
  if (info.menuItemId === 'capture-area') startAreaCapture(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'capture-area') return;
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab) startAreaCapture(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'bridge-ready' && sender.tab) sendPending(sender.tab.id);
  if (msg.type === 'area-chosen' && sender.tab) captureArea(sender.tab, msg.rect, msg.ratio);
  if (msg.type === 'popup') {
    if (msg.action === 'capture-area') startAreaCapture(msg.tab);
    if (msg.action === 'capture-visible') captureArea(msg.tab, null, 1);
    if (msg.action === 'open') openApp();
    reply({ ok: true });
  }
});

// ---------- Sending an image ----------

async function sendImage(url, tab) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`error ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    await deliver({ dataUrl: await toDataUrl(blob), name: nameFromUrl(url), sourceUrl: tab?.url || url });
  } catch (err) {
    console.warn('Reference Board: could not send image', err);
    flash('!', '#d64545');
  }
}

// ---------- Capturing part of the page ----------

async function startAreaCapture(tab) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
  } catch (err) {
    // Chrome's own pages (settings, the Web Store) can't be captured by extensions.
    console.warn('Reference Board: this page cannot be captured', err);
    flash('!', '#d64545');
  }
}

// rect: { x, y, w, h } in page pixels (null = the whole visible page); ratio: devicePixelRatio.
async function captureArea(tab, rect, ratio) {
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    let blob = await (await fetch(shot)).blob();
    if (rect) {
      const bitmap = await createImageBitmap(blob);
      const sx = Math.round(rect.x * ratio), sy = Math.round(rect.y * ratio);
      const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.w * ratio)));
      const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.h * ratio)));
      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    const host = (() => { try { return new URL(tab.url).hostname; } catch { return 'page'; } })();
    await deliver({ dataUrl: await toDataUrl(blob), name: `Capture from ${host}`, sourceUrl: tab.url || '' });
  } catch (err) {
    console.warn('Reference Board: capture failed', err);
    flash('!', '#d64545');
  }
}

// ---------- Handing things to the app ----------

async function appTab() {
  const tabs = await chrome.tabs.query({ url: APP_TABS });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

async function deliver(item) {
  const tab = await appTab();
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'refboard-add', item });
      flash('✓', '#2f9e5a');
      return;
    } catch {
      // the app tab is still loading: keep it for when it's ready
    }
  }
  const { pending = [] } = await chrome.storage.local.get('pending');
  pending.push(item);
  await chrome.storage.local.set({ pending });
  if (!tab) await chrome.tabs.create({ url: `${APP_URL}#/inbox` });
  flash('✓', '#2f9e5a');
}

async function sendPending(tabId) {
  const { pending = [] } = await chrome.storage.local.get('pending');
  if (!pending.length) return;
  await chrome.storage.local.set({ pending: [] });
  for (const item of pending) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'refboard-add', item }); } catch (err) { console.warn(err); }
  }
}

async function openApp() {
  const tab = await appTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
}

// ---------- Small helpers ----------

// A short mark on the extension's button: ✓ when sent, ! when something went wrong.
function flash(text, colour) {
  chrome.action.setBadgeBackgroundColor({ color: colour });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1800);
}

function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last.replace(/\.[a-z0-9]+$/i, '') || 'image';
  } catch { return 'image'; }
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(text)}`;
}
