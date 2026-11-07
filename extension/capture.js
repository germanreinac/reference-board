// Runs on the page you're capturing: dims the page and lets you drag a box.
// Esc cancels. When you let go, the overlay disappears and the box is sent to the
// extension, which screenshots that part.
(() => {
  if (window.__refboardCapturing) return;
  window.__refboardCapturing = true;
  const overlay = document.createElement('div');
  const box = document.createElement('div');
  const hint = document.createElement('div');
  Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair', background: 'rgba(0,0,0,0.25)' });
  Object.assign(box.style, { position: 'fixed', border: '2px solid #4da3ff', background: 'rgba(77,163,255,0.12)', display: 'none', pointerEvents: 'none', borderRadius: '4px' });
  Object.assign(hint.style, { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: '10px', background: 'rgba(20,20,22,0.9)', color: '#fff', font: '13px system-ui, sans-serif', pointerEvents: 'none' });
  hint.textContent = 'Drag a box to capture it to Reference Board · Esc to cancel';
  overlay.append(box, hint);
  document.documentElement.appendChild(overlay);
  let start = null;
  const done = () => { overlay.remove(); window.removeEventListener('keydown', onKey, true); window.__refboardCapturing = false; };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    overlay.setPointerCapture(e.pointerId);
    box.style.display = 'block';
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!start) return;
    Object.assign(box.style, {
      left: `${Math.min(start.x, e.clientX)}px`, top: `${Math.min(start.y, e.clientY)}px`,
      width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px`,
    });
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!start) return;
    const rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
    done();
    if (rect.w < 4 || rect.h < 4) return;
    // Wait two frames so the overlay is gone from the screenshot.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chrome.runtime.sendMessage({ type: 'area-chosen', rect, ratio: window.devicePixelRatio || 1 });
    }));
  });
})();
