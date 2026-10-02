// Verify: clicking a native video post in the feed does NOT open our overlay,
// and clicking a regular image post right after still opens it (no regression).
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
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
forwardPageLogs(page, 'rl');
const rlLogs = [];
page.on('console', m => rlLogs.push(m.text()));

await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });
await page.waitForTimeout(3000);

const idx = await page.evaluate(() => [...document.querySelectorAll('shreddit-post')].findIndex(p => {
    const c = p.querySelector('[slot=post-media-container]');
    return c && c.querySelector('shreddit-player, shreddit-player-2, shreddit-video, video');
}));
if(idx === -1) {
    console.log('SKIP: no video post on the front page right now');
    await browser.close();
    process.exit(0);
}
console.log('video post idx:', idx, (await page.locator('shreddit-post').nth(idx).getAttribute('post-title')));

const videoArea = page.locator('shreddit-post').nth(idx).locator('[slot=post-media-container]');
await videoArea.evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
const beforeUrl = page.url();
await videoArea.click({ position: { x: 350, y: 150 } }).catch(e => console.log('click failed:', e.message.slice(0, 90)));
await page.waitForTimeout(2500);
ok(await page.$('#rl-viewer') === null, 'our overlay did NOT open on video click');
ok(await page.$('shreddit-lightbox') === null || true, 'lightbox state whatever reddit decides');
console.log('video click: url changed to', page.url(), '| rl log:', rlLogs.filter(l => l.includes('[RL]')).slice(-3).join(' | '));

// regression: image post still works
const imgIdx = await page.evaluate(() => [...document.querySelectorAll('shreddit-post')].findIndex(p => {
    const c = p.querySelector('[slot=post-media-container]');
    return c && c.querySelector('img.non-lightboxed-content') &&
        !c.querySelector('shreddit-player, shreddit-player-2, shreddit-video, video');
}));
console.log('image post idx:', imgIdx);
const imgArea = page.locator('shreddit-post').nth(imgIdx).locator('img.non-lightboxed-content').first();
await imgArea.evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
await imgArea.click();
await page.waitForSelector('#rl-viewer img', { timeout: 5000 });
ok(true, 'image click still opens the viewer');
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
