/* End-to-end check in Chromium with a stubbed extension API:
 *   node test/e2e/run.js
 * Plays a real video and checks that seconds are recorded under the language
 * detected from the page's title/description, that pausing and muting stop
 * the count, and that a manual override moves the time. */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const clip = path.join(__dirname, "clip.webm");
if (!fs.existsSync(clip)) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440", "-t", "40", "-c:v", "libvpx", "-b:v", "200k", "-c:a", "libvorbis", clip]);
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webm": "video/webm", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.log("PAGE ERROR", e.message); failures++; });
  await page.goto(`${base}/test/e2e/player.html`);

  const entries = () => page.evaluate(() => Object.values(window.__store).filter((v) => v && v.k));
  const total = async (lang) => (await entries()).filter((e) => !lang || e.l === lang).reduce((a, e) => a + e.s, 0);

  await page.evaluate(() => document.getElementById("v").play());
  await sleep(12500);
  const buffered = await total("es");
  check("flushes while playing", buffered >= 5, `${buffered.toFixed(1)}s so far`);
  const e0 = (await entries())[0];
  check("detected Spanish from title/description", e0 && e0.l === "es" && e0.src === "text", e0 && `${e0.l} via ${e0.src}`);
  check("badge shows ES", (await page.evaluate(() => window.__badge.text)) === "ES");

  await page.evaluate(() => document.getElementById("v").pause());
  await sleep(500);
  const afterPause = await total();
  check("pausing flushes ~12.5s of playback", afterPause >= 11 && afterPause <= 13.5, `${afterPause.toFixed(1)}s`);
  await sleep(6000);
  check("paused video is not counted", Math.abs((await total()) - afterPause) < 0.01);

  await page.evaluate(() => { const v = document.getElementById("v"); v.muted = true; v.play(); });
  await sleep(6000);
  check("muted video is not counted", Math.abs((await total()) - afterPause) < 0.01);

  // Manual override: everything should move to Japanese, and new time goes there too.
  await page.evaluate(() => browser.runtime.sendMessage({ type: "setOverride", videoKey: Object.values(window.__store).find((v) => v && v.k).k, lang: "ja" }));
  await page.evaluate(() => { document.getElementById("v").muted = false; });
  await sleep(6500);
  const ja = await total("ja");
  check("override moved time to Japanese", (await total("es")) === 0 && ja > afterPause + 3, `ja=${ja.toFixed(1)}s`);

  // Subtitles: turn the Spanish track on for ~5s of playback.
  await page.evaluate(() => { const v = document.getElementById("v"); v.textTracks[0].mode = "showing"; v.play(); });
  await sleep(5200);
  await page.evaluate(() => { const v = document.getElementById("v"); v.textTracks[0].mode = "disabled"; });
  await sleep(2000);
  await page.evaluate(() => document.getElementById("v").pause());
  await sleep(500);
  const ent = (await entries()).find((e) => e.l === "ja");
  check("time with subtitles recorded separately", ent.c >= 4 && ent.c <= 6.5 && ent.s > ent.c + 1.5, `${ent.c.toFixed(1)}s of ${ent.s.toFixed(1)}s`);
  check("subtitle language recorded", ent.cl && ent.cl.es >= 4, JSON.stringify(ent.cl));

  // Sync: this device publishes a compact summary.
  await page.evaluate(() => browser.runtime.sendMessage({ type: "syncNow" }));
  const syncKeys = await page.evaluate(() => Object.keys(window.__sync));
  const devId = await page.evaluate(() => window.__store.deviceId);
  check("publishes device + summary to sync", syncKeys.includes(`dev:${devId}`) && syncKeys.some((k) => k.startsWith(`h:${devId}:`)), syncKeys.join(", "));
  const synced = await page.evaluate((id) => Object.entries(window.__sync).filter(([k]) => k.startsWith(`h:${id}:`)).map(([, v]) => v), devId);
  const syncedTotal = synced.flatMap((h) => Object.values(h)).flatMap((d) => Object.values(d)).reduce((a, v) => a + v[0], 0);
  check("synced total matches local total", Math.abs(syncedTotal - (await total())) <= 2, `${syncedTotal} vs ${(await total()).toFixed(1)}`);
  check("site rules sync", await page.evaluate(async () => {
    await browser.storage.local.set({ siteRules: { "example.org": "ko" } });
    await new Promise((r) => setTimeout(r, 100));
    return window.__sync.siteRules && window.__sync.siteRules["example.org"] === "ko";
  }));

  // Render the popup and dashboard against seeded multi-language data and screenshot them.
  const seed = await page.evaluate(() => JSON.stringify({ local: window.__store, sync: window.__sync }));
  for (const [name, url, viewport] of [
    ["popup", "/src/popup/popup.html", { width: 360, height: 560 }],
    ["dashboard", "/src/dashboard/dashboard.html", { width: 1180, height: 1500 }],
  ]) {
    const p = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    p.on("pageerror", (e) => { console.log(`${name} ERROR`, e.message); failures++; });
    await p.route("**/src/lib/languages.js", async (route) => {
      const body = fs.readFileSync(path.join(root, "src/lib/languages.js"), "utf8");
      route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(__dirname, "fake-browser.js"), "utf8") + `\n;(${seedStore})(${seed});\n` + body });
    });
    await p.goto(base + url);
    await sleep(800);
    await p.screenshot({ path: path.join(__dirname, `${name}.png`), fullPage: true });
    const text = await p.evaluate(() => document.body.innerText);
    check(`${name} renders languages`, /Spanish|Japanese/.test(text));
    check(`${name} includes the other device`, /2 devices|Laptop/.test(text));
    if (name === "dashboard") {
      check("dashboard shows subtitle breakdown", /Same-language subtitles/.test(text) && /Without subtitles/.test(text));
      const before = await p.textContent("#t-total");
      await p.selectOption("#subs-filter", "without");
      await sleep(200);
      const after = await p.textContent("#t-total");
      check("subtitle filter changes totals", before !== after, `${before} -> ${after}`);
      await p.selectOption("#subs-filter", "all");
      await sleep(200);
      await p.screenshot({ path: path.join(__dirname, `${name}.png`), fullPage: true });
    }
    await p.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll e2e checks passed");
  process.exit(failures ? 1 : 0);
})();

