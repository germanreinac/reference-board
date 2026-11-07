// The extension's background worker. It:
//   - adds "Save image to board" (with your boards) and "Capture part of this page"
//     to the right-click menu
//   - downloads images (an extension can download from any site, so nothing is blocked)
//   - takes screenshots of the visible page and crops them to the box you drew
//   - shows a small board picker on the page when you choose "Choose a board…"
//   - hands everything to the Reference Board tab, opening it in the background if
//     needed. While the app isn't open yet, images wait in the extension's own storage.

const APP_URL = 'https://artdirection.io/';
const APP_TABS = ['https://artdirection.io/*', 'https://www.artdirection.io/*', 'https://germanreinac.github.io/reference-board/*', 'http://localhost:8765/*'];
const RECENT = 8;  // boards listed straight in the menu

chrome.runtime.onInstalled.addListener(() => buildMenus());
chrome.runtime.onStartup.addListener(() => buildMenus());

// ---------- Your boards, as the app last told us ----------

async function getBoards() {
  const { boards = [], used = {} } = await chrome.storage.local.get(['boards', 'used']);
  // Boards you saved to most recently first, then the ones edited most recently.
  return boards.slice().sort((a, b) => (used[b.id] || 0) - (used[a.id] || 0) || b.updated - a.updated);
}

async function markUsed(boardId) {
  if (!boardId) return;
  const { used = {} } = await chrome.storage.local.get('used');
  used[boardId] = Date.now();
  await chrome.storage.local.set({ used });
  buildMenus();
}

let building = Promise.resolve();
function buildMenus() {
  building = building.then(async () => {
    const boards = await getBoards();
    await chrome.contextMenus.removeAll();
    const menu = (o) => chrome.contextMenus.create(o, () => void chrome.runtime.lastError);
    menu({ id: 'save', title: 'Save image to board', contexts: ['image'] });
    if (boards.length) {
      for (const b of boards.slice(0, RECENT)) menu({ id: `save:${b.id}`, parentId: 'save', title: b.name.replace(/&/g, '&&'), contexts: ['image'] });
    } else {
      menu({ id: 'save:inbox', parentId: 'save', title: 'Inbox', contexts: ['image'] });
    }
    menu({ id: 'save-sep', parentId: 'save', type: 'separator', contexts: ['image'] });
    menu({ id: 'save-pick', parentId: 'save', title: boards.length > RECENT ? `Choose a board… (all ${boards.length})` : 'Choose a board…', contexts: ['image'] });
    menu({ id: 'save-new', parentId: 'save', title: 'New board…', contexts: ['image'] });
    menu({ id: 'capture-area', title: 'Capture part of this page…', contexts: ['page', 'selection', 'link', 'image', 'video'] });
  }).catch((err) => console.warn('Reference Board: menu', err));
  return building;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id === 'save-pick') saveImage(info.srcUrl, tab, 'pick');
  else if (id === 'save-new') saveImage(info.srcUrl, tab, 'new');
  else if (id === 'save:inbox') saveImage(info.srcUrl, tab, { boardId: null });
  else if (id.startsWith('save:')) saveImage(info.srcUrl, tab, { boardId: id.slice(5) });
  else if (id === 'capture-area') startAreaCapture(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'capture-area') return;
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab) startAreaCapture(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'bridge-ready' && sender.tab) sendPending(sender.tab.id);
  if (msg.type === 'boards' && Array.isArray(msg.boards)) chrome.storage.local.set({ boards: msg.boards }).then(buildMenus);
  if (msg.type === 'area-chosen' && sender.tab) captureArea(sender.tab, msg.rect, msg.ratio);
  if (msg.type === 'popup') {
    if (msg.action === 'capture-area') startAreaCapture(msg.tab);
    if (msg.action === 'capture-visible') captureArea(msg.tab, null, 1);
    if (msg.action === 'open') openApp();
    reply({ ok: true });
  }
});

// ---------- Saving an image ----------

