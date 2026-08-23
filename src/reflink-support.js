/**
 * Shared lazy-loaded `@reflink/reflink` native binding. Two call sites need this: local-import-copy.js
 * (staging a scanned source file into the uploads dir) and character-card-parser.js (preserving
 * image-data extent-sharing through the metadata-embed rewrite that follows staging). Factored out here
 * so both share one memoized load/failure outcome instead of each maintaining its own copy of the same
 * dynamic-import dance.
 */

/**
 * @type {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }>|null}
 */
let reflinkModulePromise = null;

/**
 * Loads the `@reflink/reflink` native binding on first use. This is a NAPI-RS binding that ships one
 * prebuilt binary per platform/arch/libc combination as an optional dependency - on a combination it
 * doesn't ship a binary for, `require`-ing it throws *synchronously at module load* (see its
 * `binding.js`). A static top-level `import` of that package would therefore crash every process that
 * pulls this module in on an unsupported platform, not just reflink users, so it's loaded dynamically
 * behind a try/catch instead, and only the first call pays the load cost - later calls (from either
 * caller) reuse the memoized result (including a memoized "unavailable" outcome).
 * @returns {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }>}
 */
export function loadReflinkModule() {
    if (!reflinkModulePromise) {
        reflinkModulePromise = import('@reflink/reflink').catch((/** @type {any} */ error) => {
            console.debug('reflink-support: @reflink/reflink native binding is unavailable on this platform.', error?.message ?? error);
            return null;
        });
    }
    return reflinkModulePromise;
}
