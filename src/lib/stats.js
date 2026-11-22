/* Pure functions over stored watch entries. Used by background + pages + tests.
 *
 * An entry is one (video, day, language) bucket:
 *   { k: videoKey, d: "YYYY-MM-DD", l: lang, s: seconds,
 *     t: title, u: url, h: site host, src: detection source, ts: last update ms }
 * Stored in storage.local under ENTRY_PREFIX + entryId(k, d, l).
 */
(function (root) {
  "use strict";

  const ENTRY_PREFIX = "e:";

  function entryId(videoKey, day, lang) {
    return `${ENTRY_PREFIX}${day}|${lang}|${videoKey}`;
  }

  function isEntryKey(key) {
    return typeof key === "string" && key.startsWith(ENTRY_PREFIX);
  }

  /** Extract entries from a storage.local.get(null) result. */
  function entriesFromStorage(all) {
    const out = [];
    for (const key of Object.keys(all || {})) {
      if (isEntryKey(key) && all[key] && typeof all[key].s === "number") out.push(all[key]);
    }
    return out;
  }

  function addDays(day, n) {
    const [y, m, d] = day.split("-").map(Number);
    const date = new Date(y, m - 1, d + n);
    const yy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  /** Preset -> inclusive {from, to} day range. null bounds mean open-ended. */
  function rangeFor(preset, today) {
    switch (preset) {
      case "today": return { from: today, to: today };
      case "7d": return { from: addDays(today, -6), to: today };
      case "30d": return { from: addDays(today, -29), to: today };
      case "90d": return { from: addDays(today, -89), to: today };
      case "365d": return { from: addDays(today, -364), to: today };
      default: return { from: null, to: null };
    }
  }

  function inRange(day, range) {
    if (!range) return true;
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    return true;
  }

  /**
   * Totals for a range.
   * Returns { total, byLang: {lang: s}, byDay: {day: {lang: s}}, bySite: {site: s} }.
   */
  function aggregate(entries, range) {
    const result = { total: 0, byLang: {}, byDay: {}, bySite: {} };
    for (const e of entries) {
      if (!inRange(e.d, range)) continue;
      result.total += e.s;
      result.byLang[e.l] = (result.byLang[e.l] || 0) + e.s;
      const day = result.byDay[e.d] || (result.byDay[e.d] = {});
      day[e.l] = (day[e.l] || 0) + e.s;
      if (e.h) result.bySite[e.h] = (result.bySite[e.h] || 0) + e.s;
    }
    return result;
  }

  /** Sorted [lang, seconds] pairs, largest first. */
  function sortedLangs(byLang) {
    return Object.entries(byLang).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  /**
   * One row per video watched in range, most recent first.
   * { k, title, url, site, total, langs: {lang: s}, primaryLang, last }
   */
  function videos(entries, range) {
    const map = new Map();
    for (const e of entries) {
      if (!inRange(e.d, range)) continue;
      let v = map.get(e.k);
      if (!v) {
        v = { k: e.k, title: e.t, url: e.u, site: e.h, total: 0, langs: {}, last: 0 };
        map.set(e.k, v);
      }
      v.total += e.s;
      v.langs[e.l] = (v.langs[e.l] || 0) + e.s;
      if ((e.ts || 0) >= v.last) {
        v.last = e.ts || 0;
        if (e.t) v.title = e.t;
        if (e.u) v.url = e.u;
      }
    }
    const list = [...map.values()];
    for (const v of list) v.primaryLang = sortedLangs(v.langs)[0][0];
    return list.sort((a, b) => b.last - a.last);
  }

  /**
   * Stable language -> color slot assignment based on all-time totals, so that
   * changing the date range never repaints a language. Slots 0..max-1; the rest
   * fold into "other" (returned as -1).
   */
  function colorSlots(allTimeByLang, max) {
    const slots = {};
    sortedLangs(allTimeByLang)
      .filter(([lang]) => lang !== "und")
      .forEach(([lang], i) => { slots[lang] = i < max ? i : -1; });
    slots.und = -1;
    return slots;
  }

  /** Every day between from and to inclusive. */
  function daysBetween(from, to) {
    const out = [];
    let d = from;
    let guard = 0;
    while (d <= to && guard++ < 4000) {
      out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }

  /** Validate + normalise an imported entry. Returns null if unusable. */
  function sanitizeEntry(e) {
    if (!e || typeof e !== "object") return null;
    if (typeof e.k !== "string" || !e.k) return null;
    if (typeof e.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.d)) return null;
    if (typeof e.l !== "string" || !/^[a-z]{2,3}$/.test(e.l)) return null;
    const s = Number(e.s);
    if (!Number.isFinite(s) || s <= 0) return null;
    return {
      k: e.k, d: e.d, l: e.l, s,
      t: typeof e.t === "string" ? e.t.slice(0, 500) : "",
      u: typeof e.u === "string" ? e.u.slice(0, 2000) : "",
      h: typeof e.h === "string" ? e.h.slice(0, 255) : "",
      src: typeof e.src === "string" ? e.src.slice(0, 50) : "",
      ts: Number.isFinite(Number(e.ts)) ? Number(e.ts) : 0,
    };
  }

  const api = {
    ENTRY_PREFIX,
    entryId,
    isEntryKey,
    entriesFromStorage,
    addDays,
    rangeFor,
    inRange,
    aggregate,
    sortedLangs,
    videos,
    colorSlots,
    daysBetween,
    sanitizeEntry,
  };

  root.LWStats = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
