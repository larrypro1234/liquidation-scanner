importScripts('shared.js');

const IDLE = { scanning: false, paused: null, windowId: null, ownWindow: false, groupId: null, homeWindowId: null, captchaTab: null, manifestTab: null, startedAt: 0, scans: 0, leads: 0, tabs: {} };
const MAX_SEEN = 20000;
const MAX_LEADS = 300;
const LOAD_TIMEOUT_MS = 25000;
const MANUAL_UPDATE_GRACE_MS = 20 * 60 * 1000;

let run = null;          // live scan state, mirrored to storage.session
let memP = null;         // { settings, config, seen, leads, manifests } from storage, plus listings
const timers = {};

// ---------- state loading / saving ----------

function mem() {
  if (!memP) {
    memP = (async () => {
      const d = await chrome.storage.local.get(['settings', 'seen', 'leads', 'manifests']);
      const l = await chrome.storage.session.get('listings');
      return {
        settings: slowDownOnce({ ...DEFAULT_SETTINGS, ...(d.settings || {}) }),
        config: await getConfig(),
        seen: d.seen || {},
        leads: d.leads || [],
        manifests: d.manifests || {},
        listings: l.listings || {},
      };
    })();
  }
  return memP;
}

// One-time move to the 20 s default, after Amazon blocked faster scanning.
function slowDownOnce(s) {
  if (s.slowedDown2) return s;
  const next = { ...s, slowedDown: true, slowedDown2: true, intervalSec: Math.max(20, Number(s.intervalSec) || 20) };
  chrome.storage.local.set({ settings: next });
  return next;
}

// ---------- lighter scan tabs ----------
// The scanner only reads the page HTML, so scan tabs skip images, scripts, fonts
// and embedded frames. That's most of the CPU and bandwidth of an Amazon page.
// Lifted while a CAPTCHA is up so its picture shows. The manifest tab is left alone.
const BLOCK_RULE_ID = 1;

async function applyBlocking() {
  const { config } = await mem();
  const types = (config.performance && config.performance.blockTypes) || [];
  const tabIds = run && run.scanning && run.paused !== 'captcha' ? Object.keys(run.tabs).map(Number) : [];
  const addRules = types.length && tabIds.length
    ? [{ id: BLOCK_RULE_ID, priority: 1, action: { type: 'block' }, condition: { tabIds, resourceTypes: types } }]
    : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [BLOCK_RULE_ID], addRules }).catch(() => {});
}

async function ensureRun() {
  if (run) return run;
  const d = await chrome.storage.session.get('run');
  run = d.run || { ...IDLE };
  if (run.scanning && !run.paused) {
    // Service worker was restarted: timers are gone, so kick every tab again.
    Object.keys(run.tabs).forEach((id, i) => scheduleNext(+id, 500 + i * 200));
    scheduleManifest(3000);
    applyBlocking();
  }
  return run;
}

// Saves are throttled, not debounced: with 20 tabs a scan lands every ~150ms,
// so waiting for a quiet gap would mean almost never saving.
let runSaveT = null;
function saveRun() {
  if (runSaveT) return;
  runSaveT = setTimeout(() => { runSaveT = null; chrome.storage.session.set({ run }); }, 300);
}

let memSaveT = null;
function saveMem() {
  if (memSaveT) return;
  memSaveT = setTimeout(async () => {
    memSaveT = null;
    const m = await mem();
    const keys = Object.keys(m.seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => m.seen[a].t - m.seen[b].t);
      keys.slice(0, keys.length - MAX_SEEN).forEach(k => delete m.seen[k]);
    }
    await chrome.storage.local.set({ seen: m.seen, leads: m.leads, manifests: m.manifests });
    await chrome.storage.session.set({ listings: m.listings });
  }, 1000);
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !memP) return;
  const m = await mem();
  if (changes.settings) m.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  if (changes.remoteConfig) m.config = await getConfig();
  if (changes.settings || changes.remoteConfig) applyUrls();
  if (changes.remoteConfig) applyBlocking();
  // The dashboard can clear these.
  if (changes.leads && !changes.leads.newValue) m.leads = [];
  if (changes.seen && !changes.seen.newValue) m.seen = {};
});

