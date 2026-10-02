// Probe #2: post-images fingerprint — feed (shreddit-post media) and a post's comment page.
// Everything sensitive runs inside page.evaluate; Node only prints.
import { getChromium, launchOptions, forwardPageLogs } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const FEED_URL = process.env.FEED_URL || 'https://www.reddit.com/r/pics/';
const chromium = await getChromium();
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
await ctx.addCookies(await loadFirefoxRedditCookies());
const page = await ctx.newPage();
forwardPageLogs(page);

// Fingerprint helper shared by both pages (injected into page context)
const fingerprintFn = `
// builds an ancestor chain string up to 10 levels
function fingerprint(el) {
    const chain = [];
    let n = el;
    for(let i = 0; i < 10 && n && n.nodeType === 1; i++) {
        const cls = (n.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 4).join('.');
        chain.push(n.tagName.toLowerCase() +
            (n.hasAttribute('slot') ? '[slot=' + n.getAttribute('slot') + ']' : '') +
            (cls ? '.' + cls : ''));
        n = n.parentElement;
    }
    return {
        tag : el.tagName.toLowerCase(),
        src : (el.currentSrc || el.src || el.getAttribute('source-url') || el.getAttribute('lightbox-source') || '').slice(0, 130),
        cls : (el.getAttribute('class') || '').slice(0, 70),
        chain
    };
}
`;

await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });

const feedInfo = await page.evaluate(`
(() => {
    ${ fingerprintFn }
    const posts = [...document.querySelectorAll('shreddit-post')];
    return {
        posts: posts.length,
        samples: posts.slice(0, 4).map(p => ({
            title      : (p.getAttribute('post-title') || '').slice(0, 48),
            permalink  : (p.getAttribute('permalink') || ''),
            postAttrs  : [...p.attributes].filter(a => /media|content|source|lightbox|expando|hls|gallery/i.test(a.name)).map(a => a.name + '=' + (a.value || '').slice(0, 60)),
            media      : [...p.querySelectorAll('img, video, shreddit-player, faceplate-img')].map(el => ({
                ...fingerprint(el),
                inLink : !!el.closest('a') ? el.closest('a').getAttribute('href').slice(0, 80) : null
            }))
        }))
    };
})()
`);
console.log('=== FEED ===');
console.log(JSON.stringify(feedInfo, null, 1));
await page.screenshot({ path: 'tmp/probe-feed.png' });

// Navigate to the first media post and fingerprint post page + comments
const postUrl = await page.evaluate(() => {
    const p = [...document.querySelectorAll('shreddit-post')].find(p => /\/comments\//.test(p.getAttribute('permalink') || ''));
    return p ? new URL(p.getAttribute('permalink') || p.getAttribute('href') || location.href, 'https://www.reddit.com').href : null;
});
console.log('=== POST PAGE ===', postUrl);
if(postUrl) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('shreddit-post', { timeout: 60000 });
    await page.waitForTimeout(2500);

    const postPageInfo = await page.evaluate(`
(() => {
    ${ fingerprintFn }
    const post = document.querySelector('shreddit-post');
    const comments = [...document.querySelectorAll('shreddit-comment')];
    return {
        postAttrs : post ? [...post.attributes].map(a => a.name + '=' + (a.value || '').slice(0, 70)).filter(s => /media|source|lightbox|gallery|expando|title|hls/i.test(s)) : [],
        lightbox  : document.querySelector('shreddit-lightbox-loader, lightbox-loader') ? 'present' : 'absent',
        mediaInPost: post ? [...post.querySelectorAll('img, video, shreddit-player, gallery-carousel')].map(el => fingerprint(el)) : [],
        commentMedia: comments.slice(0, 300).flatMap(c =>
            [...c.querySelectorAll('img, video')].slice(0, 3).map(el => ({ ...fingerprint(el), inComment: true }))).slice(0, 6),
        commentsTotal : comments.length,
        commentParAttr: comments.slice(0, 3).map(c => ({
            depth: c.getAttribute('depth'),
            id   : c.getAttribute('data-id') || c.getAttribute('comment-id') || c.id,
            childrenCount: c.getAttribute('children-count')
        }))
    };
})()
`);
    console.log(JSON.stringify(postPageInfo, null, 1));
    await page.screenshot({ path: 'tmp/probe-post.png' });
    console.log('screenshot: tmp/probe-post.png');
}
await browser.close();
