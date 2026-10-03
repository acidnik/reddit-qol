// E2E: a REAL video in a comment (HLS: v.redd.it/.../HLSPlaylist.m3u8, player-type="comment_player",
// reddit's own poster) must not be primed. Priming used to assign the manifest to the shadow <video>
// and force preload="auto", which no browser can play natively — the player stayed black forever.
// Only `shreddit-player[gif]` (external-preview.redd.it *.gif?...&format=mp4) may be primed.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const THREAD_URL = process.env.THREAD_URL ||
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
const logs = [];
page.on('console', m => logs.push(m.text()));
await page.goto(THREAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });
await page.waitForTimeout(2500);

// find a real (non-gif) comment video and scroll it into view, so every priming path would have run
const video = await page.evaluate(() => {
    const players = [...document.querySelectorAll('shreddit-comment shreddit-player, shreddit-comment shreddit-player-2, shreddit-comment shreddit-video')];
    const player = players.find(p => !p.hasAttribute('gif') && /\.m3u8|\.mpd|v\.redd\.it/.test(p.getAttribute('src') || ''));
    if(!player) {
        return null;
    }
    player.scrollIntoView({ block: 'center' });
    return {
        src    : (player.getAttribute('src') || '').slice(0, 90),
        poster : (player.getAttribute('poster') || '').slice(0, 70),
        commentId: player.getAttribute('comment-id'),
        playerType: player.getAttribute('player-type')
    };
});
console.log('real comment video:', JSON.stringify(video));
ok(!!video, 'the thread has a non-gif comment video to test with');
ok(!video || !/gif/i.test(video.src), `its source is not a gif (${ (video && video.src.slice(0, 60)) || '' })`);
ok(!video || !!video.poster, 'reddit already ships a poster frame for it');

await page.waitForTimeout(4000);   // priming retries run every 300ms; give them room to misbehave

const state = await page.evaluate(commentId => {
    const player = [...document.querySelectorAll('shreddit-comment shreddit-player, shreddit-comment shreddit-player-2, shreddit-comment shreddit-video')]
        .find(p => p.getAttribute('comment-id') === commentId);
    if(!player) {
        return null;
    }
    const v = player.shadowRoot && player.shadowRoot.querySelector('video');
    return {
        observed : player.dataset.rlGifObserved || '',
        skipped  : player.dataset.rlGifSkipped || '',
        preload  : v ? v.preload : null,
        srcAttr  : v ? (v.getAttribute('src') || '') : null,
        readyState: v ? v.readyState : null,
        posterAttr: v ? (v.getAttribute('poster') || '').slice(0, 40) : null
    };
}, video && video.commentId);
console.log('after scroll:', JSON.stringify(state));
ok(!!state && state.srcAttr === '', `we never assigned the HLS manifest to the <video> (src=${ JSON.stringify(state && state.srcAttr) })`);
ok(!!state && state.preload === 'metadata', `its preload is still reddit's (${ state && state.preload })`);
ok(!!state && state.readyState === 0, `nothing was force-loaded (readyState ${ state && state.readyState })`);
ok(!!state && !state.observed, 'the player was not handed to the gif observer');
ok(!logs.some(l => /priming comment gif/.test(l) && video && l.includes(video.commentId)),
    'no priming log for this comment video');
ok(logs.some(l => /comment video is not a gif/.test(l)), 'the gate logged it as a non-gif and moved on');

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
