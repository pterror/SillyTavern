import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

/** A Storage over a Map. */
function storage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
    };
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @type {any[]} */
let streams;
/** @type {string[]} Locks other tabs of this browser hold. */
let othersLocks;
/** @type {string[]} */
let ourLocks;
/** @type {any[]} */
let forks;

class FakeEventSource {
    /** @param {string} url */
    constructor(url) {
        this.url = new URL(url, 'http://localhost');
        this.closed = false;
        streams.push(this);
    }
    close() {
        this.closed = true;
    }
    /** @param {object} frame */
    send(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

/** @type {any[]} */
let channels;

class FakeChannel {
    /** @param {string} name */
    constructor(name) {
        this.name = name;
        /** @type {any[]} */
        this.posted = [];
        channels.push(this);
    }
    /** @param {any} data */
    postMessage(data) {
        this.posted.push(data);
    }
    /** @param {any} data What another tab said. */
    hear(data) {
        this.onmessage?.({ data });
    }
}

/** This browser gives no Web Locks (plain http to a LAN address). */
function withoutLocks() {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
}

const lastStream = () => streams[streams.length - 1];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A page load of tab-session.js, with this tab's sessionStorage. */
async function load() {
    /** @type {any} */
    let mod;
    await jest.isolateModulesAsync(async () => {
        mod = await import('../public/scripts/tab-session.js');
    });
    return mod;
}

beforeEach(() => {
    channels = [];
    globalThis.BroadcastChannel = FakeChannel;
    streams = [];
    othersLocks = [];
    ourLocks = [];
    forks = [];
    globalThis.localStorage = storage();
    globalThis.sessionStorage = storage();
    globalThis.EventSource = FakeEventSource;
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            locks: {
                query: async () => ({ held: [...othersLocks, ...ourLocks].map(name => ({ name })) }),
                request: (/** @type {string} */ name, /** @type {() => Promise<unknown>} */ cb) => {
                    ourLocks.push(name);
                    return cb().then(() => ourLocks.splice(ourLocks.indexOf(name), 1));
                },
            },
        },
    });
    globalThis.fetch = async (url, init) => {
        expect(url).toBe('/api/chats/session/fork');
        const body = JSON.parse(init.body);
        forks.push(body);
        return { ok: true, status: 200, json: async () => ({ session: `fork-of-${body.from}` }) };
    };
});

