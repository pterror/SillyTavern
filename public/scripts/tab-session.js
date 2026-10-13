import { changeStreamRetryDelayMs } from './change-stream-backoff.js';

// The session this tab has open: a pointer into the chats, per tab, sent with every request as `X-ST-Session`. No two
// open tabs hold the same session. The tab's changes stream (`/api/characters/changes/stream`) holds it at the server
// and tells the tab where it is; a Web Lock named after it holds it among this browser's tabs.
// - A fresh tab (nothing in sessionStorage) is given one by the server when its stream opens: the user's most recent
//   session no tab holds, else a new one at the most recent one's place. Its first requests wait for it.
// - A reloaded or restored tab (its sessionStorage kept) goes on with its own, unless another tab holds it (a
//   duplicated tab's copy, or a tab that took it while this one was closed): then it forks it from where this tab
//   last was, its history up to there and its current chats as this tab last had them.
// - Where the browser gives no Web Locks (plain http to a LAN address), tabs of the browser tell each other their token
//   on a BroadcastChannel instead: of two live tabs with one token (a duplicate copied it), the later loaded forks.
// - A stream that doesn't answer within STREAM_WAIT_MS doesn't hold the page: a tab with a stored session uses it, a
//   fresh one goes on with none (requests send `none`) and takes the session its stream gives it when it connects.

const TAB_KEY = 'st:tab-session';
const TOKEN_KEY = 'st:tab-token';
const PLACE_KEY = 'st:tab-place';
const CHATS_KEY = 'st:tab-chats';
/** What tabs kept before a tab's session was its own; read by nothing. */
const OLD_DEVICE_KEY = 'st:device-session';

/** @type {string | null} This tab's session when storage is unavailable. */
let inMemory = null;
/** @type {string | null} */
let tokenInMemory = null;
/** Whether the tab has its session (until then a fresh tab sends `none`), or has stopped waiting for the stream. */
let ready = false;
/** Whether the page went on without the stream's answer and has not had a session frame since. */
let streamMissing = false;
/** How long the page waits for the changes stream's first answer. It takes a few ms locally (2-5 in 15 loads), so
 * this leaves room for a slow network and a busy server, and a down stream costs the page no more than this. */
export const STREAM_WAIT_MS = 3000;
/** @type {Promise<void> | null} */
let preparing = null;
/** @type {() => Record<string, string>} The page's request headers (its CSRF token among them). */
let requestHeaders = () => ({});

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
    return held === null || held === '' ? null : held;
}

/**
 * The token naming this tab to the server: kept through reloads, so the tab's own stream from before a reload isn't
 * taken for another tab's.
 */
export function tabToken() {
    const held = read(globalThis.sessionStorage, TOKEN_KEY) ?? tokenInMemory;
    if (held) return held;
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    const made = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    tokenInMemory = made;
    write(globalThis.sessionStorage, TOKEN_KEY, made);
    return made;
}

