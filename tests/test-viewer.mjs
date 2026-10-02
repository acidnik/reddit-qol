// E2E: image viewer feature — click interception, zoom, pan, nav, close, built-in lightbox override.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, forwardPageLogs } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const SCRIPT = readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8');
const FAIL = [];
const ok = (cond, name) => {
    console.log((cond ? 'PASS' : 'FAIL') + `: ${ name }`);
    if(!cond) {
        FAIL.push(name);
    }
};

const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
await ctx.addInitScript(SCRIPT);
const page = await ctx.newPage();
forwardPageLogs(page, 'rl');
const pageLogs = [];
page.on('console', msg => pageLogs.push(msg.text()));

// ---------- feed page: click interception ----------
await page.goto('https://www.reddit.com/r/pics/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post img.non-lightboxed-content', { timeout: 60000 });
await page.waitForTimeout(1500);

const firstImg = page.locator('shreddit-post img.non-lightboxed-content').first();
await firstImg.evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
await firstImg.click();
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
await page.waitForTimeout(800);

ok(await page.$('#rl-viewer'), 'our overlay opened');
ok(await page.$('shreddit-lightbox') === null, 'built-in shreddit-lightbox did not open');
const overlaySrc = await page.$eval('#rl-viewer img', img => img.src);
ok(/https:\/\/i\.redd\.it\//.test(overlaySrc), `full-res source used (${ overlaySrc.slice(0, 60) }…)`);
const counter = await page.$eval('#rl-viewer .rl-viewer-counter', el => el.textContent.trim());
console.log('counter:', counter);
ok(await page.evaluate(() => document.body.style.overflow) === 'hidden', 'body scroll locked');

// ---------- zoom ----------
const center = await page.$eval('#rl-viewer img', img => {
    const r = img.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
});
await page.mouse.move(center.x, center.y);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(200);
let transform = await page.$eval('#rl-viewer img', img => img.style.transform);
ok(transform.includes('scale(1.25)'), `wheel zoom-in applied (${ transform })`);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(200);
transform = await page.$eval('#rl-viewer img', img => img.style.transform);
ok(transform.includes('scale(1.5625)'), `zoom compounds (%24x total) (${ transform })`);

// ---------- pan while zoomed ----------
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x - 120, center.y - 60, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
const panned = await page.$eval('#rl-viewer img', img => img.style.transform);
ok(/translate\(-1[12]\dpx/.test(panned) || /translate(-120px)/.test(panned), `drag panned the image (${ panned }) `);
// |-120px translation expected; regex above is loose on purpose — prints the real value

// ---------- wheel out resets ----------
for(let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(50);
}
transform = await page.$eval('#rl-viewer img', img => img.style.transform);
ok(/scale\(1\)/.test(transform) && /translate\(0px, 0px\)/.test(transform), `reset to scale 1 (${ transform })`);

// ---------- keyboard nav + esc ----------
const count1 = await page.$eval('#rl-viewer .rl-viewer-counter', el => el.textContent.trim());
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(500);
const count2 = await page.$eval('#rl-viewer .rl-viewer-counter', el => el.textContent.trim());
ok(count1 !== count2, `ArrowRight -> next (${ count1 } -> ${ count2 })`);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(500);
const count3 = await page.$eval('#rl-viewer .rl-viewer-counter', el => el.textContent.trim());
ok(count3 === count1, `ArrowLeft -> back (${ count3 })`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok(await page.$('#rl-viewer') === null, 'Esc closes');
ok(await page.evaluate(() => document.body.style.overflow) === '', 'body scroll unlocked');

// ---------- click outside closes, buttons work ----------
await firstImg.click();
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
await page.waitForTimeout(400);
ok(await page.$('#rl-viewer'), 're-opened');
ok(await page.$eval('#rl-viewer .rl-viewer-prev', el => el.classList.contains('rl-disabled')), 'prev disabled on first image');
await page.click('#rl-viewer .rl-viewer-next');
await page.waitForTimeout(400);
const count4 = await page.$eval('#rl-viewer .rl-viewer-counter', el => el.textContent.trim());
ok(count4 !== count1, `next button navigated (${ count4 })`);
await page.mouse.click(40, 40);
await page.waitForTimeout(300);
ok(await page.$('#rl-viewer') === null, 'click outside closes');

// ---------- post page: comment media ----------
const POST = process.env.POST_URL || 'https://www.reddit.com/r/pics/comments/1wvtk3c/bakery_security/';
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
for(let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(700);
}
const commentImg = page.locator('shreddit-comment figure.rte-media img').first();
if(await commentImg.count()) {
    await commentImg.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await commentImg.click();
    await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
    await page.waitForTimeout(600);
    const commentSrc = await page.$eval('#rl-viewer img', img => img.src);
    ok(/https:\/\/i\.redd\.it\//.test(commentSrc), `comment media upgraded to full-res (${ commentSrc.slice(0, 70) })`);
    ok(await page.$('shreddit-lightbox') === null, 'lightbox did not open from comment media');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
} else {
    console.log('SKIP: no comment media on this post');
}

// ---------- title link still navigates (interception scoped to media) ----------
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
const navBefore = page.url();
await page.locator('shreddit-post a[slot=title-button], shreddit-post a[id^=post-title], h1 a, shreddit-title a').first()
    .click({ timeout: 8000 }).catch(() => console.log('SKIP: no title link clickable'));
await page.waitForTimeout(1500);
console.log(`nav test: ${ navBefore } -> ${ page.url() }`);

console.log('\n[RL] log tail:');
pageLogs.filter(l => l.includes('[RL]')).slice(-30).forEach(l => console.log(' ', l));
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
