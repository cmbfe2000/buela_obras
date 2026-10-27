/* Padre Buela · Escritos — offline PWA
 * Data source: WordPress REST API of padrebuela.org
 * Storage: IndexedDB (posts + serialized MiniSearch index)
 */
'use strict';

const CONFIG = {
  api: 'https://www.padrebuela.org/wp-json/wp/v2',
  site: 'https://www.padrebuela.org',
  // Extra pages included in the app (by slug). "¿Qué es el IVE?", Biblioteca (books by other
  // authors), Videos, Audios and the section index pages are intentionally excluded.
  pages: ['autor', 'libros'],
  snapshotUrl: 'data/snapshot.json',
  booksUrl: 'data/books/',
  checkEveryHours: 6,
  indexVersion: 4,
};

const GROUPS = [
  { key: 'escritos', name: 'Escritos', slugs: ['nuestra-fe', 'eucaristia', 'virgen-maria', 'sacerdocio', 'vida-religiosa', 'santos', 'sagrada-escritura', 'familia', 'jovenes', 'evangelizacion-de-la-cultura', 'signos-de-los-tiempos', 'actualidad', 'arte', 'dialogo-interreligioso', 'dialogos'] },
  { key: 'personajes', name: 'Grandes personajes', slugs: ['padre-julio-meinvielle', 'grandes-hombres'] },
  { key: 'pueblo', name: 'Dialogando con el pueblo', slugs: ['dialogos-eucaristicos', 'dialogos-para-los-jovenes', 'dialogos-san-cayetano', 'dialogos-sobre-la-familia'] },
  { key: 'viajes', name: 'Circulares de viajes', slugs: ['albania', 'rusia', 'lituania'] },
];

const STOP = new Set(('a al ante bajo con contra de del desde durante en entre hacia hasta mediante para por segun sin so sobre tras ' +
  'el la lo los las un una uno unos unas y e o u ni que se su sus es son fue ser ha han he hay le les me mi mis te tu tus nos ' +
  'como mas pero si no ya muy este esta esto estos estas ese esa eso esos esas aquel cual quien cuando donde porque tambien').split(' '));

