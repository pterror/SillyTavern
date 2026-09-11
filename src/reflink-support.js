/** Shared lazy-loaded `@reflink/reflink` native binding, memoized across callers. */

/** @type {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }>|null} */
let reflinkModulePromise = null;

/**
 * Loaded dynamically behind a try/catch: this optional-dependency native binding doesn't ship a
 * prebuilt binary for every platform, and `require`-ing it synchronously throws at module load on
 * an unsupported one.
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
