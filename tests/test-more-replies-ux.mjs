// E2E: "more replies" fold UX — instant loading feedback, spent fold row removed, grafted tree
// rendered without the doubled <faceplate-number> values ("3434 more replies").
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

// r/pics haucpf has a deep legacy fold (t1_fvbxqb4, "90 more replies") that expands in place
const POST = process.env.POST_URL ||
    'https://www.reddit.com/r/pics/comments/haucpf/ive_found_a_few_funny_memories_during_lockdown/';
const CID = process.env.POST_CID || 'fvbxqb4';
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
page.on('console', m => { if(/\[RL\] more-replies/.test(m.text())) console.log('  RL:', m.text().slice(0, 130)); });
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__alive = 'yes'; });
await page.evaluate(cid => {
    window.__beforeIds = [...document.querySelectorAll('shreddit-comment')].map(c => c.getAttribute('thingid'));
    window.__fold = cid;
}, CID);

const state = () => page.evaluate(() => ({
    comments: document.querySelectorAll('shreddit-comment').length,
    loading : !!document.querySelector('.rl-fold-loading'),
    // the fold row we clicked is "spent" once its link is gone for good
    foldLeft: [...document.querySelectorAll('div.fold-more a[slot=more-comments-permalink]')]
        .some(a => (a.getAttribute('href') || '').includes(window.__fold)),
    // a doubled value means one <faceplate-number> holds two equal text runs — both are rendered
    // again when the imported clone upgrades, so the visible text read "3434 more replies"
    doubled : [...document.querySelectorAll('shreddit-comment:not([data-rl-before]) faceplate-number')]
        .filter(n => [...n.childNodes].filter(c => c.nodeType === 3 && c.nodeValue.trim()).length > 1)
        .map(n => n.textContent.trim()).slice(0, 5),
    grafted : [...document.querySelectorAll('div.fold-more[data-rl-from-iframe]')].length
}));

const before = await state();
ok(before.comments > 0, `comments rendered (${ before.comments })`);
ok(before.foldLeft, `legacy fold for ${ CID } present before the click`);
ok(!before.doubled.length, 'no doubled numbers before the expansion');

await page.evaluate(() => {
    // mark what existed before so post-click queries can target the grafted tree only
    [...document.querySelectorAll('shreddit-comment')].forEach(c => c.setAttribute('data-rl-before', '1'));
    const a = [...document.querySelectorAll('div.fold-more a[slot=more-comments-permalink]')].find(x =>
        (x.getAttribute('href') || '').includes(window.__fold) && x.getBoundingClientRect().width > 0);
    if(a) {
        a.scrollIntoView({ block: 'center' });
    }
});
const pt = await page.evaluate(() => {
    const a = [...document.querySelectorAll('div.fold-more a[slot=more-comments-permalink]')].find(x =>
        (x.getAttribute('href') || '').includes(window.__fold));
    if(!a) {
        return null;
    }
    const r = a.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
});
if(!pt) {
    console.log(`❌ FAILED: no clickable legacy fold for ${ CID } — pick another post via POST_URL/POST_CID`);
    await browser.close();
    process.exit(1);
}
await page.mouse.click(pt[0], pt[1]);

await page.waitForTimeout(600);
const during = await state();
ok(during.loading, 'spinner/"Loading…" state shown right after the click');

await page.waitForTimeout(9000);
const after = await state();
ok(await page.evaluate(() => window.__alive) === 'yes', 'no full reload');
ok(after.comments > before.comments,
    `replies grafted in place (${ before.comments } -> ${ after.comments })`);
ok(!after.foldLeft, 'spent "more replies" link is gone after the load');
ok(!after.loading, 'loading state cleared');
ok(!after.doubled.length, `no doubled numbers in the grafted tree (${ JSON.stringify(after.doubled) })`);

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