/** Gives the tab a new token (a duplicate's, when another tab has the one it copied). */
function mintToken() {
    tokenInMemory = null;
    write(globalThis.sessionStorage, TOKEN_KEY, null);
    return tabToken();
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

/**
 * Where the tab last was in its session's history: how many entries it had and the cursor's (0: none).
 * @returns {{ length: number, cursor: number }}
 */
export function tabPlace() {
    try {
        const p = JSON.parse(read(globalThis.sessionStorage, PLACE_KEY) ?? 'null');
        if (Number.isSafeInteger(p?.length) && Number.isSafeInteger(p?.cursor)) return { length: p.length, cursor: p.cursor };
    } catch {
        // Unreadable: none.
    }
    return { length: 0, cursor: 0 };
}

/**
 * @param {{ length: number, cursor: number } | null} place
 */
function setPlace(place) {
    write(globalThis.sessionStorage, PLACE_KEY, place ? JSON.stringify({ length: place.length, cursor: place.cursor }) : null);
}

/**
 * The tab's current chat per tree, by `a:<avatar>` or `g:<group id>`: a bookmark's id.
 * @returns {Record<string, string>}
 */
export function tabChats() {
    try {
        const c = JSON.parse(read(globalThis.sessionStorage, CHATS_KEY) ?? '{}');
        return c && typeof c === 'object' ? c : {};
    } catch {
        return {};
    }
}

/**
 * @param {{ avatar?: string, group?: string }} tree
 */
function treeKey(tree) {
    return typeof tree?.group === 'string' ? `g:${tree.group}` : typeof tree?.avatar === 'string' ? `a:${tree.avatar}` : null;
}

/**
 * @param {{ tree: { avatar?: string, group?: string }, bookmark: string | null }[]} changes
 * @param {boolean} [replace] The tab's chats are these alone.
 */
function setChats(changes, replace = false) {
    const chats = replace ? {} : tabChats();
    for (const { tree, bookmark } of changes) {
        const k = treeKey(tree);
        if (k === null) continue;
        if (bookmark === null) delete chats[k];
        else chats[k] = bookmark;
    }
    write(globalThis.sessionStorage, CHATS_KEY, JSON.stringify(chats));
}

// ---- holding the session among this browser's tabs ----

/** @type {(() => void) | null} */
let releaseLock = null;

/** @param {string} session */
function lockName(session) {
    return `st-session:${session}`;
}

/** @returns {any} */
function locks() {
    return globalThis.navigator?.locks ?? null;
}

/**
 * Whether another tab of this browser holds the session.
 * @param {string} session
 */
async function lockHeld(session) {
    const l = locks();
    if (!l) return false;
    const { held } = await l.query();
    return held.some((/** @type {{ name: string }} */ h) => h.name === lockName(session));
}

/** @param {string | null} session */
function holdLock(session) {
    releaseLock?.();
    releaseLock = null;
    const l = locks();
    if (!l || session === null) return;
    /** @type {() => void} */
    let release = () => {};
    const until = new Promise(resolve => release = () => resolve(undefined));
    l.request(lockName(session), () => until).catch(() => {});
    releaseLock = release;
}

/**
 * The tab's session becomes `session`: held here, kept in sessionStorage, and its stream follows it.
 * @param {string | null} session
 * @param {{ keepPlace?: boolean, follow?: boolean }} [o] `keepPlace`: the place and chats stored are this session's too
 * (a fork's). `follow`: the stream reconnects to hold it (not when the stream itself was just given it).
 */
function setSession(session, { keepPlace = false, follow = true } = {}) {
    const before = tabSession();
    inMemory = session;
    write(globalThis.sessionStorage, TAB_KEY, session ?? '');
    if (session === before) return;
    if (!keepPlace) {
        setPlace(null);
        setChats([], true);
    }
    holdLock(session);
    if (ready && follow && session !== null) reconnect();
}

/** The `X-ST-Session` header's value: the tab's session, made here when it has none; `none` until it has one. */
export function sessionHeaderValue() {
    const held = tabSession();
    if (held !== null) return held;
    if (!ready || streamMissing) return 'none';
    const made = newSessionId();
    setSession(made);
    return made;
}

/**
 * The tab's session moved (it may have just been made).
 * @param {string} session
 */
export function sessionMoved(session) {
    setSession(session, { keepPlace: session === tabSession() });
}

/**
 * The server says the tab's session was deleted: the tab has none.
 */
export function sessionGone() {
    setSession(null);
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

/**
 * Forks `from` for this tab: a new session from where the tab last was in it, with its current chats. A session
 * the server doesn't have (never stored, or deleted) leaves the tab a new one of its own.
 * @param {string} from
 * @param {boolean} [newToken] The tab takes a new token with the fork (another tab has its old one).
 */
async function forkFrom(from, newToken = false) {
    const { length, cursor } = tabPlace();
    const chats = Object.entries(tabChats()).map(([k, bookmark]) => ({ tree: k.startsWith('g:') ? { group: k.slice(2) } : { avatar: k.slice(2) }, bookmark }));
    let session = null;
    try {
        const response = await globalThis.fetch('/api/chats/session/fork', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ from, length, cursor, chats }),
        });
        if (response.ok) session = (await response.json()).session ?? null;
        else if (response.status !== 404) throw new Error(`The session fork answered ${response.status}`);
    } catch (err) {
        console.error('Forking the tab\'s session failed:', err);
        throw err;
    }
    if (newToken) mintToken();
    if (session === null) {
        setSession(newSessionId());
        return;
    }
    setSession(session, { keepPlace: true });
}

// ---- telling tabs of this browser apart without Web Locks ----

const CHANNEL_NAME = 'st-tab-token';
/** @type {BroadcastChannel | null} */
let channel = null;
let leaving = false;

/**
 * This tab shares its token with an earlier loaded live tab (a duplicate copied it): it takes a new token and forks
 * its session from where it is, and its stream follows with the new token.
 */
async function leaveSharedToken() {
    if (leaving) return;
    leaving = true;
    try {
        const session = tabSession();
        if (session === null) mintToken();
        else await forkFrom(session, true);
        // setSession reconnects a tab that is ready and has a new session; any other stream still names the old token.
        if (!ready || session === null) reconnect();
    } catch (err) {
        console.error('Leaving a token shared with another tab failed:', err);
    } finally {
        leaving = false;
    }
}

/**
 * Announces this tab's (session, token, load time) to the browser's other tabs, and answers theirs. A tab that hears
 * its own token from a tab loaded before it (ties: the larger random number) is the duplicate and leaves the token.
 * Only where there are no Web Locks, which cover this on their own.
 */
