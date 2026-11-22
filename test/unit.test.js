const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/lib/languages.js");
const S = require("../src/lib/stats.js");
const T = require("../src/lib/tracker.js");

test("normalizeLang handles regional, deprecated and odd tags", () => {
  assert.equal(L.normalizeLang("en-US"), "en");
  assert.equal(L.normalizeLang("es_419"), "es");
  assert.equal(L.normalizeLang("a.ja"), "ja");
  assert.equal(L.normalizeLang("zh-Hant"), "zh");
  assert.equal(L.normalizeLang("iw"), "he");
  assert.equal(L.normalizeLang("ENG"), "en");
  assert.equal(L.normalizeLang("tl"), "fil");
  assert.equal(L.normalizeLang("und"), null);
  assert.equal(L.normalizeLang("zxx"), null);
  assert.equal(L.normalizeLang(""), null);
  assert.equal(L.normalizeLang("English"), null);
  assert.equal(L.normalizeLang(undefined), null);
});

test("formatDuration", () => {
  assert.equal(L.formatDuration(9), "9s");
  assert.equal(L.formatDuration(125), "2m 5s");
  assert.equal(L.formatDuration(3725), "1h 2m");
});

test("pickDetection prefers stronger sources", () => {
  const d = T.pickDetection([
    { lang: "en", source: "pageLang" },
    { lang: "es", source: "text" },
    { lang: "ja", source: "autoCaptions" },
  ]);
  assert.deepEqual([d.lang, d.source], ["ja", "autoCaptions"]);
  assert.equal(T.pickDetection([{ lang: "ja", source: "audioTrack" }, { lang: "fr", source: "override" }]).lang, "fr");
  assert.equal(T.pickDetection([]).lang, "und");
});

test("measureElapsed ignores seeks and sleep, counts wall time at 2x", () => {
  assert.equal(T.measureElapsed({ real: 0, media: 10 }, { real: 1000, media: 11 }, 1), 1);
  // seek forward 60s in one second -> at most 1s
  assert.equal(T.measureElapsed({ real: 0, media: 10 }, { real: 1000, media: 70 }, 1), 1);
  // computer slept for an hour, media advanced 1s
  assert.ok(Math.abs(T.measureElapsed({ real: 0, media: 10 }, { real: 3600e3, media: 11 }, 1) - 1.05) < 1e-9);
  // 2x playback: 2s of media in 1s real -> 1s
  assert.equal(T.measureElapsed({ real: 0, media: 10 }, { real: 1000, media: 12 }, 2), 1);
  // seek backward
  assert.equal(T.measureElapsed({ real: 0, media: 50 }, { real: 1000, media: 5 }, 1), 0);
  assert.equal(T.measureElapsed(undefined, { real: 1000, media: 5 }, 1), 0);
});

test("genericVideoKey drops tracking params and sorts the rest", () => {
  assert.equal(T.genericVideoKey("https://www.vimeo.com/12345/?utm_source=x&b=2&a=1&t=30"), "vimeo.com/12345?a=1&b=2");
  assert.equal(T.genericVideoKey("https://example.com/"), "example.com/");
});

test("cleanText strips links, hashtags and timestamps", () => {
  assert.equal(T.cleanText("Hola https://x.y/z #vlog @me 12:34 mundo"), "Hola mundo");
});

