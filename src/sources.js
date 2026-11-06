// Where image search results come from. Each source turns a search into a list
// of results in one shared shape, so the search pane doesn't care which it is:
//
//   { source, id, thumb, full, fallback, width, height, title, tags, author, pageUrl, license, useUrl }
//
//   thumb     small picture for the results grid
//   full      the big version that goes onto the board
//   fallback  used if `full` can't be downloaded (some sites block it)
//   tags      describing words (from the source), used for ranking and "More like this"
//   pageUrl   the image's own page, saved with it so you can find the source again
//   useUrl    Unsplash asks to be told when one of its photos is used
//
// kind says what a source mostly has: 'mixed', 'photo', 'art', 'nature' or 'space'
// (used by the All / Photos / Art / Nature filter).
//
// Openverse, Wikimedia Commons, the Art Institute of Chicago, the Cleveland Museum of
// Art, iNaturalist and NASA need no key. Unsplash, Pexels, Pixabay and Flickr need a
// free key, which you paste in once; it's kept only in this browser.

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
    throw new Error("couldn't be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new Error('refused the key. Check it with the Sources button.');
  if (res.status === 429) throw new Error('says too many searches. Wait a minute.');
  if (!res.ok) throw new Error(`had a problem (error ${res.status}).`);
  return res.json();
}

