#!/usr/bin/env node

// Standalone launch-time check (see probe-better-sqlite3.js for why). An unpatched build still loads
// fine but crashes on a real IN_Q_OVERFLOW event, so this checks for `setOverflowCallback`, which only
// exists on a patched build, rather than just checking that the import succeeds.
// Exit 0 = ok (or platform doesn't ship this package), 1 = caller should patch-package + rebuild.
import process from 'node:process';

if (process.platform !== 'linux') {
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