test("aggregate, videos and ranges", () => {
  const entries = [
    { k: "a", d: "2026-11-20", l: "es", s: 100, t: "A", h: "youtube.com", ts: 1 },
    { k: "a", d: "2026-11-22", l: "es", s: 50, t: "A2", h: "youtube.com", ts: 3 },
    { k: "b", d: "2026-11-22", l: "ja", s: 30, t: "B", h: "netflix.com", ts: 2 },
    { k: "b", d: "2026-11-22", l: "en", s: 10, t: "B", h: "netflix.com", ts: 2 },
  ];
  const today = S.aggregate(entries, S.rangeFor("today", "2026-11-22"));
  assert.equal(today.total, 90);
  assert.deepEqual(today.byLang, { es: 50, ja: 30, en: 10 });
  const all = S.aggregate(entries, S.rangeFor("all", "2026-11-22"));
  assert.equal(all.total, 190);
  assert.equal(all.bySite["youtube.com"], 150);
  const vids = S.videos(entries, null);
  assert.equal(vids[0].k, "a");
  assert.equal(vids[0].title, "A2");
  assert.equal(vids[1].primaryLang, "ja");
  assert.deepEqual(S.rangeFor("7d", "2026-11-22"), { from: "2026-11-16", to: "2026-11-22" });
  assert.equal(S.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(S.daysBetween("2026-02-27", "2026-03-02").length, 4);
});

test("colorSlots are stable and fold extras into other", () => {
  const slots = S.colorSlots({ en: 5, es: 10, und: 100, ja: 1 }, 2);
  assert.deepEqual(slots, { es: 0, en: 1, ja: -1, und: -1 });
});

test("sanitizeEntry rejects garbage", () => {
  assert.equal(S.sanitizeEntry({ k: "a", d: "bad", l: "en", s: 1 }), null);
  assert.equal(S.sanitizeEntry({ k: "a", d: "2026-01-01", l: "en", s: -1 }), null);
  assert.equal(S.sanitizeEntry({ k: "a", d: "2026-01-01", l: "en", s: 5 }).s, 5);
});

test("subtitle aggregation and filtering", () => {
  const entries = [
    { k: "a", d: "2026-11-22", l: "es", s: 100, c: 60, cl: { es: 40, en: 20 } },
    { k: "b", d: "2026-11-22", l: "ja", s: 50 },
  ];
  const agg = S.aggregate(entries, null);
  assert.equal(agg.subTotal, 60);
  assert.equal(agg.subSame, 40);
  assert.deepEqual(agg.subs.es, { s: 100, c: 60, cs: 40 });
  assert.equal(S.aggregate(S.filterSubs(entries, "without"), null).total, 90);
  assert.equal(S.aggregate(S.filterSubs(entries, "with"), null).total, 60);
  assert.equal(S.filterSubs(entries, "with").length, 1);
  const m = S.mergeEntries(entries[0], { ...entries[0], s: 10, c: 5, cl: { es: 5 }, ts: 9 });
  assert.deepEqual([m.s, m.c, m.cl.es, m.cl.en], [110, 65, 45, 20]);
});

test("sync summary round-trips and stays small", () => {
  const entries = [];
  const langs = ["es", "ja", "fr", "de", "ko", "en"];
  // Two years of daily viewing in six languages.
  for (let n = 0; n < 730; n++) {
    const d = S.addDays("2026-11-22", -n);
    for (const l of langs) entries.push({ k: `v${n}${l}`, d, l, s: 600 + n, c: 100, cl: { [l]: 50 } });
  }
  const { halves, archive } = S.buildSyncSummary(entries, "2026-11-22");
  for (const v of Object.values(halves)) assert.ok(JSON.stringify(v).length < 8000);
  assert.ok(JSON.stringify(archive).length < 8000);
  const totalBytes = JSON.stringify(halves).length + JSON.stringify(archive).length;
  assert.ok(totalBytes < 25000, `summary is ${totalBytes} bytes`);
  const rows = S.rowsFromSyncSummary(halves, archive, "dev1");
  const expected = entries.reduce((a, e) => a + e.s, 0);
  const got = rows.reduce((a, r) => a + r.s, 0);
  assert.ok(Math.abs(got - expected) < rows.length, `${got} vs ${expected}`);
  assert.equal(rows.reduce((a, r) => a + r.cs, 0), 50 * entries.length);
});

test("parseSync reads devices and their rows", () => {
  const { devices, rowsByDevice } = S.parseSync({
    "dev:abc": { name: "Laptop" },
    "h:abc:2026-11b": { "2026-11-20": { es: [100, 10, 5] } },
    "a:abc": { "2025-01": { ja: [50, 0, 0] } },
    "h:zzz:2026-11a": { "2026-11-02": { fr: [7, 0, 0] } },
    siteRules: { "x.com": "es" },
  });
  assert.equal(devices.abc.name, "Laptop");
  assert.ok(devices.zzz.name);
  assert.equal(rowsByDevice.abc.length, 2);
  assert.deepEqual(rowsByDevice.abc.find((r) => r.l === "ja").d, "2025-01-01");
});
