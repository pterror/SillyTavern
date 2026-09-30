import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Upstream's `tags` is a plain array of plain tag objects and its `tag_map` a plain object of plain arrays, so
// extensions may copy them, send them to a worker or put them in IndexedDB. Whatever works on upstream's has to
// work on ours.

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    // APP_READY is an auto-fire event: a listener added after it was emitted still runs.
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        const text = await response.text();
        try { return JSON.parse(text); } catch { return text; }
    }, { path, body });
}

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} avatar */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/**
 * Creates the fixture data from a throwaway browser context, so the page under test learns about everything only
 * through its own boot.
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<T>} fn
 * @template T
 */
async function withSetupPage(browser, fn) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await loadApp(page);
        return await fn(page);
    } finally {
        await context.close();
    }
}

test.describe('the tags and tag_map exports', () => {
    test.setTimeout(180000);

    test('can be copied, compared, stored and sent like upstream\'s plain ones', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const tag = `plain-${stamp}`;
            await api(setup, '/api/tags/create', {
                tag: { id: tag, name: tag, folder_type: 'NONE', sort_order: 1000, color: '#112233', color2: '', create_date: 1 },
            });
            const card = await createCharacter(setup, `Plain-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: tag });
            return { tag, card };
        });
        await loadApp(page);

        const results = await page.evaluate(async ({ tag, card }) => {
            const { tags, tag_map } = await import('/scripts/tags.js');
            const { lodash } = await import('/lib.js');
            const $ = window['jQuery'];
            const json = (/** @type {any} */ value) => JSON.parse(JSON.stringify(value));

            /** What each export holds, as plain data, to compare every copy against. */
            const subjects = {
                tags: { value: tags, expected: json(tags), isArray: true },
                tag: { value: tags.find(t => t.id === tag), expected: json(tags.find(t => t.id === tag)), isArray: false },
                tag_map: { value: tag_map, expected: json(tag_map), isArray: false },
                entry: { value: tag_map[card], expected: [tag], isArray: true },
            };

            const viaChannel = (/** @type {any} */ value) => new Promise((resolve, reject) => {
                const { port1, port2 } = new MessageChannel();
                port2.onmessage = event => resolve(event.data);
                try { port1.postMessage(value); } catch (error) { reject(error); }
            });
            const viaWorker = (/** @type {any} */ value) => new Promise((resolve, reject) => {
                const url = URL.createObjectURL(new Blob(['onmessage = event => postMessage(event.data);'], { type: 'text/javascript' }));
                const worker = new Worker(url);
                worker.onmessage = event => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
                worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
                try { worker.postMessage(value); } catch (error) { worker.terminate(); reject(error); }
            });
            const viaIndexedDb = (/** @type {any} */ value) => new Promise((resolve, reject) => {
                const name = `plain-exports-${Date.now()}-${Math.random()}`;
                const open = indexedDB.open(name, 1);
                open.onupgradeneeded = () => open.result.createObjectStore('s');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const done = (/** @type {() => void} */ settle) => { db.close(); indexedDB.deleteDatabase(name); settle(); };
                    try {
                        const tx = db.transaction('s', 'readwrite');
                        tx.objectStore('s').put(value, 'k');
                        const read = tx.objectStore('s').get('k');
                        tx.oncomplete = () => done(() => resolve(read.result));
                        tx.onerror = () => done(() => reject(tx.error));
                    } catch (error) {
                        done(() => reject(error));
                    }
                };
            });

            /** @type {Record<string, (subject: { value: any, expected: any, isArray: boolean }) => any>} */
            const operations = {
                'Array.isArray': s => Array.isArray(s.value) === s.isArray,
                'Object.prototype.toString': s => Object.prototype.toString.call(s.value) === (s.isArray ? '[object Array]' : '[object Object]'),
                'prototype': s => Object.getPrototypeOf(s.value) === (s.isArray ? Array.prototype : Object.prototype),
                'JSON.stringify': s => lodash.isEqual(json(s.value), s.expected),
                'spread': s => lodash.isEqual(s.isArray ? [...s.value] : { ...s.value }, s.expected),
                'Object.keys': s => lodash.isEqual(Object.keys(s.value), Object.keys(s.expected)),
                'Object.entries': s => lodash.isEqual(Object.fromEntries(Object.entries(s.value)), Object.fromEntries(Object.entries(s.expected))),
                'for...in': s => {
                    const keys = [];
                    for (const key in s.value) keys.push(key);
                    return lodash.isEqual(keys, Object.keys(s.expected));
                },
                'structuredClone': s => lodash.isEqual(structuredClone(s.value), s.expected),
                'structuredClone nested': s => lodash.isEqual(structuredClone({ inner: s.value }).inner, s.expected),
                'MessageChannel postMessage': async s => lodash.isEqual(await viaChannel(s.value), s.expected),
                'Worker postMessage': async s => lodash.isEqual(await viaWorker(s.value), s.expected),
                'IndexedDB put': async s => lodash.isEqual(await viaIndexedDb(s.value), s.expected),
                'lodash.cloneDeep': s => {
                    const clone = lodash.cloneDeep(s.value);
                    return clone !== s.value && lodash.isEqual(clone, s.expected);
                },
                'lodash.isEqual': s => lodash.isEqual(s.value, s.expected) && lodash.isEqual(s.expected, s.value),
                'lodash.isPlainObject': s => lodash.isPlainObject(s.value) === !s.isArray,
                'jQuery.isPlainObject': s => $.isPlainObject(s.value) === !s.isArray,
                'jQuery.extend deep': s => lodash.isEqual($.extend(true, s.isArray ? [] : {}, s.value), s.expected),
                'jQuery.extend deep nested': s => {
                    const copy = $.extend(true, {}, { inner: s.value }).inner;
                    return copy !== s.value && lodash.isEqual(copy, s.expected);
                },
            };

            /** @type {Record<string, string>} */
            const results = {};
            for (const [subjectName, subject] of Object.entries(subjects)) {
                for (const [operationName, operation] of Object.entries(operations)) {
                    const name = `${operationName} of ${subjectName}`;
                    try {
                        results[name] = (await operation(subject)) ? 'ok' : 'wrong result';
                    } catch (error) {
                        results[name] = `threw ${error?.name}: ${error?.message}`;
                    }
                }
            }
            return results;
        }, fixture);

        const failed = Object.fromEntries(Object.entries(results).filter(([, outcome]) => outcome !== 'ok'));
        expect(failed).toEqual({});
        expect(Object.keys(results).length).toBe(19 * 4);
    });
});