/* ---------- utilities ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`; };
const fmtShort = iso => { if (!iso) return ''; const d = new Date(iso); return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
const decode = html => { const t = document.createElement('textarea'); t.innerHTML = html; return t.value; };
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'para', 'sobre', 'con', 'en', 'a']);
const titleCase = s => s.toLocaleLowerCase('es').split(/\s+/).map((w, i) => (i && SMALL.has(w)) ? w : w.charAt(0).toLocaleUpperCase('es') + w.slice(1)).join(' ');
// Per-character normalisation that preserves string length (needed to map matches back to the original text)
const normChar = c => { const n = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); return n.length === 1 ? n : c.toLowerCase().charAt(0); };
const norm = s => { let o = ''; for (const c of s) o += normChar(c); return o; };
const stem = t => (t.length > 4 && t.endsWith('s')) ? t.slice(0, -1) : t;
const processTerm = term => { const n = norm(term); if (n.length < 2 || STOP.has(n)) return null; return stem(n); };
const WORD_RE = /[\p{L}\p{N}]+/gu;
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const ls = { get(k, d) { try { const v = localStorage.getItem('pb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('pb.' + k, JSON.stringify(v)); } catch { } } };

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('padrebuela', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('posts')) d.createObjectStore('posts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('chapters')) d.createObjectStore('chapters', { keyPath: 'id' }).createIndex('b', 'b');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  get(store, key) { return this.req(this.tx(store).get(key)); },
  all(store) { return this.req(this.tx(store).getAll()); },
  set(key, val) { return this.req(this.tx('kv', 'readwrite').put(val, key)); },
  kv(key) { return this.get('kv', key); },
  put(store, list) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, 'readwrite'); const s = t.objectStore(store);
      list.forEach(p => s.put(p)); t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
  putPosts(list) { return this.put('posts', list); },
  delPosts(ids) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('posts', 'readwrite'); const s = t.objectStore('posts');
      ids.forEach(id => s.delete(id)); t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
  delBook(b) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('chapters', 'readwrite'); const ix = t.objectStore('chapters').index('b');
      const c = ix.openKeyCursor(IDBKeyRange.only(b));
      c.onsuccess = () => { const cur = c.result; if (cur) { t.objectStore('chapters').delete(cur.primaryKey); cur.continue(); } };
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  },
  // iterate a store without loading everything at once
  each(store, fn) {
    return new Promise((res, rej) => {
      const c = this.tx(store).openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { fn(cur.value); cur.continue(); } else res(); };
      c.onerror = () => rej(c.error);
    });
  },
};

/* ---------- HTML cleaning ---------- */
const KEEP_ATTR = { A: ['href', 'id', 'title'], IMG: ['src', 'alt', 'width', 'height'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'], OL: ['start', 'type'], LI: ['value'] };
const LIST_TYPES = { 'upper-roman': 'I', 'lower-roman': 'i', 'upper-alpha': 'A', 'lower-alpha': 'a', 'upper-latin': 'A', 'lower-latin': 'a' };
function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const body = doc.body;
  body.querySelectorAll('script,style,noscript,object,embed,param,form,input,button,svg').forEach(e => e.remove());
  body.querySelectorAll('iframe,video,audio').forEach(e => {
    const src = e.getAttribute('src') || e.querySelector('source')?.getAttribute('src');
    const p = doc.createElement('p');
    if (src) { const a = doc.createElement('a'); a.href = src.startsWith('//') ? 'https:' + src : src; a.textContent = '▶ Ver contenido multimedia (requiere conexión)'; p.append(a); }
    e.replaceWith(p);
  });
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT); const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode); comments.forEach(c => c.remove());
  body.querySelectorAll('*').forEach(el => {
    if (el.tagName === 'OL') { const m = (el.getAttribute('style') || '').match(/list-style-type:\s*([\w-]+)/); if (m && LIST_TYPES[m[1]]) el.setAttribute('type', LIST_TYPES[m[1]]); }
    if (el.tagName === 'A' && el.getAttribute('name') && !el.id) el.id = el.getAttribute('name');
    const keep = KEEP_ATTR[el.tagName] || [];
    [...el.attributes].forEach(a => { if (!keep.includes(a.name)) el.removeAttribute(a.name); });
    if (el.tagName === 'IMG') { const s = el.getAttribute('src') || ''; if (s.startsWith('http:')) el.setAttribute('src', 'https:' + s.slice(5)); el.setAttribute('loading', 'lazy'); }
  });
  body.querySelectorAll('span,font,center,b:empty,i:empty,strong:empty,em:empty,u').forEach(el => el.replaceWith(...el.childNodes));
  body.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6').forEach(el => { if (!el.textContent.replace(/[\s ]/g, '') && !el.querySelector('img,a[id]')) el.remove(); });
  try { unifyNotes(body); } catch (e) { console.warn('notes', e); }
  return body.innerHTML.replace(/\n{2,}/g, '\n').trim();
}
/* Footnotes: same unified format as the books (see books/footnotes.py) */
function unifyNotes(body, prefix = 'p') {
  const BLK = 'p,li,div,blockquote,dd,td';
  const frag = a => { const h = a.getAttribute('href') || ''; const i = h.indexOf('#'); return i >= 0 ? h.slice(i + 1) : null; };
  const anchors = [...body.querySelectorAll('a[href*="#"]')].filter(a => frag(a));
  if (!anchors.length) return false;
  const byFrag = new Map(); anchors.forEach(a => { const f = frag(a); if (!byFrag.has(f)) byFrag.set(f, []); byFrag.get(f).push(a); });
  const idsOf = a => {
    const s = new Set([a.id]); const p = a.parentElement;
    if (p && p.tagName === 'SUP' && p.id) s.add(p.id);
    const pr = a.previousElementSibling; if (pr && pr.tagName === 'A' && !pr.textContent.trim() && pr.id) s.add(pr.id);
    s.delete(''); return s;
  };
  const blockOf = a => { const b = a.parentElement && a.parentElement.closest(BLK); return b && body.contains(b) && b !== body ? b : null; };
  const textBefore = (a, blk) => { let out = ''; const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (a.contains(n) || (a.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) break; out += n.nodeValue; } return out; };
  const opens = (a, blk) => textBefore(a, blk).replace(/[\s\[\]()]/g, '').length <= 2;
  const order = new Map(); [...body.querySelectorAll('*')].forEach((e, i) => order.set(e, i));
  const used = new Set(); const pairs = [];
  for (const a of anchors) {
    if (used.has(a)) continue;
    const cands = [...idsOf(a)].flatMap(i => byFrag.get(i) || []).filter(b => b !== a && !used.has(b));
    if (!cands.length) continue;
    const oa = order.get(a);
    cands.sort((x, y) => ((order.get(x) < oa) - (order.get(y) < oa)) || (Math.abs(order.get(x) - oa) - Math.abs(order.get(y) - oa)));
    const b = cands[0]; const bb = blockOf(b); const ab = blockOf(a);
    if (!bb) continue;
    if (!opens(b, bb) && ab && opens(a, ab)) continue;
    pairs.push([a, b]); used.add(a); used.add(b);
  }
  // fallback for broken Word links: pair the remaining _ftnN references with _ftnrefN notes by their visible number
  const lab = t => t.replace(/[\[\]()\s]/g, '');
  for (const a of anchors) {
    if (used.has(a) || !/^_(ftn|edn)\d+$/.test(frag(a) || '')) continue;
    const b = anchors.find(x => !used.has(x) && x !== a && /^_(ftn|edn)ref\d+$/.test(frag(x) || '') && lab(x.textContent) === lab(a.textContent) && blockOf(x) && opens(x, blockOf(x)));
    if (b) { pairs.push([a, b]); used.add(a); used.add(b); }
  }
  const clean = t => t.replace(/[\[\]()\s]/g, '').slice(0, 8);
  const items = [];
  pairs.sort((p, q) => order.get(p[0]) - order.get(q[0])).forEach(([a, b], k) => {
    const key = `${prefix}-${k + 1}`;
    const label = clean(a.textContent) || clean(b.textContent) || String(k + 1);
    const blk = blockOf(b); const c = blk.cloneNode(true);
    c.querySelectorAll('a').forEach(x => { if (frag(x) === frag(b) || (!x.textContent.trim() && !x.children.length && x.id)) x.remove(); });
    c.querySelectorAll('sup').forEach(x => { if (!x.textContent.trim()) x.remove(); });
    items.push([key, label, c.innerHTML.trim().replace(/^[\s.\-–—:)\]]+/, '')]);
    blk.dataset.fnmove = '1';
    let w = a;
    while (w.parentElement && /^(SUP|B|STRONG|I|EM|SPAN)$/.test(w.parentElement.tagName) && w.parentElement.textContent.replace(/\s/g, '') === a.textContent.replace(/\s/g, '')) w = w.parentElement;
    const pr = w.previousElementSibling; if (pr && pr.tagName === 'A' && !pr.textContent.trim() && !pr.children.length) pr.remove();
    const sup = document.createElement('sup'); sup.className = 'fnref';
    sup.innerHTML = `<a href="#fn-${key}" id="fnref-${key}">${esc(label)}</a>`;
    w.replaceWith(sup);
  });
  // notes whose reference is missing, and references whose note is missing (broken source pages)
  for (const x of anchors) {
    if (used.has(x) || !x.isConnected) continue;
    const f = frag(x) || '';
    if (/^_(ftn|edn)ref\d+$|backlink$|^rfn\d+$/.test(f)) {
      const blk = blockOf(x);
      if (blk && !blk.dataset.fnmove && opens(x, blk)) {
        const c = blk.cloneNode(true); c.querySelectorAll('a').forEach(y => { if (frag(y) === f || (!y.textContent.trim() && !y.children.length && y.id)) y.remove(); });
        const h = c.innerHTML.trim().replace(/^[\s.\-–—:)\]]+/, '');
        if (h.replace(/<[^>]+>/g, '').trim().length > 2) items.push(['', clean(x.textContent), h]);
        blk.dataset.fnmove = '1';
      }
    } else if (/^_(ftn|edn)\d+$|^footnote-\d+$|^fn\d+$/.test(f)) {
      let w = x; while (w.parentElement && /^(SUP|B|STRONG|I|EM|SPAN)$/.test(w.parentElement.tagName) && w.parentElement.textContent.replace(/\s/g, '') === x.textContent.replace(/\s/g, '')) w = w.parentElement;
      const sup = document.createElement('sup'); sup.className = 'fnref'; sup.textContent = clean(x.textContent); w.replaceWith(sup);
    }
  }
  body.querySelectorAll('[data-fnmove]').forEach(x => x.remove());
  body.querySelectorAll('a[id]').forEach(x => { if (!x.textContent.trim() && !x.children.length && /^(_ftn|footnote|fn|rfn|note)/i.test(x.id)) x.remove(); });
  body.querySelectorAll('div,p').forEach(x => { if (!x.textContent.trim() && !x.querySelector('img,br,hr,sup')) x.remove(); });
  while (body.lastElementChild && body.lastElementChild.tagName === 'HR') body.lastElementChild.remove();
  if (!items.length) return pairs.length > 0;
  const sec = document.createElement('section'); sec.className = 'notes';
  sec.innerHTML = '<h5>Notas</h5><ol class="fnlist">' + items.map(([k, l, h]) => k ? `<li id="fn-${k}"><span class="fnnum">${esc(l)}</span> <span class="fnbody">${h}</span> <a class="fnback" href="#fnref-${k}" aria-label="Volver al texto">↩</a></li>` : `<li><span class="fnnum">${esc(l)}</span> <span class="fnbody">${h}</span></li>`).join('') + '</ol>';
  body.append(sec);
  return true;
}
// re-apply the unified notes format to writings stored by older versions of the app
async function migrateNotes() {
  if ((S.meta.notesV || 0) >= 1) return false;
  const posts = await DB.all('posts'); const changed = [];
  for (const p of posts) {
    if (p.h.includes('class="notes"') || !/href="[^"]*#/.test(p.h)) continue;
    const d = new DOMParser().parseFromString(`<body>${p.h}</body>`, 'text/html');
    if (unifyNotes(d.body)) { p.h = d.body.innerHTML; p.x = toText(p.h); changed.push(p); }
  }
  if (changed.length) await DB.putPosts(changed);
  S.meta.notesV = 1; await DB.set('meta', S.meta);
  return changed.length > 0;
}
const toText = html => { const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html'); d.body.querySelectorAll('p,br,h1,h2,h3,h4,h5,h6,li,blockquote,div,tr').forEach(e => e.append(' ')); return d.body.textContent.replace(/[\s ]+/g, ' ').trim(); };

function shapePost(p) {
  const h = cleanHtml(p.content?.rendered || '');
  const x = toText(h);
  return { id: p.id, t: decode(p.title?.rendered || '').trim() || '(sin título)', d: p.date, m: p.modified, s: p.slug, l: p.link, c: p.categories || [], g: p.tags || [], h, x, w: (x.match(WORD_RE) || []).length };
}
const shapePage = p => ({ id: p.id, slug: p.slug, t: decode(p.title?.rendered || ''), h: cleanHtml(p.content?.rendered || ''), l: p.link, m: p.modified });

/* ---------- App state ---------- */
const S = {
  posts: [], byId: new Map(), bySlug: new Map(), cats: new Map(), catBySlug: new Map(), tags: new Map(), pages: {},
  books: {}, bookList: [], langs: {},
  index: null, favs: [], progress: {}, meta: {}, pending: null, ready: false,
};
const isChap = id => typeof id === 'string' && id.startsWith('c:');
const chapKey = (b, n) => `c:${b}/${n}`;
const parseChap = id => { const m = /^c:(.+)\/(\d+)$/.exec(id); return m ? { b: m[1], n: +m[2] } : null; };
const chapMeta = id => { const c = parseChap(id); const bk = c && S.books[c.b]; return bk ? { ...bk.chapters[c.n], b: c.b, n: c.n, book: bk } : null; };
const docExists = id => isChap(id) ? !!chapMeta(id) : S.byId.has(id);

const indexOpts = () => ({ idField: 'id', fields: ['t', 'x', 'cn', 'gn'], processTerm, searchOptions: { boost: { t: 5, cn: 2, gn: 2 }, prefix: t => t.length >= 3, fuzzy: t => t.length >= 6 ? 0.18 : false, combineWith: 'AND' } });

async function buildIndex(onStep) {
  const ms = new MiniSearch(indexOpts());
  const posts = await DB.all('posts');
  const nChap = Object.values(S.books).reduce((s, b) => s + b.chapters.length, 0);
  const total = posts.length + nChap; let done = 0;
  const CH = 25;
  for (let i = 0; i < posts.length; i += CH) {
    ms.addAll(posts.slice(i, i + CH).map(p => ({ id: p.id, t: p.t, x: p.x, cn: p.c.map(c => S.cats.get(c)?.name || '').join(' '), gn: p.g.map(g => S.tags.get(g)?.name || '').join(' ') })));
    done += CH; onStep?.(Math.min(1, done / total)); await sleep(0);
  }
  for (const bk of S.bookList) {
    for (let n = 0; n < bk.chapters.length; n += 4) {
      const ids = []; for (let k = n; k < Math.min(n + 4, bk.chapters.length); k++) ids.push(chapKey(bk.id, k));
      const recs = await Promise.all(ids.map(id => DB.get('chapters', id)));
      ms.addAll(recs.filter(Boolean).map(r => ({ id: r.id, t: r.t, x: r.x, cn: bk.title, gn: '' })));
      done += ids.length; onStep?.(Math.min(1, done / total)); await sleep(0);
    }
  }
  S.index = ms;
  try { await DB.set('index', { v: CONFIG.indexVersion, json: JSON.stringify(ms) }); } catch (e) { console.warn('index not persisted', e); }
}

function setBooks(books) {
  S.books = books || {};
  const order = Object.keys(S.langs).length ? Object.keys(S.langs) : ['es', 'en', 'it', 'fr', 'nl', 'uk', 'ar'];
  S.bookList = Object.values(S.books).sort((a, b) => (order.indexOf(a.lang) - order.indexOf(b.lang)) || (a.order - b.order));
}

async function loadState() {
  const [posts, cats, tags, pages, meta, favs, progress, idx, books, langs] = await Promise.all(['posts', 'cats', 'tags', 'pages', 'meta', 'favs', 'progress', 'index', 'books', 'langs'].map(k => k === 'posts' ? DB.all('posts') : DB.kv(k)));
  S.posts = posts.map(({ h, x, ...m }) => ({ ...m, e: x.slice(0, 260) })).sort((a, b) => b.d.localeCompare(a.d));
  S.byId = new Map(S.posts.map(p => [p.id, p]));
  S.bySlug = new Map(S.posts.map(p => [p.s, p.id]));
  S.cats = new Map((cats || []).map(c => [c.id, c]));
  S.catBySlug = new Map((cats || []).map(c => [c.slug, c]));
  S.tags = new Map((tags || []).map(t => [t.id, t]));
  S.pages = pages || {};
  S.meta = meta || {};
  S.favs = favs || [];
  S.progress = progress || {};
  S.langs = langs || {};
  setBooks(books);
  if (idx && idx.v === CONFIG.indexVersion) {
    try { S.index = MiniSearch.loadJSON(idx.json, indexOpts()); } catch { S.index = null; }
  }
  if (!S.index && S.posts.length) await buildIndex();
  S.ready = S.posts.length > 0;
}

/* ---------- Network / sync ---------- */
async function api(path, params = {}) {
  const u = new URL(CONFIG.api + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  let err;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { data: await r.json(), totalPages: +r.headers.get('X-WP-TotalPages') || 1, total: +r.headers.get('X-WP-Total') || 0 };
    } catch (e) { err = e; await sleep(800 * (attempt + 1)); }
  }
  throw err;
}
async function apiAll(path, params, onPage) {
  const first = await api(path, { per_page: 100, page: 1, ...params });
  let out = [...first.data]; onPage?.(1, first.totalPages, first.total);
  for (let p = 2; p <= first.totalPages; p++) { const r = await api(path, { per_page: 100, page: p, ...params }); out.push(...r.data); onPage?.(p, first.totalPages, first.total); }
  return out;
}
const POST_FIELDS = 'id,date,modified,slug,link,title,content,categories,tags';

async function saveTaxonomies(rawCats, rawTags, rawPages) {
  const cats = rawCats.filter(c => c.count > 0).map(c => ({ id: c.id, slug: c.slug, name: titleCase(decode(c.name)), count: c.count }));
  const tags = rawTags.map(t => ({ id: t.id, slug: t.slug, name: decode(t.name) }));
  const pages = {}; rawPages.filter(p => CONFIG.pages.includes(p.slug)).forEach(p => pages[p.slug] = shapePage(p));
  await Promise.all([DB.set('cats', cats), DB.set('tags', tags), DB.set('pages', pages)]);
  S.cats = new Map(cats.map(c => [c.id, c])); S.catBySlug = new Map(cats.map(c => [c.slug, c])); S.tags = new Map(tags.map(t => [t.id, t]));
}
async function fetchTaxonomies() {
  const [cats, tags, pages] = await Promise.all([
    apiAll('/categories', { _fields: 'id,name,slug,count' }),
    apiAll('/tags', { _fields: 'id,name,slug' }),
    api('/pages', { slug: CONFIG.pages.join(','), _fields: 'id,slug,title,content,link,modified' }).then(r => r.data),
  ]);
  await saveTaxonomies(cats, tags, pages);
}

