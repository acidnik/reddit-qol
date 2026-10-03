// E2E: kafka post — single legacy fold loads in place; thread completes (fold disappears).
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const POST = 'https://www.reddit.com/r/KafkaFPS/comments/1w9qhjc/%D1%8D%D1%82%D0%BE_%D1%82%D0%BE%D1%87%D0%BD%D0%BE/';
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

const g = await page.evaluate(() => {
    const a = [...document.querySelectorAll('div.fold-more a[slot=more-comments-permalink]')].find(x =>
        x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().top > 50);
    if(!a) {
        return null;
    }
    a.scrollIntoView({ block: 'center' });
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: a.getAttribute('href') };
});
ok(!!g, 'legacy fold found');
const before = await page.evaluate(() => document.querySelectorAll('shreddit-comment').length);
await page.mouse.click(g.x, g.y);
await page.waitForTimeout(7000);
ok(await page.evaluate(() => window.__alive) === 'yes', 'no full reload');
ok(!page.url().includes('/comment/'),
    `no spa/legacy navigation (${ page.url().slice(0, 70) })`);
const after = await page.evaluate(() => document.querySelectorAll('shreddit-comment').length);
ok(after > before, `comments loaded in place (${ before } -> ${ after })`);

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
