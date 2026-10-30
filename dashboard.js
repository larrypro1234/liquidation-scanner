const $ = id => document.getElementById(id);
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

let settings = { ...DEFAULT_SETTINGS };
let config = { urls: [], rules: {} };
let configCheck = null;
let outdatedSince = null;
let justUpdated = null;
let run = null;
let leads = [];
let listings = {};
let freshAsins = new Set();
let audioCtx = null;
let unseenLeads = 0;
let dismissed = {};   // asin -> when "Seen it" was clicked
let manifests = {};   // asin -> lot manifest read from its Amazon page
let banMenuAsin = null;
let activeTab = 'leads'; // only the visible list gets drawn
let listingsSig = '';     // skip redraws when a scan brings back the same lots // listing whose Ban menu is open; lists hold still while it is

// ---------- helpers ----------

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt$ = n => (n == null ? '–' : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function duration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}

function send(type) {
  return chrome.runtime.sendMessage({ type });
}

function beep() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    const t0 = audioCtx.currentTime;
    [880, 1320, 1760].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.11);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.12);
    });
  } catch {}
}

// ---------- rendering ----------

let wasScanning = null;
function renderHeader() {
  const scanning = run && run.scanning;
  // The empty-state text in the leads list depends on whether we're scanning.
  if (wasScanning !== null && wasScanning !== !!scanning && !leads.length) renderLeads();
  wasScanning = !!scanning;
  const paused = scanning && run.paused;
  const pageUrls = effectiveUrls(settings, config);
  const pageN = pageUrls.length;
  $('pageCount').textContent = pageN;
  $('everySec').textContent = settings.intervalSec;

  const st = $('status');
  st.className = 'pill ' + (paused ? 'paused' : scanning ? 'on' : 'idle');
  st.textContent = paused ? 'Paused · CAPTCHA' : scanning ? 'Scanning' : 'Idle';

  const btn = $('toggle');
  btn.textContent = scanning ? 'Stop scanning' : 'Start scanning';
  btn.classList.toggle('stop', !!scanning);
  $('showWindow').hidden = !scanning;
  $('captchaBanner').hidden = !paused;
  const backoff = scanning && run.backoff ? run.backoff : 0;
  $('slowBanner').hidden = !backoff || paused;
  if (backoff) $('slowSec').textContent = Math.min(60, settings.intervalSec * 2 ** backoff);
  if (backoff) $('everySec').textContent = Math.min(60, settings.intervalSec * 2 ** backoff);

  const tabs = scanning ? Object.values(run.tabs) : [];
  $('sScans').textContent = (run ? run.scans : 0).toLocaleString();
  const mins = scanning ? (Date.now() - run.startedAt) / 60000 : 0;
  $('sRate').textContent = mins > 0.05 ? Math.round(run.scans / mins) : 0;
  $('sLeads').textContent = run ? run.leads : 0;
  $('sTime').textContent = scanning ? duration(Date.now() - run.startedAt) : '–';
  $('sListings').textContent = tabs.reduce((a, t) => a + (t.count || 0), 0);

  const pages = $('pages');
  if (!scanning) {
    pages.innerHTML = '';
    pageUrls.forEach((u, i) => {
      const d = document.createElement('div');
      d.className = 'pg';
      d.innerHTML = `<b>Page ${i + 1}</b><span>not running</span>`;
      pages.appendChild(d);
    });
    return;
  }
  tabs.sort((a, b) => a.idx - b.idx);
  pages.innerHTML = '';
  tabs.forEach(t => {
    const d = document.createElement('div');
    d.className = 'pg ' + t.state;
    d.title = (t.error ? 'Error: ' + t.error + '\n' : '') + t.url;
    const label = t.state === 'captcha' ? 'CAPTCHA' : t.state === 'error' ? 'error' : t.state === 'throttled' ? 'Amazon busy' : `${t.count} items`;
    d.innerHTML = `<b>Page ${t.idx + 1}</b><span>${label}</span><br><span>${ago(t.lastScan)}</span>`;
    pages.appendChild(d);
  });
}