async function fetchPosts(progress, from, to) {
  progress(from, 'Conectando con padrebuela.org…');
  await fetchTaxonomies();
  const first = await api('/posts', { per_page: 50, page: 1, _fields: POST_FIELDS });
  const total = first.total, pages = first.totalPages; let got = 0;
  const handle = async list => { const shaped = list.map(shapePost); await DB.putPosts(shaped); got += list.length; progress(from + (to - from) * got / total, `Descargando escritos… ${got} de ${total}`); return shaped.map(p => p.id); };
  const ids = new Set(await handle(first.data));
  for (let p = 2; p <= pages; p++) { const r = await api('/posts', { per_page: 50, page: p, _fields: POST_FIELDS }); (await handle(r.data)).forEach(i => ids.add(i)); }
  const stale = (await DB.all('posts')).map(p => p.id).filter(id => !ids.has(id)); if (stale.length) await DB.delPosts(stale);
}

/* ---- books (bundled with the app under data/books/) ---- */
async function fetchCatalog() {
  try { const r = await fetch(CONFIG.booksUrl + 'catalog.json', { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
function wantedLangs(cat) { const all = Object.keys(cat?.langs || S.langs || {}); const w = ls.get('bookLangs', null); return w ? all.filter(l => w.includes(l)) : all; }
function bookPlan(cat) {
  if (!cat) return null;
  const want = new Set(wantedLangs(cat));
  const remote = cat.books.filter(b => want.has(b.lang));
  const dl = remote.filter(b => S.books[b.id]?.v !== b.v);
  const keep = new Set(remote.map(b => b.id));
  const rm = Object.keys(S.books).filter(id => !keep.has(id));
  return (dl.length || rm.length) ? { dl, rm, cat } : null;
}
async function syncBooks(progress, from, to, plan) {
  const cat = plan?.cat || await fetchCatalog();
  if (!cat) return false;
  plan = plan || bookPlan(cat);
  S.langs = cat.langs || {}; await DB.set('langs', S.langs);
  if (!plan) return false;
  const books = { ...S.books };
  for (const id of plan.rm) { await DB.delBook(id); delete books[id]; }
  await DB.set('books', books); setBooks(books);
  const totalBytes = plan.dl.reduce((s, b) => s + (b.size || 1), 0) || 1; let doneBytes = 0;
  for (const entry of plan.dl) {
    progress(from + (to - from) * doneBytes / totalBytes, `Descargando libros… ${entry.title}`);
    const r = await fetch(`${CONFIG.booksUrl}${entry.id}.json?v=${entry.v}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`No se pudo descargar «${entry.title}»`);
    const bk = await r.json();
    const recs = []; const metas = [];
    for (let n = 0; n < bk.chapters.length; n++) {
      const c = bk.chapters[n]; const x = toText(c.h); const w = (x.match(WORD_RE) || []).length;
      recs.push({ id: chapKey(entry.id, n), b: entry.id, n, t: c.t, h: c.h, x, p: c.p, d: c.d });
      metas.push({ t: c.t, w, p: c.p, d: c.d, e: x.slice(0, 200) });
      if (n % 8 === 7) await sleep(0);
    }
    await DB.delBook(entry.id);
    await DB.put('chapters', recs);
    books[entry.id] = { ...entry, chapters: metas };
    doneBytes += entry.size || 1;
    await DB.set('books', books); setBooks(books);
  }
  progress(to, 'Libros listos');
  return true;
}

async function fullSync(progress) {
  await fetchPosts(progress, 0.02, 0.45);
  await syncBooks(progress, 0.45, 0.8);
  progress(0.8, 'Preparando el buscador…');
  await finishSync(null, f => progress(0.8 + 0.19 * f, 'Preparando el buscador…'));
  progress(1, 'Listo');
}

async function loadSnapshot(progress) {
  const r = await fetch(CONFIG.snapshotUrl, { cache: 'no-cache' }).catch(() => null);
  if (!r || !r.ok) return false;
  progress(0.03, 'Cargando la colección incluida en la app…');
  const snap = await r.json().catch(() => null);
  if (!snap?.posts?.length) return false;
  await saveTaxonomies(snap.categories || [], snap.tags || [], snap.pages || []);
  const CH = 20;
  for (let i = 0; i < snap.posts.length; i += CH) { await DB.putPosts(snap.posts.slice(i, i + CH).map(shapePost)); progress(0.03 + 0.4 * (i + CH) / snap.posts.length, `Preparando escritos… ${Math.min(i + CH, snap.posts.length)} de ${snap.posts.length}`); await sleep(0); }
  await syncBooks(progress, 0.45, 0.8);
  await finishSync(snap.generated, f => progress(0.8 + 0.19 * f, 'Preparando el buscador…'));
  return true;
}

async function finishSync(when, onIndex) {
  S.meta = { ...S.meta, lastSync: when || new Date().toISOString(), lastCheck: new Date().toISOString() };
  await DB.set('meta', S.meta);
  S.pending = null;
  S.index = null;
  await DB.set('index', null);
  const books = await DB.kv('books'); setBooks(books);
  await buildIndex(onIndex);
  await loadState();
  try { navigator.storage?.persist?.(); } catch { }
  cacheImages();
}

async function checkUpdates() {
  const remote = await apiAll('/posts', { _fields: 'id,modified' });
  const local = new Map(S.posts.map(p => [p.id, p.m]));
  const rid = new Set(remote.map(r => r.id));
  const added = remote.filter(r => !local.has(r.id)).map(r => r.id);
  const changed = remote.filter(r => local.has(r.id) && local.get(r.id) !== r.modified).map(r => r.id);
  const removed = [...local.keys()].filter(id => !rid.has(id));
  const books = bookPlan(await fetchCatalog());
  S.meta.lastCheck = new Date().toISOString(); await DB.set('meta', S.meta);
  S.pending = (added.length + changed.length + removed.length || books) ? { added, changed, removed, books } : null;
  updateDot();
  return S.pending;
}

async function applyUpdates(progress) {
  const pend = S.pending || await checkUpdates();
  progress(0.03, 'Actualizando secciones…');
  await fetchTaxonomies();
  if (pend) {
    const ids = [...pend.added, ...pend.changed];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await api('/posts', { include: ids.slice(i, i + 50).join(','), per_page: 50, _fields: POST_FIELDS });
      await DB.putPosts(r.data.map(shapePost));
      progress(0.05 + 0.3 * Math.min(1, (i + 50) / ids.length), `Descargando ${Math.min(i + 50, ids.length)} de ${ids.length}…`);
    }
    if (pend.removed.length) await DB.delPosts(pend.removed);
    if (pend.books) await syncBooks(progress, 0.35, 0.75, pend.books);
  }
  progress(0.75, 'Actualizando el buscador…');
  await finishSync(null, f => progress(0.75 + 0.24 * f, 'Actualizando el buscador…'));
  progress(1, 'Listo');
  return pend;
}

async function cacheImages() {
  if (!('caches' in window)) return;
  try {
    const all = await DB.all('posts'); const srcs = new Set();
    all.forEach(p => (p.h.match(/<img[^>]+src="([^"]+)"/g) || []).forEach(m => srcs.add(m.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&'))));
    Object.values(S.pages).forEach(p => (p.h.match(/<img[^>]+src="([^"]+)"/g) || []).forEach(m => srcs.add(m.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&'))));
    const c = await caches.open('pb-img-v1');
    for (const s of srcs) { if (!(await c.match(s))) { try { const r = await fetch(s, { mode: 'no-cors' }); await c.put(s, r); } catch { } } }
  } catch { }
}

async function maybeAutoCheck() {
  if (!navigator.onLine || !S.ready) return;
  const last = S.meta.lastCheck ? Date.parse(S.meta.lastCheck) : 0;
  if (Date.now() - last < CONFIG.checkEveryHours * 3600e3) {
    // the book catalog ships with the app: check it on every launch (cheap, same origin)
    try { const plan = bookPlan(await fetchCatalog()); if (plan) { S.pending = { added: [], changed: [], removed: [], ...(S.pending || {}), books: plan }; updateDot(); showUpdateBanner(); } } catch { }
    return;
  }
  try { const p = await checkUpdates(); if (p) showUpdateBanner(); } catch { }
}
function pendingCount() { const p = S.pending; return p ? p.added.length + p.changed.length + p.removed.length + (p.books ? p.books.dl.length + p.books.rm.length : 0) : 0; }
function updateDot() { $('#settingsLink .dot').hidden = !pendingCount() && !swWaiting; }
function pendingText() {
  const p = S.pending; if (!p) return ''; const parts = [];
  if (p.added.length) parts.push(`${p.added.length} ${p.added.length === 1 ? 'escrito nuevo' : 'escritos nuevos'}`);
  if (p.changed.length) parts.push(`${p.changed.length} ${p.changed.length === 1 ? 'corregido' : 'corregidos'}`);
  if (p.removed.length) parts.push(`${p.removed.length} ${p.removed.length === 1 ? 'retirado' : 'retirados'}`);
  if (p.books?.dl.length) parts.push(`${p.books.dl.length} ${p.books.dl.length === 1 ? 'libro nuevo o revisado' : 'libros nuevos o revisados'}`);
  if (p.books?.rm.length) parts.push(`${p.books.rm.length} ${p.books.rm.length === 1 ? 'libro para quitar' : 'libros para quitar'}`);
  return parts.join(', ');
}
function showUpdateBanner() {
  if (!pendingCount()) return;
  banner(`<span>Hay cambios disponibles: ${pendingText()}.</span><span class="actions"><button class="btn primary" data-act="update">Actualizar</button><button class="btn" data-act="dismiss">Más tarde</button></span>`);
}
function banner(html) { const b = $('#banner'); if (!html) { b.hidden = true; b.innerHTML = ''; return; } b.innerHTML = html; b.hidden = false; }

/* ---------- Search ---------- */
function parseQuery(q) {
  const phrases = []; const rest = q.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p.trim()); return ' ' + p + ' '; });
  return { text: rest.trim(), phrases: phrases.filter(Boolean) };
}
const getBody = id => isChap(id) ? DB.get('chapters', id) : DB.get('posts', id);
async function runSearch(q) {
  if (!S.index || !q.trim()) return { results: [], phrases: [] };
  const { text, phrases } = parseQuery(q);
  const filter = r => docExists(r.id);
  let results = S.index.search(text, { filter });
  if (!results.length) results = S.index.search(text, { filter, combineWith: 'OR' });
  if (phrases.length) {
    const np = phrases.map(norm); const keep = [];
    for (const r of results) { const d = await getBody(r.id); if (!d) continue; const nx = norm(d.t + ' ' + d.x); if (np.every(p => nx.includes(p))) keep.push(r); }
    results = keep;
  }
  return { results, phrases };
}
function tokensMatching(text, termSet) {
  const hits = []; WORD_RE.lastIndex = 0; let m;
  while ((m = WORD_RE.exec(text))) { const p = processTerm(m[0]); if (p && termSet.has(p)) hits.push([m.index, m.index + m[0].length]); }
  return hits;
}
function phraseHits(text, phrases) {
  const nt = norm(text); const hits = [];
  phrases.forEach(p => { const np = norm(p); let i = nt.indexOf(np); while (i >= 0) { hits.push([i, i + np.length]); i = nt.indexOf(np, i + np.length); } });
  return hits;
}
function markRanges(text, ranges) {
  ranges.sort((a, b) => a[0] - b[0]); let out = '', pos = 0;
  for (const [s, e] of ranges) { if (s < pos) continue; out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>'; pos = e; }
  return out + esc(text.slice(pos));
}
function snippet(text, terms, phrases, len = 280) {
  const termSet = new Set(terms);
  let hits = phrases?.length ? phraseHits(text, phrases) : [];
  if (!hits.length) hits = tokensMatching(text, termSet);
  if (!hits.length) return esc(text.slice(0, len)) + (text.length > len ? '…' : '');
  let best = hits[0][0], bestN = 0;
  for (let i = 0, j = 0; i < hits.length; i++) { while (hits[j][0] < hits[i][0] - len * 0.6) j++; if (i - j + 1 > bestN) { bestN = i - j + 1; best = hits[j][0]; } }
  let start = Math.max(0, best - 70); if (start > 0) { const sp = text.indexOf(' ', start); if (sp > 0 && sp - start < 20) start = sp + 1; }
  let end = Math.min(text.length, start + len); const sp2 = text.lastIndexOf(' ', end); if (end < text.length && sp2 > start + len * 0.7) end = sp2;
  const sub = text.slice(start, end);
  const local = hits.filter(([s, e]) => s >= start && e <= end).map(([s, e]) => [s - start, e - start]);
  return (start > 0 ? '…' : '') + markRanges(sub, local) + (end < text.length ? '…' : '');
}

/* ---------- Rendering helpers ---------- */
const view = () => $('#view');
const catName = id => S.cats.get(id)?.name || '';
const readMins = w => Math.max(1, Math.round(w / 220));
const ORN = '<div class="ornament" aria-hidden="true"><svg viewBox="0 0 120 14"><path d="M2 7h44M74 7h44"/><path d="M60 1v12M55 5h10"/><circle cx="50" cy="7" r="1.6"/><circle cx="70" cy="7" r="1.6"/></svg></div>';
const ICON = {
  star: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14"/></svg>',
  theme: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  dice: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/></svg>',
};
function row(p, extra = '') {
  return `<a class="row" href="#/leer/${p.id}${extra}"><h4>${esc(p.t)}</h4><span class="d">${fmtShort(p.d)}</span><p>${esc(p.e.slice(0, 220))}${p.e.length > 220 ? '…' : ''}</p><div class="tags">${p.c.map(c => `<span>${esc(catName(c))}</span>`).join('')}</div></a>`;
}
function card(p, pct) {
  return `<a class="card" href="#/leer/${p.id}"><div class="meta"><span class="c">${esc(catName(p.c[0]))}</span><span>${readMins(p.w)} min</span></div><h4>${esc(p.t)}</h4><p>${esc(p.e.slice(0, 120))}…</p>${pct != null ? `<div class="bar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}</a>`;
}
const isMag = b => b && b.kind === 'revista';
const realBooks = () => S.bookList.filter(b => !isMag(b));
const mags = () => S.bookList.filter(isMag);
const where = c => c.d ? c.d : (c.p ? 'p. ' + c.p : '');
const langCount = () => new Set(realBooks().map(b => b.lang)).size;
function chapCard(id, pct) {
  const m = chapMeta(id);
  return `<a class="card" href="#/libro/${m.b}/${m.n}"><div class="meta"><span class="c">${esc(m.book.title)}</span><span>${readMins(m.w)} min</span></div><h4>${esc(m.t)}</h4><p>${esc((m.e || '').slice(0, 120))}…</p>${pct != null ? `<div class="bar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}</a>`;
}
function setTitle(t) { document.title = t ? `${t} · P. Buela` : 'Padre Buela · Escritos'; }

/* ---------- Views ---------- */
function homeView() {
  setTitle('');
  const words = S.posts.reduce((s, p) => s + p.w, 0);
  const cont = Object.entries(S.progress).filter(([id, v]) => (isChap(id) ? chapMeta(id) : S.byId.has(+id)) && v.p > 0.03 && v.p < 0.97).sort((a, b) => b[1].at - a[1].at).slice(0, 3);
  const groups = GROUPS.map(g => {
    const cats = g.slugs.map(s => S.catBySlug.get(s)).filter(Boolean);
    return cats.length ? { ...g, cats } : null;
  }).filter(Boolean);
  const known = new Set(GROUPS.flatMap(g => g.slugs));
  const others = [...S.cats.values()].filter(c => !known.has(c.slug));
  if (others.length) groups[0].cats.push(...others);
  view().innerHTML = `<div class="wrap">
    <section class="hero">
      <p class="eyebrow">P. Carlos Miguel Buela, IVE</p>
      <h1>Escritos para leer, meditar y buscar</h1>
      <p>Los escritos de padrebuela.org y sus libros, para leer y buscar sin conexión.</p>
      <form id="heroSearch"><input type="search" name="q" placeholder="Busque una palabra, un tema, una frase entre comillas…" aria-label="Buscar" enterkeyhint="search"><button>Buscar</button></form>
      <div class="stats"><span><b>${S.posts.length}</b>escritos</span><span><b>${realBooks().length}</b>libros</span>${mags().length ? `<span><b>${mags().reduce((n, b) => n + b.chapters.filter(c => c.t !== 'Notas').length, 0)}</b>artículos</span>` : ''}<span><b>${((words + S.bookList.reduce((s, b) => s + b.words, 0)) / 1e6).toFixed(1)} M</b>palabras</span></div>
    </section>
    ${cont.length ? `<section class="section"><h2>Continuar leyendo</h2><p class="sub">Donde lo dejó.</p><div class="cards">${cont.map(([id, v]) => isChap(id) ? chapCard(id, v.p) : card(S.byId.get(+id), v.p)).join('')}</div></section>` : ''}
    <section class="section"><h2>Secciones</h2><p class="sub">Los escritos ordenados como en la página del Padre.</p>
      <div class="groups">${groups.map(g => `<div class="group"><h3>${esc(g.name)}</h3><div class="grid">${g.cats.map(c => `<a class="cat" href="#/seccion/${c.slug}"><strong>${esc(c.name)}</strong><span>${c.count} ${c.count === 1 ? 'escrito' : 'escritos'}</span></a>`).join('')}</div></div>`).join('')}</div>
    </section>
    ${realBooks().length ? `<section class="section"><div class="sechead"><div><h2>Libros</h2><p class="sub">${realBooks().length} libros completos${langCount() > 1 ? ` en ${langCount()} idiomas` : ''}, también en el buscador.</p></div><a class="btn" href="#/biblioteca">Ver todos</a></div><div class="shelf">${realBooks().filter(b => b.lang === 'es').slice(0, 12).map(b => cover(b)).join('')}</div></section>` : ''}
    ${mags().length ? `<section class="section"><div class="sechead"><div><h2>Artículos</h2><p class="sub">Sus artículos y homilías publicados en las revistas de la Familia del Verbo Encarnado, por número y fecha.</p></div><a class="btn" href="#/articulos">Ver todos</a></div><div class="shelf">${mags().map(b => cover(b)).join('')}</div></section>` : ''}
    <section class="section"><h2>Más</h2><div class="links" style="margin-top:16px">
      <a class="feature" href="#/todos"><span class="ic">${ICON.list}</span><span><strong>Todos los escritos</strong><span>Por fecha o por título</span></span></a>
      <a class="feature" href="#/azar"><span class="ic">${ICON.dice}</span><span><strong>Un escrito al azar</strong><span>Para la lectura espiritual de hoy</span></span></a>
      <a class="feature" href="#/biblioteca"><span class="ic">${ICON.book}</span><span><strong>Biblioteca</strong><span>${realBooks().length} libros para leer sin conexión</span></span></a>
      ${mags().length ? `<a class="feature" href="#/articulos"><span class="ic">${ICON.list}</span><span><strong>Artículos</strong><span>Ave María, Diálogo, Annuntiavit, Vox Verbi</span></span></a>` : ''}
      ${S.pages.autor ? `<a class="feature" href="#/autor"><span class="ic">${ICON.user}</span><span><strong>Sobre el autor</strong><span>Breve biografía</span></span></a>` : ''}
      <a class="feature" href="#/favoritos"><span class="ic">${ICON.star}</span><span><strong>Favoritos</strong><span>${S.favs.length} ${S.favs.length === 1 ? 'guardado' : 'guardados'}</span></span></a>
    </div></section>
  </div>${footer()}`;
  $('#heroSearch').onsubmit = e => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) go(`#/buscar?q=${encodeURIComponent(q)}`); };
}
const footer = () => `<footer class="site">Textos recopilados de diversas fuentes, propiedad de sus respectivos autores${S.meta.lastSync ? ` · Actualizado el ${fmtDate(S.meta.lastSync)}` : ''}</footer>`;

function listView(title, sub, posts, crumbs, opts = {}) {
  let sort = opts.sort || 'new';
  const render = () => {
    const arr = [...posts];
    if (sort === 'old') arr.sort((a, b) => a.d.localeCompare(b.d));
    else if (sort === 'az') arr.sort((a, b) => a.t.localeCompare(b.t, 'es'));
    else arr.sort((a, b) => b.d.localeCompare(a.d));
    $('#list').innerHTML = arr.length ? arr.map(p => row(p)).join('') : `<div class="empty"><h3>${esc(opts.emptyTitle || 'Nada por aquí')}</h3><p>${esc(opts.emptyText || '')}</p></div>`;
    view().querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.s === sort));
  };
  view().innerHTML = `<div class="wrap">${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}
    <div class="pagehead"><div><h1>${esc(title)}</h1><p class="sub">${sub}</p></div>
    <div class="seg" role="group" aria-label="Ordenar"><button data-s="new">Recientes</button><button data-s="old">Antiguos</button><button data-s="az">A–Z</button></div></div>
    <div class="list" id="list"></div></div>`;
  view().querySelectorAll('.seg button').forEach(b => b.onclick = () => { sort = b.dataset.s; render(); });
  render();
}

function sectionView(slug) {
  const c = S.catBySlug.get(slug); if (!c) return notFound();
  const g = GROUPS.find(g => g.slugs.includes(slug));
  setTitle(c.name);
  const posts = S.posts.filter(p => p.c.includes(c.id));
  listView(c.name, `${posts.length} ${posts.length === 1 ? 'escrito' : 'escritos'} · <a href="#/buscar?c=${c.id}">buscar en esta sección</a>`, posts, `<a href="#/">Inicio</a> › ${esc(g?.name || 'Escritos')}`);
}

let searchState = { shown: 20 };
function searchUrl(q, o = {}) {
  const p = new URLSearchParams(); if (q) p.set('q', q);
  for (const k of ['s', 'c', 'l', 'b']) if (o[k]) p.set(k, o[k]);
  return '#/buscar?' + p.toString();
}
async function searchView(params) {
  const restore = S.lastSearch === location.hash && S.searchSaved ? S.searchSaved : null;
  S.lastSearch = location.hash; S.searchSaved = null;
  const q = params.get('q') || ''; const scope = params.get('s') || ''; const cat = +params.get('c') || 0; const lang = params.get('l') || ''; const book = params.get('b') || '';
  $('#q').value = q; setTitle(q ? `«${q}»` : 'Buscar');
  view().innerHTML = `<div class="wrap"><div class="searchhead">
      <div class="pagehead" style="margin:0"><div><h1>${q ? `«${esc(q)}»` : 'Buscar'}</h1><p class="sub count" id="count"></p></div></div>
      <div class="filters" id="scopes"></div><div class="filters" id="filters"></div>
      <p class="hint">Consejos: <code>"palabras exactas"</code> entre comillas para una frase · se ignoran tildes y mayúsculas · las palabras parciales también encuentran resultados.</p>
    </div><div class="list" id="list"><div class="loading">Buscando…</div></div><div class="more" id="more"></div></div>`;
  if (!q.trim()) {
    $('#count').textContent = 'Escriba arriba lo que busca.'; $('#scopes').innerHTML = ''; $('#filters').innerHTML = '';
    const nb = S.bookList.length;
    $('#list').innerHTML = `<div class="empty"><h3>¿Qué desea encontrar?</h3><p>Busque entre ${S.posts.length} escritos${nb ? ` y ${nb} libros` : ''}: un tema, un santo, una cita, una frase.</p></div>`;
    $('#q').focus(); return;
  }
  const t0 = performance.now();
  const { results: all, phrases } = await runSearch(q);
  const ms = Math.round(performance.now() - t0);
  const posts = all.filter(r => !isChap(r.id));
  const arts = all.filter(r => isChap(r.id) && isMag(chapMeta(r.id)?.book));
  const chaps = all.filter(r => isChap(r.id) && !isMag(chapMeta(r.id)?.book));
  let results = scope === 'escritos' ? posts : scope === 'libros' ? chaps : scope === 'articulos' ? arts : all;
  if (scope === 'articulos' && book) results = results.filter(r => parseChap(r.id)?.b === book);
  if (scope === 'escritos' && cat) results = results.filter(r => S.byId.get(r.id)?.c.includes(cat));
  if (scope === 'libros' && lang) results = results.filter(r => chapMeta(r.id)?.book.lang === lang);
  if (scope === 'libros' && book) results = results.filter(r => parseChap(r.id)?.b === book);
  const where = scope === 'articulos' ? (book ? ` en «${esc(S.books[book]?.title || '')}»` : ' en los artículos') : scope === 'escritos' ? (cat ? ` en ${esc(catName(cat))}` : ' en los escritos') : scope === 'libros' ? (book ? ` en «${esc(S.books[book]?.title || '')}»` : lang ? ` en libros en ${esc(S.langs[lang] || lang)}` : ' en los libros') : '';
  $('#count').innerHTML = `<b>${results.length}</b> ${results.length === 1 ? 'resultado' : 'resultados'}${where} · ${ms} ms`;
  // scope chips
  $('#scopes').innerHTML = [['', 'Todo', all.length], ['escritos', 'Escritos', posts.length], ['libros', 'Libros', chaps.length], ['articulos', 'Artículos', arts.length]]
    .filter(([s, , n]) => !s || n || s === scope).map(([s, label, n]) => `<a class="chip ${scope === s ? 'on' : ''}" href="${searchUrl(q, { s })}">${label} <b>${n}</b></a>`).join('');
  // secondary chips
  let sec = '';
  if (scope === 'escritos') {
    const counts = new Map(); posts.forEach(r => S.byId.get(r.id)?.c.forEach(c => counts.set(c, (counts.get(c) || 0) + 1)));
    sec = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `<a class="chip ${cat === id ? 'on' : ''}" href="${searchUrl(q, { s: scope, c: cat === id ? '' : id })}">${esc(catName(id))} <b>${n}</b></a>`).join('');
  } else if (scope === 'libros') {
    const lc = new Map(), bc = new Map();
    chaps.forEach(r => { const m = chapMeta(r.id); if (!m) return; lc.set(m.book.lang, (lc.get(m.book.lang) || 0) + 1); if (!lang || m.book.lang === lang) bc.set(m.b, (bc.get(m.b) || 0) + 1); });
    if (lc.size > 1) sec += [...lc.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `<a class="chip lang ${lang === l ? 'on' : ''}" href="${searchUrl(q, { s: scope, l: lang === l ? '' : l })}">${esc(S.langs[l] || l)} <b>${n}</b></a>`).join('');
    sec += [...bc.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `<a class="chip ${book === id ? 'on' : ''}" href="${searchUrl(q, { s: scope, l: lang, b: book === id ? '' : id })}">${esc(S.books[id]?.title || id)} <b>${n}</b></a>`).join('');
  }
  if (scope === 'articulos') {
    const bc = new Map(); arts.forEach(r => { const b = parseChap(r.id)?.b; bc.set(b, (bc.get(b) || 0) + 1); });
    sec = [...bc.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `<a class="chip ${book === id ? 'on' : ''}" href="${searchUrl(q, { s: scope, b: book === id ? '' : id })}">${esc(S.books[id]?.title || id)} <b>${n}</b></a>`).join('');
  }
  $('#filters').innerHTML = sec; $('#filters').hidden = !sec;
  searchState = { shown: 0, results, phrases, q };
  $('#list').innerHTML = results.length ? '' : `<div class="empty"><h3>Sin resultados</h3><p>Pruebe con menos palabras o con otra forma de la palabra.</p></div>`;
  await showMore();
  if (restore) {
    while (searchState.shown < Math.min(restore.shown, results.length)) await showMore();
    S.skipTop = true;
    requestAnimationFrame(() => window.scrollTo(0, restore.y));
  }
}
async function showMore() {
  const st = searchState; const { results, phrases, q } = st; const from = st.shown, to = Math.min(results.length, from + 20);
  const qs = `?q=${encodeURIComponent(q)}`;
  const html = [];
  for (let i = from; i < to; i++) {
    const r = results[i]; const body = await getBody(r.id); if (!body) continue;
    const tHits = t => phrases?.length ? phraseHits(t, phrases) : tokensMatching(t, new Set(r.terms));
    if (isChap(r.id)) {
      const m = chapMeta(r.id); if (!m) continue;
      html.push(`<a class="row book" href="#/libro/${m.b}/${m.n}${qs}"${m.book.lang === 'ar' ? ' dir="rtl"' : ''}><h4>${markRanges(m.t, tHits(m.t))}</h4><span class="d">${esc(where(m))}</span><p lang="${m.book.lang}">${snippet(body.x, r.terms, phrases)}</p><div class="tags"><span class="bk">${ICON.book} ${esc(m.book.title)}</span>${m.book.lang !== 'es' ? `<span class="lg">${esc(m.book.lang.toUpperCase())}</span>` : ''}</div></a>`);
    } else {
      const p = S.byId.get(r.id); if (!p) continue;
      html.push(`<a class="row" href="#/leer/${p.id}${qs}"><h4>${markRanges(p.t, tHits(p.t))}</h4><span class="d">${fmtShort(p.d)}</span><p>${snippet(body.x, r.terms, phrases)}</p><div class="tags">${p.c.map(c => `<span>${esc(catName(c))}</span>`).join('')}</div></a>`);
    }
  }
  if (searchState !== st || !$('#list')) return;
  $('#list').insertAdjacentHTML('beforeend', html.join(''));
  st.shown = to;
  $('#more').innerHTML = to < results.length ? `<button class="btn" id="moreBtn">Ver más resultados (${results.length - to})</button>` : '';
  if (to < results.length) $('#moreBtn').onclick = showMore;
}

let readerCleanup = null;
function openReader(o) {
  const isFav = S.favs.includes(o.key);
  const backHref = o.q ? (S.lastSearch && new URLSearchParams(S.lastSearch.split('?')[1] || '').get('q') === o.q ? S.lastSearch : searchUrl(o.q)) : '';
  view().innerHTML = `<article class="reader">
    ${backHref ? `<div class="backbar"><a class="backres" href="${esc(backHref)}" title="Volver a los resultados de la búsqueda"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg><span>Resultados <em>«${esc(o.q.length > 28 ? o.q.slice(0, 27) + '…' : o.q)}»</em></span></a></div>` : ''}
    <div class="crumbs">${o.crumbs}</div>
    <header${o.dir ? ` dir="${o.dir}"` : ''}>${o.kicker ? `<p class="kicker">${esc(o.kicker)}</p>` : ''}<h1>${esc(o.title)}</h1><div class="meta">${o.metaHtml}</div></header>
    <div class="tools">
      ${o.tocHref ? `<a class="tool" href="${o.tocHref}" title="Índice del libro" aria-label="Índice del libro">${ICON.list}</a>` : ''}
      <button class="tool txt" data-t="smaller" title="Letra más pequeña" aria-label="Letra más pequeña">A−</button>
      <button class="tool txt" data-t="bigger" title="Letra más grande" aria-label="Letra más grande">A+</button>
      <button class="tool" data-t="theme" title="Cambiar tema" aria-label="Cambiar tema">${ICON.theme}</button>
      <button class="tool ${isFav ? 'on' : ''}" data-t="fav" title="Guardar en favoritos" aria-label="Favorito">${ICON.star}</button>
      ${o.share ? `<button class="tool" data-t="share" title="Compartir" aria-label="Compartir">${ICON.share}</button>` : ''}
    </div>
    ${ORN}
    <div class="prose${o.book ? ' bookprose' : ''}" id="prose"${o.dir ? ` dir="${o.dir}"` : ''}${o.lang ? ` lang="${o.lang}"` : ''}>${o.html}</div>
    ${ORN}
    <nav class="endnav">${o.prev ? `<a href="${o.prev.href}"><small>‹ ${esc(o.prev.small)}</small><span>${esc(o.prev.label)}</span></a>` : ''}${o.next ? `<a class="n" href="${o.next.href}"><small>${esc(o.next.small)} ›</small><span>${esc(o.next.label)}</span></a>` : ''}</nav>
    ${o.source ? `<p class="source">${o.source}</p>` : ''}
  </article>`;
  const prose = $('#prose');
  prose.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (/^https?:/.test(h) && !internalTarget(h)) { a.target = '_blank'; a.rel = 'noopener'; } });
  view().querySelector('.tools').onclick = e => {
    const b = e.target.closest('button.tool'); if (!b) return;
    const t = b.dataset.t;
    if (t === 'bigger' || t === 'smaller') { const s = Math.min(30, Math.max(15, ls.get('size', 21) + (t === 'bigger' ? 1 : -1))); ls.set('size', s); applyPrefs(); }
    if (t === 'theme') { const order = ['auto', 'light', 'sepia', 'dark']; const cur = ls.get('theme', 'auto'); const nx = order[(order.indexOf(cur) + 1) % order.length]; ls.set('theme', nx); applyPrefs(); toast({ auto: 'Tema automático', light: 'Tema claro', sepia: 'Tema sepia', dark: 'Tema oscuro' }[nx]); }
    if (t === 'fav') { toggleFav(o.key); b.classList.toggle('on', S.favs.includes(o.key)); toast(S.favs.includes(o.key) ? 'Guardado en favoritos' : 'Quitado de favoritos'); }
    if (t === 'share') { if (navigator.share) navigator.share(o.share).catch(() => { }); else navigator.clipboard?.writeText(o.share.url || o.share.text).then(() => toast('Copiado')); }
  };
  let marks = [];
  if (o.q) {
    const { text, phrases } = parseQuery(o.q);
    const termSet = new Set();
    if (S.index) {
      S.index.search(text, { filter: r => r.id === o.key }).forEach(r => r.terms.forEach(t => termSet.add(t)));
      if (!termSet.size) S.index.search(text, { filter: r => r.id === o.key, combineWith: 'OR' }).forEach(r => r.terms.forEach(t => termSet.add(t)));
    }
    marks = highlightIn(prose, termSet, phrases);
    if (marks.length) showFindbar(marks, o.q);
  }
  const saved = S.progress[o.key];
  if (!o.noRestore && !marks.length && saved && saved.p > 0.02 && saved.p < 0.97) requestAnimationFrame(() => { window.scrollTo(0, saved.p * (document.documentElement.scrollHeight - innerHeight)); toast('Continuando donde lo dejó'); });
  else if (!marks.length) window.scrollTo(0, 0);
  let tm;
  const onScroll = () => {
    const h = document.documentElement.scrollHeight - innerHeight; const pct = h > 0 ? Math.min(1, scrollY / h) : 1;
    $('#progress').style.width = (pct * 100) + '%';
    clearTimeout(tm); tm = setTimeout(() => { S.progress[o.key] = { p: pct, at: Date.now() }; o.onProgress?.(pct); DB.set('progress', S.progress); }, 400);
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  readerCleanup = () => { removeEventListener('scroll', onScroll); $('#progress').style.width = '0'; $('.findbar')?.remove(); $('.notepop')?.remove(); };
}

async function readerView(id, params) {
  const p = S.byId.get(id); if (!p) return notFound();
  const body = await DB.get('posts', id);
  setTitle(p.t);
  const primary = p.c[0];
  const sib = S.posts.filter(x => x.c.includes(primary)).sort((a, b) => a.d.localeCompare(b.d));
  const i = sib.findIndex(x => x.id === id); const prev = sib[i - 1], next = sib[i + 1];
  openReader({
    key: id, title: p.t, html: body.h, q: params.get('q') || '',
    crumbs: `<a href="#/">Inicio</a> › <a href="#/seccion/${S.cats.get(primary)?.slug}">${esc(catName(primary))}</a>`,
    metaHtml: `<span>${fmtDate(p.d)}</span><span>·</span><span>${readMins(p.w)} min de lectura</span>${p.c.map(c => `<a href="#/seccion/${S.cats.get(c)?.slug}">${esc(catName(c))}</a>`).join('')}`,
    prev: prev && { href: `#/leer/${prev.id}`, small: `Anterior en ${catName(primary)}`, label: prev.t },
    next: next && { href: `#/leer/${next.id}`, small: 'Siguiente', label: next.t },
    source: `<a href="${esc(p.l)}" target="_blank" rel="noopener">Ver en padrebuela.org</a>`,
    share: { title: p.t, text: `${p.t} — P. Carlos M. Buela`, url: p.l },
  });
}

async function chapterView(bid, n, params) {
  const bk = S.books[bid]; const c = bk?.chapters[n]; if (!c) return notFound();
  const rec = await DB.get('chapters', chapKey(bid, n)); if (!rec) return notFound();
  setTitle(`${c.t} · ${bk.title}`);
  const L = BOOK_UI[bk.lang] || BOOK_UI.es;
  S.progress['book:' + bid] = { n, at: Date.now() }; DB.set('progress', S.progress);
  const prev = bk.chapters[n - 1], next = bk.chapters[n + 1];
  openReader({
    key: chapKey(bid, n), title: c.t.split(' · ').pop(), kicker: c.t.split(' · ').slice(0, -1).join(' · '), html: rec.h, q: params.get('q') || '', book: true,
    dir: bk.lang === 'ar' ? 'rtl' : '', lang: bk.lang, tocHref: `#/libro/${bid}`,
    crumbs: `<a href="#/">Inicio</a> › ${isMag(bk) ? '<a href="#/articulos">Artículos</a>' : '<a href="#/biblioteca">Libros</a>'} › <a href="#/libro/${bid}">${esc(bk.title)}</a>`,
    metaHtml: `<span>${esc(bk.title)}</span>${c.d ? `<span>·</span><span>${esc(c.d)}</span>` : ''}<span>·</span><span>${n + 1} / ${bk.chapters.length}</span>${c.p ? `<span>·</span><span>p. ${c.p}</span>` : ''}<span>·</span><span>${readMins(c.w)} min</span>`,
    prev: prev && { href: `#/libro/${bid}/${n - 1}`, small: isMag(bk) ? 'Artículo anterior' : L.prev, label: prev.t.split(' · ').pop() },
    next: next && { href: `#/libro/${bid}/${n + 1}`, small: isMag(bk) ? 'Artículo siguiente' : L.next, label: next.t.split(' · ').pop() },
    source: `${esc(bk.title)} · P. Carlos Miguel Buela, IVE`,
    share: { title: `${c.t} — ${bk.title}`, text: `${bk.title} — ${c.t} (P. Carlos M. Buela)` },
    noRestore: !!S.scrollTo,
  });
  if (S.scrollTo) { const id = S.scrollTo; S.scrollTo = null; setTimeout(() => { const t = document.getElementById(id); if (t) flashEl(t); }, 80); }
}
const BOOK_UI = { es: { prev: 'Capítulo anterior', next: 'Capítulo siguiente' }, en: { prev: 'Previous chapter', next: 'Next chapter' }, it: { prev: 'Capitolo precedente', next: 'Capitolo successivo' }, fr: { prev: 'Chapitre précédent', next: 'Chapitre suivant' }, nl: { prev: 'Vorig hoofdstuk', next: 'Volgend hoofdstuk' }, uk: { prev: 'Попередній розділ', next: 'Наступний розділ' }, ar: { prev: 'الفصل السابق', next: 'الفصل التالي' } };

/* ---------- Library ---------- */
const COVER_COLORS = ['#6b1d2a', '#1f3a5f', '#2f4f3a', '#4b2a5c', '#7a4b1c', '#3c3c46', '#5a1f3d', '#24484f'];
function coverColor(work) { let h = 0; for (const ch of work || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COVER_COLORS[h % COVER_COLORS.length]; }
function cover(bk, size = '') {
  const pr = S.progress['book:' + bk.id];
  return `<a class="cover ${size}" href="#/libro/${bk.id}" style="--cc:${coverColor(isMag(bk) ? bk.id : bk.work)}" ${bk.lang === 'ar' ? 'dir="rtl"' : ''}>
    <span class="cv${isMag(bk) ? ' mag' : ''}"><span class="cv-top">${isMag(bk) ? 'Revista · P. Carlos M. Buela' : 'P. Carlos Miguel Buela'}</span><span class="cv-title" lang="${bk.lang}">${esc(bk.title)}</span><span class="cv-orn">✠</span>${bk.lang !== 'es' ? `<span class="cv-lang">${esc(bk.lang.toUpperCase())}</span>` : ''}</span>
    <span class="cap"><b>${esc(bk.title)}</b><small>${isMag(bk) ? `${bk.chapters.filter(c => c.t !== 'Notas').length} artículos` : `${bk.chapters.length} cap.`} · ${Math.round(bk.words / 1000)} mil palabras${pr ? ' · leyendo' : ''}</small></span></a>`;
}
function articlesView() {
  setTitle('Artículos');
  view().innerHTML = `<div class="wrap"><div class="crumbs"><a href="#/">Inicio</a></div>
    <div class="pagehead"><div><h1>Artículos</h1><p class="sub">Artículos, homilías y crónicas del P. Buela en las revistas de la Familia del Verbo Encarnado</p></div></div>
    <div class="shelf">${mags().map(b => cover(b)).join('')}</div></div>`;
}
function libraryView(params) {
  setTitle('Libros');
  const lang = params.get('l') || '';
  const counts = {}; realBooks().forEach(b => counts[b.lang] = (counts[b.lang] || 0) + 1);
  const list = realBooks().filter(b => !lang || b.lang === lang);
  const groups = lang ? [[lang, list]] : Object.keys(counts).map(l => [l, list.filter(b => b.lang === l)]);
  view().innerHTML = `<div class="wrap"><div class="crumbs"><a href="#/">Inicio</a></div>
    <div class="pagehead"><div><h1>Libros</h1><p class="sub">${realBooks().length} libros del P. Buela${Object.keys(counts).length > 1 ? ` en ${Object.keys(counts).length} idiomas` : ''} · disponibles sin conexión y en el buscador</p></div></div>
    ${Object.keys(counts).length > 1 ? `<div class="chips" style="margin-bottom:24px"><a class="chip ${!lang ? 'on' : ''}" href="#/biblioteca">Todos <b>${realBooks().length}</b></a>${Object.entries(counts).map(([l, n]) => `<a class="chip ${lang === l ? 'on' : ''}" href="#/biblioteca?l=${l}">${esc(S.langs[l] || l)} <b>${n}</b></a>`).join('')}</div>` : ''}
    ${mags().length ? `<p class="hint" style="margin:-8px 0 22px">Los artículos de revistas están en <a href="#/articulos">Artículos</a>.</p>` : ''}
    ${realBooks().length ? groups.map(([l, bks]) => `<section class="group" style="margin-bottom:34px"><h3>${esc(S.langs[l] || l)}</h3><div class="shelf">${bks.map(b => cover(b)).join('')}</div></section>`).join('') : `<div class="empty"><h3>No hay libros descargados</h3><p>Elija los idiomas en <a href="#/ajustes">Ajustes</a> y pulse «Buscar actualizaciones».</p></div>`}
    ${S.pages.libros ? `<p class="hint" style="margin-top:20px">También: <a href="#/descargas">enlaces de descarga de la página padrebuela.org</a> (PDF, epub).</p>` : ''}
  </div>`;
}
function bookView(bid) {
  const bk = S.books[bid]; if (!bk) return notFound();
  setTitle(bk.title);
  const pr = S.progress['book:' + bid];
  const others = isMag(bk) ? [] : S.bookList.filter(b => b.work === bk.work && b.id !== bk.id);
  const rtl = bk.lang === 'ar';
  view().innerHTML = `<div class="wrap bookpage"><div class="crumbs"><a href="#/">Inicio</a> › ${isMag(bk) ? '<a href="#/articulos">Artículos</a>' : '<a href="#/biblioteca">Libros</a>'}</div>
    <div class="bookhead">${cover(bk, 'big')}
      <div class="bookinfo"${rtl ? ' dir="rtl"' : ''}><p class="eyebrow">P. Carlos Miguel Buela, IVE</p><h1 lang="${bk.lang}">${esc(bk.title)}</h1>
        <p class="sub">${isMag(bk) ? `Revista · ${bk.chapters.filter(c => c.t !== 'Notas').length} artículos` : `${esc(S.langs[bk.lang] || bk.lang)} · ${bk.chapters.length} capítulos`} · ${Math.round(bk.words / 1000)} mil palabras${bk.pages ? ` · ${bk.pages} págs.` : ''}</p>
        <div class="actions" style="margin:18px 0">${pr ? `<a class="btn primary" href="#/libro/${bid}/${pr.n}">Continuar: ${esc(bk.chapters[pr.n]?.t.slice(0, 40) || '')}</a><a class="btn" href="#/libro/${bid}/0">Desde el principio</a>` : `<a class="btn primary" href="#/libro/${bid}/0">Comenzar a leer</a>`}
</div>
        <form class="booksearch" id="bookSearch"><input type="search" name="q" placeholder="${isMag(bk) ? 'Buscar en esta revista…' : 'Buscar en este libro…'}" aria-label="Buscar" enterkeyhint="search"></form>
        ${others.length ? `<p class="sub">Otras ediciones: ${others.map(o => `<a href="#/libro/${o.id}">${esc(S.langs[o.lang] || o.lang)}</a>`).join(' · ')}</p>` : ''}
      </div></div>
    <h2 class="tochead">${isMag(bk) ? 'Artículos' : 'Índice'}</h2>
    <ol class="toc"${rtl ? ' dir="rtl"' : ''}>${bk.chapters.map((c, n) => { const p = S.progress[chapKey(bid, n)]; return `<li><a href="#/libro/${bid}/${n}"><span class="tn">${n + 1}</span><span class="tt">${esc(c.t)}</span><span class="tm">${where(c) ? esc(where(c)) + ' · ' : ''}${readMins(c.w)} min${p && p.p > 0.9 ? ' ✓' : ''}</span></a></li>`; }).join('')}</ol>
  </div>`;
  $('#bookSearch').onsubmit = e => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) go(searchUrl(q, { s: isMag(bk) ? 'articulos' : 'libros', b: bid })); };
}

