/* Small DOM helpers shared by popup + dashboard. All user/page-derived text is
 * inserted with textContent, never innerHTML. */
(function (root) {
  "use strict";
  const { languageName, languageOptions, formatDuration } = root.LW;

  const SERIES_COUNT = 8;

  function colorFor(slot) {
    return slot >= 0 && slot < SERIES_COUNT ? `var(--series-${slot + 1})` : "var(--series-other)";
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /** <select> of languages; includes Unknown when includeUnknown. */
  function langSelect(selected, extraCodes, includeUnknown) {
    const select = el("select", { "aria-label": "Language" });
    if (includeUnknown) select.append(el("option", { value: "und", text: "Unknown" }));
    for (const { code, name } of languageOptions(extraCodes)) {
      select.append(el("option", { value: code, text: `${name} (${code})` }));
    }
    select.value = selected || (includeUnknown ? "und" : "en");
    return select;
  }

  /** Ranked language rows with bars scaled to the largest value. */
  function langList(sorted, total, slots) {
    if (!sorted.length) return el("p", { class: "empty", text: "Nothing watched in this period yet." });
    const max = sorted[0][1] || 1;
    const ul = el("ul", { class: "lang-list" });
    for (const [lang, secs] of sorted) {
      const color = colorFor(slots[lang] ?? -1);
      const share = total ? Math.round((secs / total) * 100) : 0;
      ul.append(el("li", { class: "lang-row", title: `${languageName(lang)}: ${formatDuration(secs)} (${share}%)` }, [
        el("span", { class: "name" }, [
          el("span", { class: "swatch", style: `background:${color}` }),
          el("span", { text: languageName(lang) }),
        ]),
        el("span", {}, [
          el("span", { class: "time", text: formatDuration(secs) }),
          el("span", { class: "share", text: `${share}%` }),
        ]),
        el("span", { class: "track" }, [
          el("span", { class: "bar", style: `display:block;width:${(secs / max) * 100}%;background:${color}` }),
        ]),
      ]));
    }
    return ul;
  }

  root.LWUI = { SERIES_COUNT, colorFor, el, langSelect, langList };
})(globalThis);