function itemEl(it, { lead = false } = {}) {
  const el = $('itemTpl').content.firstElementChild.cloneNode(true);
  el.dataset.asin = it.asin;
  const href = it.url;
  el.querySelector('.thumb').href = href;
  const img = el.querySelector('img');
  if (it.img) img.src = it.img; else img.remove();
  const a = el.querySelector('.title');
  a.href = href;
  a.textContent = it.title;
  a.title = it.title;

  const meta = el.querySelector('.meta');
  const tag = (text, cls = '') => {
    const s = document.createElement('span');
    s.className = 'tag ' + cls;
    s.textContent = text;
    meta.appendChild(s);
  };
  if (lead) tag(it.reason === 'price-drop' ? 'PRICE DROP' : 'NEW', it.reason === 'price-drop' ? 'drop' : 'new');
  const info = lotInfo(it, config);
  if (info.type) tag(info.type, 'type tone-' + typeTone(info.type));
  if (info.category) tag(info.category, 'cat');
  if (info.pallets) tag(`${info.pallets} pallet${info.pallets === 1 ? '' : 's'}`);
  if (it.discount != null) tag(`${it.discount}% off retail`, 'off');
  if (it.units) tag(`${it.units} units` + (it.price ? ` · ${fmt$(it.price / it.units)}/unit` : ''));
  tag('Page ' + it.page);
  if (it.sponsored) tag('Sponsored');
  if (it.unavailable) tag('Unavailable');
  tag(lead ? 'found ' + ago(it.foundAt) : 'first seen ' + ago(it.firstSeen));

  const banBtn = document.createElement('button');
  banBtn.className = 'ban-btn';
  banBtn.textContent = '⊘ Ban…';
  banBtn.addEventListener('click', () => {
    banMenuAsin = banMenuAsin === it.asin ? null : it.asin;
    document.querySelectorAll('.ban-menu').forEach(m => m.remove());
    if (banMenuAsin) el.querySelector('.body').appendChild(banMenu(it, info));
  });
  meta.appendChild(banBtn);

  const seenBtn = document.createElement('button');
  seenBtn.className = 'seen-btn';
  const isSeen = !!dismissed[it.asin] && !(lead && it.foundAt > dismissed[it.asin]);
  seenBtn.textContent = isSeen ? '↺ Back to New leads' : '✓ Seen it';
  seenBtn.addEventListener('click', () => (isSeen ? unsee([it.asin]) : see(it)));
  meta.appendChild(seenBtn);

  el.querySelector('.body').appendChild(manifestEl(it));
  if (banMenuAsin === it.asin) el.querySelector('.body').appendChild(banMenu(it, info));

  el.querySelector('.price').textContent = fmt$(it.price);
  const r = el.querySelector('.retail');
  if (lead && it.reason === 'price-drop') r.innerHTML = `was <s>${fmt$(it.oldPrice)}</s>`;
  else if (it.retail) r.innerHTML = `retail <s>${fmt$(it.retail)}</s>`;

  const hot = settings.minDiscount > 0 ? it.discount >= settings.minDiscount : it.discount >= 70;
  if (hot) el.classList.add('hot');
  if (!lead && !it.matches) el.classList.add('nomatch');
  return el;
}

// ---------- seen it ----------

async function see(it) {
  dismissed = { ...dismissed, [it.asin]: Date.now() };
  await chrome.storage.local.set({ dismissed });
  toast('Moved to All listings', () => unsee([it.asin]));
}

async function unsee(asins) {
  dismissed = { ...dismissed };
  asins.forEach(a => delete dismissed[a]);
  await chrome.storage.local.set({ dismissed });
}

// ---------- manifests ----------

