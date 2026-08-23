import process from 'node:process';

/**
 * Cross-platform "the low-latency fs.watch layer may have silently missed something, trigger a full reconcile
 * NOW instead of waiting for the next scheduled backstop pass" detection - see local-import-scan.js's and
 * character-metadata-db.js's own module headers on why fs.watch/inotify can silently drop events under burst
 * load with no error reported, and why a periodic backstop pass is the mandatory correctness mechanism, this
 * module only an early-trigger latency optimization on top of it.
 *
 * Genuinely three different platforms, three different signals, two different SHAPES of mechanism entirely:
 *   - Linux: the kernel's own IN_Q_OVERFLOW inotify event is the real, precise signal - queue overflow, not a
 *     heuristic. Reaching it requires a SEPARATE dedicated native watch (the plain fs.watch() Node already uses
 *     elsewhere in both modules has no channel for it at all), via inotify-remastered-plus - see
 *     attachLinuxOverflowWatch() and this repo's patches/inotify-remastered-plus+*.patch (that package's own
 *     overflow-dispatch code crashed the whole process on a real overflow before the patch - reproduced and
 *     fixed directly, see the patch's own comments).
 *   - Windows: no separate mechanism needed - ReadDirectoryChangesW buffer overflow surfaces through the SAME
 *     fs.watch() callback both modules already use, as an event with `filename === null` (see
 *     isWindowsOverflowSignal()). Node's docs don't guarantee null is EXCLUSIVELY an overflow signal (a rare
 *     UTF16->UTF8 filename-conversion failure can also produce it) - owner-confirmed acceptable: an occasional
 *     spurious extra reconcile pass triggered by that edge case is harmless, so this is treated as unambiguous.
 *   - macOS (fsevents' own kFSEventStreamEventFlagUserDropped/KernelDropped flags): not implemented - blocked on
 *     verification this module's author has no way to run/test on this platform. attachDarwinOverflowWatch()
 *     doesn't exist yet; darwin is simply not dispatched by attachOverflowWatch() below, callers get `null`
 *     back exactly as if support genuinely doesn't exist yet, which is honestly the current state.
 */

/** @type {Promise<null | { Inotify: any }> | null} */
let inotifyModulePromise = null;

/**
 * Lazily loads the `inotify-remastered-plus` native binding, memoized across calls - same reasoning as
 * local-import-copy.js's loadReflinkModule(): a static top-level import would crash every process that pulls
 * this module in on a platform where the binding isn't installed/buildable, so it's loaded dynamically behind
 * a try/catch instead. That package's own package.json is already `os: linux`-gated (npm simply skips
 * installing it elsewhere), so a non-Linux platform hits the catch branch here too, harmlessly.
 *
 * Unwraps `.default`, not the dynamic-import namespace object directly - confirmed by inspection, not assumed:
 * this package is a plain CJS native addon (`module.exports = require('bindings')('inotify.node')`), and
 * Node's CJS->ESM interop can't statically detect named exports on an object a native addon populates from C++,
 * so `await import(...)` only ever exposes the whole CJS `module.exports` as `.default` here, never spread as
 * top-level named exports the way it would for a plain JS object literal.
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
 * Attaches a dedicated inotify watch on `dir` whose only purpose is catching IN_Q_OVERFLOW and invoking
 * `onOverflow` when it fires - entirely separate from whatever OTHER fs.watch() a caller already has on the
 * same directory for ordinary per-file change events (this module never replaces that, only adds to it).
 * @param {string} dir
 * @param {() => void} onOverflow
 * @returns {Promise<{ close: () => void } | null>} `null` if the native binding isn't available (wrong
 * platform, failed to load) or the watch itself couldn't be created (directory missing, permission error) -
 * callers must treat that as "no early-trigger available, the periodic backstop alone is what's relied on",
 * never as an error to surface, matching this module's own "latency optimization only" posture throughout.
 */
export async function attachLinuxOverflowWatch(dir, onOverflow) {
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
        // watch_for is deliberately minimal (IN_CREATE only, via the constant the binding exposes) - this watch
        // exists purely to keep inotify_add_watch() itself alive against `dir` so the kernel has a queue to
        // overflow in the first place; the actual per-file events it also necessarily generates are never read
        // by this module's own callback (a no-op below) - the CALLER's own separate fs.watch() on the same
        // directory is what handles those, same as before this module existed.
        const wd = inotify.addWatch({ path: dir, watch_for: Inotify.IN_CREATE, callback: () => {} });
        if (wd < 0) {
            console.debug(`watch-overflow: inotify_add_watch failed for ${dir} (errno via wd=${wd}) - falling back to the periodic backstop pass alone.`);
            inotify.close();
            return null;
        }
        return { close: () => inotify.close() };
    } catch (err) {
        console.debug(`watch-overflow: failed to attach a Linux overflow watch for ${dir} (the periodic backstop pass remains the source of truth):`, err.message);
        return null;
    }
}

/**
 * Dispatches to the right platform-specific overflow watch, or `null` on a platform with no implementation yet
 * (currently: everything except Linux). Callers treat `null` exactly like a failed/unavailable watch - there is
 * no "unsupported platform" error path, only "no early-trigger available this run".
 * @param {string} dir
 * @param {() => void} onOverflow
 * @returns {Promise<{ close: () => void } | null>}
 */
export async function attachOverflowWatch(dir, onOverflow) {
    if (process.platform === 'linux') return attachLinuxOverflowWatch(dir, onOverflow);
    return null;
}

/**
 * Windows-only check for the OTHER overflow signal shape: unlike Linux, this rides on the SAME fs.watch()
 * callback a caller already has for ordinary events - call this with the callback's own `filename` argument
 * wherever that callback currently does `if (!filename) return;` (both local-import-scan.js's
 * startWatcherFor() and character-metadata-db.js's startWatcher() have exactly this shape).
 * @param {string | null} filename
 * @returns {boolean}
 */
export function isWindowsOverflowSignal(filename) {
    return process.platform === 'win32' && filename === null;
}
