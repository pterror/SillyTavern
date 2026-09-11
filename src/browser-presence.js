import fs from 'node:fs';
import path from 'node:path';

import { safeReadFileSync } from './util.js';

// Also doubles as the SSE keep-alive ping interval on characters.js's `/changes/stream` route,
// so proxies/load balancers don't time out the idle connection.
export const PRESENCE_PING_INTERVAL_MS = 5000;

// Must comfortably cover one ping interval plus a normal restart, without misreading a real
// "nothing was open" boot as one where a tab was open.
const RECENT_GRACE_MS = 15_000;

function getPresenceFilePath() {
    return path.join(globalThis.DATA_ROOT, 'browser-presence.json');
}

/** Records that a browser client is (or very recently was) connected. */
export function touchBrowserPresence() {
    try {
        fs.writeFileSync(getPresenceFilePath(), JSON.stringify({ timestamp: Date.now() }));
    } catch (err) {
        console.error('[browser-presence] Failed to record browser heartbeat:', err.message);
    }
}

/** Whether a browser client was connected recently enough that a boot-time browser launch should be skipped. */
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
