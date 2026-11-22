(function () {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const { languageName, formatDuration, dayKey, DEFAULT_SETTINGS } = LW;
  const SOURCES = LWTracker.SOURCES;
  const { el, langSelect, langList } = LWUI;

  let range = "today";
  let tabId = null;
  let settings = { ...DEFAULT_SETTINGS };
  let lastNowSig = null;

  async function render() {
    const data = await LWData.load();
    const all = data.local;
    settings = { ...DEFAULT_SETTINGS, ...(all.settings || {}) };
    // Totals combine every synced device.
    const slots = LWStats.colorSlots(LWStats.aggregate(data.rows, null).byLang, LWUI.SERIES_COUNT);
    const agg = LWStats.aggregate(data.rows, LWStats.rangeFor(range, dayKey()));

    document.getElementById("total").textContent = formatDuration(agg.total);
    const label = { today: "watched today", "7d": "watched in the last 7 days", "30d": "watched in the last 30 days", all: "watched in total" }[range];
    const nLangs = Object.keys(agg.byLang).filter((l) => l !== "und").length;
    const nDevices = new Set(data.rows.map((r) => r.dev)).size;
    document.getElementById("total-label").textContent =
      `${label} · ${nLangs} language${nLangs === 1 ? "" : "s"}${nDevices > 1 ? ` · ${nDevices} devices` : ""}`;
    const noSubs = agg.total ? Math.round(((agg.total - agg.subTotal) / agg.total) * 100) : 0;
    document.getElementById("subs-line").textContent = agg.total ? `${noSubs}% without subtitles` : "";
    document.getElementById("langs").replaceChildren(langList(LWStats.sortedLangs(agg.byLang), agg.total, slots));

    for (const b of document.querySelectorAll("#range button")) b.setAttribute("aria-pressed", String(b.dataset.range === range));
    const pause = document.getElementById("pause");
    pause.textContent = settings.trackingPaused ? "Resume tracking" : "Pause tracking";
    pause.classList.toggle("primary", settings.trackingPaused);

    await renderNow(all);
  }

  async function renderNow(all) {
    const box = document.getElementById("now");
    const status = tabId == null ? null : await api.runtime.sendMessage({ type: "getTabStatus", tabId }).catch(() => null);
    if (!status) {
      lastNowSig = null;
      box.replaceChildren(
        el("div", { class: "label", text: "This tab" }),
        el("p", { class: "muted", text: settings.trackingPaused ? "Tracking is paused." : "No video playing in this tab." }),
      );
      return;
    }
    const overrides = all.overrides || {};
    const siteRules = all.siteRules || {};
    // Don't rebuild (and reset the user's half-made selection) if nothing changed.
    const sig = JSON.stringify([status.videoKey, status.lang, status.source, status.playing, status.title, status.subtitles,
      overrides[status.videoKey], siteRules[status.site], settings.trackingPaused]);
    if (sig === lastNowSig) return;
    lastNowSig = sig;
    const hasOverride = !!overrides[status.videoKey];
    const stateText = settings.trackingPaused ? "Paused" : status.playing ? "Now tracking" : "Not counting (paused, muted or ad)";

    const select = langSelect(status.lang === "und" ? "" : status.lang, [status.lang]);
    const setBtn = el("button", {
      type: "button", class: "primary", text: "Set for this video",
      onclick: async () => {
        await api.runtime.sendMessage({ type: "setOverride", videoKey: status.videoKey, lang: select.value });
        setTimeout(refresh, 250);
      },
    });
    const controls = el("div", { class: "controls" }, [select, setBtn]);
    if (hasOverride) {
      controls.append(el("button", {
        type: "button", text: "Auto-detect",
        title: "Remove your manual choice and detect automatically again",
        onclick: async () => {
          await api.runtime.sendMessage({ type: "setOverride", videoKey: status.videoKey, lang: null });
          setTimeout(refresh, 250);
        },
      }));
    }

    const rule = siteRules[status.site];
    const ruleRow = el("div", { class: "rule secondary" });
    if (rule) {
      ruleRow.append(`Videos on ${status.site} default to ${languageName(rule)}. `,
        el("button", { type: "button", class: "link", text: "Remove rule", onclick: async () => {
          await api.runtime.sendMessage({ type: "setSiteRule", site: status.site, lang: null });
          setTimeout(refresh, 250);
        } }));
    } else {
      ruleRow.append(el("button", { type: "button", class: "link", text: `Always use the selected language on ${status.site}`, onclick: async () => {
        await api.runtime.sendMessage({ type: "setSiteRule", site: status.site, lang: select.value });
        setTimeout(refresh, 250);
      } }));
    }

    box.replaceChildren(
      el("div", { class: "label", text: stateText }),
      el("div", { class: "title", text: status.title || status.videoKey, title: status.title || "" }),
      el("div", { class: "lang" }, [
        el("strong", { text: languageName(status.lang) }),
        el("span", { class: "source", text: ` · ${(SOURCES[status.source] || SOURCES.none).label}` }),
      ]),
      el("div", { class: "source" }, subtitleText(status.subtitles)),
      controls,
      ruleRow,
    );
  }

  function subtitleText(subs) {
    if (!subs || !subs.on) return "Subtitles off";
    return subs.lang ? `Subtitles on (${languageName(subs.lang)})` : "Subtitles on";
  }

  async function refresh() {
    if (tabId != null) {
      // Ask the tab's content scripts to report fresh status, then render.
      await api.tabs.sendMessage(tabId, { type: "requestStatus" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    }
    await render();
  }

  document.getElementById("range").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (b) { range = b.dataset.range; render(); }
  });
  document.getElementById("pause").addEventListener("click", async () => {
    const { settings: s = {} } = await api.storage.local.get("settings");
    await api.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...s, trackingPaused: !settings.trackingPaused } });
    render();
  });
  document.getElementById("dashboard").addEventListener("click", () => {
    api.runtime.openOptionsPage();
    window.close();
  });

  api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    tabId = tabs[0] ? tabs[0].id : null;
    refresh();
  });
  // Live-update while open.
  setInterval(render, 3000);
})();
