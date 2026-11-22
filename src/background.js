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
    const day = dayKey();
    const id = Stats.entryId(rec.videoKey, day, lang);
    await serial(async () => {
      const cur = (await api.storage.local.get(id))[id];
      const entry = {
        k: rec.videoKey,
        d: day,
        l: lang,
        s: (cur ? cur.s : 0) + seconds,
        t: String(rec.title || (cur && cur.t) || "").slice(0, 300),
        u: String(rec.url || (cur && cur.u) || "").slice(0, 2000),
        h: String(rec.site || (cur && cur.h) || "").slice(0, 255),
        src: String(rec.source || ""),
        ts: Date.now(),
      };
      await api.storage.local.set({ [id]: entry });
    });
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
          ? { ...target, s: target.s + e.s, ts: Math.max(target.ts || 0, e.ts || 0) }
          : { ...e, l: lang, src: "override" };
        removals.push(key);
      }
      if (removals.length) {
        await api.storage.local.set(updates);
        await api.storage.local.remove(removals);
      }
    });
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
        updates[id] = existing ? { ...existing, s: Math.max(existing.s, e.s) } : e;
        added++;
      }
      await api.storage.local.set(updates);
    });
    return added;
  }

  async function deleteVideo(videoKey) {
    await serial(async () => {
      const all = await api.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => Stats.isEntryKey(k) && all[k] && all[k].k === videoKey);
      await api.storage.local.remove(keys);
    });
  }

  async function resetAll() {
    await serial(async () => {
      const all = await api.storage.local.get(null);
      await api.storage.local.remove(Object.keys(all).filter((k) => Stats.isEntryKey(k)));
      await api.storage.local.remove("overrides");
    });
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
      case "resetAll":
        return resetAll().then(() => true);
      default:
        return undefined;
    }
  });
})();
