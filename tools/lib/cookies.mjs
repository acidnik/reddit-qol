// Loads a copy of Firefox's cookies.sqlite and returns reddit.com cookies in playwright format.
// Usage: const cookies = await loadFirefoxRedditCookies();
import { copyFileSync, mkdtempSync, globSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const COOKIE_DOMAIN = '.reddit.com';

let cached = null;

export async function loadFirefoxRedditCookies() {
    if(cached) {
        return cached;
    }
    // The live profile DB is often locked/journaled by a running Firefox, so work on a copy.
    const globPath = path.join(homedir(), '.mozilla/firefox/*default-release/cookies.sqlite');
    const [profileDb] = globSync(globPath);
    if(!profileDb) {
        throw new Error(`no cookies.sqlite found at ${ globPath }`);
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'rql-cookies-'));
    const copy = path.join(dir, 'cookies.sqlite');
    copyFileSync(profileDb, copy);
    try {
        copyFileSync(profileDb + '-wal', copy + '-wal');
    } catch {}
    const rows = JSON.parse(execFileSync('sqlite3', [copy, '-json',
        "SELECT host, name, value, path, isSecure, expiry, isHttpOnly FROM moz_cookies WHERE host LIKE '%reddit%'"]));
    cached = rows
        .filter(r => Number.isFinite(r.expiry) && (r.expiry > 0 || r.expiry === 0))
        .map(r => ({
            name    : r.name,
            value   : r.value,
            domain  : r.host,
            path    : r.path || '/',
            secure  : !!r.isSecure,
            httpOnly: !!r.isHttpOnly,
            // Firefox stores expiry in ms for modern schema (year-2077 values), seconds for old rows;
            // playwright wants unix seconds.
            expires : r.expiry > 2e11 ? Math.floor(r.expiry / 1000) : (r.expiry > 0 ? Math.floor(r.expiry) : -1)
        }));
    return cached;
}

export const cookieDomain = COOKIE_DOMAIN;
