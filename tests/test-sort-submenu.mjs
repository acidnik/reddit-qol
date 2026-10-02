// E2E: Top hover submenu + SPA feed swap (no page reload).
import { readFileSync } from 'node:fs';
import { getChromium, launchOptions, parkOutOfTheWay, forwardPageLogs } from '../tools/lib/browser.mjs';
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

await page.goto('https://www.reddit.com/r/CombatFootage/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('shreddit-post', { timeout: 60000 });
await page.waitForTimeout(2500);

// marker AFTER load: survives only if no reload happens
await page.evaluate(() => { window.__rlAlive = 'yes'; });

// open the sort dropdown (trigger may live in shadow dom — playwright pierces it);
// its menu content is lazy-loaded on first open, injection follows via MutationObserver
await page.locator('shreddit-sort-dropdown').locator('visible=true').first()
    .click({ timeout: 10000 })
    .catch(e => console.log('trigger click failed:', e.message.slice(0, 60)));
await page.waitForTimeout(1200);

// submenu injected for the Top item(s)
const subCount = await page.locator('.rl-sort-sub').count();
ok(subCount > 0, `submenu injected (${ subCount } instances)`);
const items = await page.$$eval('.rl-sort-sub a', as => as.map(a => a.textContent.trim()));
ok(items.length >= 6 && /All Time/.test(items.join()), `submenu has the 6 reddit ranges (${ [...new Set(items)].join(',') })`);
const hrefs = await page.$$eval('.rl-sort-sub a', as => as.map(a => a.getAttribute('href')));
ok(hrefs.every(h => /[?&]t=(hour|day|week|month|year|all)/.test(h)), `range hrefs ok (${ hrefs[0] }…)`);
// hover the VISIBLE desktop instance (mobile clones live far below the fold)
const hovered = await page.evaluate(() => {
    const inView = [...document.querySelectorAll('li.rl-has-sub')].filter(l => {
        const r = l.getBoundingClientRect();
        return r.top > 0 && r.bottom < innerHeight && r.width > 0;
    });
    if(!inView.length) {
        return false;
    }
    inView[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return true;
});
ok(hovered, 'found an on-screen Top item to hover');
await page.waitForTimeout(400);
const visible = await page.evaluate(() => {
    const subs = [...document.querySelectorAll('.rl-sort-sub')].filter(s => getComputedStyle(s).display === 'block' &&
        s.getBoundingClientRect().top >= 0 && s.getBoundingClientRect().top < innerHeight);
    return subs.length;
});
ok(visible > 0, `submenu shows on hover (${ visible } on-screen)`);

// Top item carries the submenu arrow; submenu inherits the parent menu chrome
const arrow = await page.$$eval('.rl-sub-arrow', as => as.length);
ok(arrow > 0, `Top item shows the submenu arrow (${ arrow } arrows)`);
const chrome = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li.rl-has-sub')].find(l => {
        const r = l.getBoundingClientRect();
        return r.top > 0 && r.bottom < innerHeight && r.width > 0;
    });
    const sub = li.querySelector(':scope > .rl-sort-sub') ||
        [...document.querySelectorAll('.rl-sort-sub')].find(s => getComputedStyle(s).display === 'block');
    const dd = li.closest('shreddit-sort-dropdown');
    const menu = dd && dd.shadowRoot && dd.shadowRoot.querySelector('faceplate-menu');
    return {
        subBg: sub && getComputedStyle(sub).backgroundColor,
        menuBg: menu && getComputedStyle(menu).backgroundColor,
        subColor: sub && getComputedStyle(sub).color,
        menuColor: menu && getComputedStyle(menu).color
    };
});
ok(chrome.subBg === chrome.menuBg, `submenu bg matches parent menu (${ chrome.subBg } vs ${ chrome.menuBg })`);
ok(chrome.subColor === chrome.menuColor, `submenu text color matches parent menu (${ chrome.subColor })`);

// hover the Top menu item to reveal the submenu

// click "This Month" -> in-place swap
const firstPostBefore = await page.$eval('shreddit-post', p => p.getAttribute('post-title'));
// click the on-screen submenu link at its coordinates (robust against reddit's phantom overlays)
await page.evaluate(() => {
    const subs = [...document.querySelectorAll('.rl-sort-sub')].filter(s => getComputedStyle(s).display === 'block' &&
        s.getBoundingClientRect().top >= 0 && s.getBoundingClientRect().top < innerHeight);
    subs[0].querySelector('a[href*="t=month"]').click();
});

await page.waitForTimeout(2500);
ok(page.url().includes('t=month'), `url updated (${ page.url() })`);
const alive = await page.evaluate(() => window.__rlAlive || 'gone');
ok(alive === 'yes', 'no page reload happened (marker survived)');
const firstPostAfter = await page.$eval('shreddit-post', p => p.getAttribute('post-title'));
ok(firstPostBefore !== firstPostAfter, `feed content swapped (${ (firstPostAfter || '').slice(0, 40) })`);
ok(await page.$('shreddit-feed'), 'feed still functional after swap');

