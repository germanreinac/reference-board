// Runs only on the Reference Board app's own page. Passes images from the extension
// to the app (the app listens for these messages), and tells the extension when the
// app is ready so anything waiting can be delivered.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'refboard-add') window.postMessage({ source: 'refboard-extension', type: 'add', item: msg.item }, location.origin);
});
document.documentElement.dataset.refboardExtension = 'installed';
chrome.runtime.sendMessage({ type: 'bridge-ready' });
