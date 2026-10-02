/* ==[ tools/lib/browser.mjs ]===============================================================================
                              SHARED HELPERS FOR THE BROWSER DEBUG SCRIPTS
   Locates playwright and a Chromium build without hardcoded absolute paths (same approach as
   Dollchan-Extension-Tools/tools/lib/browser.mjs). Scripts in tools/ run with any playwright install.
=========================================================================================================== */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const PLAYWRIGHT_CANDIDATES = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    path.join(homedir(), '.pi/agent/npm/node_modules/playwright/index.js'),
    '/usr/lib/node_modules/playwright/index.js',
    '/usr/local/lib/node_modules/playwright/index.js'
].filter(Boolean);

// Returns the `chromium` export of whichever playwright install can be found.
export async function getChromium() {
    for(const candidate of PLAYWRIGHT_CANDIDATES) {
        try {
            const mod = await import(candidate);
            const pw = mod.default ?? mod;
            if(pw?.chromium) {
                return pw.chromium;
            }
        } catch(err) {}
    }
    throw new Error(`playwright not found. Tried:\n  ${ PLAYWRIGHT_CANDIDATES.join('\n  ') }\n` +
        'Set PLAYWRIGHT_PATH=/abs/path/to/playwright/index.js');
}

// Chromium expects a binary that matches its own revision, so point it at a cached build instead of
// running `npx playwright install`.
export function findChromiumBinary() {
    if(process.env.CHROME_PATH) {
        return process.env.CHROME_PATH;
    }
    const root = path.join(homedir(), '.cache/ms-playwright');
    const variants = ['chrome-linux64/chrome', 'chrome-linux/chrome'];
    const shellVariants = ['chrome-headless-shell-linux64/chrome-headless-shell'];
    const revisions = existsSync(root) ? readdirSync(root).sort(byRevision) : [];
    for(const variant of [...variants, ...shellVariants]) {
        for(const revision of revisions) {
            const bin = path.join(root, revision, variant);
            if(existsSync(bin)) {
                return bin;
            }
        }
    }
    throw new Error(`no Chromium found under ${ root }.\n` +
        'Run `npx playwright install chromium` or set CHROME_PATH=/abs/path/to/chrome');
}

// Newest revision first, so `chromium-1234` wins over `chromium-100`
function byRevision(a, b) {
    const num = str => +(str.match(/-(\d+)$/)?.[1] ?? 0);
    return num(b) - num(a) || b.localeCompare(a);
}

export function launchOptions(extra = {}) {
    const { args = [], ...rest } = extra;
    return {
        executablePath: findChromiumBinary(),
        headless      : process.env.HEADLESS !== '0',
        args          : ['--disable-http-cache', ...args],
        ...rest
    };
}

// Injects the userscript before any page script runs, so we can watch it work on real pages.
export async function installUserscript(page, scriptPath) {
    const src = (await import('node:fs')).readFileSync(scriptPath, 'utf8');
    await page.addInitScript(src);
}

// Batches console logging of the page: pass a page and it prints [page-log] lines with a prefix.
export function forwardPageLogs(page, prefix = 'page') {
    page.on('console', msg => {
        const type = msg.type();
        if(type === 'info' || type === 'log' || type === 'warn' || type === 'error') {
            console.log(`[${ prefix}:${ type }][${ new Date().toISOString().slice(11, 23) }] ${ msg.text() }`);
        }
    });
    page.on('pageerror', err => console.error(`[${ prefix}:pageerror] ${ err.message }`));
}

// Reddit hard-blocks headless sessions (humanity wall), so tests run headed - but a test window
// popping over the user's desktop is hostile: park it on the last niri workspace without focus.
export async function parkOutOfTheWay() {
    if(!(process.env.WAYLAND_DISPLAY || process.env.NIRI_SOCKET)) {
        return;
    }
    // the window maps only after the first page paint, so park it from a detached process
    // that keeps polling niri for up to 30s instead of blocking the test
    const child = spawn(process.execPath, ['-e', `
        const { execFileSync } = require('node:child_process');
        const niriJson = args => JSON.parse(execFileSync('niri', ['msg', '--json', ...args], {encoding:'utf8'}));
        // park every chromium window except this guardian script's own (there is none)
        async function main() {
            const wsCount = Math.max(...niriJson(['workspaces']).map(w => w.idx));
            for(let i = 0; i < 60; i++) {
                const wins = niriJson(['windows']).filter(w => /chrom/i.test(w.app_id || ''));
                for(const win of wins) {
                    execFileSync('niri', ['msg', 'action', 'move-window-to-workspace',
                        '--window-id', String(win.id), '--focus', 'false', String(wsCount)]);
                    console.log('parked browser window #' + win.id + ' on workspace ' + wsCount);
                }
                if(wins.length) {
                    return;
                }
                await new Promise(r => setTimeout(r, 500));
            }
        }
        main();
    `], { detached: true, stdio: 'ignore' });
    child.unref();
}
