/* Pure helpers used by the content script (kept separate so they can be unit tested). */
(function (root) {
  "use strict";

  /**
   * Detection sources, strongest first. A higher strength wins when several
   * signals disagree.
   */
  const SOURCES = {
    override:   { strength: 100, label: "set by you" },
    audioTrack: { strength: 90,  label: "audio track" },
    autoCaptions: { strength: 80, label: "auto-generated captions" },
    siteRule:   { strength: 70,  label: "your rule for this site" },
    metadata:   { strength: 60,  label: "page metadata" },
    text:       { strength: 50,  label: "title & description" },
    textWeak:   { strength: 30,  label: "title & description (low confidence)" },
    pageLang:   { strength: 20,  label: "page language" },
    none:       { strength: 0,   label: "not detected" },
  };

  /** signals: [{lang, source}] -> best {lang, source, strength}; unknown if empty. */
  function pickDetection(signals) {
    let best = null;
    for (const sig of signals || []) {
      if (!sig || !sig.lang) continue;
      const strength = (SOURCES[sig.source] || SOURCES.none).strength;
      if (!best || strength > best.strength) best = { lang: sig.lang, source: sig.source, strength };
    }
    return best || { lang: "und", source: "none", strength: 0 };
  }

  /**
   * Seconds of real playback between two samples. Uses the smaller of the
   * wall-clock delta and the media-time delta (adjusted for playback speed), so:
   *  - seeking forward does not count as watched time,
   *  - a suspended/sleeping computer does not count as watched time,
   *  - 2x speed counts wall-clock time (what you actually spent).
   */
  function measureElapsed(prev, cur, playbackRate) {
    if (!prev || !cur) return 0;
    const realDelta = (cur.real - prev.real) / 1000;
    const rate = playbackRate > 0 ? playbackRate : 1;
    const mediaDelta = (cur.media - prev.media) / rate;
    if (!(realDelta > 0) || !(mediaDelta > 0)) return 0;
    // Allow a little slack for timer jitter, but never more than real time.
    return Math.min(realDelta, mediaDelta * 1.05);
  }

  /** Strip things that confuse language detection (links, tags, handles, timestamps). */
  function cleanText(text) {
    return String(text || "")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/www\.\S+/g, " ")
      .replace(/[#@][\p{L}\p{N}_]+/gu, " ")
      .replace(/\S+@\S+\.\S+/g, " ")
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  }

  const DROP_PARAMS = /^(utm_.*|t|time_continue|start|si|feature|fbclid|gclid|ref|pp|ab_channel)$/i;

  /** Stable key for a video on a site we don't know specifically. */
  function genericVideoKey(href) {
    try {
      const u = new URL(href);
      const params = [...u.searchParams.entries()]
        .filter(([k]) => !DROP_PARAMS.test(k))
        .sort(([a], [b]) => a.localeCompare(b));
      const qs = params.length ? "?" + new URLSearchParams(params).toString() : "";
      return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}${qs}`;
    } catch (e) {
      return String(href || "unknown");
    }
  }

  /** Strip "www." / "m." so youtube.com and m.youtube.com share rules. */
  function siteOf(hostname) {
    return String(hostname || "").replace(/^(www|m|mobile)\./, "");
  }

  const api = { SOURCES, pickDetection, measureElapsed, cleanText, genericVideoKey, siteOf };
  root.LWTracker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
