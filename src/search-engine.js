// One search across every image source at once, ranked into a single feed.
//
// Big image sites rank with data about what millions of people save, which we don't
// have. This does what we can with what we do have:
//   - ask every source at once and mix their results
//   - rank by how relevant each source thinks a result is, how big and sharp it is,
//     whether its words match your search, and what you've added to boards before
//   - drop duplicates and tiny pictures
//   - keep the feed varied, so one source never takes over a whole screen
//   - suggest words to narrow the search ("chips"), taken from the results themselves
//   - "More like this" for any image
//
// What you add is remembered in this browser only ("taste"), to nudge later searches.

import { SOURCES, loadKeys } from './sources.js';

// Sources searched: every source that needs no key, plus those whose free key has
// been added (each can be switched off with the Sources button).
// kind narrows it: 'photo', 'art' or 'nature' keep those sources plus the mixed ones.
export function activeSources(kind = 'all') {
  const keys = loadKeys();
  const off = loadOff();
  return Object.entries(SOURCES)
    .filter(([id, s]) => !off.includes(id) && (!s.needsKey || keys[id]))
    .filter(([, s]) => kind === 'all' || s.kind === kind || s.kind === 'mixed' || (kind === 'nature' && s.kind === 'space'))
    .map(([id]) => id);
}

const OFF_STORAGE = 'refboard-sources-off';
export function loadOff() {
  try { return JSON.parse(localStorage.getItem(OFF_STORAGE)) || []; } catch { return []; }
}
export function saveOff(list) {
  try { localStorage.setItem(OFF_STORAGE, JSON.stringify(list)); } catch {}
}

// How much each source's photos tend to be worth for reference (curated photo
// sites first; Openverse is huge but mixed in quality).
const SOURCE_QUALITY = {
  unsplash: 1, pexels: 0.95, pixabay: 0.9, flickr: 0.85, artic: 0.9, cleveland: 0.85,
  inaturalist: 0.85, wikimedia: 0.8, nasa: 0.8, openverse: 0.75,
};

// ---------- Words ----------

const STOP = new Set(('a an and are as at be by for from has have in into is it its of on or that the this to was were with '
  + 'without over under near very more most some any no not photo photos image images picture stock free file jpg png '
  + 'background view close up man woman people person one two three').split(' '));

export function words(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}
const wordsOf = (r) => [...new Set([...words(r.title), ...(r.tags || []).flatMap((t) => words(t))])];

// ---------- Taste: what you've added before ----------

const TASTE_STORAGE = 'refboard-taste';
function loadTaste() {
  try { return JSON.parse(localStorage.getItem(TASTE_STORAGE)) || {}; } catch { return {}; }
}
// Call when a result is added to a board.
export function rememberTaste(result) {
  const taste = loadTaste();
  for (const w of wordsOf(result)) taste[w] = (taste[w] || 0) + 1;
  // Keep only the 300 strongest words.
  const top = Object.entries(taste).sort((a, b) => b[1] - a[1]).slice(0, 300);
  try { localStorage.setItem(TASTE_STORAGE, JSON.stringify(Object.fromEntries(top))); } catch {}
}

// ---------- Ranking ----------

function score(r, rank, total, queryWords, taste, tasteMax) {
  const relevance = 1 - rank / Math.max(1, total);               // the source's own order
  const pixels = (r.width || 0) * (r.height || 0);
  const size = pixels ? Math.min(1, pixels / (2400 * 1600)) : 0.5; // bigger is sharper on the board
  const ws = wordsOf(r);
  const matched = queryWords.length ? queryWords.filter((q) => ws.some((w) => w.startsWith(q) || q.startsWith(w))).length / queryWords.length : 0;
  const liked = tasteMax ? Math.min(1, ws.reduce((sum, w) => sum + (taste[w] || 0), 0) / (tasteMax * 3)) : 0;
  let points = 0.35 * relevance + 0.15 * size + 0.15 * (SOURCE_QUALITY[r.source] ?? 0.7) + 0.25 * matched + 0.15 * liked;
  // Museums, nature and space sources return something for almost any search; when
  // none of the search words appear, it's usually off-topic, so it sinks.
  if (queryWords.length && matched === 0 && SPECIALIST.has(r.source)) points *= 0.45;
  return points;
}
const SPECIALIST = new Set(Object.entries(SOURCES).filter(([, s]) => ['art', 'nature', 'space'].includes(s.kind)).map(([id]) => id));