describe('how a tab gets its session', () => {
    test('a fresh tab waits for the server to give it one; until then it sends none', async () => {
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        expect(tab.sessionHeaderValue()).toBe('none');
        expect(lastStream().url.searchParams.get('claim')).toBe('1');
        expect(lastStream().url.searchParams.get('session')).toBeNull();
        const token = lastStream().url.searchParams.get('token');
        lastStream().send({ type: 'session', session: 's1', held: false, place: { length: 3, cursor: 2 } });
        lastStream().send({ type: 'session-chats', chats: [{ tree: { avatar: 'cara.png' }, bookmark: '9' }] });
        await ready;
        expect(tab.sessionHeaderValue()).toBe('s1');
        expect(tab.tabPlace()).toEqual({ length: 3, cursor: 2 });
        expect(tab.tabChats()).toEqual({ 'a:cara.png': '9' });
        expect(ourLocks).toEqual(['st-session:s1']);
        // Its stream rebuilt names the session and the same token.
        lastStream().onopen();
        lastStream().onerror();
        await new Promise(resolve => setTimeout(resolve, 1100));
        expect(lastStream().url.searchParams.get('session')).toBe('s1');
        expect(lastStream().url.searchParams.get('token')).toBe(token);
    });

    test('a reload goes on with its own session', async () => {
        globalThis.sessionStorage.setItem('st:tab-session', 's2');
        globalThis.sessionStorage.setItem('st:tab-token', 'token-abc');
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        expect(tab.sessionHeaderValue()).toBe('s2');
        expect(lastStream().url.searchParams.get('session')).toBe('s2');
        expect(lastStream().url.searchParams.get('token')).toBe('token-abc');
        lastStream().send({ type: 'session', session: 's2', held: false, place: { length: 1, cursor: 1 } });
        await ready;
        expect(forks).toEqual([]);
        expect(tab.tabSession()).toBe('s2');
    });

    test('a duplicated tab finds its session held here and forks it from where it was', async () => {
        globalThis.sessionStorage.setItem('st:tab-session', 's3');
        globalThis.sessionStorage.setItem('st:tab-place', JSON.stringify({ length: 5, cursor: 4 }));
        globalThis.sessionStorage.setItem('st:tab-chats', JSON.stringify({ 'g:g1': '7' }));
        othersLocks = ['st-session:s3'];
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        await tick();
        expect(forks).toEqual([{ from: 's3', length: 5, cursor: 4, chats: [{ tree: { group: 'g1' }, bookmark: '7' }] }]);
        expect(lastStream().url.searchParams.get('session')).toBe('fork-of-s3');
        lastStream().send({ type: 'session', session: 'fork-of-s3', held: false, place: { length: 5, cursor: 4 } });
        await ready;
        expect(tab.sessionHeaderValue()).toBe('fork-of-s3');
        expect(tab.tabChats()).toEqual({ 'g:g1': '7' });
        expect(ourLocks).toEqual(['st-session:fork-of-s3']);
    });

    test('a restored tab whose session another tab took forks from its own last place', async () => {
        globalThis.sessionStorage.setItem('st:tab-session', 's4');
        globalThis.sessionStorage.setItem('st:tab-place', JSON.stringify({ length: 2, cursor: 2 }));
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        const first = lastStream();
        first.send({ type: 'session', session: 's4', held: true, place: null });
        await tick();
        await tick();
        expect(first.closed).toBe(true);
        expect(forks).toEqual([{ from: 's4', length: 2, cursor: 2, chats: [] }]);
        expect(lastStream().url.searchParams.get('session')).toBe('fork-of-s4');
        lastStream().send({ type: 'session', session: 'fork-of-s4', held: false, place: { length: 2, cursor: 2 } });
        await ready;
        expect(tab.sessionHeaderValue()).toBe('fork-of-s4');
    });

    test('the tab keeps where it is as its session moves and switches chats', async () => {
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        lastStream().send({ type: 'session', session: 's5', held: false, place: null });
        await ready;
        lastStream().send({ type: 'session-place', place: { length: 4, cursor: 3 } });
        lastStream().send({ type: 'current-chat', tree: { avatar: 'ivy.png' }, bookmark: '12' });
        lastStream().send({ type: 'current-chat', tree: { avatar: 'ivy.png' }, bookmark: null });
        lastStream().send({ type: 'current-chat', tree: { group: 'g2' }, bookmark: '3' });
        expect(tab.tabPlace()).toEqual({ length: 4, cursor: 3 });
        expect(tab.tabChats()).toEqual({ 'g:g2': '3' });
        // Other frames go to the page, those before it listened included.
        lastStream().send({ type: 'tags-changed' });
        /** @type {any[]} */
        const got = [];
        tab.onChangeStream({ message: m => got.push(m), open: () => {}, error: () => {} });
        lastStream().send({ type: 'views-changed' });
        expect(got).toEqual([{ type: 'tags-changed' }, { type: 'views-changed' }]);
    });

    test('a deleted session leaves the tab with none, and it makes its own without asking for another', async () => {
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        lastStream().send({ type: 'session', session: 's6', held: false, place: null });
        await ready;
        const before = streams.length;
        tab.sessionGone();
        expect(tab.tabSession()).toBeNull();
        expect(streams.length).toBe(before);
        const made = tab.sessionHeaderValue();
        expect(made).toMatch(V7);
        expect(lastStream().url.searchParams.get('session')).toBe(made);
        expect(lastStream().url.searchParams.get('claim')).toBeNull();
    });
});

