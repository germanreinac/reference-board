// Compare mode: two images on top of each other, full screen, to see what changed
// between two versions (or how two references differ).
//
//   Slider        drag across to wipe from one to the other
//   Side by side  next to each other, zooming and moving together
//   Overlay       one on top of the other, with a see-through slider
//   Difference    only what's different shows up bright (identical parts go black)
//
// Scroll zooms, right- or middle-drag (or Space + drag) moves around. Keys 1–4 switch
// modes, X swaps the two, Esc closes.

const MODES = [
  ['slider', 'Slider'],
  ['side', 'Side by side'],
  ['overlay', 'Overlay'],
  ['difference', 'Difference'],
];

let open = null;

// a and b: { url, name, width, height }. onClose runs when it's closed.
export function openCompare(a, b, onClose = () => {}) {
  closeCompare();
  const el = document.createElement('div');
  el.className = 'compare';
  el.innerHTML = `
    <div class="compare-bar">
      <span class="compare-name" data-n="a"></span>
      <div class="compare-modes">${MODES.map(([id, label], i) => `<button data-mode="${id}" title="${label} (${i + 1})">${label}</button>`).join('')}</div>
      <label class="compare-opacity" hidden>See-through <input type="range" min="0" max="100" value="50"></label>
      <button data-a="swap" title="Swap the two (X)">Swap</button>
      <span class="compare-name" data-n="b"></span>
      <button data-a="close" class="compare-close" title="Close (Esc)"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>
    <div class="compare-stage">
      <div class="compare-view">
        <div class="compare-box" data-box="a"><img draggable="false" alt=""></div>
        <div class="compare-box" data-box="b"><img draggable="false" alt=""></div>
      </div>
      <div class="compare-handle"><span></span></div>
    </div>`;
  document.body.appendChild(el);

  const stage = el.querySelector('.compare-stage');
  const view = el.querySelector('.compare-view');
  const boxA = el.querySelector('[data-box="a"]');
  const boxB = el.querySelector('[data-box="b"]');
  const handle = el.querySelector('.compare-handle');
  const opacity = el.querySelector('.compare-opacity input');
  const state = { a, b, mode: 'slider', split: 0.5, zoom: 1, x: 0, y: 0, alpha: 0.5 };

  // Both images get the same box: big enough for either, fitted to the screen.
  function layout() {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const side = state.mode === 'side';
    const aspect = Math.max(state.a.width / state.a.height, state.b.width / state.b.height);
    const availW = side ? (sw - 30) / 2 : sw - 40;
    const availH = sh - 40;
    let w = availW, h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    for (const [box, img] of [[boxA, state.a], [boxB, state.b]]) {
      box.querySelector('img').src = img.url;
      Object.assign(box.style, { width: `${w}px`, height: `${h}px` });
    }
    const gap = side ? 20 : 0;
    const total = side ? w * 2 + gap : w;
    boxA.style.left = `${(sw - total) / 2}px`;
    boxB.style.left = `${(sw - total) / 2 + (side ? w + gap : 0)}px`;
    boxA.style.top = boxB.style.top = `${(sh - h) / 2}px`;
    state.box = { w, h, left: (sw - total) / 2, top: (sh - h) / 2 };
    apply();
  }

  function apply() {
    view.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
    el.dataset.mode = state.mode;
    boxB.style.opacity = state.mode === 'overlay' ? state.alpha : '';
    // Slider: B shows to the right of the line.
    if (state.mode === 'slider') {
      const lineX = stage.clientWidth * state.split;
      // Where the line falls inside B's box, after zoom and move.
      const boxLeft = state.x + state.box.left * state.zoom;
      const inside = (lineX - boxLeft) / (state.box.w * state.zoom);
      boxB.style.clipPath = `inset(0 0 0 ${Math.max(0, Math.min(1, inside)) * 100}%)`;
      handle.style.left = `${lineX}px`;
    } else {
      boxB.style.clipPath = '';
    }
    el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    el.querySelector('.compare-opacity').hidden = state.mode !== 'overlay';
    el.querySelector('[data-n="a"]').textContent = state.mode === 'side' || state.mode === 'slider' ? `◧ ${state.a.name}` : `Under: ${state.a.name}`;
    el.querySelector('[data-n="b"]').textContent = state.mode === 'side' || state.mode === 'slider' ? `${state.b.name} ◨` : `On top: ${state.b.name}`;
  }

  function setMode(m) { state.mode = m; state.zoom = 1; state.x = state.y = 0; layout(); }
  function swap() { [state.a, state.b] = [state.b, state.a]; layout(); }

  el.querySelector('.compare-modes').addEventListener('click', (e) => { const m = e.target.closest('[data-mode]')?.dataset.mode; if (m) setMode(m); });
  el.querySelector('[data-a="swap"]').addEventListener('click', swap);
  el.querySelector('[data-a="close"]').addEventListener('click', closeCompare);
  opacity.addEventListener('input', () => { state.alpha = opacity.value / 100; apply(); });

  // Scroll: zoom towards the mouse.
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const z = Math.min(40, Math.max(0.2, state.zoom * f));
    state.x = mx - (mx - state.x) * (z / state.zoom);
    state.y = my - (my - state.y) * (z / state.zoom);
    state.zoom = z;
    apply();
  }, { passive: false });

  // Left-drag moves the slider line (in slider mode); right/middle-drag or Space+drag moves the view.
  let drag = null;
  let space = false;
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    const pan = e.button !== 0 || space || state.mode !== 'slider';
    drag = { pan, x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
    if (!pan) moveSplit(e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.pan) { state.x = drag.ox + e.clientX - drag.x; state.y = drag.oy + e.clientY - drag.y; apply(); }
    else moveSplit(e);
  });
  stage.addEventListener('pointerup', () => { drag = null; });
  function moveSplit(e) {
    const r = stage.getBoundingClientRect();
    state.split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    apply();
  }
  stage.addEventListener('dblclick', () => { state.zoom = 1; state.x = state.y = 0; apply(); });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeCompare(); }
    else if (/^[1-4]$/.test(e.key)) setMode(MODES[Number(e.key) - 1][0]);
    else if (e.key === 'x' || e.key === 'X') swap();
    else if (e.code === 'Space') { space = true; e.preventDefault(); }
    else return;
    e.stopPropagation();
  };
  const onKeyUp = (e) => { if (e.code === 'Space') space = false; };
  const onResize = () => layout();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('resize', onResize);

  open = { el, cleanup: () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('resize', onResize); onClose(); } };
  requestAnimationFrame(layout);
}

export function closeCompare() {
  if (!open) return;
  open.cleanup();
  open.el.remove();
  open = null;
}

export const compareOpen = () => open !== null;