function manifestEl(it) {
  const box = document.createElement('div');
  box.className = 'manifest';
  const mf = manifests[it.asin];
  if (!mf) {
    box.classList.add('muted');
    box.textContent = run && run.scanning ? 'Manifest: reading the lot page…' : 'Manifest: loads while scanning';
    return box;
  }
  if (!mf.found || !mf.top || !mf.top.length) {
    box.classList.add('muted');
    box.textContent = 'No manifest on this lot’s page';
    return box;
  }
  const head = document.createElement('div');
  head.className = 'manifest-head';
  head.textContent = `Top ${mf.top.length} of ${mf.count} products by qty` + (mf.totalQty ? ` · ${mf.totalQty.toLocaleString()} units listed` : '');
  box.appendChild(head);
  const table = document.createElement('table');
  mf.top.forEach(r => {
    const tr = table.insertRow();
    tr.insertCell().textContent = r.qty + '×';
    const title = tr.insertCell();
    if (/^[A-Z0-9]{10}$/.test(r.asin)) {
      const a = document.createElement('a');
      a.href = `https://www.amazon.com/dp/${r.asin}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.title || r.asin;
      title.appendChild(a);
    } else {
      title.textContent = r.title;
    }
    title.title = r.title;
    tr.insertCell().textContent = r.brand;
    tr.insertCell().textContent = r.type;
    tr.insertCell().textContent = r.price != null ? fmt$(r.price) + ' ea' : '';
    tr.cells[0].className = 'q';
    tr.cells[1].className = 't';
    tr.cells[4].className = 'p';
  });
  box.appendChild(table);
  return box;
}

// ---------- banning ----------

function bannedWords() {
  return splitWords(settings.exclude);
}

async function setBanned(words) {
  const next = { ...settings, exclude: [...new Set(words)].join(', ') };
  settings = next;
  if (document.activeElement !== $('exclude')) $('exclude').value = next.exclude;
  await chrome.storage.local.set({ settings: next });
}

async function ban(word) {
  word = word.trim().toLowerCase();
  if (!word) return;
  banMenuAsin = null;
  await setBanned([...bannedWords(), word]);
  toast(`Banned “${word}”`, () => setBanned(bannedWords().filter(w => w !== word)));
}

// Menu of things to ban for one listing: its condition, the words in it, its
// category, or any word typed in.
function banMenu(it, info) {
  const box = document.createElement('div');
  box.className = 'ban-menu';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = 'Hide every lot whose title contains:';
  box.appendChild(label);

  const already = bannedWords();
  const options = [];
  if (info.type) {
    options.push(info.type);
    const words = info.type.split(/\s+/);
    if (words.length > 1) options.push(...words);
  }
  if (info.category) options.push(info.category);
  [...new Set(options.map(o => o.toLowerCase()))]
    .filter(o => !already.includes(o))
    .forEach(o => {
      const b = document.createElement('button');
      b.className = 'ban-option';
      b.textContent = o;
      b.addEventListener('click', () => ban(o));
      box.appendChild(b);
    });

  const form = document.createElement('form');
  form.className = 'ban-own';
  form.innerHTML = '<input type="text" placeholder="or type any word"><button type="submit" class="ban-option">Ban</button><button type="button" class="link">Cancel</button>';
  form.addEventListener('submit', e => { e.preventDefault(); ban(form.querySelector('input').value); });
  form.querySelector('.link').addEventListener('click', () => { banMenuAsin = null; box.remove(); renderLeads(); renderListings(); });
  box.appendChild(form);
  return box;
}

function renderBanned() {
  const words = bannedWords();
  const bar = $('bannedBar');
  bar.hidden = !words.length;
  bar.innerHTML = '<span class="muted">Banned:</span>';
  words.forEach(w => {
    const chip = document.createElement('button');
    chip.className = 'banned-chip';
    chip.title = 'Un-ban';
    chip.textContent = w + ' ×';
    chip.addEventListener('click', () => setBanned(words.filter(x => x !== w)));
    bar.appendChild(chip);
  });
}

let toastT = null;
function toast(text, undo) {
  const t = $('toast');
  t.innerHTML = '';
  t.append(text);
  if (undo) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = 'Undo';
    b.addEventListener('click', () => { undo(); t.hidden = true; });
    t.append(' · ', b);
  }
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 6000);
}

// New leads = every lot that isn't banned by the current filters. Drops caught
// while scanning (NEW / PRICE DROP) go first, then everything else newest first.
// Filters apply live, so banning a word removes matching lots straight away.
function renderLeads() {
  const drops = new Map();
  leads.forEach(l => { if (!drops.has(l.asin)) drops.set(l.asin, l); });
  const onPages = new Map();
  Object.values(listings).flat().forEach(it => { if (!onPages.has(it.asin)) onPages.set(it.asin, it); });

  const items = [];
  drops.forEach((l, asin) => items.push({ ...l, ...(onPages.get(asin) || {}), reason: l.reason, oldPrice: l.oldPrice, foundAt: l.foundAt, drop: true }));
  onPages.forEach((it, asin) => { if (!drops.has(asin)) items.push(it); });
  const unseen = it => !dismissed[it.asin] || (it.drop && it.foundAt > dismissed[it.asin]);
  const shown = items.filter(it => passesFilters(it, settings) && unseen(it)).map(it => ({ ...it, matches: true }));
  const seenCount = items.filter(it => passesFilters(it, settings) && !unseen(it)).length;
  $('seenInfo').hidden = !seenCount;
  $('seenCount').textContent = seenCount;
  shown.sort((a, b) => (b.drop ? 1 : 0) - (a.drop ? 1 : 0) || (b.foundAt || b.firstSeen || 0) - (a.foundAt || a.firstSeen || 0));

  $('leadCount').textContent = shown.length;
  if (activeTab !== 'leads') return;
  const box = $('leads');
  box.innerHTML = '';
  if (!shown.length) {
    box.innerHTML = `<div class="empty">${items.length
      ? 'Nothing left here: every lot is banned or marked “seen it”.'
      : run && run.scanning
        ? 'Loading the pages…'
        : 'Press <b>Start scanning</b> to open the pages and start watching for new drops.'}</div>`;
    return;
  }
  shown.slice(0, 400).forEach(it => {
    const el = itemEl(it, { lead: !!it.drop });
    if (it.drop && freshAsins.has(it.asin + it.foundAt)) el.classList.add('fresh');
    box.appendChild(el);
  });
  freshAsins.clear();
}

function renderListings() {
  const map = new Map();
  Object.values(listings).flat().forEach(it => { if (!map.has(it.asin)) map.set(it.asin, it); });
  let items = [...map.values()].map(it => ({ ...it, matches: passesFilters(it, settings) }));
  $('listingCount').textContent = items.length;
  if (activeTab !== 'listings') return;

  const q = $('search').value.trim().toLowerCase();
  if (q) items = items.filter(it => it.title.toLowerCase().includes(q));
  if ($('onlyMatch').checked) items = items.filter(it => it.matches);

  // Type and category dropdowns list what's currently on the pages, with counts.
  items.forEach(it => { it.info = lotInfo(it, config); });
  const dropdown = (id, key, allLabel) => {
    const sel = $(id);
    const chosen = sel.value;
    const counts = {};
    items.forEach(it => { const v = it.info[key] || 'Other'; counts[v] = (counts[v] || 0) + 1; });
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${n})</option>`).join('');
    sel.value = chosen in counts ? chosen : '';
    return sel.value;
  };
  const type = dropdown('typeFilter', 'type', 'All types');
  if (type) items = items.filter(it => (it.info.type || 'Other') === type);
  const cat = dropdown('catFilter', 'category', 'All categories');
  if (cat) items = items.filter(it => (it.info.category || 'Other') === cat);

  const big = Number.MAX_VALUE;
  const sorters = {
    discount: (a, b) => (b.discount ?? -1) - (a.discount ?? -1),
    price: (a, b) => (a.price ?? big) - (b.price ?? big),
    ppu: (a, b) => (a.units && a.price ? a.price / a.units : big) - (b.units && b.price ? b.price / b.units : big),
    new: (a, b) => (b.firstSeen || 0) - (a.firstSeen || 0),
    page: (a, b) => a.page - b.page,
  };
  items.sort(sorters[$('sort').value]);

  const box = $('listings');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = `<div class="empty">${map.size ? 'Nothing matches.' : 'No listings yet. Start scanning to load the pages.'}</div>`;
    return;
  }
  items.slice(0, 400).forEach(it => box.appendChild(itemEl(it)));
}