// arrow + submenu survive the swap (header re-renders lazily — injection must re-run)
await page.waitForTimeout(1600);
const arrowAfter = await page.$$eval('.rl-sub-arrow', as => as.length);
ok(arrowAfter > 0, `arrow survives the swap (${ arrowAfter })`);
const subAfter = await page.$$eval('.rl-sort-sub', els => els.length);
ok(subAfter > 0, `submenu survives the swap (${ subAfter })`);

// switching sort (Top -> Hot) must drop the dragged range params
await page.evaluate(() => { window.__rlAlive2 = 'yes'; });
const hotLink = page.locator('a[href*="/hot/"]').filter({ hasText: /hot/i }).first();
await page.locator('shreddit-sort-dropdown').locator('visible=true').first().click({ timeout: 8000 });
await page.waitForTimeout(500);
await hotLink.click({ timeout: 8000 }).catch(async e => {
    console.log('locator hot click failed, fallback:', e.message.slice(0, 50));
    await page.evaluate(() => {
        const a = [...document.querySelectorAll('a[href*="/hot/"]')].find(x => x.closest('shreddit-sort-dropdown, shreddit-async-loader'));
        a.click();
    });
});
await page.waitForTimeout(2500);
const u = new URL(page.url());
ok(/\/hot\/?$/.test(u.pathname), `navigated to hot (${ page.url().slice(0, 60) })`);
ok(!u.searchParams.has('t') && !u.searchParams.has('screen_view_count'), `range params stripped (${ u.search }|empty ok)`);
ok(await page.evaluate(() => window.__rlAlive2 || 'gone') === 'yes', 'hot switch also swapped without reload');

// after the hot swap: reopen the dropdown — arrow bigger than menu font, item styles intact
await page.waitForTimeout(1800);
await page.locator('shreddit-sort-dropdown').locator('visible=true').first().click({ timeout: 8000 });
await page.waitForTimeout(600);
await page.evaluate(() => {
    const li = [...document.querySelectorAll('li.rl-has-sub')].find(l => {
        const r = l.getBoundingClientRect();
        return r.top > 0 && r.bottom < innerHeight && r.width > 0;
    });
    li.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
});
await page.waitForTimeout(400);
const styleCheck = await page.evaluate(() => {
    const sub = [...document.querySelectorAll('.rl-sort-sub')].find(s => getComputedStyle(s).display === 'block' &&
        s.getBoundingClientRect().top >= 0 && s.getBoundingClientRect().top < innerHeight);
    if(!sub) {
        return null;
    }
    const a = sub.querySelector('a');
    const s = getComputedStyle(a);
    const arrow = document.querySelector('.rl-sub-arrow');
    const menuFont = parseFloat(getComputedStyle(sub).fontSize);
    return {
        paddingTop: s.paddingTop,
        color     : s.color,
        arrowFont : arrow ? parseFloat(getComputedStyle(arrow).fontSize) : 0,
        menuFont
    };
});
ok(styleCheck && parseFloat(styleCheck.paddingTop) > 4, `item padding restored (${ styleCheck && styleCheck.paddingTop })`);
ok(styleCheck && styleCheck.color !== 'rgb(0, 0, 238)' && styleCheck.color !== 'rgb(0, 0, 255)', `item color not link-blue (${ styleCheck && styleCheck.color })`);
ok(styleCheck && styleCheck.arrowFont >= styleCheck.menuFont * 2.5, `arrow is ~3x menu font (${ styleCheck && styleCheck.arrowFont } vs ${ styleCheck && styleCheck.menuFont })`);
// arrow is vertically centered in the Top cell
const centered = await page.evaluate(() => {
    const arrow = [...document.querySelectorAll('.rl-sub-arrow')].find(a => a.getBoundingClientRect().width > 0 &&
        a.getBoundingClientRect().top > 0 && a.getBoundingClientRect().bottom < innerHeight);
    const li = arrow && arrow.closest('li');
    if(!arrow || !li) {
        return null;
    }
    const ar = arrow.getBoundingClientRect();
    const lr = li.getBoundingClientRect();
    return Math.abs((ar.top + ar.bottom) / 2 - (lr.top + lr.bottom) / 2);
});
ok(centered !== null && centered < 4, `arrow vertically centered in the cell (offset ${ centered === null ? 'n/a' : centered.toFixed(1) }px)`);
console.log('\n[RL] tail:', rlLogs.filter(l => l.includes('[RL]')).slice(-6).join(' | '));
console.log(`\n${ FAIL.length ? '❌ FAILED: ' + FAIL.join('; ') : '✅ ALL PASSED' }`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
