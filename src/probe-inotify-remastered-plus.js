#!/usr/bin/env node

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
