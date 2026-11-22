/* Minimal in-page stand-in for the WebExtension `browser` API so background,
 * content script and pages can run together in one ordinary web page. */
(function () {
  const store = {};
  const changeListeners = [];
  const msgListeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function emit(changes) {
    if (Object.keys(changes).length) changeListeners.forEach((l) => l(changes, "local"));
  }
  const local = {
    async get(keys) {
      if (keys == null) return clone(store);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = clone(store[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: clone(v) }; store[k] = clone(v); }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) if (k in store) { changes[k] = { oldValue: store[k] }; delete store[k]; }
      emit(changes);
    },
  };
  async function dispatch(msg) {
    const sender = { tab: { id: 1 }, frameId: 0 };
    for (const l of msgListeners) {
      const r = l(clone(msg), sender);
      if (r !== undefined) return clone(await r);
    }
    return undefined;
  }
  window.__badge = {};
  window.__store = store;
  window.browser = {
    storage: { local, onChanged: { addListener: (l) => changeListeners.push(l) } },
    runtime: {
      sendMessage: (m) => dispatch(m),
      onMessage: { addListener: (l) => msgListeners.push(l) },
      openOptionsPage: () => {},
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      query: async () => [{ id: 1 }],
      sendMessage: (id, m) => dispatch(m),
    },
    browserAction: {
      setBadgeText: async ({ text }) => { window.__badge.text = text; },
      setBadgeBackgroundColor: async () => {},
    },
    i18n: {
      // Stand-in for Firefox's built-in CLD language detector.
      detectLanguage: async (text) => (/\b(hola|esto|vídeo|español)\b/i.test(text)
        ? { isReliable: true, languages: [{ language: "es", percentage: 97 }] }
        : { isReliable: false, languages: [] }),
    },
  };
})();