export const SOURCES = {
  openverse: {
    name: 'Openverse',
    kind: 'mixed',
    needsKey: false,
    about: 'Openly licensed images from Flickr, Wikimedia Commons, museums and more.',
    toResult(r) {
      const thumb = r.thumbnail || `https://api.openverse.org/v1/images/${r.id}/thumb/`;
      const license = [r.license ? String(r.license).toUpperCase() : '', r.license_version || ''].join(' ').trim();
      return {
        source: 'openverse', id: r.id, thumb, full: r.url || thumb, fallback: thumb,
        width: r.width || 0, height: r.height || 0,
        title: r.title || '', tags: (r.tags || []).map((t) => t?.name).filter(Boolean),
        author: r.creator || '', pageUrl: r.foreign_landing_url || r.url || '',
        license: license ? `CC ${license}`.replace('CC CC', 'CC').replace('CC PDM', 'Public domain') : '',
      };
    },
    async search(query, page) {
      const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page=${page}&page_size=20`;
      const data = await getJSON(url);
      return { results: (data.results || []).map((r) => this.toResult(r)), more: page < (data.page_count || 0) };
    },
    // Openverse can find images similar to one you pick.
    async related(result) {
      const data = await getJSON(`https://api.openverse.org/v1/images/${encodeURIComponent(result.id)}/related/`);
      return (data.results || []).map((r) => this.toResult(r));
    },
  },

  unsplash: {
    name: 'Unsplash',
    kind: 'photo',
    needsKey: true,
    keyLabel: 'Unsplash access key',
    keyHelp: 'https://unsplash.com/developers',
    about: 'High-quality free photos.',
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
        tags: (r.tags || []).map((t) => t?.title).filter(Boolean),
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
    kind: 'photo',
    needsKey: true,
    keyLabel: 'Pexels API key',
    keyHelp: 'https://www.pexels.com/api/',
    about: 'Free stock photos.',
    async search(query, page, key) {
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&page=${page}&per_page=30`;
      const data = await getJSON(url, { Authorization: key });
      const results = (data.photos || []).map((p) => ({
        source: 'pexels', id: p.id,
        thumb: p.src?.medium || p.src?.small,
        full: p.src?.original ? `${p.src.original}?auto=compress&cs=tinysrgb&w=2400` : p.src?.large2x,
        fallback: p.src?.large2x || p.src?.large,
        width: p.width || 0, height: p.height || 0,
        title: p.alt || '', tags: [], author: p.photographer || '', pageUrl: p.url || '',
        license: 'Pexels License',
      }));
      return { results, more: !!data.next_page };
    },
  },

  wikimedia: {
    name: 'Wikimedia Commons',
    kind: 'mixed',
    needsKey: false,
    about: 'Over 100 million free photos, scans and illustrations.',
    async search(query, page) {
      const per = 30;
      const params = new URLSearchParams({
        action: 'query', format: 'json', origin: '*', generator: 'search',
        gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(per), gsroffset: String((page - 1) * per),
        prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '500',
        iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription|ObjectName',
      });
      const data = await getJSON(`https://commons.wikimedia.org/w/api.php?${params}`);
      const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      const results = pages.map((pg) => {
        const info = pg.imageinfo?.[0];
        if (!info) return null;
        const meta = info.extmetadata || {};
        const title = plain(meta.ObjectName?.value) || pg.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
        // A 1920-wide copy rather than the original, which can be enormous.
        const big = info.width > 1920 && info.thumburl ? info.thumburl.replace(/\/\d+px-/, '/1920px-') : info.url;
        return {
          source: 'wikimedia', id: pg.pageid, thumb: info.thumburl || info.url, full: big, fallback: info.thumburl,
          width: info.width || 0, height: info.height || 0,
          title, tags: words(plain(meta.ImageDescription?.value)).slice(0, 8),
          author: plain(meta.Artist?.value).slice(0, 60), pageUrl: info.descriptionurl || '',
          license: plain(meta.LicenseShortName?.value),
        };
      }).filter(Boolean);
      return { results, more: !!data.continue };
    },
  },

  artic: {
    name: 'Art Institute of Chicago',
    kind: 'art',
    needsKey: false,
    about: 'Paintings, drawings, prints and sculpture from a major museum.',
    async search(query, page) {
      const url = `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}&page=${page}&limit=24`
        + '&fields=id,title,image_id,artist_title,thumbnail,is_public_domain,term_titles';
      const data = await getJSON(url);
      const iiif = data.config?.iiif_url || 'https://www.artic.edu/iiif/2';
      const results = (data.data || []).filter((a) => a.image_id).map((a) => ({
        source: 'artic', id: a.id,
        thumb: `${iiif}/${a.image_id}/full/400,/0/default.jpg`,
        full: `${iiif}/${a.image_id}/full/1686,/0/default.jpg`,
        fallback: `${iiif}/${a.image_id}/full/843,/0/default.jpg`,
        width: a.thumbnail?.width || 0, height: a.thumbnail?.height || 0,
        title: a.title || '', tags: (a.term_titles || []).slice(0, 8), author: a.artist_title || '',
        pageUrl: `https://www.artic.edu/artworks/${a.id}`, license: a.is_public_domain ? 'Public domain' : 'See museum page',
      }));
      return { results, more: page < (data.pagination?.total_pages || 0) };
    },
  },

  cleveland: {
    name: 'Cleveland Museum of Art',
    kind: 'art',
    needsKey: false,
    about: 'Tens of thousands of artworks, all free to use (CC0).',
    async search(query, page) {
      const per = 24;
      const url = `https://openaccess-api.clevelandart.org/api/artworks/?q=${encodeURIComponent(query)}&has_image=1&limit=${per}&skip=${(page - 1) * per}`;
      const data = await getJSON(url);
      const results = (data.data || []).filter((a) => a.images?.web?.url).map((a) => ({
        source: 'cleveland', id: a.id,
        thumb: a.images.web.url, full: a.images.print?.url || a.images.web.url, fallback: a.images.web.url,
        width: Number(a.images.print?.width || a.images.web.width) || 0, height: Number(a.images.print?.height || a.images.web.height) || 0,
        title: a.title || '', tags: [a.type, a.technique, a.culture?.[0]].filter(Boolean),
        author: a.creators?.[0]?.description || '', pageUrl: a.url || '', license: 'CC0',
      }));
      return { results, more: (page * per) < (data.info?.total || 0) };
    },
  },

  inaturalist: {
    name: 'iNaturalist',
    kind: 'nature',
    needsKey: false,
    about: 'Photos of animals and plants taken by naturalists, openly licensed.',
    async search(query, page) {
      const url = `https://api.inaturalist.org/v1/observations?q=${encodeURIComponent(query)}&photos=true&photo_licensed=true&quality_grade=research&order_by=votes&per_page=24&page=${page}`;
      const data = await getJSON(url);
      const results = [];
      for (const o of data.results || []) {
        const photo = (o.photos || []).find((ph) => ph.license_code && ph.url);
        if (!photo) continue;
        const size = (s) => photo.url.replace(/\/(square|thumb|small|medium|large|original)\./, `/${s}.`);
        const name = o.taxon?.preferred_common_name || o.taxon?.name || '';
        results.push({
          source: 'inaturalist', id: o.id,
          thumb: size('medium'), full: size('large'), fallback: size('medium'),
          width: photo.original_dimensions?.width || 0, height: photo.original_dimensions?.height || 0,
          title: name, tags: [o.taxon?.name, o.taxon?.iconic_taxon_name].filter(Boolean),
          author: o.user?.login || '', pageUrl: o.uri || `https://www.inaturalist.org/observations/${o.id}`,
          license: String(photo.license_code).toUpperCase(),
        });
      }
      return { results, more: page * 24 < (data.total_results || 0) };
    },
  },

  nasa: {
    name: 'NASA',
    kind: 'space',
    needsKey: false,
    about: 'Space, rockets, planets and Earth from orbit.',
    async search(query, page) {
      const data = await getJSON(`https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=image&page=${page}&page_size=24`);
      const items = data.collection?.items || [];
      const results = items.map((it) => {
        const d = it.data?.[0] || {};
        const thumb = it.links?.find((l) => l.rel === 'preview')?.href;
        if (!thumb) return null;
        return {
          source: 'nasa', id: d.nasa_id,
          thumb, full: thumb.replace('~thumb', '~large'), fallback: thumb.replace('~thumb', '~medium'),
          width: 0, height: 0, title: d.title || '', tags: (d.keywords || []).slice(0, 8),
          author: d.photographer || d.center || 'NASA', pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
          license: 'NASA media (generally free to use)',
        };
      }).filter(Boolean);
      return { results, more: !!data.collection?.links?.some((l) => l.rel === 'next') };
    },
  },

  pixabay: {
    name: 'Pixabay',
    kind: 'photo',
    needsKey: true,
    keyLabel: 'Pixabay API key',
    keyHelp: 'https://pixabay.com/api/docs/',
    about: 'Free photos, illustrations and vector art.',
    async search(query, page, key) {
      const url = `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&page=${page}&per_page=30&safesearch=true`;
      const data = await getJSON(url);
      const results = (data.hits || []).map((h) => ({
        source: 'pixabay', id: h.id,
        thumb: h.webformatURL, full: h.largeImageURL || h.webformatURL, fallback: h.webformatURL,
        width: h.imageWidth || 0, height: h.imageHeight || 0,
        title: h.tags || '', tags: String(h.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
        author: h.user || '', pageUrl: h.pageURL || '', license: 'Pixabay Content License',
      }));
      return { results, more: page * 30 < Math.min(500, data.totalHits || 0) };
    },
  },

  flickr: {
    name: 'Flickr',
    kind: 'photo',
    needsKey: true,
    keyLabel: 'Flickr API key',
    keyHelp: 'https://www.flickr.com/services/apps/create/',
    about: 'Billions of photos. Only openly licensed ones are searched.',
    async search(query, page, key) {
      const params = new URLSearchParams({
        method: 'flickr.photos.search', api_key: key, text: query, sort: 'relevance', content_type: '1', safe_search: '1',
        license: '1,2,3,4,5,6,7,9,10', extras: 'url_m,url_l,url_b,o_dims,owner_name,tags,license',
        per_page: '30', page: String(page), format: 'json', nojsoncallback: '1',
      });
      const data = await getJSON(`https://www.flickr.com/services/rest/?${params}`);
      if (data.stat === 'fail') throw new Error(data.code === 100 ? 'refused the key. Check it with the Sources button.' : `had a problem (${data.message || 'error'}).`);
      const results = (data.photos?.photo || []).filter((ph) => ph.url_m).map((ph) => ({
        source: 'flickr', id: ph.id,
        thumb: ph.url_m, full: ph.url_l || ph.url_b || ph.url_m, fallback: ph.url_m,
        width: Number(ph.width_l || ph.width_m) || 0, height: Number(ph.height_l || ph.height_m) || 0,
        title: ph.title || '', tags: String(ph.tags || '').split(' ').filter(Boolean).slice(0, 10),
        author: ph.ownername || '', pageUrl: `https://www.flickr.com/photos/${ph.owner}/${ph.id}`, license: 'Creative Commons',
      }));
      return { results, more: page < (data.photos?.pages || 0) };
    },
  },
};

// Text without any HTML tags (some sources put links inside names and descriptions).
function plain(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function words(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
}

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
