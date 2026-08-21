import { color } from '../util.js';

/**
 * Lazily loads better-sqlite3, the native-compiled backend the fast full-text character/group search indexes
 * (characters-search-index.js, groups-search-index.js) are built on. Centralized here (rather than each caller
 * importing 'better-sqlite3' directly) so there's exactly one load attempt, one cached outcome, and one warning
 * message - callers that need the search index just call getBetterSqlite3() and check for null.
 *
 * WHY THIS CAN FAIL: better-sqlite3 ships prebuilt binaries for the most common platform/arch/Node-version
 * combinations, but that coverage isn't universal - musl-based Linux (Alpine, common in slim Docker images),
 * brand-new Node majors shortly after release, and less common arch/runtime combos (deno, bun, some ARM
 * targets) can all fall through to "no prebuilt binary found", which then needs a local C++ toolchain (a C/C++
 * compiler plus Python 3 for node-gyp) to build from source - not something every SillyTavern install has.
 *
 * A missing native module here must never take the whole server down: this is search, not a core feature the
 * app can't function without. Everything that depends on this falls back to the slower but pure-JS Fuse.js
 * path (the one this fast index was built to replace) when getBetterSqlite3() returns null, so the app keeps
 * working - just with the old multi-second-per-keystroke search - and the fix-it instructions get printed once
 * so this isn't a silent regression nobody notices.
 * @type {typeof import('better-sqlite3') | null | undefined} undefined = not yet attempted, null = failed
 */
let databaseCtor = undefined;

/**
 * @returns {Promise<typeof import('better-sqlite3') | null>} The better-sqlite3 Database constructor, or null
 * if it isn't usable on this install (already logged a fix-it warning in that case).
 */
export async function getBetterSqlite3() {
    if (databaseCtor !== undefined) {
        return databaseCtor;
    }

    try {
        const module = await import('better-sqlite3');
        const Ctor = module.default;
        // Importing the JS wrapper always succeeds even when the native binding is missing - better-sqlite3
        // only looks up (and can throw on) the compiled .node addon lazily, the first time a Database is
        // actually constructed. So the real probe is opening one, not just resolving the import.
        new Ctor(':memory:').close();
        databaseCtor = Ctor;
    } catch (err) {
        databaseCtor = null;
        console.error(color.red('[search] better-sqlite3 (the fast full-text character/group search backend) failed to load:'));
        console.error(color.red(`[search]   ${err.message}`));
        console.error(color.yellow('[search] Falling back to the slower Fuse.js-based search - the app will keep working, just with slower search.'));
        console.error(color.yellow('[search] This usually means no prebuilt binary is available for your platform/architecture/Node version.'));
        console.error(color.yellow('[search] To fix: install a C/C++ compiler toolchain and Python 3, then run `npm rebuild better-sqlite3` in the SillyTavern directory.'));
    }

    return databaseCtor;
}
