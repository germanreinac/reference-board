// The home screen: your boards, grouped by project.
//
// Boards not in a project come first (next to "New board"), then one section per project.
// A project is just a name boards share (record.group): it exists while it has boards.
// Projects can be folded away, renamed, or removed (their boards stay).
//
// Picking several boards: the Select button, or Ctrl/⌘-click a board. Then move them to
// a project or delete them all at once. Boards can also be dragged onto a project.

import { store } from './storage.js';
import { showMenu } from './menu.js';
import { lookBackground } from './theme.js';

const timeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const DRAG_TYPE = 'application/x-refboard-boards';
const FOLDED = 'refboard.foldedProjects';
const PROJECT_ORDER = 'refboard.projectOrder';   // the order you've dragged your projects into
const PROJECT_DRAG = 'application/x-refboard-project';
const PROJECTS = 'refboard.projects';   // projects you made, kept even while they're empty

// "just now", "5 minutes ago", "yesterday", ...
function timeAgo(ts) {
  const seconds = (ts - Date.now()) / 1000;
  if (seconds > -60) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]];
  let unit = units[0];
  for (const u of units) if (-seconds >= u[1]) unit = u;
  return timeFormat.format(Math.round(seconds / unit[1]), unit[0]);
}

const ICON_MORE = '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
const ICON_FOLD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 6.5L8 9l2.5-2.5"/></svg>';
const ICON_TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8.3l2.3 2.2 4.7-5"/></svg>';

