// E2E: deep comment indents are reset — nothing narrower than the threshold, every reset container
// back on the level-0 box, no horizontal overflow. The host post is unfolded first (a couple of
// "more replies" clicks) because a plain load only reaches depth ~9 and never crosses the limit.
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay } from '../tools/lib/browser.mjs';
import { loadFirefoxRedditCookies } from '../tools/lib/cookies.mjs';

const POST = process.env.POST_URL ||
    'https://www.reddit.com/r/pics/comments/haucpf/ive_found_a_few_funny_memories_during_lockdown/';
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
page.on('console', m => { if(m.text().includes('[RL] deep nesting')) console.log('  RL:', m.text().slice(0, 140)); });
await page.goto(POST, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-comment', { timeout: 60000 });
await page.waitForTimeout(2000);

// grow the tree until comments actually cross the width limit: the deepest threads of a plain
// load are ~330px wide, so a couple of "more replies" expansions are what creates depth 12+
const clickFold = () => page.evaluate(() => {
    const cands = [
        ...document.querySelectorAll('div.fold-more a[slot=more-comments-permalink], faceplate-partial faceplate-tracker[noun="more_replies"] button')
    ];
    const el = cands.find(x => {
        const r = x.getBoundingClientRect();
        return r.width > 20 && r.height > 8 && r.top > 60 && r.bottom < innerHeight - 60;
    });
    if(!el) {
        return null;
    }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
});
const maxDepth = () => page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('shreddit-comment')].map(c => {
    let d = 0, n = c.parentElement;
    while(n) {
        if(n.tagName === 'SHREDDIT-COMMENT') {
            d++;
        }
        n = n.parentElement;
    }
    return d;
})));
for(let round = 0; round < 4; round++) {
    if(await maxDepth() >= 13) {
        break;
    }
    let pt = await clickFold();
    // folds sit below the viewport — scroll until one is clickable
    for(let look = 0; !pt && look < 12; look++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(400);
        pt = await clickFold();
    }
    if(!pt) {
        console.log(`round ${ round }: no visible fold left`);
        break;
    }
    await page.mouse.click(pt[0], pt[1]);
    await page.waitForTimeout(7000);
}
console.log('deepest nesting reached:', await maxDepth());
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1200);

const measure = () => page.evaluate(() => {
    const blk = el => el.parentElement && !el.parentElement.closest('shreddit-comment');
    const comments = [...document.querySelectorAll('shreddit-comment')];
    const top = comments.filter(blk);
    const base = top.length ? top[0].getBoundingClientRect() : null;
    const depthOf = c => {
        let d = 0, n = c.parentElement;
        while(n) {
            if(n.tagName === 'SHREDDIT-COMMENT') {
                d++;
            }
            n = n.parentElement;
        }
        return d;
    };
    const rows = comments.map(c => ({ d: depthOf(c), r: c.getBoundingClientRect() }))
        .filter(x => x.r.width > 0);
    const byDepth = new Map();
    rows.forEach(x => {
        const cur = byDepth.get(x.d) || { n: 0, min: Infinity, max: 0, leftMin: Infinity };
        cur.n++;
        cur.min = Math.min(cur.min, Math.round(x.r.width));
        cur.max = Math.max(cur.max, Math.round(x.r.width));
        cur.leftMin = Math.min(cur.leftMin, Math.round(x.r.left));
        byDepth.set(x.d, cur);
    });
    const resets = [...document.querySelectorAll('.rl-unindent')].map(b => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
            left: Math.round(r.left), width: Math.round(r.width),
            pullL: b.style.getPropertyValue('--rl-pull-left'),
            pullR: b.style.getPropertyValue('--rl-pull-right'),
            marL: cs.marginLeft, w: cs.width
        };
    });
    return {
        viewport: [innerWidth, innerHeight],
        scrollW  : document.documentElement.scrollWidth,
        base     : base ? { left: Math.round(base.left), right: Math.round(base.right), width: Math.round(base.width) } : null,
        byDepth  : [...byDepth.entries()].sort((a, b) => a[0] - b[0]),
        narrowest: Math.min(...rows.map(x => Math.round(x.r.width))),
        narrow   : rows.filter(x => Math.round(x.r.width) < 250).map(x => ({ d: x.d, w: Math.round(x.r.width) })),
        outLeft  : rows.filter(x => base && x.r.left < base.left - 1).length,
        outRight : rows.filter(x => base && x.r.right > base.right + 1).length,
        resets
    };
});