function fillSettingsForm() {
  SETTING_KEYS.forEach(k => {
    const el = $(k);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k];
  });
  syncUrlBox();
}

// With auto-update on, the box shows the GitHub list read-only.
function syncUrlBox() {
  const auto = $('autoUrls').checked;
  const box = $('urls');
  if (auto) box.value = config.urls.join('\n');
  else if (!parseUrls(box.value).length) box.value = (parseUrls(settings.urls).length ? parseUrls(settings.urls) : config.urls).join('\n');
  box.disabled = auto;
}

function renderUpdateInfo() {
  const mine = chrome.runtime.getManifest().version;
  $('version').textContent = mine;
  // Give the Mac auto-updater 20 minutes before asking for a manual update.
  const since = outdatedSince && outdatedSince.version === config.latestExtensionVersion ? outdatedSince.at : Date.now();
  const outdated = newerVersion(config.latestExtensionVersion, mine) && Date.now() - since > 20 * 60 * 1000;
  $('updateBanner').hidden = !outdated;
  if (outdated) {
    $('latestVersion').textContent = config.latestExtensionVersion;
    $('updateLink').href = config.updateUrl || '#';
  }
  // Confirm a hands-free update for a few minutes after it lands.
  const fresh = justUpdated && Date.now() - justUpdated.at < 5 * 60 * 1000;
  $('updated').hidden = !fresh;
  if (fresh) $('updated').textContent = `✓ Updated automatically to version ${justUpdated.version} ${ago(justUpdated.at)}`;
  $('notice').hidden = !config.notice;
  $('notice').textContent = config.notice || '';
  $('configStatus').textContent = !configCheck
    ? 'not checked yet'
    : configCheck.ok
      ? 'checked GitHub ' + ago(configCheck.at)
      : `couldn't reach GitHub ${ago(configCheck.at)} (${configCheck.error}), using last saved settings`;
}

