// The session this tab has open: a pointer into the chats, per tab, sent with every request as `X-ST-Session`. A new
// tab opens the device's default session: the one most recently moved by any tab on this device. A tab with none
// makes its own UUID (v7) the first time it sends one; the server creates the session on its first move.

const TAB_KEY = 'st:tab-session';
const DEVICE_KEY = 'st:device-session';

/** @type {string | null} This tab's session when storage is unavailable. */
let inMemory = null;

/**
 * @param {Storage | undefined} storage
 * @param {string} key
 */
function read(storage, key) {
    try {
        return storage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

/**
 * @param {Storage | undefined} storage
 * @param {string} key
 * @param {string | null} value
 */
function write(storage, key, value) {
    try {
        if (value === null) storage?.removeItem(key);
        else storage?.setItem(key, value);
    } catch {
        // Storage unavailable: the tab keeps its session in memory only.
    }
}

/**
 * This tab's session's UUID, or null when it has none yet.
 * @returns {string | null}
 */
export function tabSession() {
    let held;
    try {
        held = globalThis.sessionStorage.getItem(TAB_KEY);
    } catch {
        return inMemory;
    }
    if (held !== null) return held === '' ? null : held;
    // The tab's first look: it opens the device's default ('' keeps that it had none, through reloads).
    const opened = read(globalThis.localStorage, DEVICE_KEY);
    write(globalThis.sessionStorage, TAB_KEY, opened ?? '');
    return opened;
}

/**
 * A UUID v7: the time in ms, then random bits.
 * @returns {string}
 */
export function newSessionId() {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    let ms = Date.now();
    for (let i = 5; i >= 0; i--) {
        b[i] = ms % 256;
        ms = Math.floor(ms / 256);
    }
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The `X-ST-Session` header's value: the tab's session, made here when it has none. */
export function sessionHeaderValue() {
    const held = tabSession();
    if (held !== null) return held;
    const made = newSessionId();
    inMemory = made;
    write(globalThis.sessionStorage, TAB_KEY, made);
    return made;
}

/**
 * The tab's session moved (it may have just been made): it is the tab's, and the device's default.
 * @param {string} session
 */
export function sessionMoved(session) {
    inMemory = session;
    write(globalThis.sessionStorage, TAB_KEY, session);
    write(globalThis.localStorage, DEVICE_KEY, session);
}

/**
 * The server says the tab's session was deleted: the tab has none, and it isn't the device's default any more.
 */
export function sessionGone() {
    const gone = tabSession();
    inMemory = null;
    write(globalThis.sessionStorage, TAB_KEY, '');
    if (gone !== null && read(globalThis.localStorage, DEVICE_KEY) === gone) write(globalThis.localStorage, DEVICE_KEY, null);
}

/** Response headers the server answers a request's session with: the session it moved (made on a tab's first
 * move), and that the session the request named was deleted. */
export const SESSION_MOVED_HEADER = 'X-ST-Session-Moved';
export const SESSION_GONE_HEADER = 'X-ST-Session-Gone';

/**
 * Takes what an answer says of the tab's session.
 * @param {(name: string) => string | null | undefined} header Reads a response header.
 */
export function takeSessionAnswer(header) {
    if (header(SESSION_GONE_HEADER)) sessionGone();
    const moved = header(SESSION_MOVED_HEADER);
    if (moved) sessionMoved(moved);
}

let observing = false;

/**
 * Reads every answer's session headers, whoever made the request (extensions and upstream code send the tab's
 * session through `getRequestHeaders()` too): `fetch` answers, and jQuery's when it is there.
 * @param {any} [scope]
 */
export function observeSessionAnswers(scope = globalThis) {
    if (observing) return;
    observing = true;
    const fetch = scope.fetch;
    if (typeof fetch === 'function') {
        scope.fetch = async function (...args) {
            const response = await fetch.apply(this, args);
            try {
                takeSessionAnswer(name => response.headers?.get(name));
            } catch (err) {
                console.error('Reading the session headers failed:', err);
            }
            return response;
        };
    }
    scope.jQuery?.(scope.document).ajaxComplete((/** @type {unknown} */ _event, /** @type {any} */ xhr) => {
        takeSessionAnswer(name => xhr?.getResponseHeader?.(name));
    });
}
