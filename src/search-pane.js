// The image search pane: one search box over every source (see src/search-engine.js),
// a Pinterest-style grid, suggested words to narrow the search, "More like this",
// and "Fill board" to drop a whole mood board onto the board at once.

import { SOURCES, loadKeys, saveKeys } from './sources.js';
import { MixedSearch, activeSources, loadOff, saveOff, rememberTaste, similarQuery } from './search-engine.js';

export const RESULT_DRAG_TYPE = 'application/x-refboard-result';

const GEAR = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></svg>';
const GRID = '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="7" rx="1"/><rect x="9" y="2" width="5" height="4" rx="1"/><rect x="2" y="11" width="5" height="3" rx="1"/><rect x="9" y="8" width="5" height="6" rx="1"/></svg>';
const SOURCE_SHORT = { openverse: 'Openverse', unsplash: 'Unsplash', pexels: 'Pexels' };

export class SearchPane {
  // actions: { add(result), fill(results, query), changed(), toast(message) }
  constructor(pane, host, actions) {
    this.type = 'search';
    this.pane = pane;
    this.actions = actions;
    this.state = { query: '', fillCount: 20, ...pane.state };
    this.search = null;     // the MixedSearch in progress
    this.loading = false;
    this.runId = 0;

    this.el = document.createElement('div');
    this.el.className = 'search-pane';
    this.el.innerHTML = `
      <form class="search-bar">
        <input class="search-input" type="search" placeholder="Search images, or describe a mood…" spellcheck="false" autocomplete="off">
        <div class="fill-group" title="Drop a mood board of these results onto the board">
          <button type="button" class="fill-button">${GRID}<span>Fill board</span></button>
          <select class="fill-count" title="How many images">
            <option>10</option><option>20</option><option>30</option><option>50</option>
          </select>
        </div>
        <button type="button" class="search-gear" title="Sources and API keys">${GEAR}</button>
      </form>
      <div class="search-chips"></div>
      <div class="search-settings" hidden></div>
      <div class="search-scroll">
        <div class="search-results"></div>
        <div class="search-status"></div>
        <div class="search-end"></div>
      </div>`;
    host.appendChild(this.el);

    const $ = (sel) => this.el.querySelector(sel);
    this.input = $('.search-input');
    this.input.value = this.state.query;
    this.resultsEl = $('.search-results');
    this.statusEl = $('.search-status');
    this.scrollEl = $('.search-scroll');
    this.settingsEl = $('.search-settings');
    this.chipsEl = $('.search-chips');
    this.fillButton = $('.fill-button');
    this.fillCount = $('.fill-count');
    this.fillCount.value = String(this.state.fillCount);

    $('form').addEventListener('submit', (e) => { e.preventDefault(); this.run(this.input.value); });
    $('.search-gear').addEventListener('click', () => this.toggleSettings());
    this.fillButton.addEventListener('click', () => this.fill());
    this.fillCount.addEventListener('change', () => { this.state.fillCount = Number(this.fillCount.value); this.save(); });
    for (const el of [this.input, this.fillCount]) el.addEventListener('keydown', (e) => e.stopPropagation());

    // Load more results when you scroll near the bottom.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadMore();
    }, { root: this.scrollEl, rootMargin: '600px' });
    this.observer.observe($('.search-end'));

    if (this.state.query) this.run(this.state.query);
    else this.showIntro();
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  layout(rect) {
    this.el.classList.toggle('compact', rect.w < 440);
  }

  save() {
    this.pane.state = { query: this.state.query, fillCount: this.state.fillCount };
    this.actions.changed();
  }

  sourceNames() {
    return activeSources().map((s) => SOURCE_SHORT[s]).join(', ');
  }

  showIntro() {
    this.resultsEl.replaceChildren();
    this.chipsEl.replaceChildren();
    this.statusEl.replaceChildren();
    const lines = [
      ['', 'Search for anything: "hands holding a cup", "rainy street at night", "armor details".'],
      ['small', 'Or describe a mood and press Fill board to drop a whole mood board onto your board.'],
      ['small', `Searching ${this.sourceNames()}.${activeSources().length < 3 ? ' Add free Unsplash and Pexels keys with the gear button for more and better photos.' : ''}`],
      ['small', 'Check each image\'s licence before using it in published work.'],
    ];
    for (const [cls, text] of lines) {
      const p = document.createElement('p');
      if (cls) p.className = cls;
      p.textContent = text;
      this.statusEl.appendChild(p);
    }
  }

  // Start a new search. `pinned(search)` can return results to show first
  // (used by "More like this").
  async run(query, pinned = null) {
    query = query.trim();
    this.input.value = query;
    this.state.query = query;
    this.save();
    if (!query) return this.showIntro();
    const search = new MixedSearch(query);
    this.search = search;
    const id = ++this.runId;
    this.resultsEl.replaceChildren();
    this.chipsEl.replaceChildren();
    this.scrollEl.scrollTop = 0;
    if (pinned) {
      this.statusEl.textContent = 'Finding similar images…';
      const first = await pinned(search).catch(() => []);
      if (id !== this.runId) return;
      for (const r of first.slice(0, 12)) this.resultsEl.appendChild(this.resultCard(r));
      search.all.unshift(...first);
    }
    await this.loadMore();
  }

  async loadMore() {
    const search = this.search;
    if (this.loading || !search || !search.hasMore) return;
    const id = this.runId;
    this.loading = true;
    this.statusEl.textContent = 'Searching…';
    try {
      const results = await search.next();
      if (id !== this.runId) return;  // a newer search has started
      for (const r of results) this.resultsEl.appendChild(this.resultCard(r));
      this.showChips();
      this.updateStatus();
    } finally {
      this.loading = false;
    }
    // If the results don't fill the pane yet, the "near the bottom" signal won't
    // fire again on its own, so check once more.
    if (search.hasMore && id === this.runId) {
      const end = this.el.querySelector('.search-end');
      this.observer.unobserve(end);
      this.observer.observe(end);
    }
  }

  updateStatus() {
    const s = this.search;
    const failed = Object.entries(s.errors).map(([src, msg]) => `${SOURCE_SHORT[src]}: ${msg}`);
    let text = '';
    if (!this.resultsEl.children.length) text = failed.length ? 'Nothing could be loaded.' : 'Nothing found. Try other words.';
    else if (!s.hasMore) text = 'No more results.';
    this.statusEl.textContent = [text, ...failed].filter(Boolean).join(' · ');
  }

  // Suggested words that narrow the search, like Pinterest's chips.
  showChips() {
    if (this.chipsEl.children.length) return;  // keep the first set while scrolling
    const words = this.search.chips();
    for (const w of words) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = w;
      chip.addEventListener('click', () => this.run(`${this.state.query} ${w}`));
      this.chipsEl.appendChild(chip);
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

    // Buttons shown on hover.
    const overlay = document.createElement('div');
    overlay.className = 'result-overlay';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'result-add';
    add.textContent = 'Add to board';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'result-more';
    more.textContent = 'More like this';
    const credit = document.createElement('figcaption');
    credit.textContent = [r.author, SOURCE_SHORT[r.source]].filter(Boolean).join(' · ');
    overlay.append(add, more, credit);
    card.append(img, overlay);

    const addIt = (e) => { e.stopPropagation(); rememberTaste(r); this.actions.add(r); };
    add.addEventListener('click', addIt);
    card.addEventListener('click', addIt);
    more.addEventListener('click', (e) => { e.stopPropagation(); this.moreLike(r); });
    card.addEventListener('dragstart', (e) => {
      rememberTaste(r);
      e.dataTransfer.setData(RESULT_DRAG_TYPE, JSON.stringify(r));
      e.dataTransfer.setData('text/uri-list', r.full);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
    });
    return card;
  }

  // A new search built from this image's words, with its closest matches first.
  async moreLike(r) {
    const query = similarQuery(r, this.state.query);
    await this.run(query, (search) => search.similar(r));
  }

  // Pick a varied set of results and hand them to the board as a mood board.
  // A bit of randomness means pressing it again gives a different mix.
  async fill() {
    const count = Number(this.fillCount.value) || 20;
    if (this.input.value.trim() !== this.state.query || !this.search) await this.run(this.input.value);
    if (!this.search) return this.actions.toast('Type a mood or subject first.');
    this.fillButton.disabled = true;
    try {
      // Load enough results to choose from.
      while (this.search.all.length < count * 2 && this.search.hasMore) {
        const before = this.search.all.length;
        await this.loadMore();
        if (this.search.all.length === before) break;
      }
      const pool = this.search.all.slice(0, count * 2);
      if (!pool.length) return this.actions.toast('Nothing found to fill the board with.');
      // Shuffle, but keep the best-ranked half more likely to be picked.
      const picked = pool.map((r, i) => ({ r, k: Math.random() + (1 - i / pool.length) * 0.6 }))
        .sort((a, b) => b.k - a.k).slice(0, count).map((x) => x.r);
      await this.actions.fill(picked, this.state.query);
    } finally {
      this.fillButton.disabled = false;
    }
  }

  toggleSettings(open = this.settingsEl.hidden) {
    this.settingsEl.hidden = !open;
    if (!open) return;
    const keys = loadKeys();
    this.settingsEl.replaceChildren();
    const intro = document.createElement('p');
    intro.textContent = 'Every search looks in all the sources switched on here and mixes the results. Unsplash and Pexels need a free key, which stays in this browser.';
    this.settingsEl.appendChild(intro);
    for (const [id, s] of Object.entries(SOURCES)) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const toggle = document.createElement('label');
      toggle.className = 'source-toggle';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !loadOff().includes(id);
      box.addEventListener('change', () => {
        const off = new Set(loadOff());
        if (box.checked) off.delete(id); else off.add(id);
        saveOff([...off]);
      });
      toggle.append(box, document.createTextNode(` ${s.name}`));
      row.appendChild(toggle);
      if (s.needsKey) {
        const keyLine = document.createElement('label');
        keyLine.className = 'key-row';
        const name = document.createElement('span');
        name.innerHTML = `${s.keyLabel} · <a href="${s.keyHelp}" target="_blank" rel="noopener">get one free</a>`;
        const input = document.createElement('input');
        input.type = 'password';
        input.value = keys[id] || '';
        input.placeholder = 'Paste key';
        input.autocomplete = 'off';
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => {
          const k = loadKeys();
          if (input.value.trim()) k[id] = input.value.trim();
          else delete k[id];
          saveKeys(k);
        });
        keyLine.append(name, input);
        row.appendChild(keyLine);
      } else {
        const note = document.createElement('span');
        note.className = 'small';
        note.textContent = 'No key needed.';
        row.appendChild(note);
      }
      this.settingsEl.appendChild(row);
    }
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'text-button';
    done.textContent = 'Done';
    done.addEventListener('click', () => {
      this.toggleSettings(false);
      if (this.state.query) this.run(this.state.query); else this.showIntro();
    });
    this.settingsEl.appendChild(done);
  }

  destroy() {
    this.observer.disconnect();
    this.el.remove();
  }
}