// The widened block slides over the ancestor comments' threadline strips (absolute, z-index 1,
// cursor: pointer, spanning the whole thread): they must not paint over the shifted comments and
// must not steal their clicks any more.
const measureStrips = () => page.evaluate(async () => {
    const out = [];
    for(const block of document.querySelectorAll('.rl-unindent')) {
        // the probe needs the block on screen: elementFromPoint has nothing to return otherwise
        block.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 200));
        const br = block.getBoundingClientRect();
        const cs = getComputedStyle(block);
        const deep = block.querySelector('shreddit-comment');
        const dr = deep ? deep.getBoundingClientRect() : null;
        const probes = [];
        if(dr) {
            for(const x of [Math.round(br.left + 4), Math.round(dr.left + 4)]) {
                const y = Math.round(dr.top + 20);
                const top = document.elementFromPoint(x, y);
                probes.push({
                    at   : [x, y],
                    top  : top ? top.tagName.toLowerCase() + (top.classList.contains('threadline-strip') ? '.threadline-strip' : '') : null,
                    inBlock : !!(top && block.contains(top)),
                    isStrip: !!(top && top.classList.contains('threadline-strip'))
                });
            }
        }
        const covered = [...document.querySelectorAll('.threadline-strip')].filter(s => {
            const sr = s.getBoundingClientRect();
            return sr.left < br.right && sr.right > br.left && sr.top < br.bottom && sr.bottom > br.top;
        }).length;
        out.push({ z: cs.zIndex, bg: cs.backgroundColor, covered, probes });
    }
    return out;
});

const checkStrips = (tag, strips) => {
    if(!strips.length) {
        return;
    }
    console.log(`--- ${ tag }: strips vs ${ strips.length } reset block(s)`);
    strips.forEach(s => console.log(`   z=${ s.z } bg=${ s.bg } coveredStrips=${ s.covered } probes=${ JSON.stringify(s.probes) }`));
    const hits = strips.flatMap(s => s.probes);
    ok(hits.length > 0 && hits.every(p => p.inBlock),
        `${ tag }: clicks at the left edge of a widened comment land inside it (${ JSON.stringify(hits.map(p => p.top)) })`);
    ok(hits.every(p => !p.isStrip), `${ tag }: no threadline strip takes those clicks`);
    ok(strips.every(s => s.covered === 0 || (parseInt(s.z, 10) >= 2 && s.bg !== 'rgba(0, 0, 0, 0)')),
        `${ tag }: every block covering a strip is lifted above it and filled with the page background`);
};

const check = (tag, report, expectResets) => {
    console.log(`\n--- ${ tag }: viewport ${ report.viewport } | scrollWidth ${ report.scrollW } | level-0 box ${ JSON.stringify(report.base) }`);
    console.log('BY DEPTH:' + report.byDepth.map(([d, v]) => ` d${ d }=${ v.n } w${ v.min } l${ v.leftMin }`).join(''));
    report.resets.forEach(r => console.log('   reset block', JSON.stringify(r)));
    ok(report.narrow.length === 0, `${ tag }: no rendered comment narrower than 250px (narrowest ${ report.narrowest })`);
    ok(report.outLeft === 0, `${ tag }: no comment left of the level-0 box (${ report.outLeft })`);
    ok(report.outRight === 0, `${ tag }: no comment right of the level-0 box (${ report.outRight })`);
    ok(report.scrollW <= report.viewport[0],
        `${ tag }: no horizontal overflow (scrollWidth ${ report.scrollW } <= ${ report.viewport[0] })`);
    if(expectResets) {
        ok(report.resets.length > 0, `${ tag }: indent resets applied (${ report.resets.length })`);
    }
    ok(report.resets.every(r => Math.abs(r.width - report.base.width) <= 2 && Math.abs(r.left - report.base.left) <= 2),
        `${ tag }: every reset block matches the level-0 box (left + width)`);
};

check('load', await measure(), true);
checkStrips('load', await measureStrips());

// the pull is measured in px, so a narrower window has to be re-measured from scratch
await page.setViewportSize({ width: 1000, height: 1000 });
await page.waitForTimeout(1500);
check('narrower window', await measure(), true);

// a phone-ish layout renders only the shallow levels (deep ones are collapsed), so no reset is
// expected here — the point is that a narrow column must not break the invariants
await page.setViewportSize({ width: 800, height: 1000 });
await page.waitForTimeout(1500);
check('narrow window', await measure(), false);

console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