// ---------- updates from GitHub ----------

async function refreshConfig() {
  try {
    const r = await fetch(`${REMOTE_CONFIG_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    const remote = await r.json();
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) throw new Error('config.json is not an object');
    await chrome.storage.local.set({ remoteConfig: remote, configCheck: { at: Date.now(), ok: true } });
    notifyIfOutdated(remote);
    return { ok: true };
  } catch (e) {
    const error = String((e && e.message) || e);
    await chrome.storage.local.set({ configCheck: { at: Date.now(), ok: false, error } });
    return { ok: false, error };
  }
}

// Only nag about a manual update once the Mac auto-updater has had time to install it.
async function notifyIfOutdated(remote) {
  const latest = remote.latestExtensionVersion;
  if (!newerVersion(latest, chrome.runtime.getManifest().version)) return;
  let { outdatedSince, notifiedVersion } = await chrome.storage.local.get(['outdatedSince', 'notifiedVersion']);
  if (!outdatedSince || outdatedSince.version !== latest) {
    outdatedSince = { version: latest, at: Date.now() };
    await chrome.storage.local.set({ outdatedSince });
  }
  if (Date.now() - outdatedSince.at < MANUAL_UPDATE_GRACE_MS) return;
  if (notifiedVersion === latest) return;
  await chrome.storage.local.set({ notifiedVersion: latest });
  chrome.notifications.create(`update|${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 1,
    title: 'Scanner update available',
    message: `Version ${latest} has new features. Open the dashboard to update.`,
  });
}

// ---------- self-update from disk ----------
// The Mac auto-updater (install-mac.sh) swaps in new files on disk. When the
// manifest there is newer than the running code, reload to pick it up and
// put the dashboard and any running scan back the way they were.

async function checkDiskVersion() {
  let version;
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    version = (await r.json()).version;
  } catch {
    return;
  }
  if (!newerVersion(version, chrome.runtime.getManifest().version)) return;

  await ensureRun();
  const [dash] = await chrome.tabs.query({ url: chrome.runtime.getURL('dashboard.html') });
  await chrome.storage.local.set({
    resumeAfterReload: {
      scanning: run.scanning,
      homeWindowId: run.homeWindowId,
      ownWindow: run.ownWindow,
      windowId: run.windowId,
      tabIds: Object.keys(run.tabs).map(Number).concat(run.manifestTab != null ? [run.manifestTab] : []),
      dashboard: dash ? { windowId: dash.windowId, index: dash.index, active: dash.active } : null,
    },
  });
  chrome.runtime.reload();
}

async function resumeAfterReload() {
  const { resumeAfterReload: r } = await chrome.storage.local.get('resumeAfterReload');
  if (!r) return;
  await chrome.storage.local.remove('resumeAfterReload');
  await chrome.storage.local.set({ justUpdated: { version: chrome.runtime.getManifest().version, at: Date.now() } });

  // Extension pages close on reload, so reopen the dashboard where it was.
  let homeWindowId = r.homeWindowId;
  if (r.dashboard) {
    const url = chrome.runtime.getURL('dashboard.html');
    const tab = await chrome.tabs
      .create({ url, windowId: r.dashboard.windowId, index: r.dashboard.index, active: r.dashboard.active })
      .catch(() => chrome.tabs.create({ url }));
    if (homeWindowId == null || homeWindowId === r.dashboard.windowId) homeWindowId = tab.windowId;
  }
  if (!r.scanning) return;

  // The old scan tabs survive the reload but nothing drives them any more.
  if (r.ownWindow && r.windowId) await chrome.windows.remove(r.windowId).catch(() => {});
  else if (r.tabIds.length) await chrome.tabs.remove(r.tabIds).catch(() => {});
  const win = homeWindowId != null && (await chrome.windows.get(homeWindowId).catch(() => null));
  await start(win ? homeWindowId : undefined);
}