function highlightIn(root, termSet, phrases) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const n of nodes) {
    const text = n.nodeValue; let ranges = phrases?.length ? phraseHits(text, phrases) : [];
    if (!phrases?.length) ranges = tokensMatching(text, termSet);
    if (!ranges.length) continue;
    ranges.sort((a, b) => a[0] - b[0]);
    const frag = document.createDocumentFragment(); let pos = 0;
    for (const [s, e] of ranges) { if (s < pos) continue; frag.append(text.slice(pos, s)); const m = document.createElement('mark'); m.textContent = text.slice(s, e); frag.append(m); marks.push(m); pos = e; }
    frag.append(text.slice(pos)); n.replaceWith(frag);
  }
  return marks;
}
function showFindbar(marks, q) {
  let i = 0;
  const bar = document.createElement('div'); bar.className = 'findbar';
  bar.innerHTML = `<span id="fbc"></span><button data-d="-1" aria-label="Anterior">${ICON.up}</button><button data-d="1" aria-label="Siguiente">${ICON.down}</button><button data-d="0" aria-label="Cerrar">${ICON.x}</button>`;
  document.body.append(bar);
  const goTo = k => { marks[i]?.classList.remove('cur'); i = (k + marks.length) % marks.length; marks[i].classList.add('cur'); marks[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); bar.querySelector('#fbc').textContent = `«${q}» · ${i + 1} de ${marks.length}`; };
  bar.onclick = e => { const b = e.target.closest('button'); if (!b) return; const d = +b.dataset.d; if (!d) { marks.forEach(m => m.replaceWith(...m.childNodes)); bar.remove(); return; } goTo(i + d); };
  setTimeout(() => goTo(0), 60);
}
function internalTarget(href) {
  try {
    const u = new URL(href, CONFIG.site); if (!/padrebuela\.org$/.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length === 1 && S.bySlug.has(seg[0])) return `#/leer/${S.bySlug.get(seg[0])}`;
    if (seg[0] === 'category' && seg[1] && S.catBySlug.has(seg[1])) return `#/seccion/${seg[1]}`;
    if (seg.length === 1 && seg[0] === 'libros') return '#/descargas';
    if (seg.length === 1 && CONFIG.pages.includes(seg[0])) return `#/${seg[0]}`;
  } catch { }
  return null;
}

