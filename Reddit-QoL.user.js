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
            entries.push({ el, url: resolveFull(el) });
        }
        // feed + top post: walk media containers so galleries keep their page order
        document.querySelectorAll('shreddit-post').forEach(post => {
            const container = post.querySelector('[slot=post-media-container]');
            if(!container) {
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
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        #rl-viewer .rl-viewer-img {
            max-width: calc(100vw - 40px);
            max-height: calc(100vh - 40px);
            width: auto;
            height: auto;
            user-select: none;
            -webkit-user-drag: none;
            cursor: zoom-in;
        }
        #rl-viewer .rl-viewer-img.rl-draggable {
            cursor: grab;
        }
        #rl-viewer .rl-viewer-toolbar {
            position: fixed;
            bottom: 12px;
            left: 50%;
            transform: translateX(-50%);
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
        #rl-viewer .rl-viewer-counter {
            min-width: 52px;
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
        #rl-viewer .rl-viewer-btn:hover {
            background: rgba(255, 255, 255, 0.18);
        }
        #rl-viewer .rl-viewer-btn.rl-disabled {
            opacity: 0.35;
            pointer-events: none;
        }
    `;

    function ensureViewer() {
        if(!document.getElementById('rl-viewer-style')) {
            const style = document.createElement('style');
            style.id = 'rl-viewer-style';
            style.textContent = css;
            document.documentElement.appendChild(style);
            log('styles injected');
        }
        if(overlay) {
            return overlay;
        }
        overlay = document.createElement('div');
        overlay.id = 'rl-viewer';
        overlay.innerHTML = `
            <div class="rl-viewer-canvas">
                <img class="rl-viewer-img" alt="">
            </div>
            <div class="rl-viewer-toolbar">
                <span class="rl-viewer-counter"></span>
                <a class="rl-viewer-btn rl-viewer-prev" title="Previous image (←)">‹</a>
                <a class="rl-viewer-btn rl-viewer-next" title="Next image (→)">›</a>
                <a class="rl-viewer-btn rl-viewer-open" title="Open the source page">↗</a>
                <a class="rl-viewer-btn rl-viewer-download" title="Download original">⬇</a>
                <a class="rl-viewer-btn rl-viewer-close" title="Close (Esc)">×</a>
            </div>`;
        imgEl = overlay.querySelector('.rl-viewer-img');
        counterEl = overlay.querySelector('.rl-viewer-counter');
        prevBtn = overlay.querySelector('.rl-viewer-prev');
        nextBtn = overlay.querySelector('.rl-viewer-next');
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
            dragging = true;
            dragStartX = e.clientX - panX;
            dragStartY = e.clientY - panY;
            imgEl.classList.toggle('rl-draggable', scale > 1);
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
                log('drag end');
            }
        });
        // click anywhere outside the image closes; the toolbar buttons run their own handlers first
        overlay.addEventListener('click', e => {
            if(e.target === imgEl || imgEl.contains(e.target) || e.target.closest('.rl-viewer-toolbar')) {
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
        const newScale = Math.min(16, Math.max(1, scale * factor));
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

    function applyTransform() {
        imgEl.style.transform = `translate(${ panX }px, ${ panY }px) scale(${ scale })`;
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
        imgEl.src = entry.url;
        log('show', i + 1, '/', entries.length, entry.url.slice(0, 80));
        counterEl.textContent = `${ i + 1 } / ${ entries.length }`;
        prevBtn.classList.toggle('rl-disabled', i === 0);
        nextBtn.classList.toggle('rl-disabled', i === entries.length - 1);
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
        const el = hit.tagName === 'IMG' ? hit : hit.querySelector('img');
        if(!el) {
            log('clicked container has no img, skipping', hit.tagName);
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
            collected.push({ el, url: resolveFull(el) });
            idx = collected.length - 1;
        }
        entries = collected;
        openViewer(idx, collected);
    }, true);
})();
