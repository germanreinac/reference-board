// A small right-click menu.
//
// showMenu(x, y, items) where items is a list of
//   { label, shortcut, action, disabled }   or   '-' for a separator line.

let current = null;

export function showMenu(x, y, items) {
  hideMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  for (const item of items) {
    if (item === '-') {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      continue;
    }
    const row = document.createElement('button');
    row.className = 'menu-item';
    row.disabled = !!item.disabled;
    row.innerHTML = `<span></span><kbd></kbd>`;
    row.firstChild.textContent = item.label;
    row.lastChild.textContent = item.shortcut || '';
    row.addEventListener('click', () => { hideMenu(); item.action(); });
    el.appendChild(row);
  }
  document.body.appendChild(el);

  // Keep the menu inside the window. (offsetWidth/Height: its real size, not the
  // slightly shrunk size it starts at when it springs open.)
  const r = { width: el.offsetWidth, height: el.offsetHeight };
  const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  // Spring open from the corner nearest to where it was asked for.
  el.style.transformOrigin = `${x <= left + 2 ? 'left' : 'right'} ${y <= top + 2 ? 'top' : 'bottom'}`;
  current = el;
}

export function hideMenu() {
  current?.remove();
  current = null;
}

export function menuOpen() {
  return current !== null;
}

// Close the menu when clicking elsewhere or pressing Escape.
window.addEventListener('pointerdown', (e) => { if (current && !current.contains(e.target)) hideMenu(); }, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);
window.addEventListener('resize', hideMenu);
