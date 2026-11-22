/* Background script: owns storage writes, language detection on text, the
 * per-tab "now playing" status and the toolbar badge. */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const { normalizeLang, dayKey, UNKNOWN } = globalThis.LW;
  const Stats = globalThis.LWStats;

  // ------------------------------------------------- serialized storage

  // All writes go through one queue so concurrent tabs can't clobber each other.
  let queue = Promise.resolve();
  function serial(fn) {
    const p = queue.then(fn);
    queue = p.catch((e) => console.error("Lingua Watch:", e));
    return p;
  }

  const MAX_SECONDS_PER_RECORD = 120; // content scripts flush every ~5s; reject nonsense

  async function addRecord(rec) {
    const seconds = Math.min(Number(rec.seconds) || 0, MAX_SECONDS_PER_RECORD);
    if (!(seconds > 0) || typeof rec.videoKey !== "string" || !rec.videoKey) return;
    const lang = normalizeLang(rec.lang) || UNKNOWN;
    const subSeconds = Math.min(seconds, Math.max(0, Number(rec.subSeconds) || 0));
    const subLangs = {};
    for (const [l, v] of Object.entries(rec.subLangs && typeof rec.subLangs === "object" ? rec.subLangs : {})) {
      const code = l === UNKNOWN ? UNKNOWN : normalizeLang(l);
      const n = Math.min(seconds, Number(v) || 0);
      if (code && n > 0) subLangs[code] = (subLangs[code] || 0) + n;
    }
    const day = dayKey();
    const id = Stats.entryId(rec.videoKey, day, lang);
    await serial(async () => {
      const cur = (await api.storage.local.get(id))[id];
      const entry = {
        k: rec.videoKey,
        d: day,
        l: lang,
        s: (cur ? cur.s : 0) + seconds,
        c: (cur && cur.c ? cur.c : 0) + subSeconds,
        cl: mergeLangMaps(cur && cur.cl, subLangs),
        t: String(rec.title || (cur && cur.t) || "").slice(0, 300),
        u: String(rec.url || (cur && cur.u) || "").slice(0, 2000),
        h: String(rec.site || (cur && cur.h) || "").slice(0, 255),
        src: String(rec.source || ""),
        ts: Date.now(),
      };
      await api.storage.local.set({ [id]: entry });
    });
    syncDirty = true;
  }

  function mergeLangMaps(a, b) {
    const out = { ...(a || {}) };
    for (const [l, v] of Object.entries(b || {})) out[l] = (out[l] || 0) + v;
    return out;
  }

  /** Move every stored second of one video to another language. */
  async function reassignVideo(videoKey, lang) {
    await serial(async () => {
      const all = await api.storage.local.get(null);
      const updates = {};
      const removals = [];
      for (const [key, e] of Object.entries(all)) {
        if (!Stats.isEntryKey(key) || !e || e.k !== videoKey || e.l === lang) continue;
        const newId = Stats.entryId(e.k, e.d, lang);
        const target = updates[newId] || all[newId];
        updates[newId] = target
          ? Stats.mergeEntries(target, e)
          : { ...e, l: lang, src: "override" };
        removals.push(key);
      }
      if (removals.length) {
        await api.storage.local.set(updates);
        await api.storage.local.remove(removals);
      }
    });
    syncDirty = true;
  }

  async function setOverride(videoKey, lang) {
    await serial(async () => {
      const { overrides = {} } = await api.storage.local.get("overrides");
      if (lang) overrides[videoKey] = lang;
      else delete overrides[videoKey];
      await api.storage.local.set({ overrides });
    });
    if (lang) await reassignVideo(videoKey, lang);
  }

  async function setSiteRule(site, lang) {
    await serial(async () => {
      const { siteRules = {} } = await api.storage.local.get("siteRules");
      if (lang) siteRules[site] = lang;
      else delete siteRules[site];
      await api.storage.local.set({ siteRules });
    });
  }

  async function importEntries(entries) {
    let added = 0;
    await serial(async () => {
      const all = await api.storage.local.get(null);
      const updates = {};
      for (const raw of entries || []) {
        const e = Stats.sanitizeEntry(raw);
        if (!e) continue;
        const id = Stats.entryId(e.k, e.d, e.l);
        const existing = updates[id] || all[id];
        // Merge by taking the larger value so importing the same backup twice is harmless.
        updates[id] = existing && existing.s >= e.s ? existing : e;
        added++;
      }
      await api.storage.local.set(updates);
    });
    syncDirty = true;
    return added;
  }

  async function deleteVideo(videoKey) {
    await serial(async () => {
      const all = await api.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => Stats.isEntryKey(k) && all[k] && all[k].k === videoKey);
      await api.storage.local.remove(keys);
    });
    syncDirty = true;
  }

  async function resetAll() {
    await serial(async () => {
      const all = await api.storage.local.get(null);
      await api.storage.local.remove(Object.keys(all).filter((k) => Stats.isEntryKey(k)));
      await api.storage.local.remove("overrides");
    });
    syncDirty = true;
    await publish();
  }

  // ------------------------------------------------------------------ sync
  //
  // storage.sync (Firefox Sync) is small: 100 KB total, 8 KB per item. So each
  // device keeps its full per-video history locally and publishes only a compact
  // per-day, per-language summary (see LWStats.buildSyncSummary). Every device
  // reads the others' summaries to show combined totals.

  const sync = api.storage.sync;
  const PUBLISH_EVERY_MS = 60 * 1000;
  let syncDirty = true;
  let deviceId = null;
  const syncStatus = { lastPublish: 0, error: null };

  async function getDeviceId() {
    if (deviceId) return deviceId;
    const r = await api.storage.local.get("deviceId");
    if (r.deviceId) return (deviceId = r.deviceId);
    deviceId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await api.storage.local.set({ deviceId });
    return deviceId;
  }

  async function defaultDeviceName() {
    const info = await api.runtime.getPlatformInfo().catch(() => ({}));
    const os = { win: "Windows", mac: "Mac", linux: "Linux", android: "Android", cros: "ChromeOS" }[info.os];
    return os ? `${os} computer` : "This computer";
  }

  async function publish() {
    if (!sync) return;
    syncDirty = false;
    try {
      await serial(async () => {
        const id = await getDeviceId();
        const entries = Stats.entriesFromStorage(await api.storage.local.get(null));
        const { halves, archive } = Stats.buildSyncSummary(entries, dayKey());
        const want = {};
        for (const [h, v] of Object.entries(halves)) want[`h:${id}:${h}`] = v;
        if (Object.keys(archive).length) want[`a:${id}`] = archive;

        const existing = await sync.get(null);
        const devKey = `dev:${id}`;
        const updates = {};
        for (const [k, v] of Object.entries(want)) {
          if (JSON.stringify(existing[k]) !== JSON.stringify(v)) updates[k] = v;
        }
        const stale = Object.keys(existing).filter((k) =>
          (k.startsWith(`h:${id}:`) || k === `a:${id}`) && !(k in want));
        if (Object.keys(updates).length || stale.length || !existing[devKey]) {
          const dev = existing[devKey] || { name: await defaultDeviceName() };
          updates[devKey] = { ...dev, updated: Date.now() };
          if (stale.length) await sync.remove(stale);
          await sync.set(updates);
        }
      });
      syncStatus.lastPublish = Date.now();
      syncStatus.error = null;
    } catch (e) {
      syncDirty = true;
      syncStatus.error = String((e && e.message) || e);
    }
  }

  async function renameDevice(name) {
    const id = await getDeviceId();
    const key = `dev:${id}`;
    const cur = (await sync.get(key))[key] || {};
    await sync.set({ [key]: { ...cur, name: String(name || "").trim().slice(0, 60) || (await defaultDeviceName()), updated: Date.now() } });
  }

  async function removeDevice(id) {
    if (!id || id === (await getDeviceId())) return;
    const all = await sync.get(null);
    await sync.remove(Object.keys(all).filter((k) => k === `dev:${id}` || k === `a:${id}` || k.startsWith(`h:${id}:`)));
  }

  // Site rules are small, so they sync too. Sync is the source of truth on startup.
  const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
  async function initSiteRuleSync() {
    if (!sync) return;
    const [{ siteRules: remote }, { siteRules: local }] = await Promise.all([sync.get("siteRules"), api.storage.local.get("siteRules")]);
    if (remote && !same(remote, local)) await api.storage.local.set({ siteRules: remote });
    else if (!remote && local) await sync.set({ siteRules: local });
  }
  api.storage.onChanged.addListener(async (changes, area) => {
    if (!changes.siteRules || !sync) return;
    const value = changes.siteRules.newValue || {};
    try {
      if (area === "local" && !same(value, (await sync.get("siteRules")).siteRules)) await sync.set({ siteRules: value });
      if (area === "sync" && !same(value, (await api.storage.local.get("siteRules")).siteRules)) await api.storage.local.set({ siteRules: value });
    } catch (e) {
      syncStatus.error = String((e && e.message) || e);
    }
  });

  if (sync) {
    initSiteRuleSync().catch(() => {});
    publish();
    setInterval(() => { if (syncDirty) publish(); }, PUBLISH_EVERY_MS);
  }

  // ------------------------------------------------------- text detection

  async function detectText(text) {
    if (!api.i18n || !api.i18n.detectLanguage) return null;
    const r = await api.i18n.detectLanguage(String(text).slice(0, 3000));
    const top = r && r.languages && r.languages[0];
    const lang = top && normalizeLang(top.language);
    if (!lang) return null;
    return { lang, reliable: !!r.isReliable, percentage: top.percentage || 0 };
  }

  // ----------------------------------------------------- tab status/badge

  const tabStatus = new Map(); // tabId -> Map(frameId -> status)

  function bestStatus(tabId) {
    const frames = tabStatus.get(tabId);
    if (!frames) return null;
    let best = null;
    for (const s of frames.values()) {
      if (!best || (s.playing && !best.playing) || (s.playing === best.playing && s.at > best.at)) best = s;
    }
    return best;
  }

  function updateBadge(tabId) {
    const s = bestStatus(tabId);
    const text = s && s.playing ? (s.lang === UNKNOWN ? "?" : s.lang.toUpperCase()) : "";
    api.browserAction.setBadgeText({ tabId, text }).catch(() => {});
    api.browserAction.setBadgeBackgroundColor({ tabId, color: s && s.lang === UNKNOWN ? "#898781" : "#2a78d6" }).catch(() => {});
  }

  api.tabs.onRemoved.addListener((tabId) => tabStatus.delete(tabId));
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" && change.url) {
      tabStatus.delete(tabId);
      updateBadge(tabId);
    }
  });

  // ------------------------------------------------------------- messages

  api.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== "string") return undefined;
    switch (msg.type) {
      case "record":
        return addRecord(msg.record || {});
      case "detectText":
        return detectText(msg.text || "").catch(() => null);
      case "status": {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) return undefined;
        if (!tabStatus.has(tabId)) tabStatus.set(tabId, new Map());
        tabStatus.get(tabId).set(sender.frameId || 0, { ...msg.status, at: Date.now() });
        updateBadge(tabId);
        return Promise.resolve(true);
      }
      case "getTabStatus":
        return Promise.resolve(bestStatus(msg.tabId));
      case "setOverride":
        return setOverride(msg.videoKey, normalizeLang(msg.lang)).then(() => true);
      case "setSiteRule":
        return setSiteRule(msg.site, normalizeLang(msg.lang)).then(() => true);
      case "reassignVideo": {
        const lang = normalizeLang(msg.lang);
        if (lang) return setOverride(msg.videoKey, lang).then(() => true);
        // "Unknown": forget the manual choice and move the time back to unknown.
        return setOverride(msg.videoKey, null).then(() => reassignVideo(msg.videoKey, UNKNOWN)).then(() => true);
      }
      case "deleteVideo":
        return deleteVideo(msg.videoKey).then(() => true);
      case "importEntries":
        return importEntries(msg.entries);
      case "getSyncInfo":
        return getDeviceId().then((id) => ({ deviceId: id, available: !!sync, ...syncStatus }));
      case "syncNow":
        return publish().then(() => ({ ...syncStatus }));
      case "renameDevice":
        return renameDevice(msg.name).then(() => true);
      case "removeDevice":
        return removeDevice(msg.deviceId).then(() => true);
      case "resetAll":
        return resetAll().then(() => true);
      default:
        return undefined;
    }
  });
})();
