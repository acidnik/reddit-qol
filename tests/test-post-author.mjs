// E2E: post author shown next to posts on the home feed.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

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
await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post[author]', { timeout: 60000 });
await page.waitForTimeout(2500);

const check = await page.evaluate(() => {
    const posts = [...document.querySelectorAll('shreddit-post[author]')];
    const withChip = posts.filter(p => p.dataset.rlAuthorDone && p.querySelector('.rl-post-author'));
    const mismatches = withChip.filter(p =>
        p.querySelector('.rl-post-author').getAttribute('href') !== `/user/${ p.getAttribute('author') }/`);
    // lazy-loaded posts further down also get chips
    return {
        total      : posts.length,
        chipped    : withChip.length,
        mismatches : mismatches.length,
        sample     : withChip.slice(0, 3).map(p => ({
            author: p.getAttribute('author'),
            chipText: p.querySelector('.rl-post-author').textContent.trim(),
            creditNow: (p.querySelector('[slot=credit-bar]').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
        }))
    };
});
console.log(JSON.stringify(check, null, 1));
ok(check.total > 0, `posts on the home feed (${ check.total })`);
ok(check.chipped > 0, `author chips injected (${ check.chipped }/${ check.total })`);
ok(check.mismatches === 0, 'chip hrefs match the author attribute');

// scroll to trigger lazy loading, chips must follow
for(let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1400));
    await page.waitForTimeout(900);
}
const lazy = await page.evaluate(() => {
    const posts = [...document.querySelectorAll('shreddit-post[author]')];
    const chipped = posts.filter(p => p.querySelector('.rl-post-author'));
    return { total: posts.length, chipped: chipped.length };
});
ok(lazy.chipped >= lazy.total * 0.9, `lazy-loaded posts chipped too (${ lazy.chipped }/${ lazy.total })`);
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
