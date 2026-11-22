/* Content script: finds playing <video> elements, works out what language the
 * video is in, and reports watched seconds to the background script.
 *
 * Runs in every frame (so embedded players are covered). Uses Firefox's
 * `wrappedJSObject` to read player state that sites keep in page JavaScript
 * (YouTube's player response, Netflix's player API).
 */
(function () {
  "use strict";
  if (window.__linguaWatchLoaded) return;
  window.__linguaWatchLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const { normalizeLang, DEFAULT_SETTINGS } = globalThis.LW;
  const { pickDetection, measureElapsed, cleanText, genericVideoKey, siteOf, SOURCES } = globalThis.LWTracker;

  const TICK_MS = 1000;
  const FLUSH_EVERY_TICKS = 5;
  const IDLE_TICKS_BEFORE_STOP = 10;

  // ---------------------------------------------------------------- helpers

  /** Page-side view of an object (Firefox X-ray waiver); identity elsewhere. */
  function page(obj) {
    try { return obj && obj.wrappedJSObject ? obj.wrappedJSObject : obj; } catch (e) { return obj; }
  }

  /** Safely walk a property path on a page object. */
  function dig(obj, ...path) {
    let cur = obj;
    try {
      for (const key of path) {
        if (cur == null) return undefined;
        cur = cur[key];
      }
      return cur;
    } catch (e) {
      return undefined;
    }
  }

  function str(v) { return typeof v === "string" ? v : ""; }

  /** Copy a page-side array-like into a real array (bounded). */
  function list(v, max = 1000) {
    const out = [];
    try {
      const n = Math.min(Number(v && v.length) || 0, max);
      for (let i = 0; i < n; i++) out.push(v[i]);
    } catch (e) { /* ignore */ }
    return out;
  }

  function meta(selector) {
    const el = document.querySelector(selector);
    return el ? str(el.getAttribute("content")).trim() : "";
  }

  // ------------------------------------------------------- site adapters

  /** Generic: works on any page with a <video>. */
  const generic = {
    name: "generic",
    useText: true,
    usePageLang: true,
    match: () => true,
    videoKey: () => genericVideoKey(location.href),
    isAd: () => false,
    info() {
      return {
        title: meta('meta[property="og:title"]') || document.title || location.hostname,
        description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
      };
    },
    signals(video) {
      const out = [];
      // HTML audioTracks (only exposed when the browser enables it).
      for (const t of list(video.audioTracks)) {
        if (t && t.enabled && normalizeLang(t.language)) {
          out.push({ lang: normalizeLang(t.language), source: "audioTrack" });
        }
      }
      const fromLd = jsonLdLanguage();
      if (fromLd) out.push({ lang: fromLd, source: "metadata" });
      const itemprop = normalizeLang(meta('meta[itemprop="inLanguage"]'));
      if (itemprop) out.push({ lang: itemprop, source: "metadata" });
      const videoLang = normalizeLang(video.getAttribute("lang"));
      if (videoLang) out.push({ lang: videoLang, source: "metadata" });
      return out;
    },
  };

  /** schema.org VideoObject/Movie/Episode `inLanguage` from JSON-LD blocks. */
  function jsonLdLanguage() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (e) { continue; }
      const found = findInLanguage(data, 0);
      if (found) return found;
    }
    return null;
  }

  function findInLanguage(node, depth) {
    if (!node || typeof node !== "object" || depth > 6) return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const f = findInLanguage(n, depth + 1);
        if (f) return f;
      }
      return null;
    }
    if (node.inLanguage) {
      const v = Array.isArray(node.inLanguage) ? node.inLanguage[0] : node.inLanguage;
      const code = normalizeLang(typeof v === "string" ? v : v && (v.alternateName || v.name));
      if (code) return code;
    }
    for (const key of Object.keys(node)) {
      const f = findInLanguage(node[key], depth + 1);
      if (f) return f;
    }
    return null;
  }

  /** YouTube (watch pages, Shorts, embeds, music). */
  const youtube = {
    name: "youtube",
    useText: true,
    usePageLang: false, // <html lang> is your UI language, not the video's
    match: (host) => /(^|\.)youtube(-nocookie)?\.com$/.test(host),
    playerEl: (video) => video.closest(".html5-video-player"),
    response(video) {
      const el = this.playerEl(video);
      const p = el && page(el);
      try {
        if (p && typeof p.getPlayerResponse === "function") {
          const r = p.getPlayerResponse();
          if (r) return r;
        }
      } catch (e) { /* ignore */ }
      const initial = dig(page(window), "ytInitialPlayerResponse");
      const id = str(dig(initial, "videoDetails", "videoId"));
      return id && id === this.urlVideoId() ? initial : null;
    },
    urlVideoId() {
      const v = new URLSearchParams(location.search).get("v");
      if (v) return v;
      const m = location.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m ? m[1] : "";
    },
    videoKey(video) {
      const id = str(dig(this.response(video), "videoDetails", "videoId")) || this.urlVideoId();
      return id ? `youtube:${id}` : genericVideoKey(location.href);
    },
    isAd(video) {
      const el = this.playerEl(video);
      return !!el && (el.classList.contains("ad-showing") || el.classList.contains("ad-interrupting"));
    },
    info(video) {
      const r = this.response(video);
      return {
        title: str(dig(r, "videoDetails", "title")) || document.title.replace(/ - YouTube$/, ""),
        description: str(dig(r, "videoDetails", "shortDescription")),
      };
    },
    signals(video) {
      const out = [];
      const r = this.response(video);
      if (!r) return out;

      // 1. Audio tracks (videos with multiple dubs list one per language).
      const tracks = new Map();
      for (const f of list(dig(r, "streamingData", "adaptiveFormats"))) {
        const id = str(dig(f, "audioTrack", "id"));
        if (id && !tracks.has(id)) tracks.set(id, !!dig(f, "audioTrack", "audioIsDefault"));
      }
      if (tracks.size > 0) {
        const current = this.currentAudioTrackId(video, [...tracks.keys()]);
        const chosen = current || [...tracks.entries()].find(([, isDefault]) => isDefault)?.[0] ||
          (tracks.size === 1 ? [...tracks.keys()][0] : "");
        const lang = normalizeLang(chosen.split(".")[0]);
        if (lang) out.push({ lang, source: "audioTrack" });
      }

      // 2. Auto-generated (ASR) captions are made from the spoken audio.
      for (const t of list(dig(r, "captions", "playerCaptionsTracklistRenderer", "captionTracks"))) {
        if (str(dig(t, "kind")) === "asr") {
          const lang = normalizeLang(str(dig(t, "languageCode")));
          if (lang) { out.push({ lang, source: "autoCaptions" }); break; }
        }
      }
      return out;
    },
    /** Best effort: ask the player which audio track is active. */
    currentAudioTrackId(video, knownIds) {
      const el = this.playerEl(video);
      const p = el && page(el);
      let track;
      try { track = p && typeof p.getAudioTrack === "function" ? p.getAudioTrack() : null; } catch (e) { track = null; }
      if (!track) return "";
      const known = new Set(knownIds);
      // The track object's shape is internal; look for a known track id among its values.
      const seen = new Set();
      const scan = (obj, depth) => {
        if (!obj || typeof obj !== "object" || depth > 2 || seen.has(obj)) return "";
        seen.add(obj);
        let keys = [];
        try { keys = Object.keys(obj).slice(0, 50); } catch (e) { return ""; }
        for (const k of keys) {
          const v = dig(obj, k);
          if (typeof v === "string" && known.has(v)) return v;
        }
        for (const k of keys) {
          const v = dig(obj, k);
          if (v && typeof v === "object") {
            const f = scan(v, depth + 1);
            if (f) return f;
          }
        }
        return "";
      };
      return scan(track, 0);
    },
  };

  /** Netflix: reads the active audio track from Netflix's player API. */
  const netflix = {
    name: "netflix",
    useText: false,     // titles are localised to your UI language
    usePageLang: false,
    match: (host) => /(^|\.)netflix\.com$/.test(host),
    player() {
      const vp = dig(page(window), "netflix", "appContext", "state", "playerApp");
      if (!vp) return null;
      try {
        const videoPlayer = vp.getAPI().videoPlayer;
        const ids = list(videoPlayer.getAllPlayerSessionIds()).filter((id) => typeof id === "string");
        ids.sort((a, b) => (b.startsWith("watch") ? 1 : 0) - (a.startsWith("watch") ? 1 : 0));
        for (const id of ids) {
          const p = videoPlayer.getVideoPlayerBySessionId(id);
          if (p) return p;
        }
      } catch (e) { /* ignore */ }
      return null;
    },
    movieId() {
      const m = location.pathname.match(/\/watch\/(\d+)/);
      return m ? m[1] : "";
    },
    videoKey() {
      const id = this.movieId();
      return id ? `netflix:${id}` : genericVideoKey(location.href);
    },
    isAd: () => false,
    info() {
      const el = document.querySelector('[data-uia="video-title"]');
      let title = "";
      if (el) {
        title = [...el.querySelectorAll("h4, span")].map((n) => n.textContent.trim()).filter(Boolean).join(" · ") ||
          el.textContent.trim();
      }
      if (title) this.lastTitle = title;
      return { title: title || this.lastTitle || `Netflix ${this.movieId()}`.trim(), description: "" };
    },
    signals() {
      const p = this.player();
      if (!p) return [];
      let track;
      try { track = p.getAudioTrack(); } catch (e) { track = null; }
      const lang = normalizeLang(str(dig(track, "bcp47")) || str(dig(track, "language")));
      return lang ? [{ lang, source: "audioTrack" }] : [];
    },
  };

  const ADAPTERS = [youtube, netflix];

  function adapterFor(host) {
    return ADAPTERS.find((a) => a.match(host)) || generic;
  }

  // ------------------------------------------------------------- settings

  let settings = { ...DEFAULT_SETTINGS };
  let overrides = {};
  let siteRules = {};
  const site = siteOf(location.hostname);
  const adapter = adapterFor(location.hostname);

  api.storage.local.get(["settings", "overrides", "siteRules"]).then((r) => {
    settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
    overrides = r.overrides || {};
    siteRules = r.siteRules || {};
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (changes.overrides) overrides = changes.overrides.newValue || {};
    if (changes.siteRules) siteRules = changes.siteRules.newValue || {};
    if ((changes.overrides || changes.siteRules) && ctx) {
      detect(ctx).then(() => sendStatus(true));
    }
  });

  // ------------------------------------------------------------ detection

  const textCache = new Map(); // text -> Promise<signal|null>

  function detectText(text) {
    const cleaned = cleanText(text);
    if (cleaned.length < 12) return Promise.resolve(null);
    if (!textCache.has(cleaned)) {
      const p = api.runtime.sendMessage({ type: "detectText", text: cleaned }).then((r) => {
        if (!r || !r.lang) return null;
        const strong = r.reliable && r.percentage >= 50 && cleaned.length >= 40;
        if (!strong && r.percentage < 40) return null;
        return { lang: r.lang, source: strong ? "text" : "textWeak" };
      }).catch(() => null);
      textCache.set(cleaned, p);
      if (textCache.size > 50) textCache.delete(textCache.keys().next().value);
    }
    return textCache.get(cleaned);
  }

  async function detect(c) {
    const signals = [];
    const ov = overrides[c.key];
    if (ov) signals.push({ lang: ov, source: "override" });
    if (siteRules[site]) signals.push({ lang: siteRules[site], source: "siteRule" });

    try { signals.push(...adapter.signals(c.video)); } catch (e) { /* ignore */ }

    let info = { title: "", description: "" };
    try { info = adapter.info(c.video); } catch (e) { /* ignore */ }
    if (info.title) c.title = info.title.slice(0, 300);

    // Text detection only matters if nothing stronger has been found.
    const bestSoFar = pickDetection(signals);
    if (adapter.useText && bestSoFar.strength < SOURCES.text.strength) {
      const sig = await detectText(`${info.title}\n${info.description}`);
      if (sig) signals.push(sig);
    }
    if (adapter.usePageLang) {
      const pl = normalizeLang(document.documentElement.getAttribute("lang")) ||
        normalizeLang(meta('meta[http-equiv="content-language"]'));
      if (pl) signals.push({ lang: pl, source: "pageLang" });
    }

    c.detection = pickDetection(signals);
    c.detected = true;
    return c.detection;
  }

  // ------------------------------------------------------------- tracking

  let ctx = null;          // current video context
  let timer = null;
  let idleTicks = 0;
  let tickCount = 0;
  let wasCounting = false;
  const samples = new WeakMap(); // video -> {real, media}

  function isPlaying(v) {
    return !v.paused && !v.ended && v.readyState >= 2;
  }

  function pickActiveVideo() {
    let best = null;
    let bestArea = -1;
    for (const v of document.querySelectorAll("video")) {
      if (!isPlaying(v)) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      // Prefer audible videos over muted previews, then the biggest.
      const score = area + ((v.muted || v.volume === 0) ? 0 : 1e9);
      if (score > bestArea) { best = v; bestArea = score; }
    }
    return best;
  }

  function shouldCount(v) {
    if (settings.trackingPaused) return false;
    if (settings.ignoreMuted && (v.muted || v.volume === 0)) return false;
    if (settings.ignoreHidden && document.hidden) return false;
    if (settings.ignoreAds && safe(() => adapter.isAd(v), false)) return false;
    return true;
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function tick() {
    tickCount++;
    const video = pickActiveVideo();

    if (!video) {
      if (wasCounting) { wasCounting = false; sendStatus(false); }
      flush();
      if (++idleTicks >= IDLE_TICKS_BEFORE_STOP) stop();
      return;
    }
    idleTicks = 0;

    const key = safe(() => adapter.videoKey(video), genericVideoKey(location.href));
    if (!ctx || ctx.key !== key) {
      const old = ctx;
      ctx = { key, video, pending: 0, detection: null, detected: false, title: "", url: location.href };
      if (old) flush(old);
      detect(ctx).then(() => sendStatus(true));
    }
    ctx.video = video;
    ctx.url = location.href;

    const counting = shouldCount(video);
    const now = { real: performance.now(), media: video.currentTime };
    if (counting) {
      ctx.pending += measureElapsed(samples.get(video), now, video.playbackRate);
      samples.set(video, now);
    } else {
      samples.delete(video);
    }

    if (counting !== wasCounting) {
      wasCounting = counting;
      sendStatus(counting);
    }
    if (tickCount % FLUSH_EVERY_TICKS === 0) flush();
  }

  async function flush(c = ctx) {
    if (!c || c.pending < 0.5 || c.flushing) return;
    c.flushing = true;
    try {
      // Re-detect on every flush: players load metadata late, and you may switch audio tracks.
      if (c === ctx || !c.detected) await detect(c);
      const seconds = c.pending;
      c.pending = 0;
      await api.runtime.sendMessage({
        type: "record",
        record: {
          videoKey: c.key,
          seconds,
          lang: c.detection.lang,
          source: c.detection.source,
          title: c.title,
          url: c.url,
          site,
        },
      });
      if (c === ctx) sendStatus(wasCounting);
    } catch (e) {
      // Background unavailable (e.g. extension reloading) – drop this batch.
    } finally {
      c.flushing = false;
    }
  }

  function sendStatus(playing) {
    if (!ctx || !ctx.detection) return;
    api.runtime.sendMessage({
      type: "status",
      status: {
        videoKey: ctx.key,
        title: ctx.title,
        url: ctx.url,
        site,
        lang: ctx.detection.lang,
        source: ctx.detection.source,
        playing: !!playing,
        paused: !!settings.trackingPaused,
      },
    }).catch(() => {});
  }

  function start() {
    idleTicks = 0;
    if (!timer) timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Media events don't bubble, but they do pass through the capture phase.
  for (const evt of ["play", "playing", "loadeddata", "volumechange", "ratechange"]) {
    document.addEventListener(evt, (e) => {
      const v = e.target;
      if (!(v instanceof HTMLMediaElement)) return;
      // Start the clock at the moment playback begins, not at the next tick.
      if (evt === "playing" && !samples.has(v)) samples.set(v, { real: performance.now(), media: v.currentTime });
      start();
    }, true);
  }
  for (const evt of ["seeking", "pause", "ended", "emptied"]) {
    document.addEventListener(evt, (e) => {
      const v = e.target;
      if (!(v instanceof HTMLMediaElement)) return;
      // Count the partial second since the last tick before the sample is dropped.
      const prev = samples.get(v);
      if (evt !== "seeking" && prev && ctx && ctx.video === v) {
        ctx.pending += measureElapsed(prev, { real: performance.now(), media: v.currentTime }, v.playbackRate);
      }
      samples.delete(v);
      if (evt !== "seeking") flush();
    }, true);
  }
  window.addEventListener("pagehide", () => flush());
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  // The popup asks "what's playing here?" through the background page.
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "requestStatus" && ctx) sendStatus(wasCounting);
  });

  if (document.querySelector("video")) start();
})();
