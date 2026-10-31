import { changeStreamRetryDelayMs } from './change-stream-backoff.js';

const TAB_KEY = 'st:tab-session';
const TOKEN_KEY = 'st:tab-token';
const PLACE_KEY = 'st:tab-place';
const CHATS_KEY = 'st:tab-chats';
const OLD_DEVICE_KEY = 'st:device-session';

/** @type {string | null} */
let inMemory = null;
/** @type {string | null} */
let tokenInMemory = null;
let ready = false;
let streamMissing = false;
export const STREAM_WAIT_MS = 3000;
/** @type {Promise<void> | null} */
let preparing = null;
/** @type {() => Record<string, string>} */
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

function mintToken() {
    tokenInMemory = null;
    write(globalThis.sessionStorage, TOKEN_KEY, null);
    return tabToken();
}

/**
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
 * @param {boolean} [replace]
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
 * @param {string | null} session
 * @param {{ keepPlace?: boolean, follow?: boolean }} [o]
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

export function sessionHeaderValue() {
    const held = tabSession();
    if (held !== null) return held;
    if (!ready || streamMissing) return 'none';
    const made = newSessionId();
    setSession(made);
    return made;
}

/**
 * @param {string} session
 */
export function sessionMoved(session) {
    setSession(session, { keepPlace: session === tabSession() });
}

export function sessionGone() {
    setSession(null);
}

export const SESSION_MOVED_HEADER = 'X-ST-Session-Moved';
export const SESSION_GONE_HEADER = 'X-ST-Session-Gone';

/**
 * @param {(name: string) => string | null | undefined} header
 */
export function takeSessionAnswer(header) {
    if (header(SESSION_GONE_HEADER)) sessionGone();
    const moved = header(SESSION_MOVED_HEADER);
    if (moved) sessionMoved(moved);
}

let observing = false;

/**
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
 * @param {string} from
 * @param {boolean} [newToken]
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

const CHANNEL_NAME = 'st-tab-token';
/** @type {BroadcastChannel | null} */
let channel = null;
let leaving = false;

async function leaveSharedToken() {
    if (leaving) return;
    leaving = true;
    try {
        const session = tabSession();
        if (session === null) mintToken();
        else await forkFrom(session, true);
        if (!ready || session === null) reconnect();
    } catch (err) {
        console.error('Leaving a token shared with another tab failed:', err);
    } finally {
        leaving = false;
    }
}

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

/**
 * @typedef {object} StreamHandlers
 * @property {(message: any) => void} message
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
    else if (!ready || streamMissing) p.set('claim', '1');
    return `/api/characters/changes/stream?${p}`;
}

/**
 * @param {boolean} [isRebuild]
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

/** @type {{ views: (views: unknown[]) => void, connected: () => void } | null} */
let newPage = null;

/** @param {{ views: (views: unknown[]) => void, connected: () => void }} handlers */
export function attachNewPage(handlers) {
    newPage = handlers;
}

/**
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
            newPage?.connected();
            return true;
        }
        case 'views':
            newPage?.views(message.views);
            return true;
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
 * @param {() => Record<string, string>} headers
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
 * @param {StreamHandlers} h
 */
export function onChangeStream(h) {
    handlers = h;
    for (const e of queued.splice(0)) deliver(e.kind, e.message);
}
