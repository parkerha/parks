# Lingua Watch

A Firefox extension that tracks how much time you spend watching videos in each language: YouTube, Netflix, and any other site that uses an HTML5 `<video>`.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and choose `manifest.json` from this folder.

Or run `npm start` (uses `web-ext run`). To build a zip for signing, run `npm run build`.

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

## Using it

- **Toolbar badge** shows the language code of the video playing in the current tab.
- **Popup** shows what's playing, the language and how it was detected, and today's, this week's or all-time totals by language. You can correct the language for this video or set a default for the whole site.
- **Dashboard** (from the popup or the add-on's preferences) has:
  - totals and a stacked daily chart by language (with a table view)
  - a list of every video, where you can change a video's language and all its time moves with it
  - site rules and settings
  - JSON backup/import and CSV export

All data stays in `browser.storage.local` on your machine. Nothing is sent anywhere.

## Development

```
npm test            # unit tests (node:test)
node test/e2e/run.js  # plays a real video in Chromium with a stubbed WebExtension API
npm run lint        # web-ext lint
```

Layout:
- `src/content.js`: site adapters (YouTube, Netflix, generic) and the playback timer
- `src/background.js`: storage writes (serialized), text language detection, the badge
- `src/lib/`: shared pure helpers (`languages.js`, `stats.js`, `tracker.js`) and UI helpers
- `src/popup/`, `src/dashboard/`: the UI

Storage: one entry per (day, language, video) under `e:<day>|<lang>|<videoKey>`. Everything else is computed from those entries.

## Limitations

- The YouTube and Netflix integrations read player internals through Firefox's `wrappedJSObject`. If those sites change their players, detection falls back to text detection (YouTube), or to your site rule or "Unknown" (Netflix).
- Prime Video, Disney+, Max and similar sites use the generic adapter. Their pages usually don't say what language is playing, so add a site rule or set the language per video.
- A video that switches language partway through gets split correctly only when the audio track changes, e.g. you switch dubs.
