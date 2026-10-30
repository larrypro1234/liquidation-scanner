// Shared between the background service worker and the dashboard page.

// The scanner pulls page links and parsing rules from this file on GitHub, so
// fixes reach every install without reinstalling the extension.
const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/larrypro1234/liquidation-scanner/main/config.json';
const CONFIG_CHECK_MINUTES = 5;

const DEFAULT_SETTINGS = {
  autoUrls: true,     // use the page list from config.json on GitHub
  urls: '',           // custom page list, used when autoUrls is off
  intervalSec: 3,       // one Amazon page every ~this many seconds (randomised 80–120%)
  maxPrice: 0,        // 0 = no limit
  minDiscount: 0,     // % below est. retail / list price, 0 = any
  include: '',        // comma separated, title must contain one
  exclude: '',        // comma separated, title must contain none
  skipUnavailable: true,
  priceDrops: true,
  notify: true,
  sound: true,
  autoOpen: false,
  separateWindow: false, // open scan pages in their own window instead of next to the dashboard
  minimized: false,      // only applies to the separate window
};

let bundledConfigP = null;
function bundledConfig() {
  if (!bundledConfigP) bundledConfigP = fetch(chrome.runtime.getURL('config.json')).then(r => r.json());
  return bundledConfigP;
}

// The config in use: the last good copy from GitHub layered over the one shipped with the extension.
async function getConfig() {
  const base = await bundledConfig();
  const { remoteConfig } = await chrome.storage.local.get('remoteConfig');
  return mergeConfig(base, remoteConfig);
}

function mergeConfig(base, remote) {
  if (!remote || typeof remote !== 'object') return base;
  const urls = Array.isArray(remote.urls) ? parseUrls(remote.urls.join('\n')) : [];
  return {
    ...base,
    ...remote,
    urls: urls.length ? urls : base.urls,
    rules: { ...base.rules, ...(remote.rules && typeof remote.rules === 'object' ? remote.rules : {}) },
  };
}

function effectiveUrls(settings, config) {
  const custom = parseUrls(settings.urls);
  return settings.autoUrls || !custom.length ? config.urls : custom;
}

function newerVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Lot details from the title. Amazon's liquidation titles look like
// "315 Units (Est 1 pallets) - Returned Damaged - Apparel Lot"; rules.titlePattern
// pulls out units, pallets, type and category. Titles that don't fit fall back
// to the rules.lotTypes keyword list for the type.
const ruleRes = new Map();
function ruleRe(src) {
  if (!ruleRes.has(src)) {
    let re = null;
    try { re = new RegExp(src, 'i'); } catch {}
    ruleRes.set(src, re);
  }
  return ruleRes.get(src);
}

function lotInfo(it, config) {
  const rules = (config && config.rules) || {};
  const title = it.title || '';
  const m = rules.titlePattern && ruleRe(rules.titlePattern) && title.match(ruleRe(rules.titlePattern));
  if (m && m.groups) {
    return {
      type: (m.groups.type || '').trim(),
      category: (m.groups.category || '').trim(),
      pallets: m.groups.pallets ? parseFloat(m.groups.pallets) : null,
    };
  }
  let type = '';
  for (const t of rules.lotTypes || []) {
    const re = ruleRe(t.pattern);
    if (re && re.test(title)) { type = t.label; break; }
  }
  return { type, category: '', pallets: null };
}

// Colour family for a type tag, so e.g. "Returned Damaged" and "Damaged" both read as damaged.
function typeTone(type) {
  const t = (type || '').toLowerCase();
  if (/damag|salvage|parts|as[ -]is/.test(t)) return 'bad';
  if (/return/.test(t)) return 'return';
  if (/overstock|surplus|excess|shelf/.test(t)) return 'overstock';
  if (/new|open box/.test(t)) return 'new';
  if (/refurb/.test(t)) return 'refurb';
  return 'other';
}

