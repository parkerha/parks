(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const { languageName, formatDuration, dayKey, normalizeLang, DEFAULT_SETTINGS } = LW;
  const S = LWStats;
  const { el, langSelect, langList, colorFor, SERIES_COUNT } = LWUI;
  const SVG = "http://www.w3.org/2000/svg";

  let range = "30d";
  let videoFilter = "";
  let videoLimit = 100;
  let state = null; // { all, entries, slots }

  // --------------------------------------------------------------- render

  async function load() {
    const all = await api.storage.local.get(null);
    const entries = S.entriesFromStorage(all);
    const slots = S.colorSlots(S.aggregate(entries, null).byLang, SERIES_COUNT);
    state = { all, entries, slots };
    render();
  }

  function currentRange() {
    const today = dayKey();
    const r = S.rangeFor(range, today);
    if (!r.from) {
      const first = state.entries.reduce((min, e) => (e.d < min ? e.d : min), today);
      return { from: first, to: today };
    }
    return r;
  }

  function render() {
    const { entries, slots } = state;
    const r = currentRange();
    const agg = S.aggregate(entries, r);
    const vids = S.videos(entries, r);
    const sorted = S.sortedLangs(agg.byLang);
    const nDays = S.daysBetween(r.from, r.to).length;

    for (const b of document.querySelectorAll("#range button")) b.setAttribute("aria-pressed", String(b.dataset.range === range));
    document.getElementById("t-total").textContent = formatDuration(agg.total);
    document.getElementById("t-langs").textContent = String(sorted.filter(([l]) => l !== "und").length);
    document.getElementById("t-videos").textContent = String(vids.length);
    document.getElementById("t-avg").textContent = formatDuration(agg.total / Math.max(1, nDays));

    document.getElementById("langs").replaceChildren(langList(sorted, agg.total, slots));
    renderChart(agg, r, slots);
    renderVideos(vids, sorted);
    renderRules();
    renderSettings();
  }

  // ---------------------------------------------------------------- chart

  function bucketsFor(r) {
    const days = S.daysBetween(r.from, r.to);
    if (days.length <= 45) return days.map((d) => ({ key: d, days: [d], label: shortDate(d) }));
    const byKey = new Map();
    const monthly = days.length > 200;
    for (const d of days) {
      const key = monthly ? d.slice(0, 7) : weekStart(d);
      if (!byKey.has(key)) {
        byKey.set(key, { key, days: [], label: monthly ? monthLabel(key) : `Week of ${shortDate(key)}` });
      }
      byKey.get(key).days.push(d);
    }
    return [...byKey.values()];
  }

  function weekStart(day) {
    const [y, m, d] = day.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const offset = (dt.getDay() + 6) % 7; // Monday
    return S.addDays(day, -offset);
  }

  function shortDate(day) {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function monthLabel(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  /** Series = languages holding a color slot (in slot order) + "Other". */
  function seriesFor(agg, slots) {
    const series = Object.keys(agg.byLang)
      .filter((l) => slots[l] >= 0)
      .sort((a, b) => slots[a] - slots[b])
      .map((l) => ({ id: l, name: languageName(l), color: colorFor(slots[l]) }));
    if (Object.keys(agg.byLang).some((l) => !(slots[l] >= 0))) {
      series.push({ id: "__other", name: "Other / unknown", color: colorFor(-1) });
    }
    return series;
  }

  function niceStep(max) {
    // Candidate steps in seconds.
    const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 432000, 864000];
    for (const s of steps) if (max / s <= 5) return s;
    return steps[steps.length - 1];
  }

  function tickLabel(secs) {
    if (secs === 0) return "0";
    if (secs < 3600) return `${Math.round(secs / 60)}m`;
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function renderChart(agg, r, slots) {
    const chart = document.getElementById("chart");
    const legend = document.getElementById("legend");
    const tableBox = document.getElementById("chart-table");
    const series = seriesFor(agg, slots);
    const buckets = bucketsFor(r);

    // values[bucket][seriesId]
    const values = buckets.map((b) => {
      const v = {};
      for (const d of b.days) {
        for (const [lang, secs] of Object.entries(agg.byDay[d] || {})) {
          const id = slots[lang] >= 0 ? lang : "__other";
          v[id] = (v[id] || 0) + secs;
        }
      }
      return v;
    });
    const totals = values.map((v) => Object.values(v).reduce((a, b) => a + b, 0));

    legend.replaceChildren(...(series.length >= 2 ? series.map((s) =>
      el("span", {}, [el("span", { class: "key", style: `background:${s.color}` }), s.name])) : []));

    if (!agg.total) {
      chart.replaceChildren(el("p", { class: "empty", text: "Nothing watched in this period yet." }));
      tableBox.replaceChildren();
      return;
    }

    const W = 640, H = 240, padL = 40, padR = 8, padT = 8, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxTotal = Math.max(...totals, 60);
    const step = niceStep(maxTotal);
    const yMax = Math.ceil(maxTotal / step) * step;
    const y = (secs) => padT + plotH - (secs / yMax) * plotH;
    const slotW = plotW / buckets.length;
    const barW = Math.max(2, Math.min(28, slotW - 2)); // >= 2px gap between bars

    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Watch time per period, stacked by language");
    const node = (tag, attrs, parent) => {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      (parent || svg).append(n);
      return n;
    };

    const grid = node("g", { class: "grid" });
    for (let t = 0; t <= yMax; t += step) {
      if (t > 0) node("line", { x1: padL, x2: W - padR, y1: y(t), y2: y(t) }, grid);
      const label = node("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end" });
      label.textContent = tickLabel(t);
    }
    node("line", { class: "axis-line", x1: padL, x2: W - padR, y1: y(0), y2: y(0) });

    // X labels: at most ~8, evenly spaced.
    const every = Math.max(1, Math.ceil(buckets.length / 8));
    buckets.forEach((b, i) => {
      if (i % every !== 0) return;
      const t = node("text", { x: padL + slotW * i + slotW / 2, y: H - 8, "text-anchor": "middle" });
      t.textContent = b.label.replace(/^Week of /, "");
    });

    const defs = node("defs", {});
    buckets.forEach((b, i) => {
      const x = padL + slotW * i + (slotW - barW) / 2;
      const col = node("g", { class: "col", tabindex: "0", "aria-label": `${b.label}: ${formatDuration(totals[i])}` });
      // Hit target covers the whole slot height, bigger than the mark.
      node("rect", { class: "hit", x: padL + slotW * i, y: padT, width: slotW, height: plotH, rx: 3 }, col);
      if (totals[i] > 0) {
        const clipId = `c${i}`;
        const clip = node("clipPath", { id: clipId }, defs);
        // Round only the data end (top); the bottom of the clip extends below the baseline.
        node("rect", { x, y: y(totals[i]), width: barW, height: y(0) - y(totals[i]) + 6, rx: Math.min(4, barW / 2) }, clip);
        const g = node("g", { "clip-path": `url(#${clipId})` }, col);
        let acc = 0;
        for (const s of series) {
          const v = values[i][s.id] || 0;
          if (!v) continue;
          const top = y(acc + v);
          const bottom = y(acc);
          acc += v;
          // 2px surface gap between stacked segments (taken from the bottom of each upper segment).
          const gap = acc - v > 0 ? 2 : 0;
          const h = Math.max(0, bottom - top - gap);
          if (h <= 0) continue;
          node("rect", { class: "seg", x, y: top, width: barW, height: h, fill: s.color }, g);
        }
      }
      const show = (ev) => showTooltip(ev, b.label, series, values[i], totals[i], col);
      col.addEventListener("pointermove", show);
      col.addEventListener("focus", show);
      col.addEventListener("pointerleave", hideTooltip);
      col.addEventListener("blur", hideTooltip);
    });

    chart.replaceChildren(svg);
    renderChartTable(buckets, series, values, totals, tableBox);
  }

  function showTooltip(ev, label, series, v, total, anchor) {
    const tip = document.getElementById("tooltip");
    const rows = series.filter((s) => v[s.id]).reverse().map((s) =>
      el("div", { class: "tt-row" }, [
        el("span", { class: "tt-key", style: `background:${s.color}` }),
        el("span", { class: "tt-val", text: formatDuration(v[s.id]) }),
        el("span", { class: "tt-name", text: s.name }),
      ]));
    tip.replaceChildren(
      el("div", { class: "tt-head", text: label }),
      ...rows,
      el("div", { class: "tt-row", style: "margin-top:4px" }, [
        el("span", { class: "tt-key" }),
        el("span", { class: "tt-val", text: formatDuration(total) }),
        el("span", { class: "tt-name", text: "Total" }),
      ]),
    );
    tip.hidden = false;
    let x, yPos;
    if (ev.type === "focus") {
      const r = anchor.getBoundingClientRect();
      x = r.right; yPos = r.top;
    } else {
      x = ev.clientX; yPos = ev.clientY;
    }
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = x + 14 + tw > window.innerWidth ? x - tw - 14 : x + 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, Math.min(window.innerHeight - th - 4, yPos - th / 2))}px`;
  }

  function hideTooltip() {
    document.getElementById("tooltip").hidden = true;
  }

  function renderChartTable(buckets, series, values, totals, box) {
    const table = el("table", {}, [
      el("thead", {}, el("tr", {}, [el("th", { text: "Period" }), ...series.map((s) => el("th", { class: "r", text: s.name })), el("th", { class: "r", text: "Total" })])),
      el("tbody", {}, buckets.map((b, i) => totals[i] ? el("tr", {}, [
        el("td", { text: b.label }),
        ...series.map((s) => el("td", { class: "r", text: values[i][s.id] ? formatDuration(values[i][s.id]) : "–" })),
        el("td", { class: "r", text: formatDuration(totals[i]) }),
      ]) : null)),
    ]);
    box.replaceChildren(el("div", { class: "table-wrap" }, table));
  }

  // --------------------------------------------------------------- videos

  function renderVideos(vids, sortedLangs) {
    const filter = document.getElementById("video-filter");
    const prev = videoFilter;
    filter.replaceChildren(el("option", { value: "", text: "All" }),
      ...sortedLangs.map(([l]) => el("option", { value: l, text: languageName(l) })));
    filter.value = sortedLangs.some(([l]) => l === prev) ? prev : "";
    videoFilter = filter.value;

    const list = videoFilter ? vids.filter((v) => v.langs[videoFilter]) : vids;
    const tbody = document.querySelector("#videos tbody");
    const used = sortedLangs.map(([l]) => l);
    tbody.replaceChildren(...list.slice(0, videoLimit).map((v) => {
      const select = langSelect(v.primaryLang, used, true);
      select.addEventListener("change", async () => {
        await api.runtime.sendMessage({ type: "reassignVideo", videoKey: v.k, lang: select.value });
      });
      const mixed = Object.keys(v.langs).length > 1
        ? el("span", { class: "mixed", text: S.sortedLangs(v.langs).map(([l, s]) => `${languageName(l)} ${formatDuration(s)}`).join(" · ") })
        : null;
      const safeUrl = /^https?:\/\//i.test(v.url || "") ? v.url : null;
      return el("tr", {}, [
        el("td", { class: "title", title: v.title || v.k }, safeUrl
          ? el("a", { href: safeUrl, target: "_blank", rel: "noopener noreferrer", text: v.title || v.k })
          : (v.title || v.k)),
        el("td", { class: "secondary", text: v.site || "" }),
        el("td", { class: "r", text: formatDuration(v.total) }),
        el("td", {}, [select, mixed]),
        el("td", { class: "secondary", text: v.last ? new Date(v.last).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "" }),
        el("td", {}, el("button", {
          type: "button", class: "link danger", text: "Remove", title: "Delete this video's watch time",
          onclick: async () => {
            if (confirm(`Delete all watch time for “${v.title || v.k}”?`)) {
              await api.runtime.sendMessage({ type: "deleteVideo", videoKey: v.k });
            }
          },
        })),
      ]);
    }));
    if (!list.length) {
      tbody.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "empty", text: "No videos in this period." })));
    }
    document.getElementById("more").hidden = list.length <= videoLimit;
  }

  // ------------------------------------------------------ rules/settings

  function renderRules() {
    const rules = state.all.siteRules || {};
    const ul = document.getElementById("rules");
    const items = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)).map(([site, lang]) =>
      el("li", {}, [
        el("span", {}, [el("strong", { text: site }), ` → ${languageName(lang)}`]),
        el("button", { type: "button", class: "link danger", text: "Remove", onclick: () =>
          api.runtime.sendMessage({ type: "setSiteRule", site, lang: null }) }),
      ]));
    ul.replaceChildren(...(items.length ? items : [el("li", { class: "muted", text: "No rules yet." })]));
    const slot = document.getElementById("rule-lang-slot");
    if (!slot.firstChild) slot.append(langSelect("ja", [], false));
  }

  function renderSettings() {
    const s = { ...DEFAULT_SETTINGS, ...(state.all.settings || {}) };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const box = document.getElementById(`s-${key}`);
      if (box) box.checked = !!s[key];
    }
  }

  // ---------------------------------------------------------------- data

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(v) {
    const s = String(v ?? "");
    // Quote, and neutralise spreadsheet formula injection from page titles.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function msg(text) { document.getElementById("data-msg").textContent = text; }

  document.getElementById("export-json").addEventListener("click", () => {
    const { all, entries } = state;
    const data = {
      app: "lingua-watch", version: 1, exportedAt: new Date().toISOString(),
      entries, overrides: all.overrides || {}, siteRules: all.siteRules || {}, settings: all.settings || {},
    };
    download(`lingua-watch-${dayKey()}.json`, JSON.stringify(data, null, 2), "application/json");
  });

  document.getElementById("export-csv").addEventListener("click", () => {
    const rows = [["date", "language", "language_name", "seconds", "site", "title", "url", "video_key"]];
    for (const e of [...state.entries].sort((a, b) => a.d.localeCompare(b.d))) {
      rows.push([e.d, e.l, languageName(e.l), Math.round(e.s), e.h, e.t, e.u, e.k]);
    }
    download(`lingua-watch-${dayKey()}.csv`, rows.map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
  });

  document.getElementById("import").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.entries)) throw new Error("Not a Lingua Watch backup");
      const added = await api.runtime.sendMessage({ type: "importEntries", entries: data.entries });
      const cleanMap = (m) => Object.fromEntries(Object.entries(m && typeof m === "object" ? m : {})
        .map(([k, v]) => [String(k).slice(0, 2000), normalizeLang(v)]).filter(([, v]) => v));
      const cur = await api.storage.local.get(["overrides", "siteRules"]);
      await api.storage.local.set({
        overrides: { ...(cur.overrides || {}), ...cleanMap(data.overrides) },
        siteRules: { ...(cur.siteRules || {}), ...cleanMap(data.siteRules) },
      });
      msg(`Imported ${added} records.`);
    } catch (e) {
      msg(`Import failed: ${e.message}`);
    }
  });

  document.getElementById("reset").addEventListener("click", async () => {
    if (!confirm("Delete all tracked watch time? This cannot be undone. (Site rules and settings are kept.)")) return;
    await api.runtime.sendMessage({ type: "resetAll" });
    msg("All watch time deleted.");
  });

  // ---------------------------------------------------------------- wiring

  document.getElementById("range").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (b) { range = b.dataset.range; videoLimit = 100; render(); }
  });
  document.getElementById("video-filter").addEventListener("change", (e) => {
    videoFilter = e.target.value; videoLimit = 100; render();
  });
  document.getElementById("more").addEventListener("click", () => { videoLimit += 100; render(); });

  document.getElementById("rule-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("rule-site");
    let site = input.value.trim().toLowerCase();
    try { if (site.includes("/")) site = new URL(site.includes("://") ? site : `https://${site}`).hostname; } catch (err) { /* keep */ }
    site = site.replace(/^(www|m|mobile)\./, "");
    const lang = document.querySelector("#rule-lang-slot select").value;
    if (!site) return;
    await api.runtime.sendMessage({ type: "setSiteRule", site, lang });
    input.value = "";
  });

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const box = document.getElementById(`s-${key}`);
    if (!box) continue;
    box.addEventListener("change", async () => {
      const { settings = {} } = await api.storage.local.get("settings");
      await api.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, [key]: box.checked } });
    });
  }

  let pending = null;
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    clearTimeout(pending);
    const reload = () => {
      // Don't yank a dropdown out from under the user while they're choosing.
      if (document.activeElement && document.activeElement.tagName === "SELECT") pending = setTimeout(reload, 1000);
      else load();
    };
    pending = setTimeout(reload, 300);
  });

  load();
})();
