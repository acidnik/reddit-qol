// ==UserScript==
// @name         Reddit QoL
// @namespace    http://tampermonkey.net/
// @version      2026-10-02
// @description  try to take over the world!
// @author       Nikita Bilous <nikita@bilous.me>
// @match        https://www.reddit.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=reddit.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

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

    // preview.redd.it URLs carry the file id in the path suffix: "<slug>-v0-<id>.<ext>".
    // The full-res original lives on i.redd.it/<id>.<ext>.
    function upgradeToFull(src) {
        try {
            const u = new URL(src, location.origin);
            if(u.host === 'i.redd.it') {
                return u.href;
            }
            const m = u.pathname.match(/^(?:.*)-v0-([^/]+)$/);
            if(m && u.host.endsWith('redd.it')) {
                const full = new URL(`https://i.redd.it/${ m[1] }`);
                log('upgraded source to full', src.slice(0, 60), '->', full.href);
                return full.href;
            }
            // fixed thumbs and external images: strip sizing params so the viewer gets the biggest render
            u.searchParams.delete('width');
            u.searchParams.delete('height');
            u.searchParams.delete('crop');
            u.searchParams.delete('frame');
            u.searchParams.delete('auto');
            return u.href;
        } catch {
            return src;
        }
    }

    // Reddit preloads the full-res copy of post media in a hidden `div.lightboxed-content`
    // (posts and gallery pages). Comment media has no preload, so fall back to URL upgrading.
    function resolveFull(el) {
        const ctx = el.closest('li[slot], [slot=post-media-container], [slot=comment]') || el.closest('shreddit-post');
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
            entries.push({ el, url: resolveFull(el), post: el.closest('shreddit-post') });
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

    document.addEventListener('click', e => {
        if(e.ctrlKey) {
            log('ctrl+click — let the link through to', (e.target.closest('a') || {}).href);
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
            collected.push({ el, url: resolveFull(el), post: el.closest('shreddit-post') });
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
    function startSortSubmenuWatching() {
        ensureStyles();
        injectSortSubmenus();
        scheduleReinject();
        const subObserver = new MutationObserver(() => injectSortSubmenus());
        subObserver.observe(document.body, { childList: true, subtree: true });
    }
    if(document.body) {
        startSortSubmenuWatching();
    } else {
        document.addEventListener('DOMContentLoaded', startSortSubmenuWatching, { once: true });
    }
})();