function parseUrls(text) {
  return String(text || '')
    .split(/\s+/)
    .map(u => u.trim())
    .filter(u => /^https:\/\/www\.amazon\.com\//.test(u));
}

function splitWords(s) {
  return String(s || '').toLowerCase().split(',').map(w => w.trim()).filter(Boolean);
}

function passesFilters(it, s) {
  const title = (it.title || '').toLowerCase();
  if (s.skipUnavailable && it.unavailable) return false;
  if (s.maxPrice > 0 && (it.price == null || it.price > s.maxPrice)) return false;
  if (s.minDiscount > 0 && (it.discount == null || it.discount < s.minDiscount)) return false;
  const inc = splitWords(s.include);
  if (inc.length && !inc.some(w => title.includes(w))) return false;
  if (splitWords(s.exclude).some(w => title.includes(w))) return false;
  return true;
}

// Injected into each scan tab with chrome.scripting.executeScript, so it must be
// fully self-contained. All page-specific knowledge comes in through `rules`
// (selectors and regex sources from config.json).
function scrapePage(rules) {
  const R = rules || {};
  const out = { url: location.href, captcha: false, items: [] };
  const re = (src, flags = 'i') => { try { return src ? new RegExp(src, flags) : null; } catch { return null; } };
  const qs = (el, sel) => { try { return sel ? el.querySelector(sel) : null; } catch { return null; } };
  const qsa = (el, sel) => { try { return sel ? [...el.querySelectorAll(sel)] : []; } catch { return []; } };

  const bodyText = (document.body && document.body.innerText) || '';
  const capTitle = re(R.captchaTitle), capText = re(R.captchaText);
  if (
    qs(document, R.captchaSelector) ||
    (capTitle && capTitle.test(document.title)) ||
    (capText && capText.test(bodyText.slice(0, 5000)))
  ) {
    out.captcha = true;
    return out;
  }
  // Amazon's "SORRY, something went wrong on our end" dog page = rate limited.
  const thrTitle = re(R.throttleTitle), thrText = re(R.throttleText);
  if ((thrTitle && thrTitle.test(document.title)) || (thrText && thrText.test(bodyText.slice(0, 5000)))) {
    out.throttled = true;
    return out;
  }

  const money = s => {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)\s*(k\b)?/i);
    return m ? parseFloat(m[1]) * (m[2] ? 1000 : 1) : null;
  };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

  // Search-result style pages tag every product card with an ASIN attribute.
  const cards = new Map();
  qsa(document, R.cardSelector).forEach(el => {
    const asin = (el.getAttribute(R.cardAsinAttr) || '').trim();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return;
    const prev = cards.get(asin);
    if (!prev || el.contains(prev)) cards.set(asin, el);
  });
  // Widget/landing style pages: fall back to product links.
  if (cards.size === 0) {
    const linkRe = re(R.linkAsinPattern, '');
    qsa(document, R.linkSelector).forEach(a => {
      const m = linkRe && a.href.match(linkRe);
      if (!m || cards.has(m[1])) return;
      let card = a;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        if (/\$\s?\d/.test(card.innerText || '')) break;
      }
      cards.set(m[1], card);
    });
  }

  const retailRes = (R.retailPatterns || []).map(p => re(p)).filter(Boolean);
  const unitsRe = re(R.unitsPattern), unavailableRe = re(R.unavailablePattern);

  for (const [asin, el] of cards) {
    const text = clean(el.innerText);
    if (!text) continue;
    const img = el.querySelector('img');

    let title = '';
    qsa(el, R.titleSelector).forEach(h => {
      const t = clean(h.getAttribute('aria-label') || h.innerText);
      // Price links share the title's styling on Amazon; never take one as the title.
      if (/^\$\s?\d|original price|list price/i.test(t)) return;
      if (t.length > title.length) title = t;
    });
    if (!title && img) title = clean(img.alt);
    if (!title) title = text.slice(0, 160);

    let priceEl = null;
    for (const sel of R.priceSelectors || []) if ((priceEl = qs(el, sel))) break;
    let price = priceEl ? money(priceEl.textContent) : null;
    if (price == null) price = money(text.replace(title, ''));

    const listEl = qs(el, R.listPriceSelector);
    const listPrice = listEl ? money(listEl.textContent) : null;

    const flat = text.replace(/,/g, '');
    let rv = null;
    for (const r of retailRes) if ((rv = flat.match(r))) break;
    let retail = rv ? parseFloat(rv[1]) * (rv[2] ? 1000 : 1) : listPrice;
    if (retail != null && price != null && retail <= price) retail = null;
    const discount = retail && price ? Math.round((1 - price / retail) * 100) : null;

    const um = unitsRe && text.match(unitsRe);
    const link = qs(el, R.linkSelector) || qs(el, 'h2 a, a.a-link-normal');

    out.items.push({
      asin,
      title: title.slice(0, 300),
      price,
      retail,
      discount,
      units: um ? parseInt(um[1], 10) : null,
      img: img ? img.currentSrc || img.src : '',
      url: `https://www.amazon.com/dp/${asin}`,
      href: link ? link.href : '',
      sponsored: /^sponsored\b/i.test(text) || !!qs(el, R.sponsoredSelector),
      unavailable: !!(unavailableRe && unavailableRe.test(text)),
    });
    if (out.items.length >= (R.maxItemsPerPage || 200)) break;
  }
  return out;
}