describe('answers about the tab\'s session', () => {
    test('a moved session becomes the tab\'s; a gone one leaves it with none; both read from fetch and jQuery answers', async () => {
        globalThis.EventSource = undefined;
        const tab = await load();
        await tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        /** @type {Record<string, string>} */
        let next = {};
        /** @type {Function | null} */
        let onAjax = null;
        const scope = {
            fetch: async () => ({ headers: new Map(Object.entries(next)) }),
            document: {},
            jQuery: () => ({ ajaxComplete: (/** @type {Function} */ f) => { onAjax = f; } }),
        };
        tab.observeSessionAnswers(scope);
        next = { [tab.SESSION_MOVED_HEADER]: 's6' };
        await scope.fetch();
        expect(tab.sessionHeaderValue()).toBe('s6');
        next = {};
        await scope.fetch();
        expect(tab.sessionHeaderValue()).toBe('s6');
        next = { [tab.SESSION_GONE_HEADER]: '1' };
        await scope.fetch();
        expect(tab.tabSession()).toBeNull();
        /** @type {any} */ (onAjax)(null, { getResponseHeader: (/** @type {string} */ n) => (n === tab.SESSION_MOVED_HEADER ? 's7' : null) });
        expect(tab.sessionHeaderValue()).toBe('s7');
    });

    test('with no storage, the tab keeps its session in memory', async () => {
        globalThis.EventSource = undefined;
        const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
        globalThis.sessionStorage = broken;
        globalThis.localStorage = broken;
        const tab = await load();
        await tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        const made = tab.sessionHeaderValue();
        expect(made).toMatch(V7);
        expect(tab.sessionHeaderValue()).toBe(made);
        tab.sessionMoved('s8');
        expect(tab.sessionHeaderValue()).toBe('s8');
        tab.sessionGone();
        expect(tab.tabSession()).toBeNull();
    });
});

describe('tabs sharing a token without Web Locks', () => {
    /** A tab with session s9 and token tok-9, open and told its session. */
    async function openTab() {
        globalThis.sessionStorage.setItem('st:tab-session', 's9');
        globalThis.sessionStorage.setItem('st:tab-token', 'tok-9tok-9');
        globalThis.sessionStorage.setItem('st:tab-place', JSON.stringify({ length: 2, cursor: 2 }));
        withoutLocks();
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        lastStream().send({ type: 'session', session: 's9', held: false, place: { length: 2, cursor: 2 } });
        await ready;
        return tab;
    }

    test('a tab announces its session, token and load time, and does not wait for an answer', async () => {
        const tab = await openTab();
        expect(channels.length).toBe(1);
        expect(channels[0].name).toBe('st-tab-token');
        const [hello] = channels[0].posted;
        expect(hello).toMatchObject({ type: 'hello', session: 's9', token: 'tok-9tok-9' });
        expect(typeof hello.loaded).toBe('number');
        expect(typeof hello.tie).toBe('number');
        expect(forks).toEqual([]);
        expect(tab.tabSession()).toBe('s9');
    });

    test('the tab that loaded earlier answers and keeps its session and token', async () => {
        const tab = await openTab();
        const { loaded, tie } = channels[0].posted[0];
        channels[0].hear({ type: 'hello', session: 's9', token: 'tok-9tok-9', loaded: loaded + 5, tie });
        await tick();
        expect(channels[0].posted[1]).toMatchObject({ type: 'here', token: 'tok-9tok-9', loaded, tie });
        expect(forks).toEqual([]);
        expect(tab.tabToken()).toBe('tok-9tok-9');
        expect(tab.tabSession()).toBe('s9');
    });

    test('the tab that loaded later forks from where it is, and its stream follows with a new token', async () => {
        const tab = await openTab();
        const { loaded, tie } = channels[0].posted[0];
        channels[0].hear({ type: 'here', session: 's9', token: 'tok-9tok-9', loaded: loaded - 5, tie });
        await tick();
        await tick();
        expect(channels[0].posted.length).toBe(1);
        expect(forks).toEqual([{ from: 's9', length: 2, cursor: 2, chats: [] }]);
        expect(tab.tabToken()).not.toBe('tok-9tok-9');
        expect(tab.tabSession()).toBe('fork-of-s9');
        expect(lastStream().url.searchParams.get('session')).toBe('fork-of-s9');
        expect(lastStream().url.searchParams.get('token')).toBe(tab.tabToken());
        expect(streams[0].closed).toBe(true);
        expect(tab.tabPlace()).toEqual({ length: 2, cursor: 2 });
        // It now has its own token: the other tab's talk about the old one is not about it.
        channels[0].hear({ type: 'here', session: 's9', token: 'tok-9tok-9', loaded: loaded - 9, tie });
        await tick();
        expect(forks.length).toBe(1);
    });

    test('equal load times are broken by the random number: the larger one forks', async () => {
        const tab = await openTab();
        const { loaded, tie } = channels[0].posted[0];
        channels[0].hear({ type: 'here', token: 'tok-9tok-9', loaded, tie: tie + 0.5 });
        await tick();
        expect(forks).toEqual([]);
        channels[0].hear({ type: 'here', token: 'tok-9tok-9', loaded, tie: tie - 0.5 });
        await tick();
        await tick();
        expect(forks.length).toBe(1);
        expect(tab.tabSession()).toBe('fork-of-s9');
    });

    test('another tab\'s token is none of this tab\'s business', async () => {
        const tab = await openTab();
        const { loaded, tie } = channels[0].posted[0];
        channels[0].hear({ type: 'hello', session: 's1', token: 'other-tab-token', loaded: loaded - 5, tie });
        await tick();
        expect(channels[0].posted.length).toBe(1);
        expect(forks).toEqual([]);
        expect(tab.tabToken()).toBe('tok-9tok-9');
    });

    test('a tab with no session yet takes a new token and asks for its session again', async () => {
        globalThis.sessionStorage.setItem('st:tab-token', 'tok-9tok-9');
        withoutLocks();
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        const { loaded, tie } = channels[0].posted[0];
        channels[0].hear({ type: 'here', token: 'tok-9tok-9', loaded: loaded - 1, tie });
        await tick();
        expect(forks).toEqual([]);
        expect(lastStream().url.searchParams.get('token')).toBe(tab.tabToken());
        expect(tab.tabToken()).not.toBe('tok-9tok-9');
        expect(lastStream().url.searchParams.get('claim')).toBe('1');
        lastStream().send({ type: 'session', session: 's10', held: false, place: null });
        await ready;
    });

    test('where Web Locks exist, no channel is opened', async () => {
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await tick();
        lastStream().send({ type: 'session', session: 's11', held: false, place: null });
        await ready;
        expect(channels).toEqual([]);
    });
});