// Too small to be useful as a reference (when the size is known).
const tooSmall = (r) => r.width && r.height && Math.max(r.width, r.height) < 500;

// Sort by score, but never more than two in a row from the same source.
function varied(list) {
  const pool = [...list].sort((a, b) => b.score - a.score);
  const out = [];
  while (pool.length) {
    const last2 = out.slice(-2).map((r) => r.source);
    let i = pool.findIndex((r) => !(last2.length === 2 && last2.every((s) => s === r.source)));
    if (i === -1) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// ---------- One search ----------

export class MixedSearch {
  constructor(query, kind = 'all') {
    this.query = query;
    this.queryWords = words(query);
    this.sources = activeSources(kind);
    this.page = Object.fromEntries(this.sources.map((s) => [s, 0]));
    this.more = Object.fromEntries(this.sources.map((s) => [s, true]));
    this.seen = new Set();
    this.all = [];        // everything shown so far, for the chips
    this.errors = {};
    const taste = loadTaste();
    this.taste = taste;
    this.tasteMax = Math.max(0, ...Object.values(taste));
  }

  get hasMore() {
    return this.sources.some((s) => this.more[s]);
  }

  // The next batch of mixed, ranked results. Sources that fail are skipped (see .errors).
  async next() {
    const keys = loadKeys();
    const asking = this.sources.filter((s) => this.more[s]);
    const answers = await Promise.allSettled(asking.map((s) => SOURCES[s].search(this.query, this.page[s] + 1, keys[s])));
    const batch = [];
    answers.forEach((a, i) => {
      const s = asking[i];
      if (a.status === 'rejected') {
        this.errors[s] = a.reason?.message || 'failed';
        this.more[s] = false;
        return;
      }
      this.page[s]++;
      this.more[s] = a.value.more && a.value.results.length > 0;
      a.value.results.forEach((r, rank) => {
        if (this.add(r)) batch.push({ ...r, score: score(r, rank, a.value.results.length, this.queryWords, this.taste, this.tasteMax) });
      });
    });
    const ranked = varied(batch);
    this.all.push(...ranked);
    return ranked;
  }

  // Results similar to one image: Openverse's own "related" list when there is one,
  // plus a search for the image's most telling words.
  async similar(result) {
    const out = [];
    if (result.source === 'openverse' && SOURCES.openverse.related) {
      try {
        const related = await SOURCES.openverse.related(result);
        related.forEach((r, rank) => { if (this.add(r)) out.push({ ...r, score: score(r, rank, related.length, this.queryWords, this.taste, this.tasteMax) }); });
      } catch {
        // fall back to the word search alone
      }
    }
    return varied(out);
  }

  add(r) {
    if (!r.thumb || tooSmall(r)) return false;
    const key = r.full || `${r.source}:${r.id}`;
    // The same picture on two sites usually has the same title and author. (Numbers
    // count: "Forest 1" and "Forest 2" are different pictures.)
    const titleKey = `${String(r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${(r.author || '').toLowerCase()}`;
    if (this.seen.has(key) || (titleKey.length > 6 && this.seen.has(titleKey))) return false;
    this.seen.add(key);
    if (titleKey.length > 6) this.seen.add(titleKey);
    return true;
  }

  // Suggested words to narrow the search: common in the results but not
  // already in the search.
  chips(max = 8) {
    const counts = new Map();
    for (const r of this.all) for (const w of wordsOf(r)) {
      if (this.queryWords.some((q) => w.startsWith(q) || q.startsWith(w))) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
  }
}

// The words to search for to find images like this one.
export function similarQuery(result, baseQuery) {
  const base = words(baseQuery);
  const extra = wordsOf(result).filter((w) => !base.includes(w)).slice(0, 3);
  return [baseQuery.trim(), ...extra].filter(Boolean).join(' ');
}
