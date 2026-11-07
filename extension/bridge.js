// Runs only on the Reference Board app's own page. It passes messages both ways:
//   extension → app: images to add (the app listens for these messages)
//   app → extension: the list of boards, for the "Save to board" menu
// and tells the extension when the app is ready, so anything waiting can be delivered.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'refboard-add') window.postMessage({ source: 'refboard-extension', type: 'add', item: msg.item }, location.origin);
});
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'refboard-app') return;
  if (e.data.type === 'boards' && Array.isArray(e.data.boards)) {
    chrome.runtime.sendMessage({ type: 'boards', boards: e.data.boards.map((b) => ({ id: String(b.id), name: String(b.name).slice(0, 80), updated: Number(b.updated) || 0 })) });
  }
});
document.documentElement.dataset.refboardExtension = 'installed';
chrome.runtime.sendMessage({ type: 'bridge-ready' });
// Ask the app for its boards (it may have announced them before this script ran).
window.postMessage({ source: 'refboard-extension', type: 'hello' }, location.origin);
