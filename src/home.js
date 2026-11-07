// The home screen: a minimal list of your boards.
// "New board", "Open file…", and a grid of boards with a preview and when each was last edited.

import { store } from './storage.js';
import { showMenu } from './menu.js';

const timeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

// "just now", "5 minutes ago", "yesterday", ...
function timeAgo(ts) {
  const seconds = (ts - Date.now()) / 1000;
  if (seconds > -60) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]];
  let unit = units[0];
  for (const u of units) if (-seconds >= u[1]) unit = u;
  return timeFormat.format(Math.round(seconds / unit[1]), unit[0]);
}

export class Home {
  // actions: { open(id), create(), importFile(), rename(id, name), exportFile(id), remove(id) }
  constructor(element, actions) {
    this.el = element;
    this.actions = actions;
    this.urls = [];  // preview picture links, freed on every refresh
    this.grid = element.querySelector('.board-grid');
    element.querySelector('[data-action="new"]').addEventListener('click', () => actions.create());
    element.querySelector('[data-action="open-file"]').addEventListener('click', () => actions.importFile());
  }

  async refresh() {
    const boards = (await store.listBoards()).sort((a, b) => b.updated - a.updated);
    const thumbs = await Promise.all(boards.map((b) => store.loadThumb(b.id).catch(() => null)));
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];

    this.grid.querySelectorAll('.board-card:not(.new)').forEach((el) => el.remove());
    boards.forEach((b, i) => this.grid.appendChild(this._card(b, thumbs[i])));
    this.el.classList.toggle('no-boards', boards.length === 0);
  }

  _card(record, thumb) {
    const card = document.createElement('div');
    card.className = 'board-card';
    card.tabIndex = 0;
    card.dataset.id = record.id;

    const preview = document.createElement('div');
    preview.className = 'thumb';
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

    const more = document.createElement('button');
    more.className = 'more';
    more.title = 'More';
    more.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'Open', action: () => this.actions.open(record.id) },
        { label: 'Rename', action: () => this._rename(card, record) },
        { label: 'Save to file…', action: () => this.actions.exportFile(record.id) },
        '-',
        { label: 'Delete', action: () => this.actions.remove(record.id, record.name) },
      ]);
    });

    card.append(preview, meta, more);
    card.addEventListener('click', () => this.actions.open(record.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) this.actions.open(record.id); });
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