// target: { boardId } | 'pick' (show the board picker) | 'new' (name a new board)
async function saveImage(url, tab, target) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`error ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    const dataUrl = await toDataUrl(blob);
    const where = typeof target === 'object' ? target : await pickBoard(tab, dataUrl, target === 'new');
    if (!where) return;  // cancelled
    await deliver({ dataUrl, name: nameFromUrl(url), sourceUrl: tab?.url || url, ...where }, tab);
  } catch (err) {
    console.warn('Reference Board: could not save image', err);
    flash('!', '#d64545');
    note(tab, "Couldn't save that image", true);
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
// Then asks which board it goes to.
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
    const dataUrl = await toDataUrl(blob);
    const where = await pickBoard(tab, dataUrl, false);
    if (!where) return;
    const host = (() => { try { return new URL(tab.url).hostname; } catch { return 'page'; } })();
    await deliver({ dataUrl, name: `Capture from ${host}`, sourceUrl: tab.url || '', ...where }, tab);
  } catch (err) {
    console.warn('Reference Board: capture failed', err);
    flash('!', '#d64545');
  }
}

// ---------- The board picker (shown on the page) ----------

// Resolves to { boardId } or { newBoard: name }, or null if you cancelled.
async function pickBoard(tab, dataUrl, startNew) {
  const boards = await getBoards();
  if (!tab?.id) return boards[0] ? { boardId: boards[0].id } : { boardId: null };
  try {
    // A small preview for the picker (big images would be slow to pass to the page).
    const preview = await smallPreview(dataUrl);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showBoardPicker,
      args: [boards.map(({ id, name }) => ({ id, name })), preview, !!startNew],
    });
    return result || null;
  } catch (err) {
    // Pages that don't allow it (Chrome's own pages): the board you used last.
    console.warn('Reference Board: picker unavailable here', err);
    return boards[0] ? { boardId: boards[0].id } : { boardId: null };
  }
}

// This function runs inside the web page. Everything it needs is passed in.
function showBoardPicker(boards, preview, startNew) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
        .back { position: fixed; inset: 0; background: rgba(0,0,0,.35); }
        .box { position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: 340px; max-width: calc(100vw - 24px);
          background: #1f1f23; color: #d8d8dc; border: 1px solid #3a3a40; border-radius: 12px; box-shadow: 0 16px 50px rgba(0,0,0,.5); overflow: hidden; font-size: 13px; }
        .top { display: flex; gap: 10px; align-items: center; padding: 12px; border-bottom: 1px solid #2c2c31; }
        .top img { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; background: #2a2a2f; flex: none; }
        .top b { display: block; color: #fff; font-size: 13px; margin-bottom: 6px; }
        input { width: 100%; padding: 7px 9px; border: 1px solid #3a3a40; border-radius: 7px; background: #141416; color: #fff; font-size: 13px; outline: none; }
        input:focus { border-color: #4da3ff; }
        ul { list-style: none; margin: 0; padding: 6px; max-height: 300px; overflow-y: auto; }
        li { padding: 7px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        li.on { background: #4da3ff; color: #fff; }
        li.new { color: #8fc4ff; }
        li.on.new { color: #fff; }
        .hint { padding: 0 12px 10px; font-size: 11px; opacity: .55; }
      </style>
      <div class="back"></div>
      <div class="box" role="dialog" aria-label="Save to board">
        <div class="top"><img alt=""><div style="flex:1;min-width:0"><b>Save to board</b><input placeholder="Find or name a board…" spellcheck="false"></div></div>
        <ul></ul>
        <div class="hint">↑ ↓ to choose · Enter to save · Esc to cancel</div>
      </div>`;
    const img = root.querySelector('img');
    if (preview) img.src = preview; else img.remove();
    const input = root.querySelector('input');
    const list = root.querySelector('ul');
    let options = [];
    let at = 0;
    const done = (value) => {
      host.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      options = boards.filter((b) => !q || b.name.toLowerCase().includes(q)).map((b) => ({ label: b.name, value: { boardId: b.id } }));
      const exact = boards.some((b) => b.name.toLowerCase() === q);
      if (q && !exact) options.push({ label: `＋ New board “${input.value.trim()}”`, value: { newBoard: input.value.trim() }, isNew: true });
      if (!boards.length && !q) options.push({ label: 'Inbox', value: { boardId: null } });
      at = Math.min(at, Math.max(0, options.length - 1));
      list.replaceChildren(...options.map((o, i) => {
        const li = document.createElement('li');
        li.textContent = o.label;
        li.className = `${i === at ? 'on' : ''} ${o.isNew ? 'new' : ''}`;
        li.addEventListener('mouseenter', () => { at = i; draw(); });
        li.addEventListener('click', () => done(o.value));
        return li;
      }));
      list.children[at]?.scrollIntoView({ block: 'nearest' });
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(options.length - 1, at + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (options[at]) done(options[at].value); }
    };
    window.addEventListener('keydown', onKey, true);
    input.addEventListener('input', () => { at = 0; draw(); });
    root.querySelector('.back').addEventListener('click', () => done(null));
    if (startNew) input.placeholder = 'Name the new board…';
    document.documentElement.appendChild(host);
    draw();
    setTimeout(() => input.focus(), 0);
  });
}

async function smallPreview(dataUrl) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const k = 104 / Math.max(bitmap.width, bitmap.height);
    const c = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    return toDataUrl(await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
  } catch { return ''; }
}

// A short message in the corner of the page: "Saved to Characters".
async function note(tab, text, bad = false) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [text, bad],
      func: (text, bad) => {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = `all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:9px 14px;border-radius:9px;
          background:${bad ? '#5a1f22' : '#1f1f23'};color:#fff;font:13px Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);
          transition:opacity .3s;opacity:1`;
        document.documentElement.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; }, 1800);
        setTimeout(() => el.remove(), 2200);
      },
    });
  } catch { /* Chrome's own pages: the badge on the button is enough */ }
}

// ---------- Handing things to the app ----------

async function appTab() {
  const tabs = await chrome.tabs.query({ url: APP_TABS });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

async function deliver(item, fromTab) {
  const boards = await getBoards();
  const name = item.newBoard || boards.find((b) => b.id === item.boardId)?.name || 'Inbox';
  if (item.boardId) markUsed(item.boardId);
  const tab = await appTab();
  let sent = false;
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'refboard-add', item });
      sent = true;
    } catch {
      // the app tab is still loading: keep it for when it's ready
    }
  }
  if (!sent) {
    const { pending = [] } = await chrome.storage.local.get('pending');
    pending.push(item);
    await chrome.storage.local.set({ pending });
    // Open the app in the background, so saving doesn't take you away from the page.
    if (!tab) await chrome.tabs.create({ url: APP_URL, active: false });
  }
  flash('✓', '#2f9e5a');
  note(fromTab, `Saved to ${name}`);
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
