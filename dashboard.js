const $ = id => document.getElementById(id);
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

let settings = { ...DEFAULT_SETTINGS };
let config = { urls: [], rules: {} };
let configCheck = null;
let outdatedSince = null;
let run = null;
let leads = [];
let listings = {};
let freshAsins = new Set();
let audioCtx = null;
let unseenLeads = 0;

// ---------- helpers ----------

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
    const label = t.state === 'captcha' ? 'CAPTCHA' : t.state === 'error' ? 'error' : `${t.count} items`;
    d.innerHTML = `<b>Page ${t.idx + 1}</b><span>${label}</span><br><span>${ago(t.lastScan)}</span>`;
    pages.appendChild(d);
  });
}

function itemEl(it, { lead = false } = {}) {
  const el = $('itemTpl').content.firstElementChild.cloneNode(true);
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
  if (it.discount != null) tag(`${it.discount}% off retail`, 'off');
  if (it.units) tag(`${it.units} units` + (it.price ? ` · ${fmt$(it.price / it.units)}/unit` : ''));
  tag('Page ' + it.page);
  if (it.sponsored) tag('Sponsored');
  if (it.unavailable) tag('Unavailable');
  tag(lead ? 'found ' + ago(it.foundAt) : 'first seen ' + ago(it.firstSeen));

  el.querySelector('.price').textContent = fmt$(it.price);
  const r = el.querySelector('.retail');
  if (lead && it.reason === 'price-drop') r.innerHTML = `was <s>${fmt$(it.oldPrice)}</s>`;
  else if (it.retail) r.innerHTML = `retail <s>${fmt$(it.retail)}</s>`;

  const hot = settings.minDiscount > 0 ? it.discount >= settings.minDiscount : it.discount >= 70;
  if (hot) el.classList.add('hot');
  if (!lead && !it.matches) el.classList.add('nomatch');
  return el;
}

function renderLeads() {
  $('leadCount').textContent = leads.length;
  const box = $('leads');
  box.innerHTML = '';
  if (!leads.length) {
    box.innerHTML = `<div class="empty">${run && run.scanning
      ? 'Watching for new drops… leads show up here the moment they appear.'
      : 'Press <b>Start scanning</b> to open the pages and start watching for new drops.'}</div>`;
    return;
  }
  leads.slice(0, 150).forEach(l => {
    const el = itemEl(l, { lead: true });
    if (freshAsins.has(l.asin + l.foundAt)) el.classList.add('fresh');
    box.appendChild(el);
  });
  freshAsins.clear();
}

function renderListings() {
  const map = new Map();
  Object.values(listings).flat().forEach(it => { if (!map.has(it.asin)) map.set(it.asin, it); });
  let items = [...map.values()].map(it => ({ ...it, matches: passesFilters(it, settings) }));
  $('listingCount').textContent = items.length;

  const q = $('search').value.trim().toLowerCase();
  if (q) items = items.filter(it => it.title.toLowerCase().includes(q));
  if ($('onlyMatch').checked) items = items.filter(it => it.matches);

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
  ({ configCheck = null, outdatedSince = null } = await chrome.storage.local.get(['configCheck', 'outdatedSince']));
  leads = l.leads || [];
  run = s.run || null;
  listings = s.listings || {};
  fillSettingsForm();
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
    // Don't re-render the big list while the user is scrolling through it every second.
    clearTimeout(listingsT);
    listingsT = setTimeout(renderListings, 400);
  }
  if (area === 'local' && ch.leads) { leads = ch.leads.newValue || []; renderLeads(); }
  if (area === 'local' && ch.settings) { settings = { ...DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) }; renderHeader(); }
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
    if (b.dataset.tab === 'listings') renderListings();
  }));

['search', 'sort', 'onlyMatch'].forEach(id => $(id).addEventListener('input', renderListings));

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
