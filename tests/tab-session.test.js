import { describe, test, expect, beforeEach } from '@jest/globals';

import { sessionGone, sessionHeaderValue, sessionMoved, tabSession } from '../public/scripts/tab-session.js';

/** A Storage over a Map. */
function storage() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
    };
}

describe('the tab\'s session', () => {
    beforeEach(() => {
        globalThis.localStorage = storage();
        globalThis.sessionStorage = storage();
    });
    const newTab = () => {
        globalThis.sessionStorage = storage();
    };

    test('a tab with none makes its own v7 and keeps sending it; the session moved becomes the device\'s', () => {
        const made = sessionHeaderValue();
        expect(made).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(sessionHeaderValue()).toBe(made);
        newTab();
        expect(tabSession()).toBeNull();
        sessionMoved('s1');
        expect(sessionHeaderValue()).toBe('s1');
        newTab();
        expect(tabSession()).toBe('s1');
    });

    test('a new tab opens the session last moved on this device; one opened before keeps none or its own', () => {
        expect(tabSession()).toBeNull();
        const first = globalThis.sessionStorage;
        newTab();
        sessionMoved('s2');
        const second = globalThis.sessionStorage;
        globalThis.sessionStorage = first;
        expect(tabSession()).toBeNull();
        sessionMoved('s3');
        globalThis.sessionStorage = second;
        expect(tabSession()).toBe('s2');
        newTab();
        expect(tabSession()).toBe('s3');
    });

    test('a deleted session leaves the tab with none and stops being the device\'s default', () => {
        sessionMoved('s4');
        sessionGone();
        expect(tabSession()).toBeNull();
        expect(sessionHeaderValue()).not.toBe('s4');
        newTab();
        expect(tabSession()).toBeNull();
    });

    test('with no storage, the tab keeps its session in memory', () => {
        const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
        globalThis.sessionStorage = broken;
        globalThis.localStorage = broken;
        const made = sessionHeaderValue();
        expect(made).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(sessionHeaderValue()).toBe(made);
        sessionMoved('s5');
        expect(sessionHeaderValue()).toBe('s5');
        sessionGone();
        expect(tabSession()).toBeNull();
    });
});

describe('answers about the tab\'s session', () => {
    beforeEach(() => {
        globalThis.localStorage = storage();
        globalThis.sessionStorage = storage();
    });

    test('a moved session becomes the tab\'s; a gone one leaves it with none; both read from fetch and jQuery answers', async () => {
        const { observeSessionAnswers, SESSION_MOVED_HEADER, SESSION_GONE_HEADER } = await import('../public/scripts/tab-session.js');
        /** @type {Record<string, string>} */
        let next = {};
        /** @type {Function | null} */
        let onAjax = null;
        const scope = {
            fetch: async () => ({ headers: new Map(Object.entries(next)) }),
            document: {},
            jQuery: () => ({ ajaxComplete: (/** @type {Function} */ f) => { onAjax = f; } }),
        };
        observeSessionAnswers(scope);
        next = { [SESSION_MOVED_HEADER]: 's6' };
        await scope.fetch();
        expect(sessionHeaderValue()).toBe('s6');
        next = {};
        await scope.fetch();
        expect(sessionHeaderValue()).toBe('s6');
        next = { [SESSION_GONE_HEADER]: '1' };
        await scope.fetch();
        expect(tabSession()).toBeNull();
        /** @type {any} */ (onAjax)(null, { getResponseHeader: (/** @type {string} */ n) => (n === SESSION_MOVED_HEADER ? 's7' : null) });
        expect(sessionHeaderValue()).toBe('s7');
    });
});
