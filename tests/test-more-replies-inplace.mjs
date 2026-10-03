// E2E: force-legacy "more replies" expands IN PLACE (no view change, no reload), batches chained.
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
page.on('console', m => { if(m.text().includes('[RL]')) console.log('  RL:', m.text().slice(0, 130)); });
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__alive = 'yes'; });

const clickFoldBreadcrumb = () => page.evaluate(() => {
    // any visible force-legacy fold row (anchor or its button sibling)
    const fold = [...document.querySelectorAll('div.fold-more')].find(f => {
        const a = f.querySelector('a[slot=more-comments-permalink], a.more-comments-link');
        const btn = f.querySelector('button');
        return (a || btn) && (a ? (a.getAttribute('href') || '').includes('force-legacy-sct') : true) &&
            f.getBoundingClientRect().width > 0 && f.getBoundingClientRect().top > 50 &&
            f.getBoundingClientRect().bottom < innerHeight - 50;
    });
    if(!fold) {
        return null;
    }
    const a = fold.querySelector('a[slot=more-comments-permalink], a.more-comments-link') || fold.querySelector('button');
    a.scrollIntoView({ block: 'center' });
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: a.getAttribute('href') };
});

const before = await page.evaluate(() => document.querySelectorAll('shreddit-comment').length);
console.log('comments before:', before);

let batches = 0;
for(let step = 0; step < 10; step++) {
    let g = await clickFoldBreadcrumb();
    // the fold may sit below the fold — scroll and look again
    for(let look = 0; !g && look < 10; look++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(500);
        g = await clickFoldBreadcrumb();
    }
    if(!g) {
        console.log(`no more visible folds — tree complete after ${ batches } batch(es)`);
        break;
    }
    batches++;
    await page.mouse.click(g.x, g.y);
    await page.waitForTimeout(7000);
    const alive = await page.evaluate(() => window.__alive || 'GONE');
    console.log(`batch ${ batches }: ${ g.href.slice(0, 60) } | alive=${ alive } url-still-post=${ page.url().includes('ive_found') }`);
    ok(alive === 'yes', `batch ${ batches }: no full reload`);
    ok(page.url().includes('ive_found'), `batch ${ batches }: url stayed on the post`);
    if(alive !== 'yes' || !page.url().includes('ive_found')) {
        break;
    }
}
ok(batches >= 2, `several batches chained (${ batches })`);

const after = await page.evaluate(() => document.querySelectorAll('shreddit-comment').length);
await page.evaluate(() => window.scrollTo(0, 0));
console.log(`comments ${ before } -> ${ after }`);
ok(after > before + 15, `substantial growth via batches (${ after })`);

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
