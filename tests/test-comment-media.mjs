// E2E: comment inline media opens in the viewer at full res.
// Regression: comment images uploaded via the composer live on preview.redd.it WITHOUT the
// "<slug>-v0-" prefix ("<id>.<ext>"), and our old param-stripping fallback broke their signature
// (403), so the viewer showed nothing. They must map to i.redd.it/<id>.<ext> instead.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const SCRIPT = readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8');
const THREAD_URL = process.env.THREAD_URL ||
    'https://www.reddit.com/r/KafkaFPS/comments/1wvz3io/%D0%BC%D0%B5%D0%BC/';
const FAIL = [];
const ok = (cond, name) => {
    console.log((cond ? 'PASS' : 'FAIL') + `: ${ name }`);
    if(!cond) {
        FAIL.push(name);
    }
};

const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
await parkOutOfTheWay();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
await ctx.addInitScript(SCRIPT);
const page = await ctx.newPage();
forwardPageLogs(page, 'rl');
const pageLogs = [];
page.on('console', msg => pageLogs.push(msg.text()));

await page.goto(THREAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(3000);

const media = page.locator('shreddit-comment figure.rte-media img');
const total = await media.count();
console.log('comment media found:', total);
if(!total) {
    console.log('SKIP: no comment media in this thread');
    await browser.close();
    process.exit(0);
}

// lazy imgs only start loading near the viewport — walk them into view like a reader would
for(let i = 0; i < total; i++) {
    await media.nth(i).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(1200);
}
const pageSrcs = await page.evaluate(() =>
    [...document.querySelectorAll('shreddit-comment figure.rte-media img')].map(img => img.getAttribute('src') || ''));
console.log('page sources:', pageSrcs.map(s => s.slice(0, 70)));
ok(pageSrcs.every(s => /preview\.redd\.it\/[^/]+\.\w+/.test(s)),
    'all comment sources are on preview.redd.it (the no-preload case)');

// ---------- open the first comment image in the viewer ----------
await media.first().evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(500);
await media.first().click();
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
await page.waitForTimeout(1500);

ok(await page.$('#rl-viewer'), 'viewer opened from a comment image');
const state = () => page.evaluate(() => {
    const img = document.querySelector('#rl-viewer img');
    return {
        src: img.src,
        natural: `${ img.naturalWidth }x${ img.naturalHeight }`,
        complete: img.complete,
        dims: document.querySelector('#rl-viewer .rl-viewer-dims').textContent,
        counter: document.querySelector('#rl-viewer .rl-viewer-counter').textContent
    };
});
let st = await state();
console.log('viewer state 1:', JSON.stringify(st));
ok(/^https:\/\/i\.redd\.it\//.test(st.src), `viewer used the i.redd.it original (${ st.src.slice(0, 70) })`);
ok(/\d+x\d+/.test(st.natural) && !/^0x/.test(st.natural), `image actually decoded (${ st.natural })`);
ok(st.dims !== 'failed to load', 'no load-failure state');

// ---------- every comment image must render, walking with the viewer's own next button ----------
for(let i = 1; i < total; i++) {
    await page.locator('#rl-viewer .rl-viewer-next').click();
    await page.waitForTimeout(1800);
    st = await state();
    console.log(`viewer state ${ i + 1 }:`, JSON.stringify(st));
    ok(!/^0x/.test(st.natural) && st.dims !== 'failed to load', `image ${ i + 1 } rendered (${ st.natural })`);
    ok(/^https:\/\/i\.redd\.it\//.test(st.src), `image ${ i + 1 } used the full-res original`);
}

console.log('\n[RL] log tail:');
pageLogs.filter(l => l.includes('[RL]')).slice(-25).forEach(l => console.log(' ', l));
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