function updateTitle() {
  document.title = (unseenLeads ? `(${unseenLeads}) ` : '') + 'Liquidation Scanner';
}

// ---------- data loading ----------

async function load() {
  const l = await chrome.storage.local.get(['settings', 'leads']);
  const s = await chrome.storage.session.get(['run', 'listings']);
  settings = { ...DEFAULT_SETTINGS, ...(l.settings || {}) };
  config = await getConfig();
  ({ configCheck = null, outdatedSince = null, justUpdated = null, dismissed = {}, manifests = {} } =
    await chrome.storage.local.get(['configCheck', 'outdatedSince', 'justUpdated', 'dismissed', 'manifests']));
  leads = l.leads || [];
  run = s.run || null;
  listings = s.listings || {};
  fillSettingsForm();
  renderBanned();
  renderUpdateInfo();
  renderHeader();
  renderLeads();
  renderListings();
}

let listingsT = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'session' && ch.run) { run = ch.run.newValue || null; renderHeader(); }
  if (area === 'session' && ch.listings) {
    listings = ch.listings.newValue || {};
    // Most scans bring back exactly the same lots; only redraw when something changed.
    const sig = Object.keys(listings).sort().map(k => (listings[k] || [])
      .map(it => `${it.asin}:${it.price}:${it.unavailable ? 1 : 0}:${it.title.length}`).join(',')).join('|');
    if (sig === listingsSig) return;
    listingsSig = sig;
    clearTimeout(listingsT);
    listingsT = setTimeout(() => { if (!banMenuAsin) { renderListings(); renderLeads(); } }, 400);
  }
  if (area === 'local' && ch.leads) { leads = ch.leads.newValue || []; renderLeads(); }
  if (area === 'local' && ch.dismissed) { dismissed = ch.dismissed.newValue || {}; renderLeads(); renderListings(); }
  if (area === 'local' && ch.manifests) {
    // A manifest arrives every few seconds; patch just those listings instead of redrawing.
    const before = manifests;
    manifests = ch.manifests.newValue || {};
    Object.keys(manifests).filter(a => before[a] !== manifests[a] && JSON.stringify(before[a]) !== JSON.stringify(manifests[a]))
      .forEach(asin => document.querySelectorAll(`.item[data-asin="${asin}"] .manifest`)
        .forEach(old => old.replaceWith(manifestEl({ asin }))));
  }
  if (area === 'local' && ch.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) };
    if (document.activeElement !== $('exclude')) $('exclude').value = settings.exclude;
    renderBanned();
    renderHeader();
    renderLeads();
    renderListings();
  }
  if (area === 'local' && ch.configCheck) { configCheck = ch.configCheck.newValue || null; renderUpdateInfo(); }
  if (area === 'local' && ch.outdatedSince) { outdatedSince = ch.outdatedSince.newValue || null; renderUpdateInfo(); }
  if (area === 'local' && ch.remoteConfig) {
    getConfig().then(c => {
      config = c;
      if ($('autoUrls').checked) syncUrlBox();
      renderUpdateInfo();
      renderHeader();
    });
  }
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'leads') {
    msg.leads.forEach(l => freshAsins.add(l.asin + l.foundAt));
    beep();
    if (document.hidden) { unseenLeads += msg.leads.length; updateTitle(); }
  } else if (msg.type === 'captcha') {
    beep();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unseenLeads = 0; updateTitle(); send('clearBadge'); }
});

