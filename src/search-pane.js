// The image search pane, with two tabs:
//
//   Search       one search box over every source (see src/search-engine.js), a
//                Pinterest-style grid, suggested words, All / Photos / Art / Nature,
//                and "More like this".
//   Mood board   describe a mood or theme; it picks a varied set of images (each idea
//                separated by commas gets its share), you remove any you don't like or
//                shuffle, then add them all to the board at once.

import { SOURCES, loadKeys, saveKeys } from './sources.js';
import { MixedSearch, activeSources, loadOff, saveOff, rememberTaste, similarQuery } from './search-engine.js';

export const RESULT_DRAG_TYPE = 'application/x-refboard-result';

const KINDS = [['all', 'All'], ['photo', 'Photos'], ['art', 'Art'], ['nature', 'Nature']];
const sourceName = (id) => SOURCES[id]?.name || id;

export class SearchPane {
  // actions: { add(result), fill(results, query), changed(), toast(message) }
  constructor(pane, host, actions) {
    this.type = 'search';
    this.pane = pane;
    this.actions = actions;
    this.state = { tab: 'search', query: '', kind: 'all', moodText: '', moodCount: 20, ...pane.state };
    if (!KINDS.some(([k]) => k === this.state.kind)) this.state.kind = 'all';
    this.search = null;     // the MixedSearch in progress
    this.loading = false;
    this.runId = 0;
    this.mood = { pools: [], picked: [], id: 0 };

    this.el = document.createElement('div');
    this.el.className = 'search-pane';
    this.el.innerHTML = `
      <div class="search-tabs">
        <button type="button" data-tab="search">Search</button>
        <button type="button" data-tab="mood">Mood board</button>
        <button type="button" class="sources-button" title="Which sites to search, and API keys">Sources</button>
      </div>
      <div class="search-settings" hidden></div>

      <div class="tab-search">
        <form class="search-bar">
          <input class="search-input" type="search" placeholder="Search images…" spellcheck="false" autocomplete="off">
        </form>
        <div class="search-filters">
          <div class="kind-filter">${KINDS.map(([k, label]) => `<button type="button" data-kind="${k}">${label}</button>`).join('')}</div>
          <div class="search-chips"></div>
        </div>
        <div class="search-scroll">
          <div class="search-results"></div>
          <div class="search-status"></div>
          <div class="search-end"></div>
        </div>
      </div>

      <div class="tab-mood">
        <form class="mood-bar">
          <input class="mood-input" placeholder="Describe a mood or theme, e.g. moody cyberpunk alley, neon, rain" spellcheck="false" autocomplete="off">
          <select class="mood-count" title="How many images"><option>10</option><option>20</option><option>30</option><option>50</option></select>
          <button type="submit" class="mood-make">Make mood board</button>
        </form>
        <div class="search-scroll mood-scroll">
          <div class="search-results mood-results"></div>
          <div class="search-status mood-status"></div>
        </div>
        <div class="mood-actions" hidden>
          <button type="button" class="text-button mood-shuffle" title="Pick a different mix">Shuffle</button>
          <span class="mood-note"></span>
          <button type="button" class="mood-add">Add to board</button>
        </div>
      </div>`;
    host.appendChild(this.el);

    const $ = (sel) => this.el.querySelector(sel);
    this.input = $('.search-input');
    this.input.value = this.state.query;
    this.resultsEl = $('.tab-search .search-results');
    this.statusEl = $('.tab-search .search-status');
    this.scrollEl = $('.tab-search .search-scroll');
    this.settingsEl = $('.search-settings');
    this.chipsEl = $('.search-chips');
    this.moodInput = $('.mood-input');
    this.moodInput.value = this.state.moodText;
    this.moodCount = $('.mood-count');
    this.moodCount.value = String(this.state.moodCount);
    this.moodResults = $('.mood-results');
    this.moodStatus = $('.mood-status');
    this.moodActions = $('.mood-actions');

    for (const b of this.el.querySelectorAll('.search-tabs [data-tab]')) b.addEventListener('click', () => this.setTab(b.dataset.tab));
    $('.sources-button').addEventListener('click', () => this.toggleSettings());
    $('.search-bar').addEventListener('submit', (e) => { e.preventDefault(); this.run(this.input.value); });
    for (const b of this.el.querySelectorAll('.kind-filter button')) {
      b.addEventListener('click', () => {
        this.state.kind = b.dataset.kind;
        this.showKind();
        if (this.state.query) this.run(this.state.query); else this.showIntro();
      });
    }
    $('.mood-bar').addEventListener('submit', (e) => { e.preventDefault(); this.makeMood(); });
    this.moodCount.addEventListener('change', () => { this.state.moodCount = Number(this.moodCount.value); this.save(); this.pickMood(); });
    $('.mood-shuffle').addEventListener('click', () => this.pickMood());
    $('.mood-add').addEventListener('click', () => this.addMood());
    for (const el of this.el.querySelectorAll('input, select')) el.addEventListener('keydown', (e) => e.stopPropagation());

    // Load more results when you scroll near the bottom.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadMore();
    }, { root: this.scrollEl, rootMargin: '600px' });
    this.observer.observe($('.search-end'));

    this.setTab(this.state.tab === 'mood' ? 'mood' : 'search', false);
    this.showKind();
    if (this.state.query) this.run(this.state.query, null, false);
    else this.showIntro();
    this.showMoodIntro();
  }

  focus() {
    this.setTab('search');
    this.input.focus();
    this.input.select();
  }

  layout(rect) {
    this.el.classList.toggle('compact', rect.w < 440);
  }

  save() {
    const { tab, query, kind, moodText, moodCount } = this.state;
    this.pane.state = { tab, query, kind, moodText, moodCount };
    this.actions.changed();
  }

  setTab(tab, save = true) {
    this.state.tab = tab;
    this.el.dataset.tab = tab;
    for (const b of this.el.querySelectorAll('.search-tabs [data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
    if (save) this.save();
    if (tab === 'mood') setTimeout(() => this.moodInput.focus(), 0);
  }

  showKind() {
    for (const b of this.el.querySelectorAll('.kind-filter button')) b.classList.toggle('active', b.dataset.kind === this.state.kind);
  }

  sourceSummary(kind = this.state.kind) {
    const names = activeSources(kind).map(sourceName);
    return `${names.length} sources: ${names.join(', ')}`;
  }

  showIntro() {
    this.resultsEl.replaceChildren();
    this.chipsEl.replaceChildren();
    this.statusEl.replaceChildren();
    const missing = Object.entries(SOURCES).filter(([id, s]) => s.needsKey && !loadKeys()[id]).map(([, s]) => s.name);
    const lines = [
      ['', 'Search for anything: "hands holding a cup", "rainy street at night", "armor details".'],
      ['small', `Searching ${this.sourceSummary()}.`],
      ['small', missing.length ? `Add free keys for ${missing.join(', ')} with the Sources button to search those too.` : ''],
      ['small', 'Check each image\'s licence before using it in published work.'],
    ];
    for (const [cls, text] of lines) {
      if (!text) continue;
      const p = document.createElement('p');
      if (cls) p.className = cls;
      p.textContent = text;
      this.statusEl.appendChild(p);
    }
  }

  // ---------- Search ----------

  // Start a new search. `pinned(search)` can return results to show first
  // (used by "More like this").
  async run(query, pinned = null, showTab = true) {
    query = query.trim();
    if (showTab) this.setTab('search', false);
    this.input.value = query;
    this.state.query = query;
    this.save();
    if (!query) return this.showIntro();
    const search = new MixedSearch(query, this.state.kind);
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
    const failed = Object.entries(s.errors).map(([src, msg]) => `${sourceName(src)} ${msg}`);
    const empty = !this.resultsEl.children.length;
    let text = '';
    if (empty) text = failed.length ? 'Nothing could be loaded.' : 'Nothing found. Try other words.';
    else if (!s.hasMore) text = 'No more results.';
    // Sources that didn't answer: listed in full only when nothing else came back.
    const note = !failed.length ? '' : empty ? failed.join(' · ') : `${failed.length} source${failed.length > 1 ? 's' : ''} didn't answer`;
    this.statusEl.textContent = [text, note].filter(Boolean).join(' · ');
    this.statusEl.title = failed.join('\n');
  }

  // Suggested words that narrow the search, like Pinterest's chips.
  showChips() {
    if (this.chipsEl.children.length) return;  // keep the first set while scrolling
    for (const w of this.search.chips()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = w;
      chip.addEventListener('click', () => this.run(`${this.state.query} ${w}`));
      this.chipsEl.appendChild(chip);
    }
  }

  // A picture in the grid, with hover buttons. `extra` adds buttons (e.g. remove from mood board).
  resultCard(r, { more = true, onRemove = null } = {}) {
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
    img.addEventListener('error', () => { card.remove(); onRemove?.(true); });  // hide pictures that fail to load

    const overlay = document.createElement('div');
    overlay.className = 'result-overlay';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'result-add';
    add.textContent = 'Add to board';
    overlay.appendChild(add);
    if (more) {
      const moreButton = document.createElement('button');
      moreButton.type = 'button';
      moreButton.className = 'result-more';
      moreButton.textContent = 'More like this';
      moreButton.addEventListener('click', (e) => { e.stopPropagation(); this.moreLike(r); });
      overlay.appendChild(moreButton);
    }
    const credit = document.createElement('figcaption');
    credit.textContent = [r.author, sourceName(r.source)].filter(Boolean).join(' · ');
    overlay.appendChild(credit);
    card.append(img, overlay);
    if (onRemove) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'result-remove';
      x.title = 'Leave this one out';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); card.remove(); onRemove(false); });
      card.appendChild(x);
    }

    const addIt = (e) => { e.stopPropagation(); rememberTaste(r); this.actions.add(r); };
    add.addEventListener('click', addIt);
    card.addEventListener('click', addIt);
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
    const query = similarQuery(r, this.state.query || this.state.moodText);
    await this.run(query, (search) => search.similar(r));
  }

  // ---------- Mood board ----------

  showMoodIntro() {
    if (this.mood.picked.length) return;
    this.moodStatus.replaceChildren();
    for (const [cls, text] of [
      ['', 'Describe a mood, a theme or a subject, and get a ready-made mood board.'],
      ['small', 'Separate ideas with commas to mix them: "foggy forest, lanterns, old wooden house". Each idea gets its share of the images.'],
      ['small', 'Remove any you don\'t like with ×, press Shuffle for a different mix, then Add to board.'],
    ]) {
      const p = document.createElement('p');
      if (cls) p.className = cls;
      p.textContent = text;
      this.moodStatus.appendChild(p);
    }
  }

  async makeMood() {
    const text = this.moodInput.value.trim();
    this.state.moodText = text;
    this.save();
    if (!text) return this.moodInput.focus();
    const id = ++this.mood.id;
    // The whole description, plus each comma-separated idea on its own.
    const ideas = text.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
    const queries = ideas.length > 1 ? [ideas.join(' '), ...ideas] : [text];
    this.moodResults.replaceChildren();
    this.moodActions.hidden = true;
    this.moodStatus.textContent = 'Finding images…';
    this.el.querySelector('.mood-make').disabled = true;
    try {
      const need = Number(this.moodCount.value) * 2;
      const pools = await Promise.all(queries.map(async (q) => {
        const s = new MixedSearch(q, 'all');
        let list = await s.next().catch(() => []);
        if (list.length < need / queries.length && s.hasMore) list = list.concat(await s.next().catch(() => []));
        return list;
      }));
      if (id !== this.mood.id) return;
      // The same picture can turn up for several ideas; keep it once.
      const seen = new Set();
      this.mood.pools = pools.map((list) => list.filter((r) => {
        const key = r.full || `${r.source}:${r.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
      this.pickMood();
    } finally {
      this.el.querySelector('.mood-make').disabled = false;
    }
  }

  // Choose the mood board from the pools: take turns between ideas, picking at random
  // but favouring the better-ranked results.
  pickMood() {
    const pools = this.mood.pools;
    if (!pools.some((p) => p.length)) {
      if (this.mood.id) this.moodStatus.textContent = 'Nothing found. Try other words.';
      return;
    }
    const count = Number(this.moodCount.value) || 20;
    const shuffled = pools.map((list) => list.map((r, i) => ({ r, k: Math.random() + (1 - i / list.length) * 0.7 }))
      .sort((a, b) => b.k - a.k).map((x) => x.r));
    const picked = [];
    for (let round = 0; picked.length < count && shuffled.some((l) => l.length); round++) {
      for (const list of shuffled) if (list.length && picked.length < count) picked.push(list.shift());
    }
    this.mood.picked = picked;
    this.moodResults.replaceChildren();
    for (const r of picked) {
      this.moodResults.appendChild(this.resultCard(r, {
        onRemove: () => {
          this.mood.picked = this.mood.picked.filter((x) => x !== r);
          this.updateMoodActions();
        },
      }));
    }
    this.moodStatus.textContent = '';
    this.updateMoodActions();
  }

  updateMoodActions() {
    const n = this.mood.picked.length;
    this.moodActions.hidden = n === 0;
    this.el.querySelector('.mood-add').textContent = `Add ${n} to board`;
    this.el.querySelector('.mood-note').textContent = '';
  }

  async addMood() {
    if (!this.mood.picked.length) return;
    const button = this.el.querySelector('.mood-add');
    button.disabled = true;
    try {
      for (const r of this.mood.picked) rememberTaste(r);
      await this.actions.fill(this.mood.picked, this.state.moodText);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Sources and keys ----------

  toggleSettings(open = this.settingsEl.hidden) {
    this.settingsEl.hidden = !open;
    this.el.querySelector('.sources-button').classList.toggle('active', open);
    if (!open) return;
    const keys = loadKeys();
    this.settingsEl.replaceChildren();
    const intro = document.createElement('p');
    intro.textContent = 'Every search looks in all the sources ticked here and mixes the results. Some need a free key: it stays in this browser.';
    this.settingsEl.appendChild(intro);
    const list = document.createElement('div');
    list.className = 'source-list';
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
      const name = document.createElement('strong');
      name.textContent = s.name;
      toggle.append(box, name);
      const about = document.createElement('span');
      about.className = 'small';
      about.textContent = s.needsKey ? s.about : `${s.about} No key needed.`;
      row.append(toggle, about);
      if (s.needsKey) {
        const keyLine = document.createElement('label');
        keyLine.className = 'key-row';
        const label = document.createElement('span');
        label.innerHTML = `${s.keyLabel} · <a href="${s.keyHelp}" target="_blank" rel="noopener">get one free</a>`;
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
        keyLine.append(label, input);
        row.appendChild(keyLine);
      }
      list.appendChild(row);
    }
    this.settingsEl.appendChild(list);
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