// Injected into the manifest tab (an Amazon /dp/ lot page). Reads the "Lot
// Manifest" table and returns the top rows by quantity. Self-contained like
// scrapePage; page-specific bits come from rules.manifest in config.json.
async function scrapeManifest(rules) {
  const R = (rules && rules.manifest) || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const re = (src, flags = 'i') => { try { return src ? new RegExp(src, flags) : null; } catch { return null; } };
  const num = s => { const m = String(s || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

  const bodyText = () => (document.body && document.body.innerText) || '';
  if (document.querySelector('form[action*="validateCaptcha"]') || /robot check/i.test(document.title) ||
      /not a robot|enter the characters you see/i.test(bodyText().slice(0, 5000))) {
    return { captcha: true };
  }
  const thr = rules && [re(rules.throttleTitle), re(rules.throttleText)];
  if (thr && ((thr[0] && thr[0].test(document.title)) || (thr[1] && thr[1].test(bodyText().slice(0, 5000))))) {
    return { throttled: true };
  }

  const cols = R.columns || {};
  const headerRe = re(R.tableHeaderPattern || 'qty|quantity');
  const cellsOf = (row, sel) => [...row.querySelectorAll(sel)].map(c => norm(c.textContent));
  const findTable = () => {
    for (const t of document.querySelectorAll(R.tableSelector || 'table, [role="table"], [role="grid"]')) {
      const head = cellsOf(t, 'th, [role="columnheader"]').join(' | ');
      if (headerRe && headerRe.test(head)) return t;
    }
    return null;
  };

  // The manifest may sit below the fold, so nudge the page down while waiting for it.
  let table = null;
  for (let i = 0; i < 16 && !(table = findTable()); i++) {
    window.scrollTo(0, (document.body.scrollHeight * (i + 1)) / 16);
    await sleep(500);
  }
  if (!table) return { found: false, heading: /lot manifest/i.test(bodyText()) };

  const parse = () => {
    const headers = cellsOf(table, 'th, [role="columnheader"]').map(h => h.toLowerCase());
    const col = key => { const r = re(cols[key]); return r ? headers.findIndex(h => r.test(h)) : -1; };
    const ix = {};
    ['condition', 'type', 'brand', 'asin', 'title', 'qty', 'price', 'total'].forEach(k => (ix[k] = col(k)));
    const get = (cells, k) => (ix[k] >= 0 ? cells[ix[k]] || '' : '');
    return [...table.querySelectorAll('tr, [role="row"]')]
      .map(r => cellsOf(r, 'td, [role="cell"], [role="gridcell"]'))
      .filter(c => c.length >= 3)
      .map(c => ({
        condition: get(c, 'condition'),
        type: get(c, 'type'),
        brand: get(c, 'brand'),
        asin: get(c, 'asin'),
        title: get(c, 'title').slice(0, 200),
        qty: num(get(c, 'qty')) || 0,
        price: num(get(c, 'price')),
        total: num(get(c, 'total')),
      }));
  };

  let rows = parse();
  // "See all (37)": if fewer rows are in the page than that, open the full list.
  const seeAllRe = re(R.seeAllPattern || 'see all\\s*\\((\\d+)\\)');
  const declaredMatch = seeAllRe && bodyText().match(seeAllRe);
  const declared = declaredMatch ? parseInt(declaredMatch[1], 10) : null;
  if (declared && rows.length < declared) {
    const link = [...document.querySelectorAll('a, button, span[role="button"]')].find(e => seeAllRe.test(norm(e.textContent)));
    const href = link && link.getAttribute('href');
    if (link && (!href || href.startsWith('#') || href.startsWith('javascript'))) {
      link.click();
      for (let i = 0; i < 6 && rows.length < declared; i++) { await sleep(500); rows = parse(); }
    }
  }

  const top = rows.slice().sort((a, b) => b.qty - a.qty).slice(0, R.topN || 5);
  return {
    found: true,
    count: Math.max(rows.length, declared || 0),
    totalQty: rows.reduce((a, r) => a + r.qty, 0),
    top,
  };
}