// Brings the scan window in line with the current page list: retargets
// existing tabs, opens extra ones or closes the leftovers.
async function applyUrls() {
  await ensureRun();
  // While start() is still opening tabs the set is half built; it reads the
  // latest settings itself, so there's nothing to reconcile yet.
  if (!run.scanning || starting) return;
  const m = await mem();
  const urls = effectiveUrls(m.settings, m.config);
  const tabs = Object.entries(run.tabs).sort((a, b) => a[1].idx - b[1].idx);
  if (tabs.length === urls.length && tabs.every(([, t], i) => t.url === urls[i])) return;

  m.listings = {};
  tabs.forEach(([id, t], i) => {
    if (i >= urls.length) {
      delete run.tabs[id];
      clearTimeout(timers[id]);
      chrome.tabs.remove(+id).catch(() => {});
      return;
    }
    t.idx = i;
    if (t.url !== urls[i]) {
      Object.assign(t, newTabState(i, urls[i]));
      scheduleNext(+id, 200 + i * 150);
    }
  });
  for (let i = tabs.length; i < urls.length; i++) {
    const tab = await chrome.tabs.create({ windowId: run.windowId, url: urls[i], active: false });
    run.tabs[tab.id] = newTabState(i, urls[i]);
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    if (run.groupId != null) chrome.tabs.group({ groupId: run.groupId, tabIds: tab.id }).catch(() => {});
    scheduleNext(tab.id, LOAD_TIMEOUT_MS);
  }
  applyBlocking();
  saveRun();
  saveMem();
}

function newTabState(idx, url) {
  return { idx, url, state: 'loading', count: 0, lastScan: 0, scans: 0, baselined: false };
}

// ---------- scan loop ----------

function scheduleNext(tabId, delay) {
  clearTimeout(timers[tabId]);
  timers[tabId] = setTimeout(() => refreshTab(tabId), delay);
}

function clearTimers() {
  for (const id in timers) { clearTimeout(timers[id]); delete timers[id]; }
}

// Hard cap on how fast we hit Amazon in total: every page load (scan tabs and
// the manifest tab together) waits for its own slot, at least minGapMs apart.
let nextSlotAt = 0;
async function waitForSlot() {
  const { config } = await mem();
  const gap = (config.performance && config.performance.minGapMs) || 1200;
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + gap;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}

async function refreshTab(tabId, force = false) {
  await ensureRun();
  if (!run.scanning || !run.tabs[tabId] || (run.paused && !force)) return;
  await waitForSlot();
  const t = run.tabs[tabId];
  if (!run.scanning || !t || (run.paused && !force)) return;
  t.state = 'loading';
  t.requestedAt = Date.now();
  // Watchdog: if the page never finishes loading, try again.
  scheduleNext(tabId, LOAD_TIMEOUT_MS);
  try {
    await chrome.tabs.update(tabId, { url: t.url });
  } catch {
    dropTab(tabId);
  }
  saveRun();
}

async function intervalMs() {
  const s = (await mem()).settings;
  const base = Math.max(1, Number(s.intervalSec) || 5) * 1000;
  // Backed off after Amazon rate-limited us: x2 per step, at most 60 s.
  const slowed = Math.min(MAX_BACKOFF_MS, base * 2 ** (run.backoff || 0));
  return Math.round(Math.max(base, slowed) * (0.9 + Math.random() * 0.2)); // jitter so tabs don't sync up
}

// ---------- backing off when Amazon rate-limits ----------
// Each block (see enterCooldown) also doubles the refresh interval, up to 60 s;
// 5 calm minutes take it back down a step.

const MAX_BACKOFF_MS = 60000;
const CALM_STEP_DOWN_MS = 5 * 60000;
const MANIFEST_PAUSE_MS = 3 * 60000;
const RESTART_MEMORY_MS = 30 * 60000;  // a restart within this long keeps the slower speed

// Amazon's dog page means it's limiting the whole connection, and every request
// while blocked can keep the block going. So stop everything (10 min, then 20,
// 40, up to 60 if it keeps happening), then check with a single page before
// restarting, one speed step slower.
const COOLDOWN_FIRST_MS = 10 * 60000;
const COOLDOWN_MAX_MS = 60 * 60000;
const COOLDOWN_FORGET_MS = 2 * 60 * 60000; // older blocks don't lengthen the next wait
const PROBE_RETRY_MS = 60000;