export class Home {
  // actions: { open(id), create({ group }), importFile(), rename(id, name), exportFile(id),
  //            remove(ids), setGroup(ids, group) }
  constructor(element, actions) {
    this.el = element;
    this.actions = actions;
    this.urls = [];            // preview picture links, freed on every refresh
    this.boards = [];
    this.selected = new Set();
    this.selecting = false;
    try { this.folded = new Set(JSON.parse(localStorage.getItem(FOLDED) || '[]')); } catch { this.folded = new Set(); }
    this.sections = element.querySelector('.board-sections');
    this.loose = element.querySelector('.board-grid.loose');
    this.bar = element.querySelector('.select-bar');
    element.querySelector('[data-action="new"]').addEventListener('click', () => actions.create());
    element.querySelector('[data-action="open-file"]').addEventListener('click', () => actions.importFile());
    try { this.made = JSON.parse(localStorage.getItem(PROJECTS) || '[]'); } catch { this.made = []; }
    if (!Array.isArray(this.made)) this.made = [];
    element.querySelector('[data-action="new-project"]').addEventListener('click', () => this.newProject());
    // Thumbnails or a plain list (remembered).
    const VIEW = 'refboard.homeView';
    const viewButton = element.querySelector('[data-action="view"]');
    const ICON_LIST = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.500 4h11M2.500 8h11M2.500 12h11"/></svg>';
    const ICON_GRID = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
    const setView = (list) => {
      element.classList.toggle('list-view', list);
      viewButton.innerHTML = list ? ICON_GRID : ICON_LIST;
      viewButton.title = list ? 'Show boards as thumbnails' : 'Show boards as a list';
      try { localStorage.setItem(VIEW, list ? 'list' : 'grid'); } catch {}
    };
    let startList = false;
    try { startList = localStorage.getItem(VIEW) === 'list'; } catch {}
    setView(startList);
    viewButton.addEventListener('click', () => setView(!element.classList.contains('list-view')));
    element.querySelector('[data-action="select"]').addEventListener('click', () => this.setSelecting(!this.selecting));

    this.bar.querySelector('[data-select="all"]').addEventListener('click', () => {
      const all = this.selected.size === this.boards.length;
      this.selected = new Set(all ? [] : this.boards.map((b) => b.id));
      this.updateSelection();
    });
    this.bar.querySelector('[data-select="move"]').addEventListener('click', (e) => {
      if (!this.selected.size) return;
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.top - 4, this.moveItems([...this.selected]));
    });
    this.bar.querySelector('[data-select="delete"]').addEventListener('click', async () => {
      if (!this.selected.size) return;
      if (await actions.remove([...this.selected])) this.setSelecting(false);
    });
    this.bar.querySelector('[data-select="done"]').addEventListener('click', () => this.setSelecting(false));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.selecting && document.body.dataset.mode === 'home') this.setSelecting(false);
    });
    // Dropping a board on the loose boards takes it out of its project.
    this.dropTarget(this.loose, '');
    // Dragging a project: wherever the mouse is on the page, a pink line shows the gap
    // between projects it will land in, and letting go anywhere puts it there.
    const isProject = (e) => e.dataTransfer?.types?.includes(PROJECT_DRAG);
    const slot = (e) => {
      const rects = [...this.sections.querySelectorAll('.project')].map((el) => el.getBoundingClientRect());
      let index = rects.findIndex((r) => e.clientY < r.top + r.height / 2);
      if (index < 0) index = rects.length;
      const y = !rects.length ? 0 : index < rects.length ? rects[index].top - 18 : rects.at(-1).bottom + 12;
      return { index, y, left: rects[0]?.left ?? 0, width: rects[0]?.width ?? 0 };
    };
    element.addEventListener('dragover', (e) => {
      if (!isProject(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const at = slot(e);
      const l = document.getElementById('drop-line') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'drop-line' }));
      l.hidden = false;
      Object.assign(l.style, { left: `${at.left}px`, top: `${at.y - 2}px`, width: `${at.width}px`, height: '4px' });
    });
    element.addEventListener('drop', (e) => {
      if (!isProject(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const l = document.getElementById('drop-line');
      if (l) l.hidden = true;
      const moved = e.dataTransfer.getData(PROJECT_DRAG);
      const names = this.projects();
      if (!moved || !names.includes(moved)) return;
      let { index } = slot(e);
      if (names.indexOf(moved) < index) index--;   // (it leaves its old place first)
      const order = names.filter((n) => n !== moved);
      order.splice(index, 0, moved);
      try { localStorage.setItem(PROJECT_ORDER, JSON.stringify(order)); } catch {}
      this.refresh();
    });
    element.querySelector('[data-action="new-top"]').addEventListener('click', () => actions.create());
  }

  // Projects, most recently edited first; the ones with no boards yet come first of all
  // (newest at the top), so a project you just made is right there.
  projects() {
    const latest = new Map();
    for (const b of this.boards) if (b.group) latest.set(b.group, Math.max(latest.get(b.group) || 0, b.updated));
    const empty = this.made.filter((n) => !latest.has(n)).reverse();
    const all = [...empty, ...[...latest.keys()].sort((a, b) => latest.get(b) - latest.get(a))];
    // Projects you've dragged into an order keep it; new ones come first.
    let order = [];
    try { order = JSON.parse(localStorage.getItem(PROJECT_ORDER) || '[]'); } catch {}
    const at = (n) => order.indexOf(n);
    return all.map((n, i) => [n, i]).sort((a, b) => (at(a[0]) - at(b[0])) || (a[1] - b[1])).map(([n]) => n);
  }

  // Move a project up or down the page (also done by dragging its ⠿ grip).
  _moveProject(name, step) {
    const order = this.projects();
    const i = order.indexOf(name);
    if (i < 0) return;
    order.splice(i, 1);
    order.splice(Math.max(0, Math.min(order.length, step === -Infinity ? 0 : i + step)), 0, name);
    try { localStorage.setItem(PROJECT_ORDER, JSON.stringify(order)); } catch {}
    this.refresh();
  }

  _keepProjects(list) {
    this.made = [...new Set(list.filter(Boolean))];
    try { localStorage.setItem(PROJECTS, JSON.stringify(this.made)); } catch {}
  }

  // The "New project" button: a new, empty project appears with its name ready to type.
  async newProject() {
    const taken = new Set([...this.made, ...this.boards.map((b) => b.group)]);
    let name = 'New project';
    for (let n = 2; taken.has(name); n++) name = `New project ${n}`;
    this._keepProjects([...this.made, name]);
    this.folded.delete(name);
    await this.refresh();
    const section = [...this.sections.querySelectorAll('.project')].find((el) => el.dataset.name === name);
    if (!section) return;
    section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this._renameProject(section.querySelector('.project-fold'), name, []);
  }

  async refresh() {
    // Boards you've put in order by hand keep that order; new ones come first.
    const placed = (b) => typeof b.order === 'number';
    this.boards = (await store.listBoards()).sort((a, b) => (placed(a) - placed(b)) || (placed(a) ? a.order - b.order : b.updated - a.updated));
    this._showTrash();
    const thumbs = new Map(await Promise.all(this.boards.map(async (b) => [b.id, await store.loadThumb(b.id).catch(() => null)])));
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    for (const id of [...this.selected]) if (!this.boards.some((b) => b.id === id)) this.selected.delete(id);

    this.loose.querySelectorAll('.board-card:not(.new)').forEach((el) => el.remove());
    this.sections.querySelectorAll('.project').forEach((el) => el.remove());
    for (const b of this.boards) if (!b.group) this.loose.appendChild(this._card(b, thumbs.get(b.id)));
    for (const name of this.projects()) {
      const boards = this.boards.filter((b) => b.group === name);
      this.sections.appendChild(this._project(name, boards, thumbs));
    }
    this.el.classList.toggle('no-boards', this.boards.length === 0);
    this.updateSelection();
  }

  // The trash: deleted boards, kept for 30 days. A quiet link at the bottom of the page.
  async _showTrash() {
    const link = this.el.querySelector('.trash-link');
    const list = (await this.actions.trashed().catch(() => [])).sort((a, b) => b.trashed - a.trashed);
    link.hidden = !list.length;
    link.textContent = `Trash (${list.length})`;
    link.onclick = () => {
      const r = link.getBoundingClientRect();
      const left = (b) => Math.max(0, 30 - Math.floor((Date.now() - b.trashed) / 864e5));
      showMenu(r.left, r.top - 4, [
        ...list.map((b) => ({ label: `${b.name}  ·  ${left(b)} days left`, submenu: [
          { label: 'Bring it back', action: () => this.actions.restore([b.id]) },
          { label: 'Delete for good', action: () => this.actions.purge([b.id]) },
        ] })),
        '-',
        { label: 'Bring everything back', action: () => this.actions.restore(list.map((b) => b.id)) },
        { label: 'Empty the trash', action: () => this.actions.purge(list.map((b) => b.id)) },
      ]);
    };
  }

  // Dropped on a card: the dragged boards go right before or after it (in its project).
  _dropOnCard(card, record) {
    const ok = (e) => e.dataTransfer?.types?.includes(DRAG_TYPE);
    // (In the list, boards stack: before means above. As thumbnails, before means to the left.)
    const isList = () => this.el.classList.contains('list-view');
    const side = (e) => { const r = card.getBoundingClientRect(); return (isList() ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2) ? 'after' : 'before'; };
    // A pink line in the gap between two boards shows where the dragged one will land
    // (in the gap, not on a board, so it doesn't look like the two will merge).
    const line = () => document.getElementById('drop-line') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'drop-line' }));
    const clear = () => { const l = document.getElementById('drop-line'); if (l) l.hidden = true; };
    card.addEventListener('dragover', (e) => {
      if (!ok(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const r = card.getBoundingClientRect(), l = line();
      l.hidden = false;
      if (isList()) Object.assign(l.style, { left: `${r.left}px`, top: `${(side(e) === 'after' ? r.bottom + 2 : r.top - 2) - 2}px`, height: '4px', width: `${r.width}px` });
      else Object.assign(l.style, { left: `${(side(e) === 'after' ? r.right + 10 : r.left - 10) - 2}px`, top: `${r.top + 6}px`, height: `${r.height - 12}px`, width: '4px' });
    });
    card.addEventListener('dragend', clear);
    card.addEventListener('dragleave', clear);
    card.addEventListener('drop', (e) => {
      if (!ok(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const where = side(e);
      clear();
      card.closest('.drop-here')?.classList.remove('drop-here');
      const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]').filter((id) => id !== record.id);
      if (!ids.length) return;
      const group = record.group || '';
      const order = this.boards.filter((b) => (b.group || '') === group && !ids.includes(b.id)).map((b) => b.id);
      order.splice(order.indexOf(record.id) + (where === 'after' ? 1 : 0), 0, ...ids);
      this.actions.arrange(ids, group, order);
    });
  }

  // ---------- Projects ----------

  _project(name, boards, thumbs) {
    const section = document.createElement('section');
    section.className = 'project';
    section.dataset.name = name;
    section.classList.toggle('folded', this.folded.has(name));
    const head = document.createElement('div');
    head.className = 'project-head';
    const fold = document.createElement('button');
    fold.className = 'project-fold';
    fold.innerHTML = `${ICON_FOLD}<span></span><small></small>`;
    fold.querySelector('span').textContent = name;
    fold.querySelector('small').textContent = `${boards.length} board${boards.length === 1 ? '' : 's'}`;
    fold.title = 'Fold or unfold';
    fold.addEventListener('click', () => {
      if (this.folded.has(name)) this.folded.delete(name); else this.folded.add(name);
      try { localStorage.setItem(FOLDED, JSON.stringify([...this.folded])); } catch {}
      section.classList.toggle('folded', this.folded.has(name));
    });
    const more = document.createElement('button');
    more.className = 'project-more';
    more.title = 'More';
    more.innerHTML = ICON_MORE;
    more.addEventListener('click', (e) => {
      const r = more.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'New board in this project', action: () => this.actions.create({ group: name }) },
        { label: 'Rename project', action: () => this._renameProject(fold, name, boards) },
        { label: 'Move up', disabled: this.projects()[0] === name, action: () => this._moveProject(name, -1) },
        { label: 'Move down', disabled: this.projects().at(-1) === name, action: () => this._moveProject(name, 1) },
        { label: 'Move to the top', disabled: this.projects()[0] === name, action: () => this._moveProject(name, -Infinity) },
        { label: 'Select its boards', action: () => { this.selected = new Set(boards.map((b) => b.id)); this.setSelecting(true); } },
        '-',
        { label: boards.length ? 'Remove project (keep its boards)' : 'Remove project', action: async () => {
          this._keepProjects(this.made.filter((n) => n !== name));
          if (boards.length) await this.actions.setGroup(boards.map((b) => b.id), ''); else await this.refresh();
        } },
      ]);
      e.stopPropagation();
    });
    head.append(fold, more);
    // Drag a project by its name to move it above or below another project.
    const grip = document.createElement('span');
    grip.className = 'project-grip';
    grip.textContent = '⠿';
    grip.title = 'Drag to move this project up or down';
    head.prepend(grip);
    // The whole header drags the project: its grip, its name, the space beside it.
    head.draggable = true;
    fold.draggable = true;
    head.addEventListener('dragstart', (e) => {
      if (e.target.closest?.('.name-input, .project-more')) { e.preventDefault(); return; }
      document.body.classList.add('dragging-project');
      try { e.dataTransfer.setDragImage(head, 20, 14); } catch {}
      e.dataTransfer.setData(PROJECT_DRAG, name);
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
    head.addEventListener('dragend', () => { document.body.classList.remove('dragging-project'); const l = document.getElementById('drop-line'); if (l) l.hidden = true; });
    const grid = document.createElement('div');
    grid.className = 'board-grid';
    // A small + in the header starts a board in this project (no big card taking up room).
    const add = document.createElement('button');
    add.className = 'project-add';
    add.title = `New board in ${name}`;
    add.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.500v9M3.500 8h9"/></svg>';
    add.addEventListener('click', (e) => { e.stopPropagation(); this.actions.create({ group: name }); });
    head.insertBefore(add, more);
    if (!boards.length) {
      const empty = document.createElement('button');
      empty.className = 'project-empty';
      empty.textContent = 'Empty. Drag boards here, or click to start a new board in this project.';
      empty.addEventListener('click', () => this.actions.create({ group: name }));
      grid.appendChild(empty);
    }
    for (const b of boards) grid.appendChild(this._card(b, thumbs.get(b.id)));
    section.append(head, grid);
    this.dropTarget(section, name);
    return section;
  }

  _renameProject(fold, name, boards) {
    const label = fold.querySelector('span');
    const input = document.createElement('input');
    input.className = 'name-input';
    input.value = name;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== name) {
        if (this.folded.delete(name)) this.folded.add(value);
        if (this.made.includes(name)) this._keepProjects(this.made.map((n) => (n === name ? value : n)));
        if (boards.length) await this.actions.setGroup(boards.map((b) => b.id), value); else await this.refresh();
      } else await this.refresh();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // The "Move to project" choices for some boards.
  moveItems(ids) {
    const now = new Set(ids.map((id) => this.boards.find((b) => b.id === id)?.group || ''));
    const items = this.projects().map((name) => ({
      label: name, disabled: now.size === 1 && now.has(name), action: () => this.actions.setGroup(ids, name),
    }));
    return [
      ...items,
      ...(items.length ? ['-'] : []),
      { label: 'New project…', action: () => this._newProject(ids) },
      { label: 'No project', disabled: now.size === 1 && now.has(''), action: () => this.actions.setGroup(ids, '') },
    ];
  }

  async _newProject(ids) {
    const name = prompt('Name the new project:', '')?.trim();
    if (!name) return;
    this._keepProjects([...this.made, name]);
    await this.actions.setGroup(ids, name);
  }

  // Let boards be dragged onto this element, to move them to the project `name`.
  dropTarget(el, name) {
    const ok = (e) => e.dataTransfer?.types?.includes(DRAG_TYPE);
    el.addEventListener('dragover', (e) => {
      if (!ok(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-here');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-here'); });
    el.addEventListener('drop', (e) => {
      if (!ok(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-here');
      const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]');
      if (ids.length) this.actions.setGroup(ids, name);
    });
  }

  // ---------- Picking several boards ----------

  setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    this.updateSelection();
  }

  toggle(id) {
    if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    this.selecting = true;
    this.updateSelection();
  }

  updateSelection() {
    this.el.classList.toggle('selecting', this.selecting);
    this.bar.hidden = !this.selecting;
    const n = this.selected.size;
    this.bar.querySelector('.select-count').textContent = n ? `${n} selected` : 'Pick boards';
    this.bar.querySelector('[data-select="all"]').textContent = n && n === this.boards.length ? 'Select none' : 'Select all';
    for (const b of this.bar.querySelectorAll('[data-select="move"], [data-select="delete"]')) b.disabled = !n;
    this.el.querySelector('[data-action="select"]').textContent = this.selecting ? 'Done' : 'Select';
    for (const card of this.el.querySelectorAll('.board-card[data-id]')) card.classList.toggle('selected', this.selected.has(card.dataset.id));
  }

  // ---------- A board ----------

  _card(record, thumb) {
    const card = document.createElement('div');
    card.className = 'board-card';
    card.tabIndex = 0;
    card.dataset.id = record.id;
    card.draggable = true;

    // The preview, on the board's own background (its look: dark, light or colour).
    const preview = document.createElement('div');
    preview.className = 'thumb';
    preview.style.backgroundColor = lookBackground(record.look);
    if (thumb) {
      const url = URL.createObjectURL(thumb);
      this.urls.push(url);
      preview.style.backgroundImage = `url("${url}")`;
    } else {
      preview.classList.add('empty');
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = record.name;
    const when = document.createElement('div');
    when.className = 'when';
    const count = record.board?.items?.length || 0;
    const waiting = record.board?.incoming?.length || 0;
    when.textContent = `${record.offloaded ? 'In Google Drive' : timeAgo(record.updated)} · ${count} image${count === 1 ? '' : 's'}${waiting ? ` · ${waiting} new` : ''}`;
    if (record.offloaded) {
      // Removed from this computer: a cloud on its preview. It downloads when opened.
      card.classList.add('offloaded');
      card.title = 'Kept in Google Drive to save space here. It downloads when you open it.';
      const cloud = document.createElement('span');
      cloud.className = 'cloud';
      cloud.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.500 12.500h7.200a3 3 0 00.4-6 4.200 4.200 0 00-8.100.9A2.600 2.600 0 004.500 12.500z"/><path d="M8 7.200v3.300M6.600 9.200L8 10.600l1.400-1.400"/></svg>';
      preview.appendChild(cloud);
    }
    meta.append(name, when);

    const check = document.createElement('span');
    check.className = 'check';
    check.innerHTML = ICON_TICK;
    check.title = 'Select';
    check.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(record.id); });

    const more = document.createElement('button');
    more.className = 'more';
    more.title = 'More';
    more.innerHTML = ICON_MORE;
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: record.offloaded ? 'Open (downloads from Google Drive)' : 'Open', action: () => this.actions.open(record.id) },
        { label: 'Rename', action: () => this._rename(card, record) },
        { label: 'Move to project', submenu: this.moveItems([record.id]) },
        { label: 'Select', action: () => this.toggle(record.id) },
        { label: 'Save to file…', action: () => this.actions.exportFile(record.id) },
        ...(record.offloaded ? [] : [{ label: 'Remove from this computer (keep in Drive)', action: () => this.actions.offload(record.id) }]),
        '-',
        { label: 'Delete', action: () => this.actions.remove([record.id]) },
      ]);
    });

    card.append(preview, meta, check, more);
    card.addEventListener('click', (e) => {
      if (this.selecting || e.ctrlKey || e.metaKey || e.shiftKey) this.toggle(record.id);
      else this.actions.open(record.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter') this.actions.open(record.id);
      if (e.key === ' ') { e.preventDefault(); this.toggle(record.id); }
    });
    // Drag a board (or all the picked ones, if it's one of them) onto a project.
    card.addEventListener('dragstart', (e) => {
      const ids = this.selected.has(record.id) ? [...this.selected] : [record.id];
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging-boards');
    });
    card.addEventListener('dragend', () => document.body.classList.remove('dragging-boards'));
    this._dropOnCard(card, record);
    return card;
  }

  // Turn the card's name into a text box.
  _rename(card, record) {
    const nameEl = card.querySelector('.name');
    const input = document.createElement('input');
    input.className = 'name-input';
    input.value = record.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== record.name) await this.actions.rename(record.id, value);
      await this.refresh();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
}