function staticPage(slug, title, note) {
  const pg = S.pages[slug]; if (!pg) return notFound();
  setTitle(title);
  view().innerHTML = `<article class="reader static"><div class="crumbs"><a href="#/">Inicio</a></div><header><h1>${esc(title)}</h1></header>${note ? `<p class="hint" style="margin-top:12px">${note}</p>` : ''}${ORN}<div class="prose" id="prose">${pg.h}</div><p class="source"><a href="${esc(pg.l)}" target="_blank" rel="noopener">Ver en padrebuela.org</a></p></article>`;
  $('#prose').querySelectorAll('a[href]').forEach(a => { if (/^https?:/.test(a.getAttribute('href')) && !internalTarget(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; } });
  window.scrollTo(0, 0);
}

function favView() {
  setTitle('Favoritos');
  const posts = S.favs.filter(id => !isChap(id)).map(id => S.byId.get(id)).filter(Boolean);
  const chaps = S.favs.filter(isChap).map(chapMeta).filter(Boolean);
  view().innerHTML = `<div class="wrap"><div class="crumbs"><a href="#/">Inicio</a></div><div class="pagehead"><div><h1>Favoritos</h1><p class="sub">${posts.length + chaps.length} guardados</p></div></div>
    ${!posts.length && !chaps.length ? `<div class="empty"><h3>Aún no hay favoritos</h3><p>Toque el marcador en cualquier escrito o capítulo para guardarlo aquí.</p></div>` : ''}
    ${chaps.length ? `<h3 class="tochead">Capítulos de libros</h3><div class="list">${chaps.map(m => `<a class="row book" href="#/libro/${m.b}/${m.n}"><h4>${esc(m.t)}</h4><span class="d">${esc(where(m))}</span><p>${esc((m.e || '').slice(0, 200))}…</p><div class="tags"><span class="bk">${ICON.book} ${esc(m.book.title)}</span></div></a>`).join('')}</div>` : ''}
    ${posts.length ? `<h3 class="tochead">Escritos</h3><div class="list">${posts.map(p => row(p)).join('')}</div>` : ''}</div>`;
}
async function toggleFav(id) { S.favs = S.favs.includes(id) ? S.favs.filter(x => x !== id) : [id, ...S.favs]; await DB.set('favs', S.favs); }

async function settingsView() {
  setTitle('Ajustes');
  let est = ''; try { const e = await navigator.storage?.estimate?.(); if (e) est = `${(e.usage / 1048576).toFixed(1)} MB`; } catch { }
  let persisted = false; try { persisted = await navigator.storage?.persisted?.(); } catch { }
  const theme = ls.get('theme', 'auto'); const size = ls.get('size', 21);
  view().innerHTML = `<div class="wrap" style="max-width:760px"><div class="crumbs"><a href="#/">Inicio</a></div><div class="pagehead"><div><h1>Ajustes</h1><p class="sub">Contenido sin conexión, actualizaciones y lectura.</p></div></div>
    ${swWaiting ? `<div class="panel"><h2>Nueva versión de la aplicación</h2><p>Hay una versión mejorada de la app lista para usar.</p><button class="btn primary" id="swReload">Recargar ahora</button></div>` : ''}
    <div class="panel"><h2>Contenido</h2><p>Todos los textos están guardados en este dispositivo: puede leer y buscar sin conexión.</p>
      <dl class="kv"><dt>Escritos</dt><dd>${S.posts.length}</dd><dt>Libros</dt><dd>${S.bookList.length}</dd><dt>Última actualización</dt><dd>${S.meta.lastSync ? fmtDate(S.meta.lastSync) : '—'}</dd><dt>Última comprobación</dt><dd>${S.meta.lastCheck ? new Date(S.meta.lastCheck).toLocaleString('es') : '—'}</dd><dt>Espacio usado</dt><dd>${est || '—'}${persisted ? ' · protegido' : ''}</dd></dl>
      <div id="updStatus" class="mstat" style="margin-bottom:12px">${pendingCount() ? `Cambios disponibles: ${pendingText()}.` : ''}</div>
      <div class="meter" id="meter" hidden><i></i></div>
      <div class="actions"><button class="btn primary" id="btnCheck">${ICON.refresh} ${pendingCount() ? 'Descargar cambios' : 'Buscar actualizaciones'}</button><button class="btn" id="btnFull">Descargar todo de nuevo</button></div>
    </div>
    <div class="panel"><h2>Libros</h2><p>Idiomas de los libros que se guardan en este dispositivo. Menos idiomas = menos espacio y un buscador más rápido en teléfonos antiguos.</p>
      <div class="chips" id="langPick">${Object.entries(S.langs).map(([l, name]) => `<label class="chip check"><input type="checkbox" value="${l}" ${wantedLangs({ langs: S.langs }).includes(l) ? 'checked' : ''}> ${esc(name)}</label>`).join('') || '<span class="mstat">Se mostrarán después de la primera descarga.</span>'}</div>
      <p class="mstat" style="margin-top:10px">${S.bookList.length} libros guardados. Los cambios se aplican con «Buscar actualizaciones».</p>
    </div>
    <div class="panel"><h2>Lectura</h2><p>Tema y tamaño de letra para los textos.</p>
      <div class="actions" style="margin-bottom:14px"><div class="seg" id="segTheme">${['auto', 'light', 'sepia', 'dark'].map(t => `<button data-v="${t}" class="${theme === t ? 'on' : ''}">${{ auto: 'Automático', light: 'Claro', sepia: 'Sepia', dark: 'Oscuro' }[t]}</button>`).join('')}</div></div>
      <div class="actions"><button class="btn" id="fsDown">A−</button><span class="mstat" id="fsVal">${size} px</span><button class="btn" id="fsUp">A+</button></div>
      <p class="prose" style="margin-top:16px;font-size:var(--reader-size)">«Hay que comenzar siempre de nuevo.» Muestra del tamaño de letra.</p>
    </div>
    <div class="panel"><h2>Instalar</h2><p>En iPhone/iPad: Compartir → «Añadir a pantalla de inicio». En Android/Chrome o en el ordenador: menú → «Instalar aplicación».</p>${deferredInstall ? '<button class="btn primary" id="btnInstall">Instalar ahora</button>' : ''}</div>
    <div class="panel"><h2>Acerca de</h2><p>Los textos recopilados en esta app proceden de diversas fuentes y pertenecen a sus respectivos autores. La app los guarda en el dispositivo para que pueda leerlos y buscarlos sin conexión.</p></div>
  </div>`;
  const meter = $('#meter'), bar = meter.querySelector('i'), st = $('#updStatus');
  const prog = (f, msg) => { meter.hidden = false; bar.style.width = (f * 100) + '%'; st.textContent = msg; };
  const lock = on => ['#btnCheck', '#btnFull'].forEach(s => $(s).disabled = on);
  $('#btnCheck').onclick = async () => {
    if (!navigator.onLine) return toast('Sin conexión a internet');
    lock(true);
    try {
      if (!S.pending) { st.textContent = 'Comprobando padrebuela.org…'; const p = await checkUpdates(); if (!p) { st.textContent = 'Todo está al día.'; toast('Todo está al día'); lock(false); await finishSync(); return settingsView(); } }
      const p = await applyUpdates(prog); banner(null); updateDot();
      toast('Actualizado'); settingsView();
    } catch (e) { st.textContent = 'No se pudo actualizar: ' + e.message; lock(false); }
  };
  $('#btnFull').onclick = async () => {
    if (!navigator.onLine) return toast('Sin conexión a internet');
    lock(true);
    try { await fullSync(prog); banner(null); updateDot(); toast('Colección descargada de nuevo'); settingsView(); } catch (e) { st.textContent = 'Error: ' + e.message; lock(false); }
  };
  $('#langPick')?.addEventListener('change', () => { const sel = [...document.querySelectorAll('#langPick input:checked')].map(i => i.value); ls.set('bookLangs', sel); S.pending = null; toast('Pulse «Buscar actualizaciones» para aplicar'); });
  $('#segTheme').onclick = e => { const b = e.target.closest('button'); if (!b) return; ls.set('theme', b.dataset.v); applyPrefs(); settingsView(); };
  const fs = d => { const s = Math.min(30, Math.max(15, ls.get('size', 21) + d)); ls.set('size', s); applyPrefs(); $('#fsVal').textContent = s + ' px'; };
  $('#fsDown').onclick = () => fs(-1); $('#fsUp').onclick = () => fs(1);
  $('#swReload')?.addEventListener('click', () => swWaiting?.postMessage('skipWaiting'));
  $('#btnInstall')?.addEventListener('click', async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; settingsView(); });
}