async function enterCooldown() {
  if (run.paused === 'cooldown') return;
  run.paused = 'cooldown';
  clearTimers();
  clearTimeout(manifestTimer);
  manifestAsin = null;
  const now = Date.now();
  const { lastThrottle } = await chrome.storage.local.get('lastThrottle');
  const recent = lastThrottle && now - lastThrottle.at < COOLDOWN_FORGET_MS ? lastThrottle.cooldowns || 0 : 0;
  run.cooldowns = Math.max(run.cooldowns || 0, recent) + 1;
  const wait = Math.min(COOLDOWN_MAX_MS, COOLDOWN_FIRST_MS * 2 ** (run.cooldowns - 1));
  run.cooldownUntil = now + wait;
  run.backoff = Math.min(4, (run.backoff || 0) + 1);
  run.calmSince = now;
  run.probeTab = null;
  Object.values(run.tabs).forEach(t => { if (t.state === 'loading') t.state = 'throttled'; });
  chrome.alarms.create('cooldown', { when: run.cooldownUntil });
  chrome.storage.local.set({ lastThrottle: { level: run.backoff, cooldowns: run.cooldowns, cooldownUntil: run.cooldownUntil, at: now } });
  chrome.notifications.create(`cooldown|${now}`, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 2,
    title: 'Amazon blocked the connection for now',
    message: `The scanner stopped all requests for ${Math.round(wait / 60000)} minutes so the block can clear. It restarts by itself.`,
  });
  saveRun();
}

async function maybeEndCooldown() {
  if (!run || !run.scanning) return;
  const now = Date.now();
  const due = (run.paused === 'cooldown' && now >= run.cooldownUntil) ||
    (run.paused === 'probe' && now - (run.probeAt || 0) > PROBE_RETRY_MS);
  if (!due) return;
  const first = Object.entries(run.tabs).sort((a, b) => a[1].idx - b[1].idx)[0];
  if (!first) return;
  run.paused = 'probe';
  run.probeTab = +first[0];
  run.probeAt = now;
  saveRun();
  refreshTab(run.probeTab, true);
}

function noteCalm() {
  if (!run.backoff) return;
  const now = Date.now();
  if (now - (run.calmSince || now) >= CALM_STEP_DOWN_MS) {
    run.backoff--;
    run.calmSince = now;
    chrome.storage.local.set({ lastThrottle: { level: run.backoff, at: now } });
    saveRun();
  }
}

async function onTabLoaded(tabId) {
  await ensureRun();
  const t = run.tabs[tabId];
  if (!run.scanning || !t) return;

  let res = null;
  try {
    const { config } = await mem();
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapePage, args: [config.rules] });
    res = r && r.result;
    t.error = null;
  } catch (e) {
    t.error = String((e && e.message) || e);
  }

  if (res && res.captcha) return onCaptcha(tabId);

  if (run.paused === 'captcha' && run.captchaTab === tabId) resume();

  if (res && res.throttled) {
    // Keep this page's last good listings and rest until Amazon lets us back in.
    t.state = 'throttled';
    await enterCooldown();
    return;
  }

  if (run.paused === 'probe' && tabId === run.probeTab && res) {
    // The test page came through: restart everything (slower), manifests a bit later.
    run.probeTab = null;
    run.manifestPausedUntil = Date.now() + MANIFEST_PAUSE_MS;
    resume();
  }

  if (res) await handleScan(tabId, t, res);
  if (res && res.items.length) noteCalm();
  t.state = t.error ? 'error' : 'ok';
  if (!run.paused) scheduleNext(tabId, await intervalMs());
  saveRun();
}

