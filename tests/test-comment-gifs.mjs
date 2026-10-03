// E2E: comment gifs show a frame instead of a black square.
// A comment gif is a shreddit-player whose shadow <video> sits at preload="metadata" with no src
// until the user presses play. We load the data on first scroll-into-view (and never play/pause,
// which would desync shreddit-player's own play button), so frame 0 is painted.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const SCRIPT = readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8');
const THREAD_URL = process.env.THREAD_URL ||
    'https://www.reddit.com/r/KafkaFPS/comments/1ww1nv3/%D0%BF%D0%BE%D1%87%D1%82%D0%B8_60_%D0%BC%D0%B8%D0%BB%D0%BB%D0%B8%D0%B0%D1%80%D0%B4%D0%BE%D0%B2_%D1%80%D1%83%D0%B1%D0%BB%D0%B5%D0%B9_%D0%BD%D0%B0_%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC%D1%83/';
const FAIL = [];
const ok = (cond, name) => {
    console.log((cond ? 'PASS' : 'FAIL') + `: ${ name }`);
    if(!cond) {
        FAIL.push(name);
    }
};

// mean luma of a PNG buffer (8-bit RGB/RGBA) — enough to tell a painted frame from a black square
function pngMeanLuma(buf) {
    let pos = 8;
    let w = 0;
    let h = 0;
    let colorType = 6;
    const idat = [];
    while(pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const chunk = buf.subarray(pos + 8, pos + 8 + len);
        if(type === 'IHDR') {
            w = chunk.readUInt32BE(0);
            h = chunk.readUInt32BE(4);
            colorType = chunk[9];
        } else if(type === 'IDAT') {
            idat.push(chunk);
        }
        pos += 12 + len;
    }
    const bpp = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);
    let i = 0;
    for(let y = 0; y < h; y++) {
        const filter = raw[i++];
        const line = Buffer.from(raw.subarray(i, i + stride));
        i += stride;
        for(let x = 0; x < stride; x++) {
            const a = x >= bpp ? line[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let add = 0;
            if(filter === 1) {
                add = a;
            } else if(filter === 2) {
                add = b;
            } else if(filter === 3) {
                add = (a + b) >> 1;
            } else if(filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                add = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            line[x] = (line[x] + add) & 0xff;
        }
        line.copy(out, y * stride);
        prev = line;
    }
    let sum = 0;
    let dark = 0;
    const pixels = w * h;
    for(let k = 0; k < out.length; k += bpp) {
        const luma = (out[k] * 0.299 + out[k + 1] * 0.587 + out[k + 2] * 0.114);
        sum += luma;
        if(luma < 12) {
            dark++;
        }
    }
    return { w, h, mean: sum / pixels, darkFraction: dark / pixels };
}

const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
await parkOutOfTheWay();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
await ctx.addInitScript(SCRIPT);
const page = await ctx.newPage();
forwardPageLogs(page, 'rl');
const pageLogs = [];
page.on('console', msg => pageLogs.push(msg.text()));

await page.goto(THREAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(3000);

const players = () => page.evaluate(() => {
    const list = [...document.querySelectorAll('shreddit-comment shreddit-player, shreddit-comment shreddit-player-2')];
    return list.map((p, i) => {
        const v = p.shadowRoot && p.shadowRoot.querySelector('video');
        const r = p.getBoundingClientRect();
        return {
            i,
            commentId: p.getAttribute('comment-id') || String(i),
            observed: p.dataset.rlGifObserved === '1',
            hasVideo: !!v,
            preload: v ? v.preload : null,
            readyState: v ? v.readyState : null,
            videoWidth: v ? v.videoWidth : 0,
            paused: v ? v.paused : null,
            currentTime: v ? +v.currentTime.toFixed(3) : null,
            top: Math.round(r.top),
            visible: r.top < window.innerHeight && r.bottom > 0
        };
    });
});

const all = await players();
console.log('comment gif players:', JSON.stringify(all));
if(!all.length) {
    console.log('SKIP: no comment gifs in this thread');
    await browser.close();
    process.exit(0);
}

// ---------- not primed before it is visible ----------
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1200);
const offscreen = (await players()).filter(p => !p.visible);
console.log('offscreen players:', JSON.stringify(offscreen));
if(offscreen.length) {
    ok(offscreen.every(p => p.observed), 'offscreen gifs are registered with the observer');
    ok(offscreen.every(p => p.readyState < 2 && !p.videoWidth), 'offscreen gifs stay unprimed (no early download)');
} else {
    console.log('SKIP: every comment gif is on screen right after load');
}

// ---------- primed on scroll into view ----------
const target = page.locator('shreddit-comment shreddit-player, shreddit-comment shreddit-player-2').last();
await target.evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForFunction(() => {
    const list = [...document.querySelectorAll('shreddit-comment shreddit-player, shreddit-comment shreddit-player-2')];
    return list.every(p => {
        const v = p.shadowRoot && p.shadowRoot.querySelector('video');
        const r = p.getBoundingClientRect();
        const visible = r.top < window.innerHeight && r.bottom > 0;
        return !visible || (v && v.readyState >= 2 && v.videoWidth > 0);
    });
}, { timeout: 20000 }).catch(() => console.log('(a visible gif never reached readyState>=2)'));

const primed = (await players()).filter(p => p.visible);
console.log('visible players after scroll:', JSON.stringify(primed));
ok(primed.length > 0, 'at least one gif is visible after scrolling');
ok(primed.every(p => p.readyState >= 2 && p.videoWidth > 0), 'visible gifs decoded a frame');
ok(primed.every(p => p.preload === 'auto'), 'visible gifs switched to preload=auto');
ok(primed.every(p => p.paused === true), 'priming never started playback');
ok(primed.every(p => p.currentTime === 0), 'frame pinned to the beginning');

// ---------- and that frame is not a black square ----------
const shot = await target.screenshot({ type: 'png' });
const luma = pngMeanLuma(shot);
console.log(`player screenshot: ${ luma.w }x${ luma.h }, mean luma ${ luma.mean.toFixed(1) }, dark ${ (luma.darkFraction * 100).toFixed(1) }%`);
ok(luma.mean > 40 && luma.darkFraction < 0.5, 'rendered frame is not a black square');

// ---------- the user's own click must still start playback ----------
await target.click({ position: { x: 60, y: 40 } });
await page.waitForTimeout(900);
const afterClick = (await players()).filter(p => p.visible);
console.log('after a real click:', JSON.stringify(afterClick));
ok(afterClick.some(p => p.paused === false && p.currentTime > 0), 'clicking the primed gif still starts playback');

console.log('\n[RL] log tail:');
pageLogs.filter(l => l.includes('[RL]')).slice(-20).forEach(l => console.log(' ', l));
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
