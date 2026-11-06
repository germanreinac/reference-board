// Where image search results come from. Each source turns a search into a list
// of results in one shared shape, so the search pane doesn't care which it is:
//
//   { source, id, thumb, full, fallback, width, height, title, author, pageUrl, license, useUrl }
//
//   thumb     small picture for the results grid
//   full      the big version that goes onto the board
//   fallback  used if `full` can't be downloaded (some sites block it)
//   pageUrl   the image's own page, saved with it so you can find the source again
//   useUrl    Unsplash asks to be told when one of its photos is used
//
// Openverse needs no key. Unsplash and Pexels need a free key, which you paste in
// once; it's kept only in this browser.

const KEYS_STORAGE = 'refboard-keys';

export function loadKeys() {
  try { return JSON.parse(localStorage.getItem(KEYS_STORAGE)) || {}; } catch { return {}; }
}
export function saveKeys(keys) {
  try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys)); } catch {}
}

async function getJSON(url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new Error("Couldn't reach the image service. Check your internet connection.");
  }
  if (res.status === 401 || res.status === 403) throw new Error('The service refused the key. Check it in search settings (the gear button).');
  if (res.status === 429) throw new Error('Too many searches for now. Wait a minute and try again.');
  if (!res.ok) throw new Error(`The image service had a problem (error ${res.status}).`);
  return res.json();
}

export const SOURCES = {
  openverse: {
    name: 'Openverse',
    needsKey: false,
    about: 'Free, openly licensed images from Flickr, Wikimedia Commons, museums and more. No key needed.',
    async search(query, page) {
      const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page=${page}&page_size=20`;
      const data = await getJSON(url);
      const results = (data.results || []).map((r) => {
        const thumb = r.thumbnail || `https://api.openverse.org/v1/images/${r.id}/thumb/`;
        const license = [r.license ? String(r.license).toUpperCase() : '', r.license_version || ''].join(' ').trim();
        return {
          source: 'openverse', id: r.id, thumb, full: r.url || thumb, fallback: thumb,
          width: r.width || 0, height: r.height || 0,
          title: r.title || '', author: r.creator || '', pageUrl: r.foreign_landing_url || r.url || '',
          license: license ? `CC ${license}`.replace('CC CC', 'CC').replace('CC PDM', 'Public domain') : '',
        };
      });
      return { results, more: page < (data.page_count || 0) };
    },
  },

  unsplash: {
    name: 'Unsplash',
    needsKey: true,
    keyLabel: 'Unsplash access key',
    keyHelp: 'https://unsplash.com/developers',
    about: 'High-quality free photos. Needs a free access key from unsplash.com/developers.',
    headers: (key) => ({ Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' }),
    async search(query, page, key) {
      const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&page=${page}&per_page=30`;
      const data = await getJSON(url, this.headers(key));
      const results = (data.results || []).map((r) => ({
        source: 'unsplash', id: r.id,
        thumb: r.urls?.small || r.urls?.thumb,
        // A large but not enormous version: plenty for reference.
        full: r.urls?.raw ? `${r.urls.raw}&w=2400&fm=jpg&q=85` : r.urls?.full,
        fallback: r.urls?.regular,
        width: r.width || 0, height: r.height || 0,
        title: r.alt_description || r.description || '', author: r.user?.name || '',
        pageUrl: r.links?.html ? `${r.links.html}?utm_source=reference_board&utm_medium=referral` : '',
        license: 'Unsplash License',
        useUrl: r.links?.download_location || '',
      }));
      return { results, more: page < (data.total_pages || 0) };
    },
    // Unsplash's rules: tell them when a photo is used.
    used(result, key) {
      if (result.useUrl) fetch(result.useUrl, { headers: this.headers(key) }).catch(() => {});
    },
  },

  pexels: {
    name: 'Pexels',
    needsKey: true,
    keyLabel: 'Pexels API key',
    keyHelp: 'https://www.pexels.com/api/',
    about: 'Free stock photos. Needs a free API key from pexels.com/api.',
    async search(query, page, key) {
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&page=${page}&per_page=30`;
      const data = await getJSON(url, { Authorization: key });
      const results = (data.photos || []).map((p) => ({
        source: 'pexels', id: p.id,
        thumb: p.src?.medium || p.src?.small,
        full: p.src?.original ? `${p.src.original}?auto=compress&cs=tinysrgb&w=2400` : p.src?.large2x,
        fallback: p.src?.large2x || p.src?.large,
        width: p.width || 0, height: p.height || 0,
        title: p.alt || '', author: p.photographer || '', pageUrl: p.url || '',
        license: 'Pexels License',
      }));
      return { results, more: !!data.next_page };
    },
  },
};

// Download a result's big version for the board. Falls back to the smaller
// version when the original site doesn't let other pages download it.
export async function downloadResult(result) {
  for (const [url, isFallback] of [[result.full, false], [result.fallback, true]]) {
    if (!url) continue;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.type.startsWith('image/')) return { blob, smaller: isFallback && result.fallback !== result.full };
    } catch {
      // try the next one
    }
  }
  throw new Error("Couldn't download that image. Try another one.");
}
