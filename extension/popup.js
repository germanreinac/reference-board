// The small window that opens from the extension's button.
for (const b of document.querySelectorAll('button')) {
  b.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ type: 'popup', action: b.dataset.action, tab });
    window.close();
  });
}
