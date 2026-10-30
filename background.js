importScripts('shared.js');

const IDLE = { scanning: false, paused: null, windowId: null, ownWindow: false, groupId: null, homeWindowId: null, captchaTab: null, startedAt: 0, scans: 0, leads: 0, tabs: {} };
const MAX_SEEN = 20000;
const MAX_LEADS = 300;
const LOAD_TIMEOUT_MS = 25000;
const MANUAL_UPDATE_GRACE_MS = 20 * 60 * 1000;

let run = null;          // live scan state, mirrored to storage.session
let memP = null;         // { settings, config, seen, leads } from storage, plus listings
const timers = {};

// ---------- state loading / saving ----------

function mem() {
  if (!memP) {
    memP = (async () => {
      const d = await chrome.storage.local.get(['settings', 'seen', 'leads']);
      const l = await chrome.storage.session.get('listings');
      return {
        settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
        config: await getConfig(),
        seen: d.seen || {},
        leads: d.leads || [],
        listings: l.listings || {},
      };
    })();
  }
  return memP;
}

async function ensureRun() {
  if (run) return run;
  const d = await chrome.storage.session.get('run');
  run = d.run || { ...IDLE };
  if (run.scanning && !run.paused) {
    // Service worker was restarted: timers are gone, so kick every tab again.
    Object.keys(run.tabs).forEach((id, i) => scheduleNext(+id, 500 + i * 200));
  }
  return run;
}

let runSaveT = null;
function saveRun() {
  clearTimeout(runSaveT);
  runSaveT = setTimeout(() => chrome.storage.session.set({ run }), 300);
}

let memSaveT = null;
function saveMem() {
  clearTimeout(memSaveT);
  memSaveT = setTimeout(async () => {
    const m = await mem();
    const keys = Object.keys(m.seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => m.seen[a].t - m.seen[b].t);
      keys.slice(0, keys.length - MAX_SEEN).forEach(k => delete m.seen[k]);
    }
    await chrome.storage.local.set({ seen: m.seen, leads: m.leads });
    await chrome.storage.session.set({ listings: m.listings });
  }, 1000);
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !memP) return;
  const m = await mem();
  if (changes.settings) m.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  if (changes.remoteConfig) m.config = await getConfig();
  if (changes.settings || changes.remoteConfig) applyUrls();
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
      tabIds: Object.keys(run.tabs).map(Number),
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
  if (!run.scanning) return;
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

async function refreshTab(tabId) {
  await ensureRun();
  const t = run.tabs[tabId];
  if (!run.scanning || run.paused || !t) return;
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
  const base = Math.max(1, Number(s.intervalSec) || 3) * 1000;
  return Math.round(base * (0.9 + Math.random() * 0.2)); // small jitter so tabs don't sync up
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

  if (res) await handleScan(tabId, t, res);
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

  m.listings[t.idx] = res.items;
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
    found.slice(0, 5).forEach(l =>
      chrome.tabs.create({ url: l.url, active: false, ...(run.homeWindowId ? { windowId: run.homeWindowId } : {}) }).catch(() =>
        chrome.tabs.create({ url: l.url, active: false })));
  }
}

function onCaptcha(tabId) {
  const t = run.tabs[tabId];
  t.state = 'captcha';
  if (run.paused !== 'captcha') {
    run.paused = 'captcha';
    run.captchaTab = tabId;
    clearTimers();
    chrome.notifications.create(`captcha|${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon128.png', priority: 2,
      title: 'Amazon is asking for a CAPTCHA',
      message: 'Scanning is paused. Solve it in the scanner window and scanning resumes by itself.',
    });
    chrome.runtime.sendMessage({ type: 'captcha' }).catch(() => {});
    chrome.windows.update(run.windowId, { focused: true, state: 'normal' }).catch(() => {});
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
  saveRun();
}

function resume() {
  if (!run.scanning) return;
  run.paused = null;
  run.captchaTab = null;
  Object.keys(run.tabs).forEach((id, i) => scheduleNext(+id, 300 + i * 250));
  saveRun();
}

function dropTab(tabId) {
  clearTimeout(timers[tabId]);
  delete timers[tabId];
  if (!run || !run.tabs[tabId]) return;
  delete run.tabs[tabId];
  if (!Object.keys(run.tabs).length) stop(false);
  else saveRun();
}

async function start(homeWindowId) {
  await ensureRun();
  if (run.scanning) await stop(true);
  await refreshConfig();
  const m = await mem();
  const urls = effectiveUrls(m.settings, m.config);
  if (!urls.length) throw new Error('No amazon.com URLs in the page list.');

  m.listings = {};
  const ownWindow = m.settings.separateWindow || homeWindowId == null;
  run = { ...IDLE, scanning: true, ownWindow, homeWindowId, startedAt: Date.now(), tabs: {} };
  const track = (tab, i) => {
    run.tabs[tab.id] = newTabState(i, urls[i]);
    // Keep Chrome from discarding background scan tabs to save memory.
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    scheduleNext(tab.id, LOAD_TIMEOUT_MS);
  };

  if (ownWindow) {
    const win = await chrome.windows.create({ url: urls, focused: false });
    if (m.settings.minimized) chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
    run.windowId = win.id;
    win.tabs.forEach(track);
  } else {
    // Open the pages next to the dashboard, bundled into one "Scanner" tab group.
    run.windowId = homeWindowId;
    for (let i = 0; i < urls.length; i++) {
      track(await chrome.tabs.create({ windowId: homeWindowId, url: urls[i], active: false }), i);
    }
    try {
      run.groupId = await chrome.tabs.group({ tabIds: Object.keys(run.tabs).map(Number), createProperties: { windowId: homeWindowId } });
      await chrome.tabGroups.update(run.groupId, { title: 'Scanner', color: 'orange' });
    } catch {}
  }
  chrome.action.setBadgeText({ text: '' });
  saveRun();
  saveMem();
}

async function stop(closeWindow = true) {
  await ensureRun();
  clearTimers();
  const { windowId, ownWindow } = run;
  const tabIds = Object.keys(run.tabs).map(Number);
  run = { ...IDLE, scans: run.scans, leads: run.leads };
  await chrome.storage.session.set({ run });
  if (!closeWindow) return;
  if (ownWindow && windowId) await chrome.windows.remove(windowId).catch(() => {});
  else if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
}

// ---------- events ----------

// Scrape as soon as the HTML is parsed instead of waiting for every image to load.
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  ensureRun().then(() => { if (run.tabs[tabId]) onTabLoaded(tabId); });
});

chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId, error }) => {
  if (frameId !== 0 || error === 'net::ERR_ABORTED') return;
  ensureRun().then(async () => {
    const t = run.tabs[tabId];
    if (!run.scanning || !t) return;
    t.state = 'error';
    t.error = error;
    if (!run.paused) scheduleNext(tabId, await intervalMs());
    saveRun();
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  ensureRun().then(() => { if (run.tabs[tabId]) dropTab(tabId); });
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
  if (kind === 'lead') chrome.tabs.create({ url: `https://www.amazon.com/dp/${asin}` });
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
  else ensureRun().then(checkDiskVersion);
});

resumeAfterReload();