function notFound() { setTitle('No encontrado'); view().innerHTML = `<div class="wrap"><div class="empty"><h3>No encontrado</h3><p><a href="#/">Volver al inicio</a></p></div></div>`; }

function setupView(errorMsg) {
  view().innerHTML = `<div class="setup"><img src="icons/icon-192.png" alt=""><h1>Escritos del P. Buela</h1>
    <p>${errorMsg ? esc(errorMsg) : 'La primera vez la app descarga los escritos de padrebuela.org y los libros del Padre (unos 35 MB). Después funcionará sin conexión.'}</p>
    <div class="meter" id="meter"><i></i></div><div class="mstat" id="mstat">${errorMsg ? '' : 'Preparando…'}</div>
    ${errorMsg ? '<p style="margin-top:20px"><button class="btn primary" id="retry">Reintentar</button></p>' : ''}</div>`;
  $('#retry')?.addEventListener('click', firstRun);
}
async function firstRun() {
  setupView();
  const prog = (f, msg) => { const m = $('#meter i'); if (m) m.style.width = (f * 100) + '%'; const s = $('#mstat'); if (s) s.textContent = msg; };
  try {
    const fromSnap = await loadSnapshot(prog);
    if (!fromSnap) {
      if (!navigator.onLine) throw new Error('Se necesita conexión a internet para la primera descarga.');
      await fullSync(prog);
    }
    route();
    if (fromSnap) maybeAutoCheck();
  } catch (e) {
    console.error(e);
    setupView(e.message.includes('conexión') ? e.message : 'No se pudo descargar la colección. Compruebe la conexión y vuelva a intentarlo. (' + e.message + ')');
  }
}

