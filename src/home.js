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
  }

  // Projects in use, most recently edited first.
  projects() {
    const latest = new Map();
    for (const b of this.boards) if (b.group) latest.set(b.group, Math.max(latest.get(b.group) || 0, b.updated));
    return [...latest.keys()].sort((a, b) => latest.get(b) - latest.get(a));
  }

  async refresh() {
    this.boards = (await store.listBoards()).sort((a, b) => b.updated - a.updated);
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

  // ---------- Projects ----------

  _project(name, boards, thumbs) {
    const section = document.createElement('section');
    section.className = 'project';
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
        { label: 'Select its boards', action: () => { this.selected = new Set(boards.map((b) => b.id)); this.setSelecting(true); } },
        '-',
        { label: 'Remove project (keep its boards)', action: () => this.actions.setGroup(boards.map((b) => b.id), '') },
      ]);
      e.stopPropagation();
    });
    head.append(fold, more);
    const grid = document.createElement('div');
    grid.className = 'board-grid';
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
        await this.actions.setGroup(boards.map((b) => b.id), value);
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
    if (name) await this.actions.setGroup(ids, name);
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
    when.textContent = `${timeAgo(record.updated)} · ${count} image${count === 1 ? '' : 's'}${waiting ? ` · ${waiting} new` : ''}`;
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
        { label: 'Open', action: () => this.actions.open(record.id) },
        { label: 'Rename', action: () => this._rename(card, record) },
        { label: 'Move to project', submenu: this.moveItems([record.id]) },
        { label: 'Select', action: () => this.toggle(record.id) },
        { label: 'Save to file…', action: () => this.actions.exportFile(record.id) },
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
