// E2E: user's repro — r/pics haucpf, chain of "more replies" expansions, no full reload anywhere.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const POST = 'https://www.reddit.com/r/pics/comments/haucpf/ive_found_a_few_funny_memories_during_lockdown/';
const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
await parkOutOfTheWay();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
await ctx.addInitScript(readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8'));
const page = await ctx.newPage();
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__alive = 'yes'; });

// find the Rick Astley thread fold (fv7zm1e's subtree) by scanning visible folds
const clickNextFold = async () => {
    for(let attempt = 0; attempt < 8; attempt++) {
        const g = await page.evaluate(() => {
            const folds = [...document.querySelectorAll('div.fold-more')].filter(f => {
                const r = f.getBoundingClientRect();
                const a = f.querySelector('a');
                return r.width > 40 && r.height > 10 && a && a.getBoundingClientRect().width > 0 &&
                    r.top > 80 && r.bottom < innerHeight - 80;
            });
            const f = folds[0];
            if(!f) {
                return null;
            }
            const a = f.querySelector('a');
            a.scrollIntoView({ block: 'center' });
            const ar = a.getBoundingClientRect();
            return { x: ar.left + ar.width / 2, y: ar.top + ar.height / 2, href: a.getAttribute('href'),
                cid: (a.getAttribute('href').match(/comment\/([^/?]+)/) || [])[1] };
        });
        if(g) {
            return g;
        }
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(600);
    }
    return null;
};

let failures = 0;
for(let step = 1; step <= 5; step++) {
    const g = await clickNextFold();
    if(!g) {
        console.log(`step ${ step }: no more visible folds — end of chain`);
        break;
    }
    const before = await page.evaluate(() => document.querySelectorAll('shreddit-comment').length);
    await page.mouse.click(g.x, g.y);
    await page.waitForTimeout(4500);
    const alive = await page.evaluate(() => window.__alive || 'GONE');
    const after = await page.evaluate(() => document.querySelectorAll('shreddit-comment').length);
    const clean = !page.url().includes('force-legacy-sct');
    const okStep = alive === 'yes' && clean;
    console.log(`step ${ step } cid=${ g.cid }: ${ okStep ? 'OK' : 'FAILED' } (alive=${ alive }, comments ${ before } -> ${ after }, url ${ page.url().slice(0, 70) })`);
    if(!okStep) {
        failures++;
        break;
    }
}
console.log(failures ? '❌ FAILED' : '✅ ALL STEPS PASSED (no full reload in the chain)');
await browser.close();
process.exit(failures ? 1 : 0);