/* ---------- Footnotes / in-book links ---------- */
const NOTE_RE = /foot|note|nota|ftn|fn|endnote/i;
function flashEl(t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); const blk = t.closest('p,li,div,h1,h2,h3,h4') || t; blk.classList.remove('flash'); void blk.offsetWidth; blk.classList.add('flash'); }
function notePop(html, actionHtml) {
  $('.notepop')?.remove();
  const d = document.createElement('div'); d.className = 'notepop'; d.setAttribute('role', 'dialog');
  d.innerHTML = `<div class="np-body">${html}</div><div class="np-actions">${actionHtml || ''}<button class="btn" data-np="close">Cerrar</button></div>`;
  document.body.append(d);
  d.addEventListener('click', ev => { if (ev.target.closest('[data-np="close"]')) d.remove(); });
  return d;
}
function noteHtml(el) {
  let blk = el.closest('p,li,dd,div,aside') || el;
  if (!blk.textContent.trim() || blk.matches('div') && blk.textContent.length > 3000) { let n = el.nextElementSibling || blk.nextElementSibling; while (n && !n.textContent.trim()) n = n.nextElementSibling; if (n) blk = n; }
  const c = blk.cloneNode(true); c.querySelectorAll('.fnback').forEach(x => x.remove()); c.querySelectorAll('a[href^="#"]').forEach(x => x.replaceWith(...x.childNodes));
  return c.innerHTML;
}
async function openNote(id, link) {
  const local = document.getElementById(id) || document.getElementsByName(id)[0];
  const isRef = link.closest('sup') || NOTE_RE.test(id);
  if (local) {
    if (!isRef) return flashEl(local);
    const p = notePop(noteHtml(local), '<button class="btn" data-np="go">Ir a la nota</button>');
    p.querySelector('[data-np="go"]').onclick = () => { p.remove(); flashEl(local); };
    return;
  }
  const m = /^#\/libro\/([^/]+)\/(\d+)/.exec(location.hash); if (!m) return;
  const bk = S.books[decodeURIComponent(m[1])]; if (!bk) return;
  const needle = `id="${id}"`;
  for (let n = 0; n < bk.chapters.length; n++) {
    const rec = await DB.get('chapters', chapKey(bk.id, n));
    if (!rec || !rec.h.includes(needle)) continue;
    const tmp = document.createElement('div'); tmp.innerHTML = rec.h;
    const el = tmp.querySelector(`[id="${CSS.escape(id)}"]`); if (!el) continue;
    const back = /back|ref/i.test(id);
    const p = notePop(back ? `<p class="np-ctx">${esc(bk.chapters[n].t)}</p>` + noteHtml(el) : noteHtml(el), `<button class="btn" data-np="go">${back ? 'Volver al texto' : 'Abrir la nota'}</button>`);
    p.querySelector('[data-np="go"]').onclick = () => { p.remove(); S.scrollTo = id; go(`#/libro/${bk.id}/${n}`); };
    return;
  }
  toast('No se encontró la nota');
}

