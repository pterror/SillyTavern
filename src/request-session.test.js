// A request's session as the routes act through it, and what the answer tells the tab (build path 5f).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { ChatEngine, defaultSessionKey } from './chat-engine.js';
import { requestSession, SESSION_GONE_HEADER, SESSION_MOVED_HEADER } from './request-session.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'request-session-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const people = { speakers: async () => new Map(), byAvatar: async () => new Map() };
const tree = 7n;

/** @param {string | undefined} header */
const request = header => ({ get: (/** @type {string} */ n) => (n === 'X-ST-Session' ? header : undefined), user: { profile: { handle: 'u' } } });
const response = () => {
    /** @type {Record<string, string>} */
    const headers = {};
    return { headers, setHeader: (/** @type {string} */ n, /** @type {string} */ v) => { headers[n] = v; } };
};

for (const kind of ['native', 'wasm']) {
    test(`a request's session and its answer (${kind})`, async () => {
        const engine = loadEngine(kind === 'wasm' ? { platform: null } : {}).binding;
        const store = await engine.Store.open(path.join(root, kind));
        try {
            const chats = await ChatEngine.open(store, people);

            // A caller with no tab: the deterministic session, told nothing.
            const third = await requestSession(chats, request(undefined), tree);
            assert.equal(third.identifier, defaultSessionKey('u', tree));
            assert.deepEqual(third.actor(), { user: 'u', session: defaultSessionKey('u', tree) });
            let res = response();
            third.answer(res, { moved: true });
            assert.deepEqual(res.headers, {});

            // A tab with none: reads land through the cascade; a write makes a session, which the answer hands over.
            const fresh = await requestSession(chats, request('none'), tree);
            assert.deepEqual(fresh.reader(), { user: 'u', session: null });
            assert.equal(fresh.identifier, defaultSessionKey('u', tree));
            const made = /** @type {string} */ (fresh.actor().session);
            assert.equal(fresh.actor().session, made);
            assert.equal(fresh.identifier, made);
            res = response();
            fresh.answer(res);
            assert.deepEqual(res.headers, { [SESSION_MOVED_HEADER]: made });
            assert.equal((await chats.nameSession({ session: made, name: 'Made', actor: fresh.actor() })).ok, true);

            // The tab's own session: told it moved only when the write moved it.
            const own = await requestSession(chats, request(made), tree);
            assert.deepEqual(own.actor(), { user: 'u', session: made });
            res = response();
            own.answer(res);
            assert.deepEqual(res.headers, {});
            own.answer(res, { moved: true });
            assert.deepEqual(res.headers, { [SESSION_MOVED_HEADER]: made });

            // A deleted session: the tab is told, and acts as a tab with none.
            assert.deepEqual(await chats.deleteSession(made), { ok: true });
            const stale = await requestSession(chats, request(made), tree);
            assert.deepEqual(stale.reader(), { user: 'u', session: null });
            res = response();
            stale.answer(res);
            assert.deepEqual(res.headers, { [SESSION_GONE_HEADER]: '1' });
            const again = stale.actor().session;
            assert.notEqual(again, made);
            stale.answer(res);
            assert.deepEqual(res.headers, { [SESSION_GONE_HEADER]: '1', [SESSION_MOVED_HEADER]: again });
        } finally {
            await store.close();
        }
    });
}
