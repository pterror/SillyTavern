import fs from 'node:fs';
import path from 'node:path';

import { safeReadFileSync } from './util.js';

// How often a held-open connection re-touches the presence file. Also doubles as an SSE keep-alive ping
// interval so proxies/load balancers don't time out the idle connection - see characters.js's `/changes/stream`
// route, which now owns the actual SSE connection this drives (merged in from this module's own former
// `/api/browser-heartbeat` SSE endpoint - see that merge's commit for why: each held its own permanent
// EventSource per tab, and the per-origin browser connection pool is shared across every tab/window of the
// same origin, not per-tab, so N tabs meant 2N permanently-occupied slots out of the ~6 total before any other
// request could even be sent - a handful of tabs was enough to starve the pool completely).
export const PRESENCE_PING_INTERVAL_MS = 5000;

// How recent the last-seen timestamp has to be, at boot, to count as "a browser tab is already open".
// A restart drops every open EventSource, and the browser doesn't retry instantly - this has to comfortably
// cover one ping interval plus a normal restart, without being so long that a real "nothing was open" boot
// gets treated as if something was.
const RECENT_GRACE_MS = 15_000;

function getPresenceFilePath() {
    return path.join(globalThis.DATA_ROOT, 'browser-presence.json');
}

/**
 * Records that a browser client is (or very recently was) connected, so a boot that races a client's
 * reconnect attempt still sees it as present. Called from characters.js's `/changes/stream` handler, once
 * on connect and once per `PRESENCE_PING_INTERVAL_MS` for as long as the connection stays open.
 */
export function touchBrowserPresence() {
    try {
        fs.writeFileSync(getPresenceFilePath(), JSON.stringify({ timestamp: Date.now() }));
    } catch (err) {
        console.error('[browser-presence] Failed to record browser heartbeat:', err.message);
    }
}

/**
 * Whether a browser client was connected recently enough (including one that's mid-reconnect right now
 * because the server just restarted) that a boot-time browser launch should be skipped.
 * @returns {boolean}
 */
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
