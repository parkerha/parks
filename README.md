# Lingua Watch

A Firefox extension that tracks how much time you spend watching videos in each language: YouTube, Netflix, and any other site that uses an HTML5 `<video>`.

## Install permanently (recommended)

Regular Firefox only keeps add-ons that Mozilla has signed. Signing is free, and an "unlisted" add-on stays private to you:

1. Back up existing data first: Dashboard → **Export backup (JSON)**.
2. Run `npm run build` to create `web-ext-artifacts/lingua_watch_video_time_by_language-<version>.zip`.
3. Go to <https://addons.mozilla.org/developers/addon/submit/distribution>, sign in, choose **On your own**, and upload the zip. Answer "No" to the source-code question, since the code isn't minified.
4. Signing usually takes a few minutes. Download the signed `.xpi` and open it in Firefox (drag it into a window or use File → Open File). Do this on every computer.
5. If the dashboard is empty, use **Import backup**.

For later updates, bump `version` in `manifest.json` and upload again. Firefox keeps your data, because the add-on ID (`lingua-watch@example.invalid`) stays the same. Don't change that ID: sync data is tied to it.

To sign from the command line instead, create API credentials at <https://addons.mozilla.org/developers/addon/api/key/> and run:

```
WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=... npm run sign
```

## Install temporarily (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and choose `manifest.json` from this folder.

Temporary add-ons are removed when Firefox closes. `npm start` launches a throwaway Firefox profile with the add-on loaded.

## How it works

A content script runs in every frame. It finds the video that is actually playing and adds up the seconds you watch. Every ~5 seconds, and whenever you pause, it reports those seconds to the background script, filed under that video's language.

**Time counting**
- Only playing time counts. Paused, buffering and ended videos are skipped.
- Seeking forward isn't counted as watched time, and neither is time while the computer is asleep. Each interval is the smaller of the wall-clock time and the video-time advance.
- Watching at 2× speed counts the real time you spent.
- By default, muted videos (autoplay previews) and YouTube ads are skipped. You can change this in the dashboard.

**Language detection.** Each video gets the strongest signal that's available:

| Priority | Source | Where |
|---|---|---|
| 1 | Your manual choice for this video | everywhere |
| 2 | The audio track that's playing | Netflix player API, YouTube multi-language audio, HTML `audioTracks` |
| 3 | Auto-generated captions (made from the speech) | YouTube |
| 4 | Your rule for the site (e.g. `crunchyroll.com → Japanese`) | everywhere |
| 5 | `inLanguage` metadata (schema.org JSON-LD / microdata) | generic sites |
| 6 | Title + description run through Firefox's built-in language detector | YouTube, generic sites |
| 7 | `<html lang>` | generic sites only |

Unknown languages are still tracked, under "Unknown". You can reassign them later.

**Subtitles.** Every second is also tagged with whether subtitles were on and in which language:
- YouTube: player caption state (including auto-translated captions), falling back to the CC button
- Netflix: the player's active timed-text track (forced narrative subtitles count as off)
- Other sites: standard HTML `<track>` subtitles that are showing. Players that draw their own captions can't be detected.

Total time is unchanged. The dashboard splits each language into *no subtitles*, *same-language subtitles* and *other-language subtitles*. A **Count** filter switches every chart and total to "without subtitles only" or "with subtitles only".

## Syncing between computers

Install the extension on each computer, sign in to the same Firefox account, and make sure **Add-ons** is checked under Firefox Sync settings. Totals in the popup and dashboard then combine all devices.

Firefox Sync gives each extension only 100 KB, so each device keeps its detailed per-video history locally and syncs a compact summary:
- seconds per day per language, with subtitle splits, for the last ~3 months
- monthly totals for anything older

That's about 3–5 KB per device for a year of heavy viewing.

- Site rules sync too. Per-video language corrections and settings stay local.
- The dashboard's **Devices** card lets you rename this device, remove old devices and sync immediately. It also has a device filter.
- Firefox uploads sync data on its own schedule, roughly every 10 minutes. A new number can take a while to show up on another device.
- Each computer needs a permanent install, so the extension must be signed (`npm run build`, then upload as an unlisted add-on on addons.mozilla.org). Temporary add-ons disappear when Firefox restarts.

## Using it

- **Toolbar badge** shows the language code of the video playing in the current tab.
- **Popup** shows what's playing, the language and how it was detected, and today's, this week's or all-time totals by language. You can correct the language for this video or set a default for the whole site.
- **Dashboard** (from the popup or the add-on's preferences) has:
  - totals and a stacked daily chart by language (with a table view)
  - a list of every video, where you can change a video's language and all its time moves with it
  - site rules and settings
  - JSON backup/import and CSV export

Detailed data stays in `browser.storage.local` on your machine. The only thing that leaves it is the daily summary sent through your own Firefox Sync account.

## Development

```
npm test            # unit tests (node:test)
node test/e2e/run.js  # plays a real video in Chromium with a stubbed WebExtension API
npm run lint        # web-ext lint
```

Layout:
- `src/content.js`: site adapters (YouTube, Netflix, generic) and the playback timer
- `src/background.js`: storage writes (serialized), text language detection, the badge
- `src/lib/`: shared pure helpers (`languages.js`, `stats.js`, `tracker.js`), `data.js` (combines local + synced data) and UI helpers
- `src/popup/`, `src/dashboard/`: the UI

Storage: one entry per (day, language, video) under `e:<day>|<lang>|<videoKey>`, including seconds with subtitles (`c`) and per-subtitle-language seconds (`cl`). Everything else is computed from those entries.

Sync keys: `dev:<id>` (name), `h:<id>:<YYYY-MMa|b>` (daily data per half-month), `a:<id>` (older monthly totals) and `siteRules`.

## Limitations

- The YouTube and Netflix integrations read player internals through Firefox's `wrappedJSObject`. If those sites change their players, detection falls back to text detection (YouTube), or to your site rule or "Unknown" (Netflix).
- Prime Video, Disney+, Max and similar sites use the generic adapter. Their pages usually don't say what language is playing, so add a site rule or set the language per video.
- A video that switches language partway through gets split correctly only when the audio track changes, e.g. you switch dubs.
