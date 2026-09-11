import process from 'node:process';

/**
 * Native directory watching plus overflow/drop detection, so callers can trigger an immediate reconcile instead
 * of waiting for the next backstop pass. Linux uses inotify-remastered-plus as the primary event source with a
 * real IN_Q_OVERFLOW signal; Windows detects overflow via `filename === null` on the ordinary fs.watch()
 * callback; macOS isn't implemented (no native binding dispatched, callers get `null`).
 */

/** @type {Promise<null | { Inotify: any }> | null} */
let inotifyModulePromise = null;

/**
 * Loaded dynamically (not a static import) since the native binding isn't installed on non-Linux platforms.
 * @returns {Promise<null | { Inotify: any }>}
 */
function loadInotifyModule() {
    if (!inotifyModulePromise) {
        inotifyModulePromise = import('inotify-remastered-plus').then(mod => mod.default).catch((/** @type {any} */ error) => {
            console.debug('watch-overflow: inotify-remastered-plus native binding is unavailable on this platform, falling back to the periodic backstop pass alone.', error?.message ?? error);
            return null;
        });
    }
    return inotifyModulePromise;
}

/**
 * Attaches inotify-remastered-plus on `dir` as the primary event source: `onEvent` fires per raw event
 * (unfiltered, like fs.watch()), `onOverflow` fires on the kernel's IN_Q_OVERFLOW signal.
 * @param {string} dir
 * @param {{ onEvent: (filename: string) => void, onOverflow: () => void }} handlers
 * @returns {Promise<{ close: () => void } | null>} `null` if unavailable — caller should fall back to fs.watch().
 */
export async function attachLinuxDirectoryWatch(dir, { onEvent, onOverflow }) {
    if (process.platform !== 'linux') return null;

    const mod = await loadInotifyModule();
    if (!mod) return null;

    const { Inotify } = mod;
    try {
        const inotify = new Inotify();
        inotify.setOverflowCallback(() => {
            try {
                onOverflow();
            } catch (err) {
                console.error('watch-overflow: onOverflow callback threw (the periodic backstop pass remains the source of truth):', err.message);
            }
        });
        const watchFor = Inotify.IN_CREATE | Inotify.IN_CLOSE_WRITE | Inotify.IN_MODIFY | Inotify.IN_DELETE
            | Inotify.IN_MOVED_FROM | Inotify.IN_MOVED_TO | Inotify.IN_ATTRIB;
        const wd = inotify.addWatch({
            path: dir,
            watch_for: watchFor,
            callback: (event) => {
                // No `name` means a self-watch event (e.g. IN_IGNORED on teardown), not a file change.
                if (!event || !event.name) return;
                try {
                    onEvent(event.name);
                } catch (err) {
                    console.error(`watch-overflow: onEvent callback threw for ${dir}/${event.name} (the periodic backstop pass remains the source of truth):`, err.message);
                }
            },
        });
        if (wd < 0) {
            console.debug(`watch-overflow: inotify_add_watch failed for ${dir} (errno via wd=${wd}) - falling back to fs.watch()/the periodic backstop pass.`);
            inotify.close();
            return null;
        }
        return { close: () => inotify.close() };
    } catch (err) {
        console.debug(`watch-overflow: failed to attach a Linux primary watch for ${dir} (falling back to fs.watch()/the periodic backstop pass remains the source of truth):`, err.message);
        return null;
    }
}

/**
 * Windows ReadDirectoryChangesW overflow surfaces as `filename === null` on the ordinary fs.watch() callback.
 * @param {string | null} filename
 * @returns {boolean}
 */
export function isWindowsOverflowSignal(filename) {
    return process.platform === 'win32' && filename === null;
}
