// E2E: image viewer feature — click interception, zoom, pan, nav, close, built-in lightbox override.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
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
await parkOutOfTheWay();
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
ok(await page.$eval('#rl-viewer .rl-viewer-canvas', c => getComputedStyle(c).bottom) === '96px', 'canvas reserves the two-row hud');

// feed context: title row [image-in-post/total] + post title, width clipped by the buttons row
ok(await page.$eval('#rl-viewer .rl-viewer-titlebar', el => el.style.display) !== 'none', 'title row visible in feed');
const postCounter = await page.$eval('#rl-viewer .rl-viewer-postcounter', el => el.textContent.trim());
ok(/^\[\d+\/\d+\]$/.test(postCounter), `per-post image counter (${ postCounter })`);
const postTitle = await page.$eval('#rl-viewer .rl-viewer-title', el => el.textContent.trim());
ok(postTitle.length > 3, `post title shown (${ postTitle.slice(0, 40) })`);
const titlebarW = await page.$eval('#rl-viewer .rl-viewer-titlebar', el => Math.round(el.getBoundingClientRect().width));
const toolbarW = await page.$eval('#rl-viewer .rl-viewer-toolbar', el => Math.round(el.getBoundingClientRect().width));
ok(Math.abs(titlebarW - toolbarW) <= 2, `title row clipped to toolbar width (${ titlebarW } vs ${ toolbarW })`);

// a very long title must not stretch either row nor move the buttons
const btnLefts0 = await page.$eval('#rl-viewer .rl-viewer-toolbar', tb =>
    [...tb.querySelectorAll('.rl-viewer-btn')].map(b => Math.round(b.getBoundingClientRect().left)));
await page.$eval('#rl-viewer .rl-viewer-title', el => { el.textContent = 'Long '.repeat(120); });
await page.waitForTimeout(200);
const titlebarW2 = await page.$eval('#rl-viewer .rl-viewer-titlebar', el => Math.round(el.getBoundingClientRect().width));
const toolbarW2 = await page.$eval('#rl-viewer .rl-viewer-toolbar', el => Math.round(el.getBoundingClientRect().width));
const btnLefts1 = await page.$eval('#rl-viewer .rl-viewer-toolbar', tb =>
    [...tb.querySelectorAll('.rl-viewer-btn')].map(b => Math.round(b.getBoundingClientRect().left)));
ok(toolbarW2 === toolbarW, `toolbar width unchanged under long title (${ toolbarW } -> ${ toolbarW2 })`);
ok(titlebarW2 <= toolbarW2 + 2, `title row stays clipped (${ titlebarW2 })`);
ok(JSON.stringify(btnLefts0) === JSON.stringify(btnLefts1), 'buttons stay put under long title');

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

// ---------- native HTML5 image drag must not hijack the pointer ----------
await page.evaluate(() => {
    window.__dnd = 0;
    document.addEventListener('dragstart', () => window.__dnd++, true);
});
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x - 40, center.y, { steps: 3 });
await page.mouse.up();
const dnd = await page.evaluate(() => window.__dnd);
ok(dnd === 0, `no native browser dragstart while panning (count = ${ dnd | 0 })`);

// reset zoom/pan (pan persists between gestures by design, so start this check clean)
for(let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(50);
}

