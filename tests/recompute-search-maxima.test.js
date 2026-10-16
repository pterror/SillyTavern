// The one-off src/migrations/recompute-search-maxima.js, deleted with it. That its maps equal a fresh build's under
// changed reference lengths is the engine's test (engine/tests/one_off_recompute_search_maxima.rs).
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {any} */
let engine;
/** @type {typeof import('../src/migrations/recompute-search-maxima.js')} */
let script;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    script = await import('../src/migrations/recompute-search-maxima.js');
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const say = (/** @type {bigint} */ id, /** @type {string} */ text) => ({ kind: 'messageAppend', id, owner: 5n, time: 1, text, flags: 0, session: 1n, user: 1n });

/** A data root whose user `u` has a store of one owner's messages. */
async function userWithMessages() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recompute-maxima-'));
    dirs.push(dataRoot);
    const store = await engine.Store.open(path.join(dataRoot, 'u', 'store'));
    await store.commit([
        { kind: 'keyMap', session: 1n, key: Buffer.from('s') },
        { kind: 'keyMap', user: 1n, key: Buffer.from('u') },
        say(1n, 'The Dragon sleeps.'),
        say(2n, 'a dragon? No, a drake and a wyvern'),
        say(3n, 'Café au lait dragon dragon'),
    ]);
    await store.close();
    return dataRoot;
}

/**
 * @param {string} dataRoot
 * @param {boolean} apply
 * @param {object} [more]
 */
async function run(dataRoot, apply, more = {}) {
    /** @type {string[]} */
    const lines = [];
    const code = await script.runRecompute({
        dataRoot, handle: 'u', apply, engine: async () => engine, probeServer: async () => ({ running: false, lines: [] }),
        log: l => lines.push(l), warn: l => lines.push(l), ...more,
    });
    return { code, text: lines.join('\n') };
}

/** @param {string} text */
const maps = text => Number(/maxima maps [^:]*: ([\d,]+)/.exec(text)?.[1].replaceAll(',', ''));

/** @param {string} dataRoot */
async function dragons(dataRoot) {
    const store = await engine.Store.open(path.join(dataRoot, 'u', 'store'));
    try {
        return (await store.search({ scope: { chat: 5n }, clauses: [{ text: 'dragon' }], limit: 10 })).hits.map((/** @type {any} */ h) => [h.doc, h.score]);
    } finally {
        await store.close();
    }
}

describe('recompute-search-maxima', () => {
    test('refuses while the server holds the port, before opening the store', async () => {
        const dataRoot = await userWithMessages();
        const { code, text } = await run(dataRoot, true, {
            probeServer: async () => ({ running: true, lines: ['port probe 127.0.0.1:1: in-use'] }),
            engine: async () => { throw new Error('opened'); },
        });
        expect(code).toBe(1);
        expect(text).toMatch(/REFUSED: the server appears to be running/);
    });

    test('the port probe reports a bound port in use and a free one free', async () => {
        const server = net.createServer();
        await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(undefined)));
        const port = /** @type {net.AddressInfo} */ (server.address()).port;
        expect(await script.probeBind('127.0.0.1', port)).toBe('in-use');
        await new Promise(resolve => server.close(resolve));
        expect(await script.probeBind('127.0.0.1', port)).toBe('free');
    });

    test('a store built with these lengths has nothing to change', async () => {
        const dataRoot = await userWithMessages();
        expect(await run(dataRoot, false)).toEqual({ code: 0, text: expect.stringMatching(/would write or delete: 0 /) });
        expect(await run(dataRoot, true)).toEqual({ code: 0, text: expect.stringMatching(/written or deleted: 0 /) });
    });

    test('maps no message is under any more go, the dry run counting what the apply writes, and searches are unchanged', async () => {
        const dataRoot = await userWithMessages();
        const store = await engine.Store.open(path.join(dataRoot, 'u', 'store'));
        await store.commit([{ kind: 'textValue', message: 2n, field: 1, text: 'gone' }]);
        await store.close();
        const before = await dragons(dataRoot);
        const dry = await run(dataRoot, false);
        expect(dry.code).toBe(0);
        expect(maps(dry.text)).toBeGreaterThan(0);
        const applied = await run(dataRoot, true);
        expect(applied.code).toBe(0);
        expect(maps(applied.text)).toBe(maps(dry.text));
        expect(maps((await run(dataRoot, false)).text)).toBe(0);
        expect(await dragons(dataRoot)).toEqual(before);
    });
});
