// The session this tab has open: a pointer into the chats, per tab, sent with every request as
// `X-ST-Session` (`none` until the tab has one). A new tab opens the device's default session: the one most recently
// moved by any tab on this device. A tab with none gets one when the server makes it, on its first move.

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

/** The `X-ST-Session` header's value. */
export function sessionHeaderValue() {
    return tabSession() ?? 'none';
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