async function handleScan(tabId, t, res) {
  const m = await mem();
  const s = m.settings;
  const now = Date.now();
  const found = [];

  for (const it of res.items) {
    it.page = t.idx + 1;
    Object.assign(it, lotInfo(it, m.config));
    it.matches = passesFilters(it, s);
    const prev = m.seen[it.asin];
    if (!prev) {
      m.seen[it.asin] = { t: now, p: it.price, lo: it.price };
      it.firstSeen = now;
      if (t.baselined && it.matches) found.push({ ...it, reason: 'new', foundAt: now });
    } else {
      it.firstSeen = prev.t;
      if (it.price != null) {
        const lo = prev.lo != null ? prev.lo : prev.p;
        if (s.priceDrops && t.baselined && it.matches && lo != null && it.price < lo - 0.009) {
          found.push({ ...it, reason: 'price-drop', oldPrice: lo, foundAt: now });
        }
        prev.p = it.price;
        prev.lo = lo == null ? it.price : Math.min(lo, it.price);
      }
    }
  }

  // A page that suddenly comes back empty is far more likely a hiccup than a
  // sold-out page, so keep what it showed last time.
  if (res.items.length || !(m.listings[t.idx] || []).length) m.listings[t.idx] = res.items;
  t.count = res.items.length;
  t.lastScan = now;
  t.scans = (t.scans || 0) + 1;
  // The first good scan of each page in a session just records what's already there.
  if (res.items.length) t.baselined = true;
  run.scans++;

  if (found.length) {
    run.leads += found.length;
    m.leads = found.concat(m.leads).slice(0, MAX_LEADS);
    announce(found, s);
  }
  saveMem();
}

// Open an Amazon page in a normal (not private) window, i.e. on the real
// logged-in account, preferring the dashboard's window.
async function openForBuying(url, active = true) {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const normal = wins.filter(w => !w.incognito);
  const target = normal.find(w => run && w.id === run.homeWindowId) || normal[0];
  if (target) return chrome.tabs.create({ url, active, windowId: target.id });
  return chrome.windows.create({ url, focused: active });
}

