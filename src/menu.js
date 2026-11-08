// A small right-click menu, with submenus.
//
// showMenu(x, y, items) where items is a list of
//   { label, shortcut, action, disabled }   a command
//   { label, submenu: [items] }             opens a menu to the side when you point at it
//   '-'                                     a separator line
// Empty sections (two separators in a row, or one at either end) are tidied away.

let levels = [];   // the open menu, then any submenus opened from it

export function showMenu(x, y, items) {
  hideMenu();
  open(x, y, items, 0);
}

function tidy(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-' && (!out.length || out[out.length - 1] === '-')) continue;
    if (it.submenu && !tidy(it.submenu).length) continue;
    out.push(it);
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
}

function open(x, y, items, depth, from = null) {
  const el = document.createElement('div');
  el.className = 'menu';
  for (const item of tidy(items)) {
    if (item === '-') {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      continue;
    }
    const row = document.createElement('button');
    row.className = 'menu-item';
    row.disabled = !!item.disabled;
    row.innerHTML = `<span></span><kbd></kbd>`;
    row.firstChild.textContent = item.label;
    row.lastChild.textContent = item.submenu ? '›' : (item.shortcut || '');
    if (item.submenu) row.classList.add('has-sub');
    const openSub = () => {
      closeFrom(depth + 1);
      row.classList.add('open');
      const r = row.getBoundingClientRect();
      open(r.right - 2, r.top - 5, item.submenu, depth + 1, r);
    };
    row.addEventListener('pointerenter', () => {
      if (item.submenu) { clearTimeout(row.timer); row.timer = setTimeout(openSub, 90); }
      else closeFrom(depth + 1);
    });
    row.addEventListener('pointerleave', () => clearTimeout(row.timer));
    row.addEventListener('click', () => {
      if (item.submenu) { openSub(); return; }
      hideMenu();
      item.action();
    });
    el.appendChild(row);
  }
  document.body.appendChild(el);

  // Keep it inside the window. (offsetWidth/Height: its real size, not the slightly
  // shrunk size it starts at when it springs open.) A submenu that doesn't fit on the
  // right opens on the left of its menu instead.
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = x;
  if (from && left + w > window.innerWidth - 4) left = from.left - w + 2;
  left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - h - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transformOrigin = `${x <= left + 2 ? 'left' : 'right'} ${y <= top + 2 ? 'top' : 'bottom'}`;
  levels[depth] = el;
}

// Close submenus from this depth down.
function closeFrom(depth) {
  for (let i = levels.length - 1; i >= depth; i--) levels[i]?.remove();
  levels.length = Math.min(levels.length, depth);
  levels[depth - 1]?.querySelectorAll('.menu-item.open').forEach((r) => r.classList.remove('open'));
}

export function hideMenu() {
  for (const el of levels) el?.remove();
  levels = [];
}

export function menuOpen() {
  return levels.length > 0;
}

// Close the menu when clicking elsewhere or pressing Escape.
window.addEventListener('pointerdown', (e) => { if (levels.length && !levels.some((el) => el?.contains(e.target))) hideMenu(); }, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);
window.addEventListener('resize', hideMenu);
