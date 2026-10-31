import fs from 'node:fs';
import path from 'node:path';

import { safeReadFileSync } from './util.js';

export const PRESENCE_PING_INTERVAL_MS = 5000;

const RECENT_GRACE_MS = 15_000;

function getPresenceFilePath() {
    return path.join(globalThis.DATA_ROOT, 'browser-presence.json');
}

export function touchBrowserPresence() {
    try {
        fs.writeFileSync(getPresenceFilePath(), JSON.stringify({ timestamp: Date.now() }));
    } catch (err) {
        console.error('[browser-presence] Failed to record browser heartbeat:', err.message);
    }
}

export function wasBrowserRecentlyConnected() {
    try {
        const raw = safeReadFileSync(getPresenceFilePath());
        if (!raw) return false;
        const { timestamp } = JSON.parse(raw);
        return typeof timestamp === 'number' && (Date.now() - timestamp) < RECENT_GRACE_MS;
    } catch (err) {
        console.error('[browser-presence] Failed to read browser presence file:', err.message);
        return false;
    }
}
