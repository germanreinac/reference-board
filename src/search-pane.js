// The image search pane: a search box, a choice of source, and a grid of results.
// Drag a result onto a board pane, or click it, to add it to the board.

import { SOURCES, loadKeys, saveKeys } from './sources.js';

export const RESULT_DRAG_TYPE = 'application/x-refboard-result';

const GEAR = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></svg>';

export class SearchPane {
  // actions: { add(result), changed(), toast(message) }
  constructor(pane, host, actions) {
    this.type = 'search';
    this.pane = pane;
    this.actions = actions;
    this.state = { source: 'openverse', query: '', ...pane.state };
    if (!SOURCES[this.state.source]) this.state.source = 'openverse';
    this.page = 0;
    this.more = false;
    this.loading = false;
    this.searchId = 0;

    this.el = document.createElement('div');
    this.el.className = 'search-pane';
    this.el.innerHTML = `
      <form class="search-bar">
        <select class="search-source" title="Where to search"></select>
        <input class="search-input" type="search" placeholder="Search images…" spellcheck="false" autocomplete="off">
        <button type="button" class="search-gear" title="Search settings (API keys)">${GEAR}</button>
      </form>
      <div class="search-settings" hidden></div>
      <div class="search-scroll">
        <div class="search-results"></div>
        <div class="search-status"></div>
        <div class="search-end"></div>
      </div>`;
    host.appendChild(this.el);

    this.sourceSelect = this.el.querySelector('.search-source');
    for (const [id, s] of Object.entries(SOURCES)) this.sourceSelect.add(new Option(s.name, id));
    this.sourceSelect.value = this.state.source;
    this.input = this.el.querySelector('.search-input');
    this.input.value = this.state.query;
    this.resultsEl = this.el.querySelector('.search-results');
    this.statusEl = this.el.querySelector('.search-status');
    this.scrollEl = this.el.querySelector('.search-scroll');
    this.settingsEl = this.el.querySelector('.search-settings');

    this.el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); this.search(); });
    this.sourceSelect.addEventListener('change', () => {
      this.state.source = this.sourceSelect.value;
      this.save();
      if (this.state.query) this.search();
      else this.showIntro();
    });
    this.el.querySelector('.search-gear').addEventListener('click', () => this.toggleSettings());

    // Load more results when you scroll near the bottom.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadMore();
    }, { root: this.scrollEl, rootMargin: '400px' });
    this.observer.observe(this.el.querySelector('.search-end'));

    if (this.state.query) this.search();
    else this.showIntro();
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  save() {
    this.pane.state = { source: this.state.source, query: this.state.query };
    this.actions.changed();
  }

  showIntro() {
    this.resultsEl.replaceChildren();
    const s = SOURCES[this.state.source];
    const missingKey = s.needsKey && !loadKeys()[this.state.source];
    this.statusEl.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = missingKey ? `${s.about} Click the gear to add it.` : `${s.about} Type something and press Enter.`;
    const tip = document.createElement('p');
    tip.className = 'small';
    tip.textContent = 'Drag a result onto the board, or click it. Each image keeps a link to where it came from. Check its licence before using it in published work.';
    this.statusEl.append(p, tip);
  }

  async search() {
    const query = this.input.value.trim();
    this.state.query = query;
    this.save();
    if (!query) return this.showIntro();
    const s = SOURCES[this.state.source];
    if (s.needsKey && !loadKeys()[this.state.source]) {
      this.showIntro();
      this.toggleSettings(true);
      return;
    }
    this.resultsEl.replaceChildren();
    this.scrollEl.scrollTop = 0;
    this.page = 0;
    this.more = true;
    this.searchId++;
    await this.loadMore();
  }

  async loadMore() {
    if (this.loading || !this.more || !this.state.query) return;
    const id = this.searchId;
    const s = SOURCES[this.state.source];
    this.loading = true;
    this.statusEl.textContent = 'Searching…';
    try {
      const { results, more } = await s.search(this.state.query, this.page + 1, loadKeys()[this.state.source]);
      if (id !== this.searchId) return;  // a newer search has started
      this.page++;
      this.more = more && results.length > 0;
      for (const r of results) this.resultsEl.appendChild(this.resultCard(r));
      if (!this.resultsEl.children.length) this.statusEl.textContent = 'Nothing found. Try other words.';
      else this.statusEl.textContent = this.more ? '' : 'No more results.';
    } catch (err) {
      if (id === this.searchId) {
        this.more = false;
        this.statusEl.textContent = err.message;
      }
    } finally {
      this.loading = false;
    }
    // If the results don't fill the pane yet, the "near the bottom" signal won't
    // fire again on its own, so check once more.
    if (this.more && id === this.searchId) {
      const end = this.el.querySelector('.search-end');
      this.observer.unobserve(end);
      this.observer.observe(end);
    }
  }

  resultCard(r) {
    const card = document.createElement('figure');
    card.className = 'result';
    card.draggable = true;
    card.title = [r.title, r.author && `by ${r.author}`, r.license].filter(Boolean).join(' · ');
    const img = document.createElement('img');
    img.src = r.thumb;
    img.loading = 'lazy';
    img.alt = r.title || '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    if (r.width && r.height) img.style.aspectRatio = `${r.width} / ${r.height}`;
    img.addEventListener('error', () => card.remove());  // hide pictures that fail to load
    const caption = document.createElement('figcaption');
    caption.textContent = r.author || r.title || '';
    const add = document.createElement('span');
    add.className = 'result-add';
    add.textContent = '+';
    card.append(img, caption, add);

    card.addEventListener('click', () => this.actions.add(r));
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(RESULT_DRAG_TYPE, JSON.stringify(r));
      e.dataTransfer.setData('text/uri-list', r.full);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
    });
    return card;
  }

  toggleSettings(open = this.settingsEl.hidden) {
    this.settingsEl.hidden = !open;
    if (!open) return;
    const keys = loadKeys();
    this.settingsEl.replaceChildren();
    const intro = document.createElement('p');
    intro.textContent = 'Unsplash and Pexels need a free key. It stays in this browser only.';
    this.settingsEl.appendChild(intro);
    for (const [id, s] of Object.entries(SOURCES)) {
      if (!s.needsKey) continue;
      const row = document.createElement('label');
      row.className = 'key-row';
      const name = document.createElement('span');
      name.innerHTML = `${s.keyLabel} · <a href="${s.keyHelp}" target="_blank" rel="noopener">get one</a>`;
      const input = document.createElement('input');
      input.type = 'password';
      input.value = keys[id] || '';
      input.placeholder = 'Paste key';
      input.autocomplete = 'off';
      input.addEventListener('change', () => {
        const k = loadKeys();
        if (input.value.trim()) k[id] = input.value.trim();
        else delete k[id];
        saveKeys(k);
        if (id === this.state.source && this.state.query) this.search();
      });
      row.append(name, input);
      this.settingsEl.appendChild(row);
    }
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'text-button';
    done.textContent = 'Done';
    done.addEventListener('click', () => {
      this.toggleSettings(false);
      if (this.state.query) this.search(); else this.showIntro();
    });
    this.settingsEl.appendChild(done);
  }

  destroy() {
    this.observer.disconnect();
    this.el.remove();
  }
}
