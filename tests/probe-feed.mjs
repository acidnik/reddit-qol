// Probe: what does Reddit's DOM look like around images in a feed and in post comments?
// Prints a compact fingerprint of image/media elements + screenshots, so we can build the
// image viewer against the real markup instead of guessing.
import { getChromium, launchOptions, forwardPageLogs } from '../tools/lib/browser.mjs';

const URL = process.env.PROBE_URL || 'https://www.reddit.com/r/pics/';

// Reddit's bot-wall ("Prove your humanity") only lets authenticated/sane-cookie sessions through,
// so reuse the user's real reddit_session/token_v2 cookies.
const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
const { loadFirefoxRedditCookies } = await import('../tools/lib/cookies.mjs');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
const page = await ctx.newPage();
forwardPageLogs(page);

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
    // Shreddit custom elements vs old reddit markup — fingerprint both.
    const out = { url: location.href, title: document.title };
    out.shreddit = !!document.querySelector('shreddit-post, shreddit-comment');
    out.faces = !!document.querySelector('#main .post, .thing');
    // Every <img>/video in the feed surface: tag, closest "post container" candidates, src
    const medias = [...document.querySelectorAll('img, video, shreddit-async-loader img, faceplate-img')]
        .slice(0, 30)
        .map(el => {
            let chain = [];
            let n = el;
            for(let i = 0; i < 8 && n && n.tagName !== 'BODY'; i++) {
                chain.push(n.tagName.toLowerCase() +
                    (n.hasAttribute('slot') ? `[slot=${ n.getAttribute('slot') }]` : '') +
                    (n.id ? `#${ n.id }` : '') +
                    (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0, 3).join('.') : ''));
                n = n.parentElement;
            }
            return {
                tag: el.tagName.toLowerCase(),
                src: (el.currentSrc || el.src || el.getAttribute('src') || '').slice(0, 140),
                alt: (el.alt || '').slice(0, 60),
                cls: (el.getAttribute('class') || '').slice(0, 80),
                chain
            };
        });
    out.medias = medias;
    return out;
});
console.log(JSON.stringify(info, null, 1));

await page.screenshot({ path: 'tmp/probe-feed.png', fullPage: false });
console.log('screenshot saved: tmp/probe-feed.png');
await browser.close();
