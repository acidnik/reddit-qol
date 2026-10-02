Structure:
- Reddit-QoL.user.js — the userscript (vanilla JS, no build step, use edit tools directly)
- tools/lib/ — playwright helpers for test/probe scripts
- tests/ — e2e tests + DOM probes (committed; tmp/ is for scratch only)
- Keep tests in tests/ when they contain no secrets; cookies are read from the Firefox profile at runtime, never logged or stored

Run a test: `HEADLESS=0 timeout 240 node tests/test-viewer.mjs` (~1-2 min, needs sqlite3 + Firefox profile with a valid reddit session; see tools/lib/cookies.mjs)

You MUST NOT commit/push unless the user says so in the current turn.

## Working with reddit data

- reddit blocks fresh/headless sessions ("Prove your humanity" wall, old.reddit -> 403). Tests get the user's real session via tools/lib/cookies.mjs (cookie expiry in Firefox cookies.sqlite is in MILLISECONDS — divide by 1000 for playwright).
- Use playwright (HEADLESS=0) or firefox mcp to peek at the real DOM before writing markup-coupled code.
- Shreddit DOM map:
  - post media container: shreddit-post [slot=post-media-container]
  - visible feed/post preview img: img.non-lightboxed-content
  - full-res preload already in DOM: hidden div.lightboxed-content img (i.redd.it url) — read it instead of re-constructing urls
  - galleries: gallery-carousel li[slot=page-N]; lazy pages have src="" until near viewport — resolve via their preloads
  - comment inline media: shreddit-comment figure.rte-media > a > img
  - url upgrade: preview.redd.it/<slug>-v0-<id>.<ext> -> i.redd.it/<id>.<ext>
  - built-in lightbox: blocks the "real" one with a document-level capture-phase click listener

use excessive logging to be able to solve complicated cases, ask user to reproduce and provide logs
