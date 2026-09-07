import process from 'node:process';

/**
 * Cross-platform native directory watching, where a real native mechanism actually exists, PLUS the "the
 * low-latency watch layer may have silently missed something, trigger a full reconcile NOW instead of waiting
 * for the next scheduled backstop pass" overflow/drop detection that rides alongside it - see
 * local-import-scan.js's and character-metadata-db.js's own module headers on why fs.watch/inotify can silently
 * drop events under burst load with no error reported, and why a periodic backstop pass is the mandatory
 * correctness mechanism regardless of which watch mechanism is delivering events.
 *
 * Genuinely three different platforms, three different shapes of support:
 *   - Linux: inotify-remastered-plus (this repo's patches/inotify-remastered-plus+*.patch fixes a real crash in
 *     its overflow-dispatch code - reproduced and fixed directly, see the patch's own comments) is used as the
 *     ACTUAL PRIMARY event source here (attachLinuxDirectoryWatch() below), not as a bolt-on riding alongside a
 *     separate plain fs.watch() on the same directory - fs.watch() is exactly the known-unreliable mechanism
 *     (can silently drop/coalesce events under burst load, with no error signal JS can observe) this exists to
 *     get off of wherever a real native alternative is available, so callers should prefer it over fs.watch()
 *     for actual event delivery, not just for the kernel's own IN_Q_OVERFLOW signal (queue overflow, a real
 *     precise signal - not a heuristic - that has no channel through plain fs.watch() at all).
 *   - Windows: no native binding here - ReadDirectoryChangesW buffer overflow surfaces through the SAME
 *     fs.watch() callback both modules already use, as an event with `filename === null` (see
 *     isWindowsOverflowSignal()). Node's docs don't guarantee null is EXCLUSIVELY an overflow signal (a rare
 *     UTF16->UTF8 filename-conversion failure can also produce it) - owner-confirmed acceptable: an occasional
 *     spurious extra reconcile pass triggered by that edge case is harmless, so this is treated as unambiguous.
 *     fs.watch() remains the primary (and only) event source on this platform.
 *   - macOS (fsevents' own kFSEventStreamEventFlagUserDropped/KernelDropped flags, and a real native primary
 *     watch to go with it): not implemented - blocked on verification this module's author has no way to
 *     run/test on this platform. Nothing in this module is dispatched for darwin; callers get `null` back
 *     exactly as if support genuinely doesn't exist yet, which is honestly the current state - fs.watch() plus
 *     the always-on periodic backstop pass (never able to back off into heartbeat mode, since that requires a
 *     confirmed overflow/primary watch) is what macOS runs on for now, tracked as a separate, smaller followup
 *     rather than folded into this file.
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
 * Attaches inotify-remastered-plus directly on `dir` as the PRIMARY event source (2026-09: replaces the old
 * shape here, where a SEPARATE dedicated inotify watch existed only for IN_Q_OVERFLOW while a caller's own
 * plain fs.watch() on the same directory did the real per-file event delivery - meaning Linux watched every
 * configured directory twice, with the more reliable native mechanism used only for the narrower of the two
 * jobs). One real inotify watch now does both: `onEvent` fires once per raw event this watch's mask covers
 * (every raw event, no filtering by this module - same "let the caller's own debounce/mtime-check absorb the
 * noise" posture plain fs.watch() callers already had to have anyway, since fs.watch() itself never filtered
 * either), and `onOverflow` fires on the kernel's own IN_Q_OVERFLOW signal (queue overflow - a real precise
 * signal, not a heuristic, that has no channel through plain fs.watch() at all).
 * @param {string} dir
 * @param {{ onEvent: (filename: string) => void, onOverflow: () => void }} handlers
 * @returns {Promise<{ close: () => void } | null>} `null` if the native binding isn't available (wrong
 * platform, failed to load) or the watch itself couldn't be created (directory missing, permission error) -
 * callers must treat that as "no native watch available this run, fall back to fs.watch() for event delivery
 * and the periodic backstop alone for overflow detection", never as an error to surface, matching this
 * module's own "optional native mechanism, never the thing solely relied on" posture throughout.
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
        // Broad, unfiltered mask - deliberately mirroring fs.watch()'s own lack of event-type filtering (it
        // fires its callback for essentially any change under the directory), so switching a caller from
        // fs.watch() to this watch changes WHICH mechanism delivers events, never what counts as "something
        // may have changed, go recheck this filename" from the caller's point of view.
        const watchFor = Inotify.IN_CREATE | Inotify.IN_CLOSE_WRITE | Inotify.IN_MODIFY | Inotify.IN_DELETE
            | Inotify.IN_MOVED_FROM | Inotify.IN_MOVED_TO | Inotify.IN_ATTRIB;
        const wd = inotify.addWatch({
            path: dir,
            watch_for: watchFor,
            callback: (event) => {
                // No `name` at all is a self-watch event (IN_DELETE_SELF/IN_MOVE_SELF/IN_IGNORED on `dir`
                // itself, none of which this watch_for mask actually requests, but the binding can still
                // surface IN_IGNORED on watch teardown) - nothing for a per-FILE onEvent callback to act on,
                // same as the `if (!filename) return;` guard every fs.watch() caller already has.
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
