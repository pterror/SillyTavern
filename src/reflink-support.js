/** @type {Promise<null | { reflinkFile: (src: string, dst: string) => Promise<number> }>|null} */
let reflinkModulePromise = null;

/**
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
