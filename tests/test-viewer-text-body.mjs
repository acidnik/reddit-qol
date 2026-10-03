// E2E: images embedded in a post's own markdown body open in the viewer too. They live in
// shreddit-post [slot=text-body] inside an <a target="_blank">, so before this they were not in
// INTERCEPT_SELECTOR and the click left for a new tab instead of the modal.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const POST = process.env.POST_URL ||
    'https://www.reddit.com/r/tjournal_refugees/comments/1wwuajx/';
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
const popups = [];
page.on('popup', p => popups.push(p.url()));
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });
await page.waitForTimeout(3000);

const urlBefore = page.url();
// this post is a `multi_media` post: its image is markdown in the body, there is no
// [slot=post-media-container] at all, so only the text-body rule can catch the click
const postInfo = await page.evaluate(() => {
    const post = document.querySelector('shreddit-post');
    return {
        postType: post.getAttribute('post-type'),
        hasMediaContainer: !!post.querySelector('[slot=post-media-container]'),
        bodyImgs: [...post.querySelectorAll('[slot=text-body] img')]
            .filter(img => img.getBoundingClientRect().width > 40).length
    };
});
ok(postInfo.postType === 'multi_media' && !postInfo.hasMediaContainer,
    `post has no media container (type ${ postInfo.postType }) — the body image is the only way in`);
ok(postInfo.bodyImgs >= 1, `post body has an inline image to test with (${ postInfo.bodyImgs })`);
const bodyImgs = { length: postInfo.bodyImgs };

const clickImg = async index => {
    const pt = await page.evaluate(i => {
        const imgs = [...document.querySelectorAll('shreddit-post [slot=text-body] img')]
            .filter(img => img.getBoundingClientRect().width > 40);
        const img = imgs[i];
        if(!img) {
            return null;
        }
        img.scrollIntoView({ block: 'center' });
        const r = img.getBoundingClientRect();
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    }, index);
    if(!pt) {
        return null;
    }
    await page.mouse.click(pt[0], pt[1]);
    await page.waitForTimeout(900);
    return pt;
};
const viewerState = () => page.evaluate(() => {
    const v = document.querySelector('#rl-viewer');
    if(!v) {
        return { open: false };
    }
    const img = v.querySelector('.rl-viewer-img');
    return {
        open   : true,
        src    : img ? (img.currentSrc || img.src || '') : '',
        counter: (v.querySelector('.rl-viewer-counter') || {}).textContent || ''
    };
});

// first inline image: the clicked body image is the first entry of the collection (only
// post-media-container images could precede it, and this post has none)
await clickImg(0);
const first = await viewerState();
const [num1, total1] = first.counter.trim().split('/').map(s => +(s.trim()));
ok(first.open, 'clicking a post-body image opens the viewer (not a new tab)');
ok(/^https:\/\/i\.redd\.it\//.test(first.src), `viewer shows the full-res original (${ first.src.slice(0, 60) })`);
ok(num1 === 1, `counter starts at the clicked image (${ first.counter.trim() })`);

// next entry (a comment image on this post) — still in the viewer, and it is a different image
if(total1 >= 2) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(900);
    const second = await viewerState();
    const [num2] = second.counter.trim().split('/').map(s => +(s.trim()));
    ok(second.open && num2 === 2, `arrow key moves on inside the viewer (${ second.counter.trim() })`);
    ok(second.src !== first.src, 'the shown image actually changed');
} else {
    console.log('note: page has a single collected image, nav check skipped');
}

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok(!(await viewerState()).open, 'Escape closes the viewer');

ok(popups.length === 0, `no new tab was opened (${ popups.length } popup(s))`);
ok(page.url() === urlBefore, 'the page never navigated');

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