// ---------- pan while zoomed (needs a zoom first — pan is disabled at scale 1) ----------
await page.mouse.move(center.x, center.y);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(150);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(150);
await page.mouse.down();
await page.mouse.move(center.x - 120, center.y - 60, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
const panned = await page.$eval('#rl-viewer img', img => img.style.transform);
ok(/translate\(-1[12]\dpx/.test(panned) && !/scale\(1\)/.test(panned), `drag panned the zoomed image (${ panned })`);

// cursor protocol: default at rest -> grabbing mid-drag -> default after drag
const cursorAtRest = await page.$eval('#rl-viewer img', img => getComputedStyle(img).cursor);
await page.mouse.down();
const cursorDuring = await page.$eval('#rl-viewer img', img => getComputedStyle(img).cursor);
await page.mouse.up();
const cursorAfter = await page.$eval('#rl-viewer img', img => getComputedStyle(img).cursor);
ok(cursorAtRest === 'default', `default cursor at rest (${ cursorAtRest })`);
ok(cursorDuring === 'grabbing', `grabbing cursor mid-drag (${ cursorDuring })`);
ok(cursorAfter === 'default', `default cursor after drag (${ cursorAfter })`);

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

// toolbar info: dims + zoom; buttons must never shift on zoom/nav changes (click-in-place UX)
const dims = await page.$eval('#rl-viewer .rl-viewer-dims', el => el.textContent.trim());
ok(/^\d+×\d+$/.test(dims), `dims shown (${ dims })`);
// 1:1 semantics: open shows the REAL downscale of the fitted image (<100% for big images),
// and the percent matches fit-to-canvas math
const zoomAtOpen = await page.$eval('#rl-viewer .rl-viewer-zoom', el => el.textContent.trim());
const expectedFit = await page.$eval('#rl-viewer .rl-viewer-canvas', c => {
    const img = c.querySelector('img');
    return Math.round(Math.min(c.clientWidth / img.naturalWidth, c.clientHeight / img.naturalHeight, 1) * 100);
});
const zoomShown = await page.$eval('#rl-viewer .rl-viewer-zoom', el => parseInt(el.textContent, 10));
ok(zoomShown === expectedFit && zoomShown <= 100, `fit shows actual pixel downscale (${ zoomAtOpen }, fit math = ${ expectedFit }%)`);
const buttonsBefore = await page.$eval('#rl-viewer .rl-viewer-toolbar', tb =>
    [...tb.querySelectorAll('.rl-viewer-btn')].map(b => Math.round(b.getBoundingClientRect().left)));
const zoomBefore = await page.$eval('#rl-viewer .rl-viewer-zoom', el => el.textContent.trim());
await page.mouse.move(center.x, center.y);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(200);
const zoomAfter = await page.$eval('#rl-viewer .rl-viewer-zoom', el => el.textContent.trim());
ok(zoomAfter !== zoomBefore && /%$/.test(zoomAfter), `zoom indicator updates (${ zoomBefore } -> ${ zoomAfter })`);
const buttonsAfter = await page.$eval('#rl-viewer .rl-viewer-toolbar', tb =>
    [...tb.querySelectorAll('.rl-viewer-btn')].map(b => Math.round(b.getBoundingClientRect().left)));
ok(JSON.stringify(buttonsBefore) === JSON.stringify(buttonsAfter), `buttons stay put on zoom (${ buttonsAfter.join(',') })`);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(600);
const buttonsNav = await page.$eval('#rl-viewer .rl-viewer-toolbar', tb =>
    [...tb.querySelectorAll('.rl-viewer-btn')].map(b => Math.round(b.getBoundingClientRect().left)));
ok(JSON.stringify(buttonsNav) === JSON.stringify(buttonsBefore), 'buttons stay put on nav');
const dims2 = await page.$eval('#rl-viewer .rl-viewer-dims', el => el.textContent.trim());
ok(/^\d+×\d+$/.test(dims2), `dims refresh after nav (${ dims2 })`);
await page.keyboard.press('ArrowLeft');
await page.mouse.wheel(0, 300);
// titlebar styling matches the toolbar row
const titleFont = await page.$eval('#rl-viewer .rl-viewer-titlebar', el => getComputedStyle(el).fontSize);
const toolbarFont = await page.$eval('#rl-viewer .rl-viewer-toolbar', el => getComputedStyle(el).fontSize);
ok(titleFont === toolbarFont, `title row font matches toolbar (${ titleFont })`);
const titleColor = await page.$eval('#rl-viewer .rl-viewer-titlebar', el => getComputedStyle(el).color);
const toolbarColor = await page.$eval('#rl-viewer .rl-viewer-toolbar', el => getComputedStyle(el).color);
ok(titleColor === toolbarColor, `title row color matches toolbar (${ titleColor })`);

// click on the title row: modal closes and the feed scrolls to the post
await page.click('#rl-viewer .rl-viewer-titlebar');
await page.waitForTimeout(1500); // smooth scroll needs to settle before the next interactions
ok(await page.$('#rl-viewer') === null, 'titlebar click closes the modal');
const postVisible = await page.evaluate(() => {
    const post = [...document.querySelectorAll('shreddit-post')]
        .find(p => p.getBoundingClientRect().top >= -10 && p.getBoundingClientRect().top < innerHeight / 2 &&
            p.querySelector('[slot=post-media-container] img'));
    return !!post;
});
ok(postVisible, 'feed scrolled near the source post');

// pick a point that is verifiably not on the image/toolbar
const outside = await page.evaluate(() => {
    const candidates = [
        [window.innerWidth - 12, 12],
        [12, 12],
        [window.innerWidth - 12, window.innerHeight - 70],
        [12, window.innerHeight - 70]
    ];
    for(const [x, y] of candidates) {
        const el = document.elementFromPoint(x, y);
        if(el && (el.id === 'rl-viewer' || el.classList.contains('rl-viewer-canvas'))) {
            return { x, y };
        }
    }
    return { x: candidates[0][0], y: candidates[0][1] };
});
await page.mouse.click(outside.x, outside.y);
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
    ok(await page.$eval('#rl-viewer .rl-viewer-titlebar', el => el.style.display) === 'none', 'title row hidden inside a post page');
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
