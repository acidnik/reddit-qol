// ==UserScript==
// @name         Reddit QoL
// @namespace    http://tampermonkey.net/
// @version      1.0.3
// @updateURL    https://github.com/acidnik/reddit-qol/raw/refs/heads/main/Reddit-QoL.user.js
// @downloadURL  https://github.com/acidnik/reddit-qol/raw/refs/heads/main/Reddit-QoL.user.js
// @run-at       document-start
// @description  try to take over the world!
// @author       Nikita Bilous <nikita@bilous.me>
// @match        https://www.reddit.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=reddit.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // tampermonkey may inject the script twice (page + content contexts); one is enough —
    // double registrations meant double iframes and duplicated grafts
    if(window.__rlLoaded) {
        return;
    }
    window.__rlLoaded = true;

    const LOG_PREFIX = '[RL]';
    let verbose = true;
    function log(...args) {
        if(verbose) {
            console.debug(LOG_PREFIX, ...args);
        }
    }
    function logErr(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    // ==================== image collection ====================

    // true for any redd.it media host (preview, external-preview, full-res i.redd.it)
    function isRedditMedia(src) {
        try {
            return /(?:^|\.)redd\.it$/.test(new URL(src, location.origin).host || '');
        } catch {
            return false;
        }
    }

    // Only preview.redd.it names map onto an i.redd.it original, and the id is the last path
    // segment: "<slug>-v0-<id>.<ext>" for most posts, but a bare "<id>.<ext>" for images
    // uploaded in a comment (clipboard/composer) — the slug is simply absent there.
    function upgradeToFull(src) {
        try {
            const u = new URL(src, location.origin);
            if(u.host === 'i.redd.it') {
                return u.href;
            }
            if(u.host !== 'preview.redd.it') {
                // external-preview.redd.it thumbs and off-site images are signed: any param edit
                // breaks the signature (403), so hand the URL over exactly as the page got it
                return u.href;
            }
            const segment = u.pathname.split('/').pop() || '';
            const m = segment.match(/^(?:.*-v0-)?([A-Za-z0-9]+)\.([A-Za-z0-9]+)$/);
            if(!m) {
                return u.href;
            }
            const full = new URL(`https://i.redd.it/${ m[1] }.${ m[2] }`);
            log('upgraded source to full', src.slice(0, 60), '->', full.href);
            return full.href;
        } catch {
            return src;
        }
    }

    // Reddit preloads the full-res copy of post media in a hidden `div.lightboxed-content`
    // (posts and gallery pages). Comment media has no preload, so fall back to URL upgrading.
    function resolveFull(el) {
        // the text body is its own scope: without it a post-body image would fall back to the whole
        // post and could pick up the preload of an unrelated media-container image
        const ctx = el.closest('li[slot], [slot=post-media-container], [slot=text-body], [slot=comment]') ||
            el.closest('shreddit-post');
        const preloaded = ctx && ctx.querySelector('div.lightboxed-content img:not([src=""])');
        const direct = preloaded ? (preloaded.currentSrc || preloaded.getAttribute('src')) : null;
        if(direct && isRedditMedia(direct)) {
            return direct;
        }
        return upgradeToFull(el.currentSrc || el.src || '');
    }

    // One "entry" = a viewable image, in DOM order (feed posts, gallery pages, comment inline media)
    function collectEntries() {
        const entries = [];
        const seen = new Set();
        let skipCount = 0;
        function add(el) {
            if(!el) {
                return;
            }
            const raw = el.currentSrc || el.src || '';
            const key = raw.split('?')[0];
            if(!isRedditMedia(raw) || seen.has(key)) {
                skipCount += 1;
                return;
            }
            seen.add(key);
            entries.push({ el, url: resolveFull(el), src: raw, post: el.closest('shreddit-post') });
        }
        // feed + top post: walk media containers so galleries keep their page order
        document.querySelectorAll('shreddit-post').forEach(post => {
            const container = post.querySelector('[slot=post-media-container]');
            if(!container) {
                return;
            }
            // video posts own the click (native player); their poster img is not a viewer image
            if(container.querySelector('shreddit-player, shreddit-player-2, shreddit-video, video')) {
                log('video post — not a viewer image:', (post.getAttribute('post-title') || '').slice(0, 40));
                return;
            }
            const previews = container.querySelectorAll('img.non-lightboxed-content');
            if(previews.length) {
                previews.forEach(preview => {
                    // lazy gallery pages keep an empty src until scrolled near; recover the url
                    // from that page's hidden full-res preload
                    if(!(preview.currentSrc || preview.getAttribute('src'))) {
                        const page = preview.closest('li[slot]');
                        const preload = page && page.querySelector('div.lightboxed-content img');
                        if(preload && (preload.currentSrc || preload.getAttribute('src'))) {
                            add(preload);
                            return;
                        }
                    }
                    add(preview);
                });
            } else {
                container.querySelectorAll('img').forEach(add);
            }
        });
        // images embedded in the post's own markdown body (they sit in [slot=text-body], inside an
        // <a target="_blank"> — without this the click leaves for a new tab instead of the viewer)
        document.querySelectorAll('shreddit-post [slot=text-body] img').forEach(add);
        // inline images inside comments (figure.rte-media wraps them in an <a>)
        document.querySelectorAll('shreddit-comment figure.rte-media img, shreddit-comment-parser img').forEach(add);
        log('collected entries:', entries.length, '(skipped', skipCount, 'non-media/duplicate)');
        return entries;
    }

    // ==================== viewer state ====================

    let entries = [];
    let index = 0;
    let isOpen = false;
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;

    // ==================== UI ====================

    let overlay = null;
    let imgEl = null;
    let counterEl = null;
    let dimsEl = null;
    let zoomEl = null;
    let canvasEl = null;
    let titlebarEl = null;
    let postCounterEl = null;
    let titleEl = null;
    let currentPostEl = null;
    let prevBtn = null;
    let nextBtn = null;
    let keyHandler = null;

    const css = `
        #rl-viewer {
            position: fixed;
            z-index: 2147483647;
            inset: 0;
            background: rgba(0, 0, 0, 0.88);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: default;
        }
        #rl-viewer .rl-viewer-canvas {
            position: absolute;
            inset: 0 0 96px 0;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        #rl-viewer .rl-viewer-img {
            max-width: calc(100vw - 40px);
            /* leave room for the bottom toolbar so the image never eats into it */
            max-height: calc(100vh - 136px);
            width: auto;
            height: auto;
            user-select: none;
            -webkit-user-drag: none;
            cursor: default;
        }
        #rl-viewer .rl-viewer-canvas {
            cursor: default;
        }
        #rl-viewer.rl-panning {
            cursor: grabbing;
        }
        #rl-viewer.rl-panning * {
            cursor: grabbing !important;
        }
        /* two stacked rows: title row above, buttons row sets the width */
        #rl-viewer .rl-viewer-hud {
            position: fixed;
            bottom: 12px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            flex-direction: column;
            align-items: stretch;
            gap: 4px;
            z-index: 2147483647;
        }
        #rl-viewer .rl-viewer-titlebar {
            /* absolute above the buttons row: a long title must never stretch the hud width,
               the bottom row alone defines the panel size */
            position: absolute;
            left: 0;
            right: 0;
            bottom: calc(100% + 4px);
            display: flex;
            align-items: baseline;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            background: rgba(20, 20, 20, 0.85);
            color: #eee;
            font: 14px/1.2 sans-serif;
            overflow: hidden;
            cursor: pointer;
        }
        #rl-viewer .rl-viewer-postcounter {
            white-space: pre;
            opacity: 0.85;
        }
        #rl-viewer .rl-viewer-title {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            min-width: 0;
        }
        #rl-viewer .rl-viewer-toolbar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border-radius: 20px;
            background: rgba(20, 20, 20, 0.85);
            color: #eee;
            font: 14px/1 sans-serif;
            z-index: 2147483647;
        }
        #rl-viewer .rl-viewer-btn:hover {
            background: rgba(255, 255, 255, 0.18);
        }
        #rl-viewer .rl-viewer-btn.rl-disabled {
            opacity: 0.35;
            pointer-events: none;
        }
        .rl-sort-sub {
            position: fixed;
            z-index: 2147483646;
            display: none;
            margin: 0;
            padding: 4px 0;
            list-style: none;
            min-width: 140px;
            overflow: hidden;
        }
        .rl-sort-sub li {
            list-style: none;
            margin: 0;
        }
        .rl-sort-sub a {
            display: block;
            text-decoration: none;
            white-space: nowrap;
            cursor: pointer;
        }
        .rl-sort-sub a:hover {
            background: var(--color-neutral-background-hover, rgba(0, 0, 0, 0.08));
        }
        /* Deep nesting: the reply container of a too-narrow comment is pulled back onto the level-0
           box — --rl-pull-left slides it left, and the width makes its right edge land on the box's
           right edge (percentages here resolve against the grid area the block lives in) */
        .rl-unindent {
            margin-left: calc(-1 * var(--rl-pull-left, 0px));
            width: calc(100% + var(--rl-pull-left, 0px) - var(--rl-pull-right, 0px));
            /* Sliding left puts the block over the ancestor comments' threadline strips: absolute,
               z-index 1, cursor-pointer, spanning the whole thread — they painted over the shifted
               comments and swallowed their clicks (and lighting up their hover highlight made the
               thread line show through the text). Lift the block above them and fill it with the
               page background, so the strips it covers are neither visible nor clickable there. */
            position: relative;
            z-index: 2;
            background: var(--color-neutral-background, #fff);
        }
        /* "N more replies" folds we expand ourselves: the legacy page needs seconds to render,
           so the link is swapped for a spinner instead of leaving the click without feedback */
        .rl-fold-loading a,
        .rl-fold-loading button {
            display: none;
        }
        .rl-fold-loading-label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 0;
            font-size: 12px;
            color: var(--color-neutral-content-weak, #7a7a7a);
        }
        .rl-fold-spinner {
            width: 12px;
            height: 12px;
            border: 2px solid currentColor;
            border-top-color: transparent;
            border-radius: 50%;
            animation: rl-fold-spin 0.7s linear infinite;
        }
        @keyframes rl-fold-spin {
            to {
                transform: rotate(360deg);
            }
        }
        .rl-post-author {
            color: var(--color-neutral-content-weak, #777);
            font-size: inherit;
            text-decoration: none;
        }
        .rl-post-author:hover {
            text-decoration: underline;
        }
        .rl-post-author-sep {
            opacity: 0.6;
            margin: 0 2px;
        }
        .rl-sub-arrow {
            /* absolutely positioned inside the (relative) Top link: dead-center vertically,
               no layout impact from the 3em glyph */
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 3em;
            line-height: 1;
            opacity: 0.65;
        }
        html.rl-swapping main {
            opacity: 0.5;
        }
        #rl-viewer .rl-viewer-counter,
        #rl-viewer .rl-viewer-info {
            font-variant-numeric: tabular-nums;
        }
        /* pinned widths: counter/zoom text changes must never shift the buttons */
        #rl-viewer .rl-viewer-info {
            width: 168px;
            display: inline-flex;
            justify-content: space-between;
            gap: 6px;
            white-space: pre;
        }
        #rl-viewer .rl-viewer-dims {
            flex: 1;
            text-align: left;
            overflow: hidden;
        }
        #rl-viewer .rl-viewer-zoom {
            width: 5ch;
            text-align: right;
        }
        #rl-viewer .rl-viewer-counter {
            min-width: 56px;
            text-align: center;
            opacity: 0.85;
            margin-right: 6px;
        }
        #rl-viewer .rl-viewer-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            cursor: pointer;
            color: #eee;
            text-decoration: none;
            font-size: 18px;
            transition: background 0.15s;
        }
    `;

    // style sheet is needed on page load already (sort submenu), not only when the viewer opens
    function ensureStyles() {
        if(!document.getElementById('rl-viewer-style')) {
            const style = document.createElement('style');
            style.id = 'rl-viewer-style';
            style.textContent = css;
            document.documentElement.appendChild(style);
            log('styles injected');
        }
    }

    function ensureViewer() {
        ensureStyles();
        if(overlay) {
            return overlay;
        }
        overlay = document.createElement('div');
        overlay.id = 'rl-viewer';
        overlay.innerHTML = `
            <div class="rl-viewer-canvas">
                <img class="rl-viewer-img" alt="">
            </div>
            <div class="rl-viewer-hud">
                <div class="rl-viewer-titlebar">
                    <span class="rl-viewer-postcounter"></span>
                    <span class="rl-viewer-title"></span>
                </div>
                <div class="rl-viewer-toolbar">
                    <span class="rl-viewer-info">
                        <span class="rl-viewer-dims"></span>
                        <span class="rl-viewer-zoom"></span>
                    </span>
                    <span class="rl-viewer-counter"></span>
                    <a class="rl-viewer-btn rl-viewer-prev" title="Previous image (←)">‹</a>
                    <a class="rl-viewer-btn rl-viewer-next" title="Next image (→)">›</a>
                    <a class="rl-viewer-btn rl-viewer-open" title="Open the source page">↗</a>
                    <a class="rl-viewer-btn rl-viewer-download" title="Download original">⬇</a>
                    <a class="rl-viewer-btn rl-viewer-close" title="Close (Esc)">×</a>
                </div>
            </div>`;

        imgEl = overlay.querySelector('.rl-viewer-img');
        // нативный браузерный HTML5 drag выключаем на <img> атрибутом (Firefox игнорирует
        // -webkit-user-drag из css) и ещё одним dragstart preventDefault под страховку
        imgEl.draggable = false;
        overlay.addEventListener('dragstart', e => {
            e.preventDefault();
            log('native image drag suppressed');
        });
        counterEl = overlay.querySelector('.rl-viewer-counter');
        titlebarEl = overlay.querySelector('.rl-viewer-titlebar');
        postCounterEl = overlay.querySelector('.rl-viewer-postcounter');
        titleEl = overlay.querySelector('.rl-viewer-title');
        canvasEl = overlay.querySelector('.rl-viewer-canvas');
        dimsEl = overlay.querySelector('.rl-viewer-dims');
        zoomEl = overlay.querySelector('.rl-viewer-zoom');
        prevBtn = overlay.querySelector('.rl-viewer-prev');
        nextBtn = overlay.querySelector('.rl-viewer-next');
        // click on the title row: close the viewer and reveal the post in the feed
        titlebarEl.addEventListener('click', e => {
            e.stopPropagation();
            const post = currentPostEl;
            log('titlebar click -> close & scroll to post', !!post);
            closeViewer();
            if(post) {
                post.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }
        });
        // px dimensions in the info span; zoom updates on every transform change
        imgEl.onload = () => {
            dimsEl.textContent = `${ imgEl.naturalWidth }×${ imgEl.naturalHeight }`;
            applyTransform();
            log('loaded', imgEl.naturalWidth, 'x', imgEl.naturalHeight);
        };
        // the full-res guess can 404 (a preview id with no i.redd.it twin, a gate, ...): retry the
        // source the page itself used, exactly once per entry. Errors from a previous image that
        // arrive after a nav must not hijack the current one.
        imgEl.onerror = () => {
            const entry = entries[index];
            if(!entry || imgEl.getAttribute('src') !== entry.url) {
                logErr('stale image load error, ignored');
                return;
            }
            if(entry.src && entry.src !== entry.url && !entry.fallbackTried) {
                entry.fallbackTried = true;
                log('full-res failed, retrying the page source', entry.src.slice(0, 80));
                imgEl.src = entry.src;
                return;
            }
            logErr('viewer image failed to load:', entry.url.slice(0, 120));
            dimsEl.textContent = 'failed to load';
        };
        overlay.querySelector('.rl-viewer-close').addEventListener('click', closeViewer);
        prevBtn.addEventListener('click', () => nav(-1));
        nextBtn.addEventListener('click', () => nav(1));

        // zoom via wheel, always absorbed so the page underneath never scrolls
        overlay.addEventListener('wheel', e => {
            e.preventDefault();
            e.stopPropagation();
            applyWheelZoom(e);
        }, { passive: false });
        // pan by dragging while zoomed: pointer events cover mouse + touch
        overlay.addEventListener('pointerdown', e => {
            if(e.target !== imgEl && !imgEl.contains(e.target)) {
                return;
            }
            if(scale === 1) {
                log('pointerdown at scale 1 — no pan, wheel to zoom first');
                return;
            }
            dragging = true;
            dragStartX = e.clientX - panX;
            dragStartY = e.clientY - panY;
            overlay.classList.add('rl-panning');
            imgEl.setPointerCapture(e.pointerId);
            log('drag start', 'scale =', scale);
        });
        overlay.addEventListener('pointermove', e => {
            if(!dragging) {
                return;
            }
            panX = e.clientX - dragStartX;
            panY = e.clientY - dragStartY;
            applyTransform();
            log('drag move dx =', Math.round(panX), 'dy =', Math.round(panY));
        });
        overlay.addEventListener('pointerup', e => {
            if(dragging) {
                dragging = false;
                overlay.classList.remove('rl-panning');
                log('drag end');
            }
        });
        // the class must not stay if the gesture is cancelled mid-drag (e.g. browser takes over)
        overlay.addEventListener('pointercancel', () => {
            dragging = false;
            overlay.classList.remove('rl-panning');
            log('drag cancelled');
        });
        // click anywhere outside the image closes; the toolbar buttons run their own handlers first
        overlay.addEventListener('click', e => {
            if(e.target === imgEl || imgEl.contains(e.target) || e.target.closest('.rl-viewer-hud')) {
                log('click on image/toolbar — not closing');
                return;
            }
            log('click outside image — closing');
            closeViewer();
        });
        // ctrl+click follows the image link instead of zooming (as with any <a>)
        imgEl.addEventListener('click', e => {
            if(e.ctrlKey) {
                log('ctrl+click on image — follow link');
                e.stopPropagation();
                closeViewer();
            }
        });
        document.documentElement.appendChild(overlay);
        log('viewer created');
        return overlay;
    }

    // zoom toward/away from the cursor point
    function applyWheelZoom(e) {
        const oldScale = scale;
        const factor = e.deltaY < 0 ? 1.25 : 0.8;
        let newScale = Math.min(16, Math.max(1, scale * factor));
        // don't wheel past the 1:1 pixel view: land exactly on 100% when a step crosses it.
        // eps keeps float noise (scale*fit = 0.9999999) from re-triggering the snap forever.
        // standing exactly at 100% and wheeling out must go DOWN freely — snap only on crossing
        const fit = fitScaleFactor();
        if(fit && fit < 1) {
            // the displayed percent is rounded, so "100%" on screen covers r in [0.995, 1.005]
            const eps = 5e-3;
            const rOld = scale * fit;
            const rNew = newScale * fit;
            if((rOld < 1 - eps && rNew >= 1) || (rOld > 1 + eps && rNew <= 1)) {
                newScale = 1 / fit;
                log('wheel zoom snapped to 100% (1:1)');
            }
        }
        if(newScale === oldScale) {
            log('wheel zoom clamped at', oldScale);
            return;
        }
        const rect = imgEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        // keep the point under the cursor stationary: T' = T - (cursor - T)(S'-S)/S
        panX = scale === 1 ? 0 : panX - dx * (newScale - scale) / scale;
        panY = scale === 1 ? 0 : panY - dy * (newScale - scale) / scale;
        scale = newScale;
        if(scale === 1) {
            panX = 0;
            panY = 0;
        }
        applyTransform();
        log('wheel zoom', factor, '-> scale =', scale.toFixed(2));
    }

    // zoom % semantics: 100% = one image pixel per screen pixel; the fitted view reports its
    // actual downscale (e.g. a 4k image on a 2k screen opens as 47%)
    function fitScaleFactor() {
        const nw = imgEl.naturalWidth;
        const nh = imgEl.naturalHeight;
        if(!nw || !nh || !canvasEl || !canvasEl.clientWidth) {
            return null;
        }
        return Math.min(canvasEl.clientWidth / nw, canvasEl.clientHeight / nh, 1);
    }

    function currentZoomPercent() {
        const fit = fitScaleFactor();
        return fit === null ? null : Math.round(scale * fit * 100);
    }

    function applyTransform() {
        imgEl.style.transform = `translate(${ panX }px, ${ panY }px) scale(${ scale })`;
        if(zoomEl) {
            const p = currentZoomPercent();
            zoomEl.textContent = p === null ? '' : `${ p }%`;
        }
    }

    // load & display entry `i`
    function show(i) {
        index = i;
        const entry = entries[i];
        if(!entry) {
            return;
        }
        scale = 1;
        panX = 0;
        panY = 0;
        applyTransform();
        dimsEl.textContent = '';
        imgEl.src = entry.url;
        log('show', i + 1, '/', entries.length, entry.url.slice(0, 80));
        counterEl.textContent = `${ i + 1 } / ${ entries.length }`;
        prevBtn.classList.toggle('rl-disabled', i === 0);
        nextBtn.classList.toggle('rl-disabled', i === entries.length - 1);
        // title row shows only in the feed: [image-in-post] post title, clipped to fit the bar
        const inFeed = entry.post && entry.post.closest('shreddit-feed');
        currentPostEl = entry.post;
        titlebarEl.style.display = inFeed ? '' : 'none';
        if(inFeed) {
            const postImages = entries.filter(e => e.post === entry.post);
            const postIdx = postImages.indexOf(entry) + 1;
            postCounterEl.textContent = `[${ postIdx }/${ postImages.length }]`;
            titleEl.textContent = entry.post.getAttribute('post-title') || '';
            log('title row:', `[${ postIdx }/${ postImages.length }]`, titleEl.textContent.slice(0, 50));
        }
        // spec: "opens at its source post URL" — derive permalink from the clicked element
        const post = entry.el && entry.el.closest('shreddit-post');
        overlay.querySelector('.rl-viewer-open').href =
            post ? new URL(post.getAttribute('permalink') || '', location.origin).href : entry.url;
        overlay.querySelector('.rl-viewer-download').href = entry.url;
        overlay.querySelector('.rl-viewer-download').download = '';
        // preload neighbours so nav feels instant
        [i - 1, i + 1].forEach(j => {
            if(j >= 0 && j < entries.length && !entries[j].preloaded) {
                const im = new Image();
                im.onload = () => log('preloaded', j + 1, entries[j].url.slice(0, 60));
                im.src = entries[j].url;
                entries[j].preloaded = true;
            }
        });
    }

    function nav(delta) {
        const next = index + delta;
        if(next < 0 || next >= entries.length) {
            log('nav blocked at boundary', index, '->', next);
            return;
        }
        show(next);
    }

    function openViewer(startIndex, collected) {
        ensureViewer();
        // re-collect on every open: SPA feeds add/remove posts constantly
        entries = collected || collectEntries();
        if(!entries.length) {
            log('no viewable media found, aborting open');
            return;
        }
        startIndex = Math.max(0, Math.min(startIndex, entries.length - 1));
        if(!isOpen) {
            isOpen = true;
            document.documentElement.classList.add('rl-viewer-opened');
            document.body.style.cssText += '; overflow: hidden !important;';
            keyHandler = onKeyDown;
            document.addEventListener('keydown', keyHandler, true);
        }
        show(startIndex);
    }

    function closeViewer() {
        if(!isOpen) {
            return;
        }
        isOpen = false;
        dragging = false;
        document.documentElement.classList.remove('rl-viewer-opened');
        document.body.style.overflow = '';
        document.removeEventListener('keydown', keyHandler, true);
        overlay.remove();
        overlay = null;
        entries = [];
        log('viewer closed');
    }

    function onKeyDown(e) {
        if(!isOpen) {
            return;
        }
        if(e.key === 'Escape') {
            log('keydown Esc -> close');
            e.preventDefault();
            e.stopPropagation();
            closeViewer();
        } else if(e.key === 'ArrowLeft') {
            log('keydown ArrowLeft -> prev');
            e.preventDefault();
            e.stopPropagation();
            nav(-1);
        } else if(e.key === 'ArrowRight') {
            log('keydown ArrowRight -> next');
            e.preventDefault();
            e.stopPropagation();
            nav(1);
        }
    }

    // ==================== interception ====================

    // One capture-phase click hook is cheaper and covers every marked element.
    // The built-in lightbox chokes on custom stickers or slow loading (unknown why),
    // so we sidestep it entirely and run our own.
    const INTERCEPT_SELECTOR = `
        shreddit-post [slot=post-media-container],
        shreddit-post [slot=text-body] img,
        shreddit-comment figure.rte-media img,
        shreddit-comment-parser img
    `.trim();

    function interceptable(target) {
        const hit = target && target.closest && target.closest(INTERCEPT_SELECTOR);
        if(!hit) {
            return null;
        }
        // video posts own the click: native player must keep its standard behavior
        if(target.closest && target.closest('shreddit-player, shreddit-player-2, shreddit-video, video')) {
            log('click on video markup — passed through to reddit');
            return null;
        }
        // gallery carousels embed full-res preloads we must not intercept on their own elements
        if(hit.closest('.rl-viewer') || hit.closest('shreddit-lightbox')) {
            return null;
        }
        return hit;
    }

    // The gallery arrows render inside the gallery-carousel shadow root as
    // <span slot="nextButton">/<span slot="prevButton"> wrappers. Their clicks retarget to the
    // host, so `closest` cannot see them, and a capture-phase stopPropagation at the document
    // would kill the arrow's own handler (our modal opened instead of the carousel advancing).
    const CAROUSEL_NAV_SELECTOR = '[slot=nextButton], [slot=prevButton]';
    function isCarouselNavClick(e) {
        const path = (e.composedPath && e.composedPath()) || [];
        return path.some(node => node && node.nodeType === 1 && node.closest && node.closest(CAROUSEL_NAV_SELECTOR));
    }

    document.addEventListener('click', e => {
        if(e.ctrlKey) {
            log('ctrl+click — let the link through to', (e.target.closest('a') || {}).href);
            return;
        }
        if(isCarouselNavClick(e)) {
            log('click on native carousel arrow — passed through to reddit');
            return;
        }
        const hit = interceptable(e.target);
        if(!hit) {
            return;
        }
        // second video line of defense: the container itself holds a player
        const el = hit.tagName === 'IMG' ? hit : hit.querySelector('img');
        if(!el || hit.querySelector('shreddit-player, shreddit-player-2, shreddit-video, video')) {
            log('video/empty container — passed through', hit.tagName);
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        log('intercepted click on', el.tagName, (el.currentSrc || el.src || '').slice(0, 60));
        // index inside the freshly collected set; gallery pages map by their preview img
        const collected = collectEntries();
        let idx = collected.findIndex(entry => entry.el === el);
        if(idx === -1) {
            const srcKey = (el.currentSrc || el.src || '').split('?')[0];
            idx = collected.findIndex(entry => ((entry.el.currentSrc || entry.el.src || '').split('?')[0]) === srcKey);
        }
        if(idx === -1) {
            log('clicked media not in collection, appending');
            collected.push({ el, url: resolveFull(el), src: (el.currentSrc || el.src || ''), post: el.closest('shreddit-post') });
            idx = collected.length - 1;
        }
        entries = collected;
        openViewer(idx, collected);
    }, true);

    // ==================== sort submenu: Top -> time range, SPA feed swap ====================

    // Reddit offers no time-range choice on default feeds: you must click Top (a page load),
    // then open another dropdown and pick the range (another page load). We add a nested
    // hover submenu on the Top item and swap the feed in place instead of reloading.
    const RANGE_ITEMS = [
        ['Now', 'hour'],
        ['Today', 'day'],
        ['This Week', 'week'],
        ['This Month', 'month'],
        ['This Year', 'year'],
        ['All Time', 'all']
    ];

    // the parent panel paints its background outside the li ancestor chain (portal/slot),
    // so sample the rendered panel by point while the menu is open
    // item look is copied from the Top link each time it becomes visible: after an spa swap
    // the header can be injected while still unstyled (default link blue, zero padding)
    function applyItemStyles(sub, topLink) {
        if(sub.dataset.itemStylesApplied) {
            return;
        }
        const s = getComputedStyle(topLink);
        if(!s.paddingTop || s.paddingTop === '0px') {
            return;
        }
        sub.querySelectorAll('a').forEach(a => {
            a.style.padding = `${ s.paddingTop } ${ s.paddingRight } ${ s.paddingBottom } ${ s.paddingLeft }`;
            a.style.color = s.color;
            a.style.font = s.font;
        });
        sub.dataset.itemStylesApplied = '1';
        log('submenu item styles applied');
    }

    function applyMenuChrome(sub, li) {
        if(sub.dataset.chromeApplied) {
            return;
        }
        // the rendered panel is a faceplate-menu inside the (open) shadow root of the dropdown;
        // light-dom ancestors are all transparent, so query the shadow menu directly
        const dd = li.closest('shreddit-sort-dropdown');
        const menu = dd && dd.shadowRoot && dd.shadowRoot.querySelector('faceplate-menu');
        if(!menu) {
            return;
        }
        const s = getComputedStyle(menu);
        sub.style.background = s.backgroundColor;
        sub.style.borderRadius = s.borderRadius === '0px' ? '8px' : s.borderRadius;
        sub.style.boxShadow = s.boxShadow === 'none' ? '0 4px 16px rgba(0, 0, 0, 0.25)' : s.boxShadow;
        sub.style.color = s.color;
        sub.dataset.chromeApplied = '1';
        log('submenu chrome copied from faceplate-menu');
    }

    function positionSubmenu(sub, li) {
        const r = li.getBoundingClientRect();
        sub.style.top = `${ Math.max(4, Math.min(r.top, innerHeight - 220)) }px`;
        // prefer the right side; flip left near the viewport edge
        if(r.right + 160 < innerWidth) {
            sub.style.left = `${ r.right }px`;
        } else {
            sub.style.left = `${ Math.max(4, r.left - 150) }px`;
        }
    }

    function injectSortSubmenus() {
        // on a top/?t=month page reddit renders the menu link as /top/?t=month — match the
        // path, not the raw href
        document.querySelectorAll('a[href*="/top/"]').forEach(topLink => {
            if(!/\/top\/?$/.test(new URL(topLink.href, location.origin).pathname)) {
                return;
            }
            const li = topLink.closest('li');
            if(!li || li.classList.contains('rl-has-sub') ||
                !li.closest('shreddit-sort-dropdown, shreddit-async-loader')) {
                return;
            }
            // NOTE: reddit renders several instances (mobile + desktop), some hidden or far
            // off-screen; each li gets its own submenu and only shows it from its own hover,
            // so no global "visible instance" filtering is needed here
            li.classList.add('rl-has-sub');
            // arrow on the Top item: there is a nested menu now
            if(!topLink.querySelector('.rl-sub-arrow')) {
                const arrow = document.createElement('span');
                arrow.className = 'rl-sub-arrow';
                arrow.textContent = '▸';
                topLink.appendChild(arrow);
            }
            const sub = document.createElement('ul');
            sub.className = 'rl-sort-sub';
            RANGE_ITEMS.forEach(([label, t]) => {
                const item = document.createElement('li');
                const a = document.createElement('a');
                a.href = `${ topLink.href.split('?')[0] }?t=${ t }`;
                a.textContent = label;
                a.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    sub.style.display = 'none';
                    swapFeed(a.href);
                });
                item.appendChild(a);
                sub.appendChild(item);
            });
            // body-level panel: reddit's dropdown containers clip absolutely-positioned children
            document.body.appendChild(sub);
            let hideTimer = null;
            const show = () => {
                clearTimeout(hideTimer);
                positionSubmenu(sub, li);
                applyMenuChrome(sub, li);
                applyItemStyles(sub, topLink);
                sub.style.display = 'block';
            };
            const hideSoon = () => {
                clearTimeout(hideTimer);
                hideTimer = setTimeout(() => { sub.style.display = 'none'; }, 150);
            };
            li.addEventListener('mouseenter', show);
            li.addEventListener('mouseleave', hideSoon);
            sub.addEventListener('mouseenter', () => clearTimeout(hideTimer));
            sub.addEventListener('mouseleave', hideSoon);
            log('sort submenu injected:', topLink.href);
        });
    }

    // ==================== post author on the home feed ====================

    // the home feed credit bar shows only the subreddit; the author is right there in the
    // shreddit-post[author] attribute — surface it as a u/ link next to the subreddit
    function injectPostAuthors() {
        document.querySelectorAll('shreddit-post[author]').forEach(post => {
            if(post.dataset.rlAuthorDone) {
                return;
            }
            const credit = post.querySelector('[slot=credit-bar]');
            if(!credit) {
                return;
            }
            const author = post.getAttribute('author');
            const subLink = credit.querySelector('a[href*="/comments/"], a[href^="/r/"], a[href*="/r/"]');
            if(!subLink || credit.querySelector('.rl-post-author')) {
                post.dataset.rlAuthorDone = '1';
                return;
            }
            const sep = document.createElement('span');
            sep.className = 'rl-post-author-sep';
            sep.textContent = '•';
            const a = document.createElement('a');
            a.className = 'rl-post-author';
            a.href = `/user/${ author }/`;
            a.textContent = `u/${ author }`;
            a.addEventListener('click', e => e.stopPropagation());
            // credit bar layout: subreddit ... time — put the author right after the subreddit
            subLink.after(sep, a, ' ');
            post.dataset.rlAuthorDone = '1';
            log('author chip added:', author, 'in', post.getAttribute('subreddit-prefixed-name') || '');
        });
    }

    function stripRangeParams(u) {
        ['t', 'screen_view_count', 'ext-referrer'].forEach(p => u.searchParams.delete(p));
        return u;
    }

    // leaving Top for another sort must not drag the time range (and tracking junk) along
    document.addEventListener('click', e => {
        if(e.ctrlKey || e.defaultPrevented) {
            return;
        }
        const a = e.target.closest && e.target.closest('a[href*="/best/"], a[href*="/hot/"], a[href*="/new/"], a[href*="/rising/"]');
        if(!a || !document.querySelector('shreddit-feed')) {
            return;
        }
        const url = new URL(a.href, location.origin);
        const isSortListing = /\/(best|hot|new|rising)\/?$/.test(url.pathname);
        if(!isSortListing || (!url.searchParams.has('t') && !url.searchParams.has('screen_view_count'))) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        swapFeed(stripRangeParams(url).href);
    }, true);

    // ==================== dynamic "more replies" (no legacy page reload) ====================

    // ==================== dynamic "more replies": true in-place expansion via hidden iframe ========

    // Deep "N more replies" folds are anchors with force-legacy-sct=1 — a full page load to a
    // minimal subthread page. That page renders its slice of comments client-side, so: load it
    // in a hidden same-origin iframe, harvest the rendered reply subtrees (slot names match the
    // live parent by construction), graft them into the fold position and drop the iframe.
    // Folds inside the grafted content are intercepted again -> arbitrary depth, all in place.
    // The force-legacy link of ONE fold row. reddit ships the same fold in several dresses: the
    // anchor may be zero-sized with the visible text in a button next to/inside it, and that button
    // can be wrapped in a faceplate-tracker[noun=more_replies][action=click]. The action attr is
    // NOT a tell: the native in-place loader (faceplate-partial[src=/svc/shreddit/more-comments/..])
    // carries it too. Only the row's own markup tells the variants apart. Searching ancestors'
    // subtrees for the link (the old findCommentHref) grabbed an unrelated fold's anchor on pages
    // with hundreds of folds and grafted the wrong subthread into the wrong place.
    function rowAnchor(row) {
        const a = row.querySelector('a[slot=more-comments-permalink], a.more-comments-link, a[href*="/comment/"][href*="force-legacy-sct"]');
        if(a && a.href && a.href.includes('force-legacy-sct')) {
            return a;
        }
        // a partial whose src names one comment is the same fold in another dress
        const src = row.getAttribute && row.getAttribute('src');
        const m = src && decodeURIComponent(src).match(/comment\/([^/?]+)/);
        return m ? { href: new URL(`comment/${ m[1] }/?force-legacy-sct=1`, location.origin).href, virtual: true } : null;
    }

    // compact identity of a node for logs
    function describeEl(el, len = 200) {
        if(!el || !el.tagName) {
            return String(el);
        }
        const cls = (el.getAttribute('class') || '').split(' ').slice(0, 3).join('.');
        const slot = el.getAttribute('slot') ? `[slot=${ el.getAttribute('slot') }]` : '';
        return `<${ el.tagName.toLowerCase() }${ slot }${ cls ? '.' + cls : '' }> ${ (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, len) }`;
    }

    // reddit's native in-place loader: the partial fetches its own slice (/svc/shreddit/more-comments)
    // and swaps it in, so that click must stay untouched, action attr or not
    function isNativeLoaderRow(row) {
        const src = row.getAttribute && row.getAttribute('src');
        return !!(src && /\/svc\/shreddit\/more-comments\//.test(src));
    }

    // Last resort for a variant we do not know: the nearest ancestor of the clicked CONTROL whose
    // subtree carries a force-legacy link. Only ever called for a click that already landed on a
    // more-replies control, and it stops at the comment holding that control: a wider search finds
    // some unrelated fold's anchor on a comment page and would start a load on any click at all.
    function guessFoldRow(control) {
        let n = control;
        for(let i = 0; i < 5 && n && n !== document.body; i++, n = n.parentElement) {
            if(n.querySelector && n.querySelector('a[href*="force-legacy-sct"]')) {
                return n;
            }
            if(n.tagName === 'SHREDDIT-COMMENT') {
                break;
            }
        }
        return null;
    }

    // The click may land on the link, on a faceplate-tracker wrapper or on the row itself. The row
    // must be the OUTER wrapper: div.fold-more holds div[data-more-replies-link], and grafting
    // inside the inner one breaks fold-more's two-column grid — the absolutely positioned
    // threadline of the grafted comments then covers the link, so follow-up clicks hit that
    // overlay (the click "does nothing").
    function foldRowOf(fromEl) {
        if(!fromEl || !fromEl.closest) {
            return null;
        }
        return fromEl.closest('div.fold-more, faceplate-partial') ||
            fromEl.closest('div[data-more-replies-link]');
    }

    // The legacy page needs ~3.5s of client rendering; a silent click reads as "nothing happened".
    // We hide the link and show a spinner instead, and keep data-rl-busy so a second click on the
    // same fold is ignored rather than queued up. The target is usually the fold row, but for a
    // variant we cannot name it is whatever was clicked (a tracker around the link).
    function setFoldLoading(row, busy) {
        if(!row || !row.classList) {
            return;
        }
        if(busy) {
            row.dataset.rlBusy = '1';
            row.classList.add('rl-fold-loading');
            const holder = row.querySelector('div[data-more-replies-link]') || row;
            const label = document.createElement('span');
            label.className = 'rl-fold-loading-label';
            label.innerHTML = '<span class="rl-fold-spinner"></span>Loading…';
            holder.appendChild(label);
        } else {
            delete row.dataset.rlBusy;
            row.classList.remove('rl-fold-loading');
            row.querySelectorAll('.rl-fold-loading-label').forEach(n => n.remove());
        }
    }

    // Importing an already-rendered custom element re-runs its upgrade in this document, so
    // <faceplate-number number="34"> renders its value a second time and "34 more replies" turned
    // into "3434 more replies". Both runs write the same formatted string — keep the last one.
    function collapseDoubledNumbers(scope) {
        scope.querySelectorAll('faceplate-number').forEach(n => {
            const texts = [...n.childNodes].filter(c => c.nodeType === Node.TEXT_NODE && c.nodeValue.trim());
            texts.pop();
            texts.forEach(t => t.remove());
        });
    }

    // rowHint is the fold row, or — for a variant we could not name — whatever was clicked
    async function expandViaIframe(rowHint, href, cid) {
        const row = foldRowOf(rowHint);
        // graft position: as a SIBLING of the fold row, inside the tree slot; a nameless variant
        // has no wrapper to be a sibling of, so fall back to the clicked node's parent (the
        // placement the feature used before the row check existed — odd beats a dead click)
        const slot = (row && row.parentElement) || (rowHint && rowHint.parentElement);
        if(!slot) {
            logErr('no tree slot for', cid, '- doing nothing (no navigation)');
            return;
        }
        // what carries the loading state: the fold row, or the clicked link itself
        const stateful = row || rowHint;
        if(stateful.dataset && stateful.dataset.rlBusy === '1') {
            log('more-replies: fold already loading — click ignored');
            return;
        }
        setFoldLoading(stateful, true);
        const iframe = document.createElement('iframe');
        iframe.src = href;
        iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1280px;height:1000px;';
        document.body.appendChild(iframe);
        log('more-replies: iframe loading', href.slice(0, 80));
        const t0 = Date.now();
        let idoc = null;
        while(Date.now() - t0 < 20000) {
            await new Promise(r => setTimeout(r, 400));
            try {
                idoc = iframe.contentDocument;
            } catch(err) {
                break;
            }
            if(idoc && idoc.querySelector(`shreddit-comment[thingid="t1_${ cid }"]`) &&
                idoc.querySelectorAll('shreddit-comment').length > 0 && Date.now() - t0 > 2500) {
                break;
            }
        }
        const root = idoc && idoc.querySelector(`shreddit-comment[thingid="t1_${ cid }"]`);
        const rooted = root ? [...root.querySelectorAll('shreddit-comment')] : [];
        const present = id => !!document.querySelector(`shreddit-comment[thingid="${ id }"]`);
        // the legacy URL is stateless: loading it again returns the very same slice, so grafting
        // blindly would duplicate whole subtrees. Only take comments the page does not have yet.
        const replies = rooted.filter(r =>
            (r.getAttribute('slot') || '').startsWith(`children-t1_${ cid }`) &&
            !present(r.getAttribute('thingid')));
        if(!replies.length) {
            iframe.remove();
            setFoldLoading(stateful, false);
            if(!rooted.length) {
                logErr('iframe render failed for', cid, '- keeping the fold for another try');
                return;
            }
            // the slice is already on the page: this fold has nothing left to give, and leaving
            // the stale link behind only invites a click that would do nothing
            log('more-replies: no new replies for', cid, '- dropping the spent fold');
            removeSpent(stateful);
            return;
        }
        const frag = document.createDocumentFragment();
        const grafts = [];
        // importNode (clone, NOT adopt): listeners from the iframe context must not come along —
        // cloned custom elements re-register in this document and faceplate-partial machinery
        // re-attaches, so "+N more replies" buttons inside transplanted replies stay alive
        replies.forEach(r => {
            const clone = document.importNode(r, true);
            grafts.push(clone);
            frag.appendChild(clone);
        });
        // folds inside the grafted content carried listeners bound in the iframe context; after
        // iframe removal those are dead (click = silent nothing). Stamp them so the click
        // interceptor owns them.
        frag.querySelectorAll('div.fold-more').forEach(f => { f.dataset.rlFromIframe = '1'; });
        slot.insertBefore(frag, row);
        // the fold is spent — its batch is on the page, and the same URL yields nothing new.
        // Dropping it also stops the row from looking stuck after a finished load.
        removeSpent(stateful);
        iframe.remove();
        log('subthread grafted in place:', replies.length, 'replies for', cid);
        // the clones only upgrade (and render their numbers a second time) at the next microtask
        // checkpoint, so the doubled text shows up right after this task finishes
        await Promise.resolve();
        grafts.forEach(collapseDoubledNumbers);
    }

    // A fold we expanded is spent and its row goes away — but only a row we recognize as a fold
    // wrapper. For an unnamed variant the clicked node is dropped instead (it is the link itself),
    // and if even that looks unsafe the spinner is simply cleared.
    function removeSpent(stateful) {
        if(foldRowOf(stateful)) {
            stateful.remove();
        } else if(stateful.matches && stateful.matches('faceplate-tracker, button, a')) {
            stateful.remove();
        } else {
            setFoldLoading(stateful, false);
        }
    }

    window.addEventListener('click', e => {
        if(e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
            return;
        }
        // Only a click that lands on a more-replies control or on a fold row may be ours. This gate
        // is what keeps the rest of the page clickable: anything else returns before any lookup, so
        // an ordinary click can never be swallowed by a fold search.
        const target = e.target;
        const control = target.closest && target.closest(
            'a[slot=more-comments-permalink], a.more-comments-link, faceplate-tracker[noun="more_replies"], div[data-more-replies-link]');
        let row = target.closest && target.closest('div.fold-more, faceplate-partial, div[data-more-replies-link]');
        if(!control && !row) {
            return;
        }
        let anchor = row && rowAnchor(row);
        // the native in-place loader fetches its own slice — hand that click over untouched
        if(row && !anchor && isNativeLoaderRow(row)) {
            log('more-replies: native in-place row — left to reddit');
            return;
        }
        if(!anchor && control) {
            // the control is real but its row is not one we know: find the link it belongs to,
            // without leaving the comment the control sits in (logged — this path is a guess)
            const guessed = guessFoldRow(control);
            if(guessed) {
                log('more-replies: unrecognized fold row:', describeEl(guessed));
                row = guessed;
                anchor = rowAnchor(row);
            }
        }
        if(!anchor) {
            return;
        }
        const url = new URL(anchor.href, location.origin);
        if(!url.searchParams.has('force-legacy-sct')) {
            log('more-replies: row link has no force-legacy-sct — left to reddit');
            return;
        }
        // our expansion owns this click — no navigation, no dead iframe listeners
        e.preventDefault();
        e.stopImmediatePropagation();
        const cid = (url.pathname.match(/comment\/([^/?]+)/) || [])[1];
        const rowHint = row || e.target;
        expandViaIframe(rowHint, url.href, cid).catch(err => {
            // put the link back so the fold is clickable again instead of spinning forever
            setFoldLoading(foldRowOf(rowHint) || rowHint, false);
            logErr('iframe expansion failed:', err.message, '- doing nothing');
        });
    }, true);

    // hide stray submenus on any outside click (the host menu may close without a mouseleave)
    document.addEventListener('click', () => {
        document.querySelectorAll('.rl-sort-sub').forEach(s => { s.style.display = 'none'; });
    }, true);

    let lastSwapUrl = null;
    async function swapFeed(url) {
        try {
            log('spa feed swap ->', url);
            const main = document.querySelector('main');
            if(!main) {
                throw new Error('no main element');
            }
            document.documentElement.classList.add('rl-swapping');
            const res = await fetch(url, { credentials: 'same-origin' });
            if(!res.ok) {
                throw new Error(`http ${ res.status }`);
            }
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            const newMain = doc.querySelector('main');
            if(!newMain) {
                throw new Error('no main in fetched document');
            }
            main.replaceWith(newMain);
            history.pushState({}, '', url);
            lastSwapUrl = url;
            // the header can re-render lazily after the swap — re-inject on a short schedule
            scheduleReinject();
            setTimeout(injectPostAuthors, 0);
            log('feed swapped in place');
        } catch(err) {
            logErr('feed swap failed, falling back to full navigation:', err.message);
            location.href = url;
        } finally {
            document.documentElement.classList.remove('rl-swapping');
        }
    }

    window.addEventListener('popstate', () => {
        if(document.querySelector('shreddit-feed') && location.href !== lastSwapUrl) {
            swapFeed(location.href);
        }
    });

    // the dropdown content loads lazily (and re-renders after swaps) — poll briefly in
    // addition to the MutationObserver, since the loader activates on its own schedule
    function scheduleReinject() {
        let n = 0;
        const iv = setInterval(() => {
            injectSortSubmenus();
            if(++n >= 16) {
                clearInterval(iv);
            }
        }, 750);
    }

    // the script runs at document-start: body may not exist yet, and the dropdown content
    // loads lazily — install the observer as soon as body appears, inject as DOM settles
    function injectAll() {
        injectSortSubmenus();
        injectPostAuthors();
    }

    function startSortSubmenuWatching() {
        ensureStyles();
        injectAll();
        scheduleReinject();
        const subObserver = new MutationObserver(() => injectAll());
        subObserver.observe(document.body, { childList: true, subtree: true });
    }
    if(document.body) {
        startSortSubmenuWatching();
    } else {
        document.addEventListener('DOMContentLoaded', startSortSubmenuWatching, { once: true });
    }

    // ==================== comment gif priming ====================

    // A gif posted in a comment renders as shreddit-player with the <video> inside its shadow
    // root parked at preload="metadata" and no src until the user presses play, so the comment
    // shows a black square. Loading the data is enough for the browser to paint frame 0 — and we
    // must NOT play()/pause() it: shreddit-player hides its own play button once it believes it
    // is playing, after which clicks land on the bare <video> (no toggle handler) and the gif
    // can never be started by hand again.
    const GIF_PRIME_SELECTOR = 'shreddit-comment shreddit-player, shreddit-comment shreddit-player-2';
    const GIF_PRIME_THRESHOLD = 0.1;
    const GIF_PRIME_READY_STATE = 2;
    const GIF_PRIME_TRIES = 20;
    const GIF_PRIME_RETRY_MS = 300;
    const GIF_PRIME_SCAN_DEBOUNCE_MS = 200;

    // ONLY a gif may be primed. A real video in a comment is an HLS stream
    // (shreddit-player src=https://v.redd.it/link/<post>/asset/<id>/HLSPlaylist.m3u8?...) with
    // player-type="comment_player" and reddit's own poster — it already shows a frame. Priming it
    // meant assigning that manifest to the <video> (no browser plays HLS natively) plus
    // preload="auto", which parks the real player on a black frame forever.
    // A comment gif is `shreddit-player[gif]` with an external-preview.redd.it/<hash>.gif?...&format=mp4
    // source — a plain mp4 the browser decodes, which is the only reason priming works for it.
    function isGifPlayer(player) {
        if(player.hasAttribute('gif')) {
            return true;
        }
        const src = player.getAttribute('src') || '';
        return /external-preview\.redd\.it\//.test(src) && /\.gif(\?|$)/i.test(src) && /format=mp4/i.test(src);
    }

    // true once the player was handled (primed or nothing left to do), false to retry later
    function primeCommentGif(player) {
        if(!isGifPlayer(player)) {
            return true;   // a real video loads itself — never touch it
        }
        const video = player.shadowRoot && player.shadowRoot.querySelector('video');
        if(!video) {
            return false;   // the async loader has not built the shadow video yet
        }
        if(video.readyState >= GIF_PRIME_READY_STATE && video.videoWidth) {
            log('comment gif already has a frame, left alone');
            return true;
        }
        const src = video.getAttribute('src') || player.getAttribute('src');
        if(!src) {
            logErr('comment gif player has no src:', player.getAttribute('comment-id') || '(no comment-id)');
            return true;   // nothing to load — retrying will not help
        }
        log('priming comment gif', player.getAttribute('comment-id') || '', src.slice(0, 80));
        video.preload = 'auto';
        if(!video.getAttribute('src')) {
            video.src = src;
        }
        video.addEventListener('loadeddata', () => {
            log('comment gif frame ready', video.videoWidth, 'x', video.videoHeight);
            // we never started playback, so pin the visible frame to the very beginning
            if(video.paused && video.currentTime > 0) {
                video.currentTime = 0;
            }
        }, { once: true });
        video.load();
        return true;
    }

    function primeCommentGifWithRetries(player, attempt) {
        attempt = attempt || 0;
        if(!player.isConnected) {
            log('comment gif player left the DOM before priming, dropping it');
            return;
        }
        if(primeCommentGif(player)) {
            return;
        }
        if(attempt >= GIF_PRIME_TRIES) {
            logErr('comment gif never hydrated, giving up:', player.getAttribute('comment-id') || '(no comment-id)');
            return;
        }
        setTimeout(() => primeCommentGifWithRetries(player, attempt + 1), GIF_PRIME_RETRY_MS);
    }

    // gifs are primed when they scroll into view, never earlier: a comment page can hold dozens of
    // comments and priming them all would pull megabytes of video nobody asked to see
    let gifObserver = null;
    function observeCommentGifs() {
        if(!gifObserver) {
            gifObserver = new IntersectionObserver(visible => {
                visible.forEach(entry => {
                    if(!entry.isIntersecting) {
                        return;
                    }
                    // one shot per player: never fight shreddit-player's own state again
                    gifObserver.unobserve(entry.target);
                    primeCommentGifWithRetries(entry.target);
                });
            }, { threshold: GIF_PRIME_THRESHOLD });
        }
        document.querySelectorAll(GIF_PRIME_SELECTOR).forEach(player => {
            if(player.dataset.rlGifObserved || player.dataset.rlGifSkipped) {
                return;
            }
            if(!isGifPlayer(player)) {
                // a real comment video: log the variant once, never come back to it
                player.dataset.rlGifSkipped = '1';
                log('comment video is not a gif, left to reddit:', (player.getAttribute('src') || '').slice(0, 70));
                return;
            }
            player.dataset.rlGifObserved = '1';
            gifObserver.observe(player);
        });
    }

    // comments arrive through SPA feeds and through our own iframe "more replies" grafts, so the
    // scan has to keep running; it is debounced because reddit mutates the tree constantly
    function startGifPriming() {
        observeCommentGifs();
        let pending = null;
        const gifDomObserver = new MutationObserver(() => {
            if(pending) {
                return;
            }
            pending = setTimeout(() => {
                pending = null;
                observeCommentGifs();
            }, GIF_PRIME_SCAN_DEBOUNCE_MS);
        });
        gifDomObserver.observe(document.body, { childList: true, subtree: true });
    }
    if(document.body) {
        startGifPriming();
    } else {
        document.addEventListener('DOMContentLoaded', startGifPriming, { once: true });
    }

    // ==================== deep nesting: keep comments readable ====================

    // Every nesting level costs one indent gutter (32px at xs and up, 24px below): a reply is
    // `col-start-2` inside its parent's children grid, whose first column IS that gutter. So every
    // level walks the left edge 32px right and shrinks the text column by 32px — around depth 12 a
    // comment is narrower than MIN_COMMENT_WIDTH and a deep thread becomes a sliver of text.
    //
    // The fix: when a comment gets that narrow, pull the block that holds it (its parent, the
    // children grid) back to the level-0 box — same left edge, same right edge, same width as a
    // top-level comment. The subtree below it then has a fresh full-width budget, and the next
    // reset only happens ~11 levels further down.
    const MIN_COMMENT_WIDTH = 250;
    const INDENT_RESET_DEBOUNCE_MS = 200;

    let lastIndentSignature = null;
    let lastIndentLog = null;

    function resetDeepIndents(forced) {
        const comments = [...document.querySelectorAll('shreddit-comment')];
        if(!comments.length) {
            return;
        }
        // reddit mutates the tree constantly (timestamps, view counts) while the nesting itself
        // only moves when comments come or go, the marks are dropped by a re-render, or the
        // viewport changes. Skipping the sweep on an unchanged shape keeps this off the hot path —
        // the sweep costs a reflow per reset it applies.
        const signature = `${ comments.length }:${ innerWidth }:${ document.querySelectorAll('.rl-unindent').length }`;
        if(!forced && signature === lastIndentSignature) {
            return;
        }
        lastIndentSignature = signature;
        // our own pull must not feed back into the measurement — always start from the plain layout
        document.querySelectorAll('.rl-unindent').forEach(block => {
            block.classList.remove('rl-unindent');
            block.style.removeProperty('--rl-pull-left');
            block.style.removeProperty('--rl-pull-right');
        });
        // the box of a level-0 comment is the reference every reset aligns to
        const topLevel = comments.filter(c => c.parentElement && !c.parentElement.closest('shreddit-comment'));
        if(!topLevel.length) {
            lastIndentSignature = null;
            return;
        }
        const base = topLevel[0].getBoundingClientRect();
        if(!base.width) {
            // not laid out yet (hidden post, preview pane, ...): undo the signature so the next
            // mutation retries instead of skipping on an unchanged tree
            lastIndentSignature = null;
            return;
        }
        let resets = 0;
        // Document order matters: a shallower reset widens everything below it, so deeper comments
        // must be measured AFTER it was applied — that is what lands nested resets on the level-0
        // box instead of stacking their pulls and running off to the left.
        for(const comment of comments) {
            if(comment.parentElement && !comment.parentElement.closest('shreddit-comment')) {
                continue;   // top level: already full width
            }
            const rect = comment.getBoundingClientRect();
            if(rect.width <= 0 || rect.width >= MIN_COMMENT_WIDTH) {
                continue;   // wide enough, or not rendered (collapsed thread)
            }
            const block = comment.parentElement;
            if(!block || block === document.body || block.tagName === 'SHREDDIT-COMMENT' ||
                block.classList.contains('rl-unindent')) {
                continue;
            }
            const box = block.getBoundingClientRect();
            // how far the block has walked right, and how far it already sticks out on the right
            const pullLeft = Math.round(box.left - base.left);
            const pullRight = Math.round(box.right - base.right);
            if(pullLeft <= 0) {
                continue;   // already starts at the level-0 left edge
            }
            block.style.setProperty('--rl-pull-left', `${ pullLeft }px`);
            block.style.setProperty('--rl-pull-right', `${ Math.max(0, pullRight) }px`);
            block.classList.add('rl-unindent');
            resets++;
        }
        // the tree churns constantly, so only a changed set of resets is worth a log line
        const key = [...document.querySelectorAll('.rl-unindent')]
            .map(b => b.style.getPropertyValue('--rl-pull-left')).join(',');
        if(resets && key !== lastIndentLog) {
            lastIndentLog = key;
            log('deep nesting: pulled', resets, 'container(s) back to the level-0 width for comments under',
                MIN_COMMENT_WIDTH, 'px');
        }
    }

    // Comments arrive lazily and through our own grafts, SPA swaps rebuild the tree, and expanding
    // a collapsed thread only flips `open` — all of those can expose new deep comments. Only `open`
    // is watched as an attribute: our own class/style writes must not re-trigger the scan.
    function startIndentResets() {
        let pending = null;
        let forced = false;
        const schedule = mustRescan => {
            forced = forced || !!mustRescan;
            if(pending) {
                return;
            }
            pending = setTimeout(() => {
                pending = null;
                const force = forced;
                forced = false;
                resetDeepIndents(force);
            }, INDENT_RESET_DEBOUNCE_MS);
        };
        new MutationObserver(records => {
            // expanding a collapsed thread only flips `open` — the comment count stays the same
            schedule(records.some(r => r.type === 'attributes'));
        }).observe(document.body, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['open']
        });
        window.addEventListener('resize', schedule);
        schedule();
    }
    if(document.body) {
        startIndentResets();
    } else {
        document.addEventListener('DOMContentLoaded', startIndentResets, { once: true });
    }
})();