/** Runs in the page: seed storage with the e2e results plus demo history. */
function seedStore(existing) {
  Object.assign(window.__store, existing.local);
  Object.assign(window.__sync, existing.sync);
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const demo = [["es", 1800], ["ja", 1200], ["fr", 600], ["de", 300], ["ko", 900]];
  for (let n = 0; n < 30; n++) {
    demo.forEach(([l, s], i) => {
      if ((n + i) % 3 === 0) return;
      const k = `demo:${l}:${n % 5}`;
      const secs = s * (0.4 + ((n * 7 + i) % 10) / 10);
      const c = (n + i) % 4 === 0 ? 0 : secs * (((n + i) % 3) / 3);
      window.__store[`e:${day(n)}|${l}|${k}`] = { k, d: day(n), l, s: secs, c, cl: c ? { [(n % 2) ? l : "en"]: c } : {}, t: `Demo video ${l} #${n % 5}`, u: "https://example.com", h: i % 2 ? "youtube.com" : "netflix.com", src: "audioTrack", ts: Date.now() - n * 864e5 };
    });
  }
  window.__store.siteRules = { "crunchyroll.com": "ja" };
  // A second device that has synced a summary.
  const half = (d) => d.slice(0, 7) + (Number(d.slice(8, 10)) <= 15 ? "a" : "b");
  window.__sync["dev:laptop0001"] = { name: "Laptop", updated: Date.now() - 3600e3 };
  for (let n = 0; n < 20; n += 2) {
    const k = `h:laptop0001:${half(day(n))}`;
    (window.__sync[k] = window.__sync[k] || {})[day(n)] = { es: [2400, 600, 600], ja: [900, 900, 0] };
  }
  window.__store[`e:${day(0)}|und|mystery`] = { k: "mystery", d: day(0), l: "und", s: 420, t: "Untitled stream", u: "", h: "twitch.tv", ts: Date.now() };
}
