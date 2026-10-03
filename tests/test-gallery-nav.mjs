// E2E: native gallery carousel arrows must drive the carousel, not our viewer.
// Their wrappers (<span slot="nextButton">/<span slot="prevButton">) live in the
// gallery-carousel shadow root, so the document capture-phase hook has to let them through.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const SCRIPT = readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8');
// gallery with the reported repro: swipe to the second page without opening the modal, then click
const POST_URL = process.env.POST_URL ||
    'https://www.reddit.com/r/tjournal_refugees/comments/1wwwfze/';
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

// ---------- the image itself opens the viewer, at the page the user is looking at ----------
const viewer = () => page.evaluate(() => {
    const v = document.querySelector('#rl-viewer');
    if(!v) {
        return null;
    }
    const img = v.querySelector('.rl-viewer-img');
    return {
        counter: ((v.querySelector('.rl-viewer-counter') || {}).textContent || '').trim(),
        src    : img ? (img.currentSrc || img.src || '') : ''
    };
});
// clicks the image of the gallery page that is visible right now (mouse-level click, so whatever
// sits on top receives it — exactly how a user hits a swiped-to page)
const clickVisiblePage = async () => {
    const pt = await page.evaluate(() => {
        const img = [...document.querySelectorAll('gallery-carousel li[slot^=page-] img.non-lightboxed-content')]
            .find(i => {
                const li = i.closest('li[slot^=page-]');
                return i.getBoundingClientRect().width > 40 && (!li || getComputedStyle(li).visibility === 'visible');
            });
        if(!img) {
            return null;
        }
        img.scrollIntoView({ block: 'center' });
        const r = img.getBoundingClientRect();
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    });
    if(!pt) {
        return null;
    }
    await page.mouse.click(pt[0], pt[1]);
    await page.waitForTimeout(900);
    return pt;
};

ok(!!(await clickVisiblePage()), 'clicked the visible gallery image (page 1)');
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
const page1 = await viewer();
ok(!!page1, 'clicking the gallery image still opens our viewer');
ok(/^https:\/\/i\.redd\.it\//.test(page1.src), `viewer used the full-res source (${ page1.src.slice(0, 60) }…)`);
ok(/^1 \//.test(page1.counter), `viewer opened at the first image (${ page1.counter })`);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok(await page.$('#rl-viewer') === null, 'Esc closed the viewer');

// the reported bug: swipe to page 2 WITHOUT the viewer, then click — image 1 used to open
await page.locator('gallery-carousel [slot=nextButton] button').click();
await page.waitForTimeout(1200);
ok(/Item 2 of/.test((await state()).label || ''), 'carousel moved to page 2 before the click');
ok(!!(await clickVisiblePage()), 'clicked the visible gallery image (page 2)');
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
const page2 = await viewer();
ok(/^2 \//.test((page2 || {}).counter || ''), `viewer opened at the second image (${ page2 && page2.counter })`);
ok(!!page2 && page2.src !== page1.src, 'the viewer shows the image that was swiped to, not the first one');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok(await page.$('#rl-viewer') === null, 'Esc closed the viewer again');

// back to page 1, so the arrow regression below keeps its expectation
await page.locator('gallery-carousel [slot=prevButton] button').click();
await page.waitForTimeout(1200);
ok(/Item 1 of/.test((await state()).label || ''), 'prev arrow returned the carousel to page 1');

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
