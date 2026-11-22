/* Pure functions over stored watch entries. Used by background + pages + tests.
 *
 * An entry is one (video, day, language) bucket:
 *   { k: videoKey, d: "YYYY-MM-DD", l: lang, s: seconds,
 *     c: seconds of that with subtitles on, cl: {subtitleLang: seconds},
 *     t: title, u: url, h: site host, src: detection source, ts: last update ms }
 *
 * For totals across devices, entries are flattened to "rows":
 *   { d, l, s, c, cs (subtitle seconds where subtitle lang == audio lang), dev, h? }
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
    const result = { total: 0, byLang: {}, byDay: {}, bySite: {}, subs: {}, subTotal: 0, subSame: 0 };
    for (const e of entries) {
      if (!inRange(e.d, range)) continue;
      result.total += e.s;
      const c = e.c || 0;
      const cs = e.cs != null ? e.cs : sameLangSubs(e);
      const sub = result.subs[e.l] || (result.subs[e.l] = { s: 0, c: 0, cs: 0 });
      sub.s += e.s; sub.c += c; sub.cs += cs;
      result.subTotal += c; result.subSame += cs;
      result.byLang[e.l] = (result.byLang[e.l] || 0) + e.s;
      const day = result.byDay[e.d] || (result.byDay[e.d] = {});
      day[e.l] = (day[e.l] || 0) + e.s;
      if (e.h) result.bySite[e.h] = (result.bySite[e.h] || 0) + e.s;
    }
    return result;
  }

  /** Seconds of an entry watched with subtitles in the same language as the audio. */
  function sameLangSubs(e) {
    return (e.cl && e.cl[e.l]) || 0;
  }

  /** Combine two entries for the same (video, day, lang) bucket. */
  function mergeEntries(a, b) {
    const cl = { ...(a.cl || {}) };
    for (const [l, v] of Object.entries(b.cl || {})) cl[l] = (cl[l] || 0) + v;
    const newer = (b.ts || 0) >= (a.ts || 0) ? b : a;
    return { ...a, ...newer, l: a.l, s: a.s + b.s, c: (a.c || 0) + (b.c || 0), cl, ts: Math.max(a.ts || 0, b.ts || 0) };
  }

  /** Flatten detailed entries to rows (see header). */
  function rowsFromEntries(entries, dev) {
    return entries.map((e) => ({ d: e.d, l: e.l, s: e.s, c: e.c || 0, cs: sameLangSubs(e), h: e.h, dev }));
  }

  /**
   * Restrict rows/entries to "all" time, time "without" subtitles, or time
   * "with" subtitles. Returns new objects whose `s` is the filtered amount.
   */
  function filterSubs(items, mode) {
    if (!mode || mode === "all") return items;
    const out = [];
    for (const e of items) {
      const c = Math.min(e.c || 0, e.s);
      const cs = e.cs != null ? e.cs : sameLangSubs(e);
      const s = mode === "with" ? c : e.s - c;
      if (s > 0.01) out.push({ ...e, s, c: mode === "with" ? c : 0, cs: mode === "with" ? cs : 0 });
    }
    return out;
  }

  // ------------------------------------------------------------ sync

  /** Days kept at daily resolution in sync; older time is kept per month. */
  const SYNC_DAILY_DAYS = 92;

  /** Half-month bucket id for a day: "2026-11a" (1st-15th) or "2026-11b". */
  function halfMonth(day) {
    return day.slice(0, 7) + (Number(day.slice(8, 10)) <= 15 ? "a" : "b");
  }

  const r0 = (v) => Math.round(v || 0);

  /**
   * Compact per-device summary for storage.sync (100 KB total, 8 KB/item):
   *   halves:  { "2026-11a": { "2026-11-03": { es: [s, c, cs] } } }   recent days
   *   archive: { "2025-06": { es: [s, c, cs] } }                        older months
   */
  function buildSyncSummary(entries, today) {
    const cutoff = addDays(today, -SYNC_DAILY_DAYS);
    const halves = {};
    const archive = {};
    const add = (obj, lang, e) => {
      const v = obj[lang] || (obj[lang] = [0, 0, 0]);
      v[0] += e.s; v[1] += e.c || 0; v[2] += sameLangSubs(e);
    };
    for (const e of entries) {
      if (e.d >= cutoff) {
        const h = halves[halfMonth(e.d)] || (halves[halfMonth(e.d)] = {});
        add(h[e.d] || (h[e.d] = {}), e.l, e);
      } else {
        add(archive[e.d.slice(0, 7)] || (archive[e.d.slice(0, 7)] = {}), e.l, e);
      }
    }
    const round = (o) => { for (const l of Object.keys(o)) o[l] = o[l].map(r0); };
    for (const h of Object.values(halves)) for (const d of Object.values(h)) round(d);
    for (const m of Object.values(archive)) round(m);
    // Keep the archive under the per-item limit by folding the oldest months into years.
    const size = () => JSON.stringify(archive).length;
    while (size() > 7000) {
      const months = Object.keys(archive).filter((k) => k.length === 7).sort();
      if (!months.length) break;
      const m = months[0];
      const y = m.slice(0, 4);
      const target = archive[y] || (archive[y] = {});
      for (const [l, v] of Object.entries(archive[m])) {
        const t = target[l] || (target[l] = [0, 0, 0]);
        for (let i = 0; i < 3; i++) t[i] += v[i];
      }
      delete archive[m];
    }
    return { halves, archive };
  }

  /** Rows from a device's synced summary. Archived months/years are dated to their first day. */
  function rowsFromSyncSummary(halves, archive, dev) {
    const rows = [];
    const push = (d, langs) => {
      for (const [l, v] of Object.entries(langs || {})) {
        if (Array.isArray(v) && v[0] > 0) rows.push({ d, l, s: v[0], c: v[1] || 0, cs: v[2] || 0, dev });
      }
    };
    for (const h of Object.values(halves || {})) for (const [d, langs] of Object.entries(h || {})) push(d, langs);
    for (const [k, langs] of Object.entries(archive || {})) push(k.length === 4 ? `${k}-01-01` : `${k}-01`, langs);
    return rows;
  }

  /**
   * Parse everything in storage.sync into { devices: {id: {name, updated}}, rowsByDevice: {id: rows} }.
   * Key layout: dev:<id>  h:<id>:<half>  a:<id>
   */
  function parseSync(all) {
    const devices = {};
    const halves = {};
    const archives = {};
    for (const [key, val] of Object.entries(all || {})) {
      const m = key.match(/^(dev|h|a):([^:]+)(?::(.+))?$/);
      if (!m) continue;
      const [, kind, id, rest] = m;
      if (kind === "dev") devices[id] = val;
      else if (kind === "h") (halves[id] || (halves[id] = {}))[rest] = val;
      else archives[id] = val;
    }
    const rowsByDevice = {};
    for (const id of new Set([...Object.keys(halves), ...Object.keys(archives)])) {
      rowsByDevice[id] = rowsFromSyncSummary(halves[id], archives[id], id);
      if (!devices[id]) devices[id] = { name: `Device ${id.slice(0, 4)}` };
    }
    return { devices, rowsByDevice };
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
        v = { k: e.k, title: e.t, url: e.u, site: e.h, total: 0, sub: 0, langs: {}, last: 0 };
        map.set(e.k, v);
      }
      v.total += e.s;
      v.sub += e.c || 0;
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
      c: Math.min(s, Math.max(0, Number(e.c) || 0)),
      cl: sanitizeLangMap(e.cl, s),
      ts: Number.isFinite(Number(e.ts)) ? Number(e.ts) : 0,
    };
  }

  function sanitizeLangMap(m, max) {
    const out = {};
    if (!m || typeof m !== "object") return out;
    for (const [l, v] of Object.entries(m)) {
      const n = Number(v);
      if (/^[a-z]{2,3}$/.test(l) && Number.isFinite(n) && n > 0) out[l] = Math.min(n, max);
    }
    return out;
  }

  const api = {
    ENTRY_PREFIX,
    SYNC_DAILY_DAYS,
    sameLangSubs,
    mergeEntries,
    rowsFromEntries,
    filterSubs,
    halfMonth,
    buildSyncSummary,
    rowsFromSyncSummary,
    parseSync,
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