/* ---------- Router ---------- */
function go(h) { location.hash = h; }
async function route() {
  readerCleanup?.(); readerCleanup = null;
  if (!S.ready) return firstRun();
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?'); const params = new URLSearchParams(qs || '');
  const seg = path.split('/').filter(Boolean);
  if (seg[0] !== 'buscar') $('#q').value = '';
  switch (seg[0]) {
    case undefined: homeView(); break;
    case 'buscar': await searchView(params); break;
    case 'seccion': sectionView(decodeURIComponent(seg[1] || '')); break;
    case 'leer': await readerView(+seg[1], params); break;
    case 'todos': setTitle('Todos los escritos'); listView('Todos los escritos', `${S.posts.length} escritos del P. Carlos M. Buela`, S.posts, '<a href="#/">Inicio</a>'); break;
    case 'favoritos': favView(); break;
    case 'autor': staticPage('autor', 'Sobre el autor'); break;
    case 'descargas': staticPage('libros', 'Enlaces de descarga', 'Página «Libros» de padrebuela.org. Los enlaces llevan a sitios externos y necesitan conexión a internet.'); break;
    case 'libros': case 'biblioteca': libraryView(params); break;
    case 'articulos': articlesView(); break;
    case 'libro': if (seg[2] != null) await chapterView(decodeURIComponent(seg[1]), +seg[2], params); else bookView(decodeURIComponent(seg[1])); break;
    case 'ajustes': await settingsView(); break;
    case 'azar': { const p = S.posts[Math.floor(Math.random() * S.posts.length)]; history.replaceState(null, '', `#/leer/${p.id}`); await readerView(p.id, new URLSearchParams()); break; }
    default: notFound();
  }
  if (S.skipTop) S.skipTop = false;
  else if (seg[0] !== 'leer' && seg[0] !== 'azar' && !(seg[0] === 'libro' && seg[2] != null)) window.scrollTo(0, 0);
}

/* ---------- Prefs, events, SW ---------- */
function applyPrefs() {
  const t = ls.get('theme', 'auto');
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  document.documentElement.style.setProperty('--reader-size', ls.get('size', 21) + 'px');
}
let swWaiting = null, deferredInstall = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

document.addEventListener('click', e => {
  if (e.target.closest('#list a.row') && location.hash.startsWith('#/buscar')) S.searchSaved = { y: scrollY, shown: searchState.shown };
  const b = e.target.closest('[data-act]');
  if (b?.dataset.act === 'dismiss') { banner(null); return; }
  if (b?.dataset.act === 'update') { banner(null); go('#/ajustes'); setTimeout(() => $('#btnCheck')?.click(), 50); return; }
  if (b?.dataset.act === 'reload') { swWaiting?.postMessage('skipWaiting'); return; }
  const a = e.target.closest('#prose a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (href.startsWith('#') && !href.startsWith('#/')) {
      e.preventDefault();
      if (href.length > 1) openNote(decodeURIComponent(href.slice(1)), a);
      return;
    }
    const internal = internalTarget(href);
    if (internal) { e.preventDefault(); go(internal); }
  }
});
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); const cur = new URLSearchParams(location.hash.split('?')[1] || ''); go(`#/buscar?q=${encodeURIComponent(q)}${location.hash.startsWith('#/buscar') && cur.get('c') ? '&c=' + cur.get('c') : ''}`); $('#q').blur(); });
addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); } });
addEventListener('hashchange', route);
addEventListener('online', maybeAutoCheck);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const track = w => w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { swWaiting = w; updateDot(); banner(`<span>Hay una nueva versión de la aplicación.</span><button class="btn primary" data-act="reload">Recargar</button>`); } });
    if (reg.waiting && navigator.serviceWorker.controller) { swWaiting = reg.waiting; updateDot(); }
    reg.addEventListener('updatefound', () => track(reg.installing));
    setInterval(() => reg.update().catch(() => { }), 3600e3);
  }).catch(() => { });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && swWaiting) { reloaded = true; location.reload(); } });
}

(async function init() {
  applyPrefs();
  view().innerHTML = '<div class="loading">Cargando…</div>';
  try { await DB.open(); await loadState(); if (S.ready) await migrateNotes(); }
  catch (e) { view().innerHTML = `<div class="wrap"><div class="empty"><h3>El almacenamiento no está disponible</h3><p>${esc(e.message)}. Si está en navegación privada, ábrala en una ventana normal.</p></div></div>`; return; }
  await route();
  if (S.ready && !Object.keys(S.books).length) S.meta.lastCheck = null; // existing installs: offer the new library right away
  setTimeout(maybeAutoCheck, 2500);
})();
