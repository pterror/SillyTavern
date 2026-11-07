import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { ChatEngine, defaultSessionKey } from './chat-engine.js';
import { requestSession, SessionHeaderMissing, SESSION_GONE_HEADER, SESSION_MOVED_HEADER } from './request-session.js';
import { fakeOwners } from './chat-test-people.js';

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
people.owners = fakeOwners(people);

for (const kind of ['native', 'wasm']) {
    test(`a request's session and its answer (${kind})`, async () => {
        const engine = loadEngine(kind === 'wasm' ? { platform: null } : {}).binding;
        const store = await engine.Store.open(path.join(root, kind));
        try {
            const chats = await ChatEngine.open(store, people);

            await assert.rejects(requestSession(chats, request(undefined), tree), SessionHeaderMissing);
            let res = response();

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

            const own = await requestSession(chats, request(made), tree);
            assert.deepEqual(own.actor(), { user: 'u', session: made });
            res = response();
            own.answer(res);
            assert.deepEqual(res.headers, {});
            own.answer(res, { moved: true });
            assert.deepEqual(res.headers, { [SESSION_MOVED_HEADER]: made });

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