function watchSharedToken() {
    if (locks() || typeof globalThis.BroadcastChannel === 'undefined') return;
    const loaded = Date.now();
    const tie = Math.random();
    try {
        channel = new globalThis.BroadcastChannel(CHANNEL_NAME);
    } catch {
        return;
    }
    const ch = channel;
    const say = (/** @type {string} */ type) => ch.postMessage({ type, session: tabSession(), token: tabToken(), loaded, tie });
    ch.onmessage = ({ data }) => {
        if (!data || data.token !== tabToken()) return;
        if (data.type === 'hello') say('here');
        if (loaded > data.loaded || (loaded === data.loaded && tie > data.tie)) void leaveSharedToken();
    };
    say('hello');
}

// ---- the changes stream ----

/**
 * @typedef {object} StreamHandlers
 * @property {(message: any) => void} message A frame not about the tab's session.
 * @property {() => void} open
 * @property {() => void} error
 */

/** @type {StreamHandlers | null} */
let handlers = null;
/** @type {{ kind: 'message' | 'open' | 'error', message?: any }[]} */
const queued = [];
/** @type {EventSource | null} */
let source = null;
let failedTries = 0;
/** @type {(() => void) | null} */
let gotSession = null;

/**
 * @param {'message' | 'open' | 'error'} kind
 * @param {any} [message]
 */
function deliver(kind, message) {
    if (!handlers) {
        queued.push({ kind, message });
        return;
    }
    if (kind === 'message') handlers.message(message);
    else handlers[kind]();
}

function streamUrl() {
    const p = new URLSearchParams({ token: tabToken() });
    const session = tabSession();
    if (session !== null) p.set('session', session);
    // Only a tab starting up is given a session; one left with none (its session deleted) makes its own.
    else if (!ready || streamMissing) p.set('claim', '1');
    return `/api/characters/changes/stream?${p}`;
}

/**
 * @param {boolean} [isRebuild] Not the tab's first stream, nor one following its session.
 */
function connect(isRebuild = false) {
    const url = streamUrl();
    const named = new URLSearchParams(url.slice(url.indexOf('?'))).get('session');
    const es = new EventSource(url);
    source = es;
    let opened = false;
    es.onopen = () => {
        opened = true;
        failedTries = 0;
        deliver('open');
    };
    es.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            message = null;
        }
        if (source !== es) return;
        if (!takeSessionFrame(message)) deliver('message', message);
    };
    es.onerror = () => {
        if (source !== es) return;
        deliver('error');
        // The browser reconnects to the same URL; one it gave up on (closed), or one not naming the session the tab
        // holds now (a fresh tab's, given its session), is rebuilt here.
        if (named === tabSession() && es.readyState !== EventSource.CLOSED) return;
        es.close();
        if (isRebuild && !opened) failedTries++;
        setTimeout(() => {
            if (source === es) connect(true);
        }, changeStreamRetryDelayMs(failedTries));
    };
}

function reconnect() {
    if (typeof EventSource === 'undefined' || source === null) return;
    source.close();
    connect();
}

/**
 * Takes a frame about the tab's session; false for any other.
 * @param {any} message
 */
function takeSessionFrame(message) {
    switch (message?.type) {
        case 'session': {
            if (message.held) {
                const es = source;
                es?.close();
                source = null;
                forkFrom(message.session).then(() => connect(), () => setTimeout(() => connect(true), changeStreamRetryDelayMs(failedTries++)));
                return true;
            }
            const before = tabSession();
            if (message.session !== before) setSession(message.session, { follow: false });
            if (message.place) setPlace(message.place);
            streamMissing = false;
            gotSession?.();
            gotSession = null;
            return true;
        }
        case 'session-chats':
            setChats(message.chats ?? []);
            return true;
        case 'current-chat':
            setChats([{ tree: message.tree, bookmark: message.bookmark ?? null }]);
            return true;
        case 'session-place':
            if (message.place) setPlace(message.place);
            return true;
        default:
            return false;
    }
}

/**
 * Gives the tab its session (see the top of this file), opening its changes stream. Requests wait for it.
 * @param {() => Record<string, string>} headers The page's request headers, for the fork's request.
 * @returns {Promise<void>}
 */
export function prepareTabSession(headers) {
    requestHeaders = headers;
    preparing ??= (async () => {
        write(globalThis.localStorage, OLD_DEVICE_KEY, null);
        tabToken();
        watchSharedToken();
        const stored = tabSession();
        if (stored !== null && await lockHeld(stored)) await forkFrom(stored);
        else holdLock(stored);
        if (typeof EventSource !== 'undefined') {
            await new Promise(resolve => {
                const timer = setTimeout(() => {
                    streamMissing = true;
                    resolve(undefined);
                }, STREAM_WAIT_MS);
                gotSession = () => {
                    clearTimeout(timer);
                    resolve(undefined);
                };
                connect();
            });
        }
        ready = true;
    })();
    return preparing;
}

/**
 * Hands the changes stream's other frames, and its opens and errors, to `h` (those before it are handed now).
 * @param {StreamHandlers} h
 */
export function onChangeStream(h) {
    handlers = h;
    for (const e of queued.splice(0)) deliver(e.kind, e.message);
}
