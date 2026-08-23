#!/usr/bin/env node

/**
 * Standalone launch-time probe for the launch scripts (start.sh, Start.bat) - not imported by the running
 * server. Same shape and same reason as probe-better-sqlite3.js: those scripts run with --ignore-scripts (see
 * .npmrc), so inotify-remastered-plus's native .node addon never gets auto-built on install, and this repo
 * additionally carries a real patch (patches/inotify-remastered-plus+*.patch - see that file's own comments)
 * that patch-package also never gets to apply automatically for the same reason.
 *
 * Unlike better-sqlite3, "the package loads at all" isn't the thing worth checking - an UNPATCHED build loads
 * completely fine too, right up until a real IN_Q_OVERFLOW event crashes the whole process (reproduced
 * directly during development - see the patch's own comments). So this probes for the PATCHED capability
 * specifically: `setOverflowCallback` only exists on an Inotify instance built from the patched source, so its
 * presence is proof both that patches/inotify-remastered-plus+*.patch was actually applied to node_modules AND
 * that the compiled .node addon is currently built from that patched source (an unpatched source with a stale
 * .node left over from before an update, or vice versa, would both fail this the same way an outright-missing
 * addon would).
 *
 * Exit code communicates the outcome to the calling shell script: 0 = nothing needed (either the platform
 * doesn't use this at all - the package is `os: linux`-gated in its own package.json, npm simply never
 * installs it elsewhere - or the patched binding is present and working); 1 = caller should run
 * `patch-package` then `npm rebuild inotify-remastered-plus`.
 */
import process from 'node:process';

if (process.platform !== 'linux') {
    // Nothing to probe or rebuild - see this file's own header on why a non-Linux platform never even has
    // this package installed in the first place.
    process.exit(0);
}

try {
    const mod = await import('inotify-remastered-plus');
    const { Inotify } = mod.default;
    const inotify = new Inotify();
    const patched = typeof inotify.setOverflowCallback === 'function';
    inotify.close();
    process.exit(patched ? 0 : 1);
} catch {
    process.exit(1);
}