describe('a stream that does not answer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('a fresh tab goes on after the wait with none, asks to be given a session, and takes the one the stream gives', async () => {
        const tab = await load();
        let loaded = false;
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' })).then(() => loaded = true);
        await jest.advanceTimersByTimeAsync(tab.STREAM_WAIT_MS - 1);
        expect(loaded).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await ready;
        expect(tab.sessionHeaderValue()).toBe('none');
        expect(tab.tabSession()).toBeNull();
        const stream = lastStream();
        expect(stream.url.searchParams.get('claim')).toBe('1');
        // The browser's retry is of the same stream; when it connects, the tab takes what it is given.
        const before = streams.length;
        stream.send({ type: 'session', session: 's12', held: false, place: { length: 1, cursor: 1 } });
        expect(streams.length).toBe(before);
        expect(tab.sessionHeaderValue()).toBe('s12');
        expect(tab.tabPlace()).toEqual({ length: 1, cursor: 1 });
    });

    test('a tab with a stored session goes on with it', async () => {
        globalThis.sessionStorage.setItem('st:tab-session', 's13');
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await jest.advanceTimersByTimeAsync(tab.STREAM_WAIT_MS);
        await ready;
        expect(tab.sessionHeaderValue()).toBe('s13');
        expect(lastStream().url.searchParams.get('session')).toBe('s13');
        lastStream().send({ type: 'session', session: 's13', held: false, place: null });
        expect(tab.sessionHeaderValue()).toBe('s13');
    });

    test('a session the server moves meanwhile is kept, and the stream follows it', async () => {
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await jest.advanceTimersByTimeAsync(tab.STREAM_WAIT_MS);
        await ready;
        tab.sessionMoved('s14');
        expect(tab.sessionHeaderValue()).toBe('s14');
        expect(lastStream().url.searchParams.get('session')).toBe('s14');
    });

    test('a stream that answers in time costs no wait', async () => {
        const tab = await load();
        const ready = tab.prepareTabSession(() => ({ 'X-CSRF-Token': 't' }));
        await jest.advanceTimersByTimeAsync(0);
        lastStream().send({ type: 'session', session: 's15', held: false, place: null });
        await ready;
        await jest.advanceTimersByTimeAsync(tab.STREAM_WAIT_MS * 2);
        expect(tab.sessionHeaderValue()).toBe('s15');
    });
});
