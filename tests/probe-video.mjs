// Probe #5: native reddit-hosted video posts (shreddit-player-2): markup + click behavior.
import { getChromium, launchOptions, forwardPageLogs, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
await parkOutOfTheWay();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
await ctx.addInitScript((await import('node:fs')).readFileSync(new URL('../Reddit-QoL.user.js', import.meta.url), 'utf8'));
const page = await ctx.newPage();
forwardPageLogs(page, 'rl');
const rlLogs = [];
page.on('console', m => rlLogs.push(m.text()));

await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });
await page.waitForTimeout(3000);

const videoPosts = await page.evaluate(() => {
    return [...document.querySelectorAll('shreddit-post')].map(post => {
        const c = post.querySelector('[slot=post-media-container]');
        const hasPlayer = c?.querySelector('shreddit-player-2, shreddit-player');
        const imgs = c?.querySelectorAll('img').length;
        return {
            title: (post.getAttribute('post-title') || '').slice(0, 40),
            contentType: post.getAttribute('content-type') || 'none',
            frameTitle: post.getAttribute('post-video-frame-time') || '',
            hasPlayer: !!hasPlayer,
            imgs,
            containerTags: c ? [...c.querySelectorAll('*')].slice(0, 20).map(el => el.tagName.toLowerCase()) : []
        };
    });
});
console.log(JSON.stringify(videoPosts, null, 1));

// find one with the player and click it
const idx = await page.evaluate(() => {
    const posts = [...document.querySelectorAll('shreddit-post')];
    const i = posts.findIndex(p => {
        const c = p.querySelector('[slot=post-media-container]');
        return c && c.querySelector('shreddit-player-2, shreddit-player');
    });
    return i;
});
console.log('video post idx:', idx);
if(idx >= 0) {
    const target = page.locator('shreddit-post').nth(idx).locator('[slot=post-media-container]');
    await target.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(800);
    await target.click({ position: { x: 350, y: 150 } }).catch(e => console.log('click failed:', e.message.slice(0, 90)));
    await page.waitForTimeout(3000);
    console.log('after click — rl logs:', rlLogs.filter(l => l.includes('[RL]')).slice(-10));
    console.log('our overlay:', await page.$('#rl-viewer') ? 'OPENED (would be the bug)' : 'absent');
    console.log('shreddit-lightbox:', await page.$('shreddit-lightbox') ? 'opened' : 'absent');
    // player state: did the video start playing?
    console.log('player attrs:', await page.evaluate(() => {
        const p = document.querySelector('shreddit-player-2');
        if(!p) {
            return 'player element gone';
        }
        return { playing: p.getAttribute('playing'), class: p.getAttribute('class')?.slice(0, 80) };
    }));
    await page.screenshot({ path: 'tmp/probe-video2.png' });
}
await browser.close();