function announce(found, s) {
  chrome.runtime.sendMessage({ type: 'leads', leads: found }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  chrome.action.setBadgeText({ text: String(Math.min(999, run.leads)) });

  if (s.notify) {
    found.slice(0, 3).forEach(l => {
      const bits = [];
      if (l.type) bits.push(l.type);
      if (l.price != null) bits.push('$' + l.price.toFixed(2));
      if (l.discount != null) bits.push(l.discount + '% off retail');
      if (l.reason === 'price-drop') bits.push('was $' + l.oldPrice.toFixed(2));
      bits.push('page ' + l.page);
      chrome.notifications.create(`lead|${l.asin}|${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: l.reason === 'price-drop' ? 'Price drop' : 'New liquidation lead',
        message: l.title.slice(0, 200),
        contextMessage: bits.join(' · '),
        priority: 2,
      });
    });
    if (found.length > 3) {
      chrome.notifications.create(`more|${Date.now()}`, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: `+${found.length - 3} more leads`, message: 'Open the scanner dashboard to see them all.', priority: 1,
      });
    }
  }
  if (s.autoOpen) {
    found.slice(0, 5).forEach(l => openForBuying(l.url, false).catch(() => {}));
  }
}

function onCaptcha(tabId) {
  const t = run.tabs[tabId];
  if (t) t.state = 'captcha';
  if (run.paused !== 'captcha') {
    run.paused = 'captcha';
    run.captchaTab = tabId;
    clearTimers();
    clearTimeout(manifestTimer);
    chrome.notifications.create(`captcha|${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon128.png', priority: 2,
      title: 'Amazon is asking for a CAPTCHA',
      message: 'Scanning is paused. Solve it in the scanner window and scanning resumes by itself.',
    });
    chrome.runtime.sendMessage({ type: 'captcha' }).catch(() => {});
    chrome.windows.update(run.windowId, { focused: true, state: 'normal' }).catch(() => {});
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    // Let the CAPTCHA picture load, then show it again.
    applyBlocking().then(() => chrome.tabs.reload(tabId).catch(() => {}));
  }
  saveRun();
}

function resume() {
  if (!run.scanning) return;
  run.paused = null;
  run.captchaTab = null;
  run.probeTab = null;
  Object.keys(run.tabs).forEach((id, i) => scheduleNext(+id, 300 + i * 250));
  scheduleManifest(2000);
  applyBlocking();
  saveRun();
}

// ---------- lot manifests ----------
// One extra tab walks through lot pages (/dp/ASIN) and reads each "Lot Manifest"
// table once. New drops go first, then the rest in page order. Banned lots and
// lots marked "Seen it" are never read.

let manifestTimer = null;
let manifestAsin = null;     // lot the manifest tab is loading right now
const manifestFails = {};    // asin -> failed attempts this session

function scheduleManifest(delay, fn = nextManifest) {
  clearTimeout(manifestTimer);
  manifestTimer = setTimeout(fn, delay);
}

async function pickManifestAsin() {
  const m = await mem();
  const { dismissed = {} } = await chrome.storage.local.get('dismissed');
  const onPages = Object.keys(m.listings).sort((a, b) => a - b).flatMap(k => m.listings[k]);
  // Skip lots marked "Seen it", unless they've dropped in price since.
  const seen = it => dismissed[it.asin] && !(it.foundAt > dismissed[it.asin]);
  const want = it => !m.manifests[it.asin] && (manifestFails[it.asin] || 0) < 2 && passesFilters(it, m.settings) && !seen(it);
  const pick = m.leads.find(want) || onPages.find(want);
  return pick ? pick.asin : null;
}

async function nextManifest() {
  await ensureRun();
  if (!run.scanning || run.paused || run.manifestTab == null) return;
  const wait = (run.manifestPausedUntil || 0) - Date.now();
  if (wait > 0) return scheduleManifest(wait + 1000);
  const asin = await pickManifestAsin();
  if (!asin) return scheduleManifest(10000);
  await waitForSlot();
  if (!run.scanning || run.paused || run.manifestTab == null) return;
  manifestAsin = asin;
  // Watchdog: a lot page that never loads counts as a failed attempt.
  scheduleManifest(LOAD_TIMEOUT_MS + 10000, () => {
    manifestFails[asin] = (manifestFails[asin] || 0) + 1;
    nextManifest();
  });
  try {
    await chrome.tabs.update(run.manifestTab, { url: `https://www.amazon.com/dp/${asin}` });
  } catch {
    run.manifestTab = null;
    saveRun();
  }
}

async function onManifestLoaded(tabId) {
  if (!run.scanning) return;
  const asin = manifestAsin;
  if (!asin) return scheduleManifest(2000);
  const m = await mem();
  let res = null;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeManifest, args: [m.config.rules] });
    res = r && r.result;
  } catch {}
  if (res && res.captcha) return onCaptcha(tabId);
  if (run.paused === 'captcha' && run.captchaTab === tabId) resume();
  if (res && res.throttled) {
    manifestAsin = null;
    return enterCooldown();
  }

  if (res && (res.found || res.heading === false)) {
    m.manifests[asin] = { ...res, at: Date.now() };
    saveMem();
  } else {
    manifestFails[asin] = (manifestFails[asin] || 0) + 1;
  }
  manifestAsin = null;
  const delay = (m.config.rules.manifest && m.config.rules.manifest.delayMs) || 2500;
  if (!run.paused) scheduleManifest(delay);
}

function dropTab(tabId) {
  clearTimeout(timers[tabId]);
  delete timers[tabId];
  if (!run || !run.tabs[tabId]) return;
  delete run.tabs[tabId];
  if (!Object.keys(run.tabs).length) stop(false);
  else saveRun();
}

let starting = false;

async function start(homeWindowId) {
  if (starting) return;
  starting = true;
  try {
    await startScan(homeWindowId);
  } finally {
    starting = false;
  }
}

