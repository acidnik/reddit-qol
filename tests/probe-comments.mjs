// Probe #3: comments structure — inline media in comments, comment layout, lazy loading.
import { getChromium, launchOptions, forwardPageLogs } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const POST = process.env.PROBE_URL || 'https://www.reddit.com/r/pics/comments/1wvtk3c/bakery_security/';
const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
const page = await ctx.newPage();
forwardPageLogs(page);
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });

// scroll a few times to trigger lazy comment loading
for(let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1200);
}
await page.waitForTimeout(2000);

const info = await page.evaluate(`
(() => {
    const mediaish = [/redd\\.it/];
    const isRedditMedia = u => /(?:^|\\.)redd\\.it$/.test(new URL(u, location.origin).host || '');
    const all = [...document.querySelectorAll('shreddit-comment img, img')].filter(img => {
        try {
            return isRedditMedia(img.currentSrc || img.src || '');
        } catch { return false; }
    });
    const uniq = [];
    const seen = new Set();
    for(const img of all) {
        const key = (img.currentSrc || img.src).split('?')[0];
        if(!seen.has(key)) {
            seen.add(key);
            uniq.push(img);
        }
    }
    return {
        commentCount : document.querySelectorAll('shreddit-comment').length,
        sortedComments: document.querySelectorAll('shreddit-sort, shreddit-comment-search').length,
        uniqMedia: uniq.slice(0, 12).map(img => {
            let n = img, chain = [];
            for(let i = 0; i < 8 && n && n.nodeType === 1; i++) {
                const cls = (n.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 4).join('.');
                chain.push(n.tagName.toLowerCase() + (n.hasAttribute('slot') ? '[slot=' + n.getAttribute('slot') + ']' : '') + (cls ? '.' + cls : ''));
                n = n.parentElement;
            }
            return { src: (img.currentSrc || img.src).slice(0, 110), chain, hidden: img.offsetParent === null };
        }),
        // how nested comments look
        depths: [...document.querySelectorAll('shreddit-comment')].slice(0, 12).map(c =>
            (c.getAttribute('depth') || '?') + (c.getAttribute('author') ? '/' + c.getAttribute('author') : ''))
    };
})()
`);
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'tmp/probe-comments.png' });
console.log('screenshot: tmp/probe-comments.png');
await browser.close();
