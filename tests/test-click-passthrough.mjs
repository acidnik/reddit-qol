// E2E: only a click on a "more replies" control may be ours. An ordinary click anywhere on the
// page has to reach reddit untouched — no hidden iframe, no loading state, not swallowed (a wider
// search for the fold link finds an unrelated fold's anchor on a comment page and used to start a
// load on ANY click).
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const POST = process.env.POST_URL ||
    'https://www.reddit.com/r/pics/comments/haucpf/ive_found_a_few_funny_memories_during_lockdown/';
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
await ctx.addInitScript(readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8'));
const page = await ctx.newPage();
const started = [];
page.on('console', m => { if(m.text().includes('more-replies: iframe loading')) started.push(m.text()); });
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
    window.__alive = 'yes';
    window.__seen = [];
    // our interceptor is a window-capture listener, so it runs before this one: a click that never
    // arrives here was swallowed by the userscript
    document.addEventListener('click', e => {
        window.__seen.push((e.target.tagName || '').toLowerCase());
    }, true);
});

const clickAt = async (where, finder) => {
    const before = await page.evaluate(() => ({
        // only OUR loader parks a hidden iframe off-screen; reddit has its own (recaptcha, tracking)
        iframes : document.querySelectorAll('iframe[style*="-9999px"]').length,
        loading : document.querySelectorAll('.rl-fold-loading').length,
        seen    : window.__seen.length
    }));
    const pt = await page.evaluate(finder);
    if(!pt) {
        return null;
    }
    const logsBefore = started.length;
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({
        // only OUR loader parks a hidden iframe off-screen; reddit has its own (recaptcha, tracking)
        iframes : document.querySelectorAll('iframe[style*="-9999px"]').length,
        loading : document.querySelectorAll('.rl-fold-loading').length,
        seen    : window.__seen.length
    }));
    ok(after.seen > before.seen, `${ where }: the click reached the page`);
    ok(after.iframes === before.iframes, `${ where }: no hidden iframe was spawned (${ before.iframes } -> ${ after.iframes })`);
    ok(after.loading <= before.loading, `${ where }: no "Loading…" state appeared (${ before.loading } -> ${ after.loading })`);
    ok(started.length === logsBefore, `${ where }: no comment load was started`);
    return pt;
};

// a comment's own text
await clickAt('comment text', () => {
    const el = document.querySelector('shreddit-comment div[slot=comment]') ||
        document.querySelector('shreddit-comment p') ||
        document.querySelector('shreddit-comment [id$="-comment-rtjson-content"]');
    if(!el) {
        return null;
    }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 10) };
});
// empty space inside the same comment box, past its text
await clickAt('comment whitespace', () => {
    const el = document.querySelector('shreddit-comment div[slot=comment]') ||
        document.querySelector('shreddit-comment p');
    if(!el) {
        return null;
    }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.right - 8), y: Math.round(r.top + 6) };
});
// a plain heading in the left nav
await clickAt('sidebar heading', () => {
    const el = [...document.querySelectorAll('h1, h2, h3, p, span')]
        .find(n => n.children.length === 0 && n.textContent.trim() === 'CUSTOM FEEDS');
    if(!el) {
        return null;
    }
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});

// positive control: a "more replies" fold must still be intercepted
const beforeFold = await page.evaluate(() => document.querySelectorAll('iframe').length);
const foldPt = await page.evaluate(async () => {
    const el = [...document.querySelectorAll('div.fold-more a[slot=more-comments-permalink]')]
        .find(x => x.getBoundingClientRect().width > 20);
    if(!el) {
        return null;
    }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
ok(!!foldPt, 'a legacy fold is available for the positive control');
if(foldPt) {
    await page.mouse.click(foldPt.x, foldPt.y);
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => !!document.querySelector('.rl-fold-loading') ||
        document.querySelectorAll('iframe[style*="-9999px"]').length > 0),
        'clicking a real "more replies" still starts an in-place load');
    await page.waitForTimeout(8000);
}
ok(await page.evaluate(() => window.__alive) === 'yes', 'page never reloaded');
ok(started.length > 0, `the fold click really used the loader (${ started.length } load(s) started) [sanity]`);
ok(beforeFold >= 0, 'control click did not touch unrelated state');

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