async function startScan(homeWindowId) {
  await ensureRun();
  if (run.scanning) await stop(true);
  await refreshConfig();
  const m = await mem();
  const urls = effectiveUrls(m.settings, m.config);
  if (!urls.length) throw new Error('No amazon.com URLs in the page list.');

  m.listings = {};
  // Scanning from a private window keeps all that traffic off the Amazon account
  // you buy with; the dashboard and every lot link stay in the normal window.
  const privateScan = !!m.settings.privateScan && (await chrome.extension.isAllowedIncognitoAccess());
  const ownWindow = privateScan || m.settings.separateWindow || homeWindowId == null;
  run = { ...IDLE, scanning: true, ownWindow, privateScan, homeWindowId, startedAt: Date.now(), tabs: {} };
  // If Amazon pushed back recently, start at that slower speed instead of full speed.
  const { lastThrottle } = await chrome.storage.local.get('lastThrottle');
  if (lastThrottle && lastThrottle.level && Date.now() - lastThrottle.at < RESTART_MEMORY_MS) {
    run.backoff = lastThrottle.level;
    run.calmSince = Date.now();
    run.manifestPausedUntil = Date.now() + MANIFEST_PAUSE_MS;
  }
  // Still inside a cooldown: open the tabs empty and wait it out before touching Amazon.
  const cooling = !!(lastThrottle && lastThrottle.cooldownUntil > Date.now());
  if (cooling) {
    run.paused = 'cooldown';
    run.cooldownUntil = lastThrottle.cooldownUntil;
    run.cooldowns = lastThrottle.cooldowns || 1;
    chrome.alarms.create('cooldown', { when: run.cooldownUntil });
  }
  const openUrl = i => (cooling ? 'about:blank' : urls[i]);
  // Open the pages one by one, spread over one refresh interval, not all at once.
  const stagger = cooling ? 0 : Math.min(1500, Math.max(250, Math.round((await intervalMs()) / urls.length)));
  const pause = () => new Promise(r => setTimeout(r, stagger));
  const track = (tab, i) => {
    run.tabs[tab.id] = newTabState(i, urls[i]);
    // Keep Chrome from discarding background scan tabs to save memory.
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    scheduleNext(tab.id, LOAD_TIMEOUT_MS);
  };

  if (ownWindow) {
    const win = await chrome.windows.create({ url: openUrl(0), focused: false, incognito: privateScan });
    if (m.settings.minimized) chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
    run.windowId = win.id;
    track(win.tabs[0], 0);
    for (let i = 1; i < urls.length; i++) {
      await pause();
      track(await chrome.tabs.create({ windowId: win.id, url: openUrl(i), active: false }), i);
    }
    run.manifestTab = (await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false })).id;
    if (privateScan) {
      try {
        run.groupId = await chrome.tabs.group({ tabIds: Object.keys(run.tabs).map(Number).concat(run.manifestTab), createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(run.groupId, { title: 'Scanner', color: 'orange' });
      } catch {}
    }
  } else {
    // Open the pages next to the dashboard, bundled into one "Scanner" tab group.
    run.windowId = homeWindowId;
    for (let i = 0; i < urls.length; i++) {
      if (i) await pause();
      track(await chrome.tabs.create({ windowId: homeWindowId, url: openUrl(i), active: false }), i);
    }
    run.manifestTab = (await chrome.tabs.create({ windowId: homeWindowId, url: 'about:blank', active: false })).id;
    try {
      run.groupId = await chrome.tabs.group({ tabIds: Object.keys(run.tabs).map(Number).concat(run.manifestTab), createProperties: { windowId: homeWindowId } });
      await chrome.tabGroups.update(run.groupId, { title: 'Scanner', color: 'orange' });
    } catch {}
  }
  chrome.tabs.update(run.manifestTab, { autoDiscardable: false }).catch(() => {});
  scheduleManifest(8000); // let the first scans land so there's something to look up
  applyBlocking();
  chrome.action.setBadgeText({ text: '' });
  saveRun();
  saveMem();
}

async function stop(closeWindow = true) {
  await ensureRun();
  clearTimers();
  clearTimeout(manifestTimer);
  chrome.alarms.clear('cooldown');
  manifestAsin = null;
  const { windowId, ownWindow, manifestTab } = run;
  const tabIds = Object.keys(run.tabs).map(Number).concat(manifestTab != null ? [manifestTab] : []);
  run = { ...IDLE, scans: run.scans, leads: run.leads };
  await chrome.storage.session.set({ run });
  await applyBlocking();
  if (!closeWindow) return;
  if (ownWindow && windowId) await chrome.windows.remove(windowId).catch(() => {});
  else if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
}

