// E2E: native gallery carousel arrows must drive the carousel, not our viewer.
// Their wrappers (<span slot="nextButton">/<span slot="prevButton">) live in the
// gallery-carousel shadow root, so the document capture-phase hook has to let them through.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const SCRIPT = readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8');
const POST_URL = process.env.POST_URL ||
    'https://www.reddit.com/r/VintageDigitalCameras/comments/1wwe9m1/low_light_c5000z_nice_and_warm/';
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

await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post img.non-lightboxed-content', { timeout: 60000 });
await page.waitForTimeout(3000);

const carousel = page.locator('gallery-carousel').first();
if(!(await carousel.count())) {
    console.log('SKIP: no gallery-carousel on this post');
    await browser.close();
    process.exit(0);
}
await carousel.evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(800);

// reads the carousel state from the shadow root (page label + which page is visible)
const state = () => page.evaluate(() => {
    const c = document.querySelector('gallery-carousel');
    const fc = c && c.shadowRoot && c.shadowRoot.querySelector('faceplate-carousel');
    return {
        label: fc ? fc.getAttribute('current-aria-live-msg') : null,
        pages: [...c.querySelectorAll('li[slot^=page-]')].map(li => getComputedStyle(li).visibility),
        transform: c.querySelector('ul')?.style.transform
    };
});

const start = await state();
console.log('carousel start:', JSON.stringify(start));
ok(/Item 1 of/.test(start.label || ''), `carousel starts on page 1 (${ start.label })`);

// ---------- native next arrow: carousel advances, our viewer stays shut ----------
await page.locator('gallery-carousel [slot=nextButton] button').click();
await page.waitForTimeout(1200);
const afterNext = await state();
console.log('carousel after next:', JSON.stringify(afterNext));
ok(/Item 2 of/.test(afterNext.label || ''), `next arrow advanced the carousel (${ afterNext.label })`);
ok(afterNext.pages[1] === 'visible' && afterNext.pages[0] === 'hidden', 'page 2 visible, page 1 hidden');
ok(await page.$('#rl-viewer') === null, 'our viewer did NOT open on the native arrow');
ok(await page.$('shreddit-lightbox') === null, 'built-in lightbox did NOT open on the native arrow');

// ---------- native prev arrow: goes back, our viewer still shut ----------
await page.locator('gallery-carousel [slot=prevButton] button').click();
await page.waitForTimeout(1200);
const afterPrev = await state();
console.log('carousel after prev:', JSON.stringify(afterPrev));
ok(/Item 1 of/.test(afterPrev.label || ''), `prev arrow went back (${ afterPrev.label })`);
ok(await page.$('#rl-viewer') === null, 'our viewer did NOT open on the native prev arrow');

// ---------- regression: the image itself still opens the viewer ----------
await page.locator('gallery-carousel li[slot=page-1] img.non-lightboxed-content').first().click();
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
await page.waitForTimeout(600);
ok(await page.$('#rl-viewer'), 'clicking the gallery image still opens our viewer');
const overlaySrc = await page.$eval('#rl-viewer img', img => img.src);
ok(/https:\/\/i\.redd\.it\//.test(overlaySrc), `viewer used the full-res source (${ overlaySrc.slice(0, 60) }…)`);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok(await page.$('#rl-viewer') === null, 'Esc closed the viewer');

// ---------- after closing, the arrows still drive the carousel ----------
await page.locator('gallery-carousel [slot=nextButton] button').click();
await page.waitForTimeout(1200);
ok(/Item 2 of/.test((await state()).label || ''), 'arrows still work after the viewer was used');
ok(await page.$('#rl-viewer') === null, 'viewer stayed shut after reopening clicks on the arrow');

console.log('\n[RL] log tail:');
pageLogs.filter(l => l.includes('[RL]')).slice(-20).forEach(l => console.log(' ', l));
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
