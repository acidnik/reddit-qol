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
  - comment gif: shreddit-comment > figure.rte-media > a > div > shreddit-async-loader > shreddit-player[gif][src=external-preview.redd.it/<hash>.gif?width=..&format=mp4&s=..]; the <video> is in shreddit-player's SHADOW root, parked at preload="metadata" with no src until play -> black square. Priming = video.preload='auto' + video.src = video[src] || player[src] + video.load() (browser then paints frame 0). NEVER play()/pause() during priming: shreddit-player hides its play button once it believes it is playing, clicks then land on the bare <video> (no toggle handler) and the gif can never be started by hand again. The real toggle is a BUTTON inside shreddit-media-ui, same shadow root
  - url upgrade: preview.redd.it/<slug>-v0-<id>.<ext> -> i.redd.it/<id>.<ext>; composer/clipboard uploads (comment images) drop the slug -> preview.redd.it/<id>.<ext>, same mapping, take the LAST path segment
  - never edit params of a signed reddit media url: preview/external-preview carry `s=` over the exact query, so stripping width/crop (or even `s` staying put but width removed) yields 403. Only i.redd.it originals are param-free; for anything else hand the url over untouched and keep the page's own src as a viewer fallback (imgEl.onerror)
  - built-in lightbox: blocks the "real" one with a document-level capture-phase click listener

## "More replies" / comments DOM specifics (learned the hard way)

- TWO render paths for "N more replies":
    - native in-place loader: button inside faceplate-partial[src=/svc/shreddit/more-comments/r/<sub>/t3_<postid>?sort=CONFIDENCE&startingDepth=N&commentParentPositions=...]  — expands natively, batches can be large; DO NOT intercept buttons without the action attr
    - deep/legacy: div.fold-more + a[slot=more-comments-permalink] with href ?force-legacy-sct=1 (in ff the anchor is often hidden w=0; the clickable is a BUTTON wrapped in faceplate-tracker[noun=more_replies][action=click] — tracked FULL navigation)
- expansion mechanism (userscript): hidden same-origin iframe with the legacy url (~3.5s client render), harvest the root's replies by slot prefix `children-t1_<cid>`, graft before the fold row; if the thread has more batches the fold stays and gets clicked again; slot names are deterministic and match the live parent by construction
- transplant MUST use document.importNode (clone) — adoptNode carries iframe-bound listeners; after iframe.remove() they become dead closures: clicks silently do nothing. Cloned custom elements re-register in the main document, so faceplate-partial inside transplanted content comes alive
- click interception must run BEFORE reddit's handlers: `// @run-at document-start` + window-capture listener + stopImmediatePropagation (the faceplate-tracker capture listener registered earlier would otherwise stopPropagation-kill ours, and the full navigation wins); tampermonkey injects the script twice — dedupe with window.__rlLoaded at the top of the closure
- any exception thrown before preventDefault inside the click hook = untracked navigation; guard every step, and on failure do NOTHING (never fall back to navigation silently)
- comment identity: shreddit-comment[thingid=t1_<id>] (attr `thingid`, not `id`); reply slots: children-t1_<parent-id>-N; nested comments render as details[open] > summary + div children container
- headless chromium tests often can't reach deep folds: they live below the viewport — scroll-and-recheck in a loop; "43 more replies"-style buttons may exist only in the real ff DOM after navigation

use excessive logging to be able to solve complicated cases, ask user to reproduce and provide logs
