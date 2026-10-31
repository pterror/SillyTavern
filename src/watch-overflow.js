import process from 'node:process';

/** @type {Promise<null | { Inotify: any }> | null} */
let inotifyModulePromise = null;

/**
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
 * @param {string} dir
 * @param {{ onEvent: (filename: string) => void, onOverflow: () => void }} handlers
 * @returns {Promise<{ close: () => void } | null>}
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
 * @param {string | null} filename
 * @returns {boolean}
 */
export function isWindowsOverflowSignal(filename) {
    return process.platform === 'win32' && filename === null;
}
