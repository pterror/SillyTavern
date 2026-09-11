import { color } from '../util.js';

/**
 * Loaded once and cached; a missing native binding falls back to Fuse.js search rather than failing startup.
 * @type {typeof import('better-sqlite3') | null | undefined} undefined = not yet attempted, null = failed
 */
let databaseCtor = undefined;

/** @returns {Promise<typeof import('better-sqlite3') | null>} */
export async function getBetterSqlite3() {
    if (databaseCtor !== undefined) {
        return databaseCtor;
    }

    try {
        const module = await import('better-sqlite3');
        const Ctor = module.default;
        // The native binding is only probed on first Database construction, not on import.
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