// ---------- controls ----------

$('toggle').addEventListener('click', async () => {
  // Creating the AudioContext inside a click lets alerts play later.
  try { audioCtx = audioCtx || new AudioContext(); audioCtx.resume(); } catch {}
  const btn = $('toggle');
  btn.disabled = true;
  const res = await send(run && run.scanning ? 'stop' : 'start');
  btn.disabled = false;
  if (res && !res.ok) alert(res.error);
});
$('resume').addEventListener('click', () => send('resume'));
$('showCaptcha').addEventListener('click', () => send('showCaptcha'));
$('showWindow').addEventListener('click', () => send('showWindow'));

$('bringBack').addEventListener('click', () => unsee(Object.keys(dismissed)));
$('clearLeads').addEventListener('click', async () => {
  await chrome.storage.local.remove('leads');
  send('clearBadge');
});
$('forgetSeen').addEventListener('click', async () => {
  if (!confirm('Forget every item seen so far? Price-drop history is cleared too.')) return;
  await chrome.storage.local.remove('seen');
});

document.querySelectorAll('.tabs button').forEach(b =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach(p => (p.hidden = p.id !== 'tab-' + b.dataset.tab));
    activeTab = b.dataset.tab;
    if (activeTab === 'listings') renderListings();
    if (activeTab === 'leads') renderLeads();
  }));

['search', 'sort', 'onlyMatch', 'typeFilter', 'catFilter'].forEach(id => $(id).addEventListener('input', renderListings));

$('autoUrls').addEventListener('change', syncUrlBox);
$('reloadExt').addEventListener('click', () => chrome.runtime.reload());
$('checkNow').addEventListener('click', async () => {
  $('configStatus').textContent = 'checking…';
  await send('checkUpdates');
});

$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  const next = { ...settings };
  SETTING_KEYS.forEach(k => {
    const el = $(k);
    if (!el) return;
    if (k === 'urls' && $('autoUrls').checked) return;
    if (el.type === 'checkbox') next[k] = el.checked;
    else if (el.type === 'number') next[k] = Math.max(0, parseFloat(el.value) || 0);
    else next[k] = el.value;
  });
  next.intervalSec = Math.max(1, next.intervalSec || 3);
  if (!next.autoUrls && !parseUrls(next.urls).length) { alert('Add at least one https://www.amazon.com/ URL.'); return; }
  await chrome.storage.local.set({ settings: next });
  $('saved').hidden = false;
  setTimeout(() => ($('saved').hidden = true), 1800);
});

setInterval(() => { renderHeader(); renderUpdateInfo(); }, 1000);
load();
