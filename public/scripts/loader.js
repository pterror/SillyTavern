import { loader } from './action-loader.js';

/**
 * Handle for the legacy loader created by showLoader().
 * @type {import('./action-loader.js').ActionLoaderHandle|null}
 */
let legacyLoaderHandle = null;

/**
 * @deprecated Use `showActionLoader()` from action-loader.js instead.
 */
export function showLoader() {
    if (legacyLoaderHandle && legacyLoaderHandle.isActive) {
        legacyLoaderHandle.hide();
    }

    legacyLoaderHandle = loader.show({
        slug: 'legacy-loader',
        blocking: true,
        toastMode: loader.ToastMode.NONE,
    });
}

/**
 * @deprecated Use `hideActionLoader()` or `handle.hide()` from action-loader.js instead.
 */
export async function hideLoader() {
    if (!legacyLoaderHandle || !legacyLoaderHandle.isActive) {
        console.warn('There is no loader showing to hide');
        return Promise.resolve();
    }

    await legacyLoaderHandle.hide();
    legacyLoaderHandle = null;
}
