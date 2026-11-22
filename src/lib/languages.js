/* Language helpers shared by background, content scripts and pages. */
(function (root) {
  "use strict";

  const UNKNOWN = "und";

  const DEFAULT_SETTINGS = {
    trackingPaused: false, // global on/off switch
    ignoreMuted: true,     // don't count muted autoplay previews
    ignoreHidden: false,   // count videos playing in background tabs
    ignoreAds: true,       // skip YouTube ads
  };

  // Languages offered in the "change language" pickers.
  const COMMON_LANGUAGES = [
    "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da",
    "de", "el", "en", "eo", "es", "et", "eu", "fa", "fi", "fil", "fr", "ga",
    "gl", "gu", "ha", "he", "hi", "hr", "ht", "hu", "hy", "id", "ig", "is",
    "it", "ja", "jv", "ka", "kk", "km", "kn", "ko", "ku", "ky", "la", "lb",
    "lo", "lt", "lv", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "nb",
    "ne", "nl", "nn", "pa", "pl", "ps", "pt", "qu", "ro", "ru", "rw", "sd",
    "si", "sk", "sl", "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg",
    "th", "tr", "uk", "ur", "uz", "vi", "xh", "yi", "yo", "yue", "zh", "zu",
  ];

  // Deprecated / ISO 639-2 / odd codes seen in the wild -> canonical code.
  const ALIASES = {
    iw: "he", in: "id", ji: "yi", jw: "jv", tl: "fil", no: "nb", mo: "ro",
    sh: "sr", cmn: "zh", eng: "en", spa: "es", fra: "fr", fre: "fr",
    deu: "de", ger: "de", ita: "it", por: "pt", rus: "ru", jpn: "ja",
    kor: "ko", zho: "zh", chi: "zh", ara: "ar", hin: "hi", tur: "tr",
    nld: "nl", dut: "nl", pol: "pl", swe: "sv", dan: "da", fin: "fi",
    nor: "nb", nob: "nb", ell: "el", gre: "el", heb: "he", tha: "th",
    vie: "vi", ukr: "uk", ces: "cs", cze: "cs", hun: "hu", ron: "ro",
    rum: "ro", ind: "id", msa: "ms", may: "ms", fil: "fil", tgl: "fil",
    cat: "ca", hrv: "hr", srp: "sr", bul: "bg", slk: "sk", slo: "sk",
    tam: "ta", tel: "te", ben: "bn", urd: "ur", fas: "fa", per: "fa",
  };

  // Codes that mean "no language" or "unknown".
  const NON_LANGUAGES = new Set(["und", "zxx", "mul", "mis", "xx", "un", "qaa"]);

  /**
   * Turn any BCP-47-ish tag ("en-US", "es_419", "a.en", "zh-Hant", "ENG")
   * into the primary language code used for aggregation ("en", "es", "zh").
   * Returns null for empty / non-language input.
   */
  function normalizeLang(tag) {
    if (tag == null) return null;
    let s = String(tag).trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^a\./, ""); // YouTube auto-caption vss ids like "a.en"
    const primary = s.split(/[-_.\s]/)[0];
    if (!/^[a-z]{2,3}$/.test(primary)) return null;
    if (NON_LANGUAGES.has(primary)) return null;
    return ALIASES[primary] || primary;
  }

  let displayNames = null;
  function getDisplayNames() {
    if (displayNames === null) {
      try {
        const loc = (typeof navigator !== "undefined" && navigator.language) || "en";
        displayNames = new Intl.DisplayNames([loc, "en"], { type: "language" });
      } catch (e) {
        displayNames = false;
      }
    }
    return displayNames;
  }

  function languageName(code) {
    if (!code || code === UNKNOWN) return "Unknown";
    const dn = getDisplayNames();
    if (dn) {
      try {
        const name = dn.of(code);
        if (name && name.toLowerCase() !== code) {
          return name.charAt(0).toUpperCase() + name.slice(1);
        }
      } catch (e) { /* fall through */ }
    }
    return code.toUpperCase();
  }

  /** Picker options sorted by display name, plus any extra codes in use. */
  function languageOptions(extraCodes) {
    const set = new Set(COMMON_LANGUAGES);
    (extraCodes || []).forEach((c) => c && c !== UNKNOWN && set.add(c));
    return [...set]
      .map((code) => ({ code, name: languageName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 3725 -> "1h 2m", 125 -> "2m 5s", 9 -> "9s". */
  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  /** Local calendar day as YYYY-MM-DD. */
  function dayKey(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const api = {
    UNKNOWN,
    DEFAULT_SETTINGS,
    COMMON_LANGUAGES,
    normalizeLang,
    languageName,
    languageOptions,
    formatDuration,
    dayKey,
  };

  root.LW = Object.assign(root.LW || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
