import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { safeReadFileSync } from './util.js';

export const router = express.Router();

// How often an open heartbeat connection re-touches the presence file. Also doubles as the SSE keep-alive
// ping so proxies/load balancers don't time out the idle connection.
const PING_INTERVAL_MS = 5000;

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
 * reconnect attempt still sees it as present.
 */
function touchBrowserPresence() {
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

/**
 * SSE endpoint a browser tab holds open for as long as it's alive. `EventSource` auto-reconnects on drop
 * (e.g. a server restart), so an open tab keeps re-touching the presence file within `RECENT_GRACE_MS` of
 * any restart, which is what lets `wasBrowserRecentlyConnected()` tell a fresh boot "don't open a new tab,
 * one's already open and about to reconnect".
 */
router.get('/', function (request, response) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    response.write(':ok\n\n');
    touchBrowserPresence();

    const interval = setInterval(() => {
        response.write(':ping\n\n');
        touchBrowserPresence();
    }, PING_INTERVAL_MS);

    request.on('close', () => {
        clearInterval(interval);
    });
});