// ---------- events ----------

// Scrape as soon as the HTML is parsed instead of waiting for every image to load.
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId, url }) => {
  // Empty placeholder tabs (about:blank while resting) aren't scans.
  if (frameId !== 0 || !/^https:/.test(url)) return;
  ensureRun().then(() => {
    if (run.tabs[tabId]) onTabLoaded(tabId);
    else if (run.scanning && tabId === run.manifestTab) onManifestLoaded(tabId);
  });
});

chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId, error }) => {
  if (frameId !== 0 || error === 'net::ERR_ABORTED') return;
  ensureRun().then(async () => {
    if (run.scanning && tabId === run.manifestTab && manifestAsin) {
      manifestFails[manifestAsin] = (manifestFails[manifestAsin] || 0) + 1;
      manifestAsin = null;
      if (!run.paused) scheduleManifest(5000);
      return;
    }
    const t = run.tabs[tabId];
    if (!run.scanning || !t) return;
    t.state = 'error';
    t.error = error;
    if (!run.paused) scheduleNext(tabId, await intervalMs());
    saveRun();
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  ensureRun().then(() => {
    if (run.tabs[tabId]) dropTab(tabId);
    else if (tabId === run.manifestTab) { run.manifestTab = null; clearTimeout(manifestTimer); saveRun(); }
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  ensureRun().then(() => { if (run.scanning && run.windowId === windowId) stop(false); });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ensureRun();
    if (msg.type === 'start') await start(sender.tab && sender.tab.windowId);
    else if (msg.type === 'stop') await stop(true);
    else if (msg.type === 'resume') resume();
    else if (msg.type === 'showCaptcha' && run.captchaTab) {
      await chrome.windows.update(run.windowId, { focused: true, state: 'normal' });
      await chrome.tabs.update(run.captchaTab, { active: true });
    } else if (msg.type === 'showWindow' && run.windowId) {
      await chrome.windows.update(run.windowId, { focused: true, state: 'normal' });
      const first = Object.entries(run.tabs).sort((a, b) => a[1].idx - b[1].idx)[0];
      if (!run.ownWindow && first) await chrome.tabs.update(+first[0], { active: true });
    } else if (msg.type === 'checkUpdates') {
      return refreshConfig();
    } else if (msg.type === 'clearBadge') {
      chrome.action.setBadgeText({ text: '' });
    }
    return { ok: true };
  })().then(reply, e => reply({ ok: false, error: String(e.message || e) }));
  return true;
});

chrome.notifications.onClicked.addListener(id => {
  const [kind, asin] = id.split('|');
  if (kind === 'lead') ensureRun().then(() => openForBuying(`https://www.amazon.com/dp/${asin}`));
  else if (kind === 'captcha') {
    ensureRun().then(() => {
      if (!run.captchaTab) return;
      chrome.windows.update(run.windowId, { focused: true, state: 'normal' });
      chrome.tabs.update(run.captchaTab, { active: true });
    });
  } else openDashboard();
  chrome.notifications.clear(id);
});

async function openDashboard() {
  const url = chrome.runtime.getURL('dashboard.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(openDashboard);

chrome.runtime.onInstalled.addListener(details => {
  refreshConfig();
  if (details.reason === 'install') openDashboard();
});
chrome.runtime.onStartup.addListener(refreshConfig);

// keepalive wakes the service worker so a long scan survives worker restarts;
// config checks GitHub for new page links, parsing rules and versions.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.get('config').then(a => {
  if (!a) chrome.alarms.create('config', { delayInMinutes: 0.1, periodInMinutes: CONFIG_CHECK_MINUTES });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'config') refreshConfig();
  else if (alarm.name === 'cooldown') ensureRun().then(maybeEndCooldown);
  else ensureRun().then(() => { checkDiskVersion(); maybeEndCooldown(); });
});

resumeAfterReload();
