import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// users.js (imported through stats.js) reads the config at import time.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router: statsRouter, keepOldStatsFile, STATS_BACKUP_FILE } = await import('./stats.js');
const treeDb = await import('../message-tree-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-endpoint-test-'));
const directories = { root };

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: 'default-user' }, directories };
        next();
    });
    app.use('/api/stats', statsRouter);
    return app;
}

async function postJson(app, urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

const T0 = Date.parse('2026-09-01T10:00:00.000Z');

async function seed() {
    await treeDb.saveChatToTree(directories, 'rex', 'main', [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Welcome back.', send_date: T0, extra: {} },
        { name: 'User', is_user: true, mes: 'Hi there Rex', send_date: T0 + 1000, extra: {} },
        // A streamed reply as the server stores it: its whole text, and when it was generated.
        {
            name: 'Rex', is_user: false, mes: 'Good to see you, old friend', send_date: T0 + 5000, extra: {},
            gen_started: new Date(T0 + 1000).toISOString(), gen_finished: new Date(T0 + 4000).toISOString(),
        },
        // A reply stored without its generation time.
        { name: 'User', is_user: true, mes: 'Same', send_date: T0 + 6000, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Indeed', send_date: T0 + 7000, extra: {} },
    ], false, { kind: 'character', rowId: 'rex.png' });
}

async function run() {
    await seed();
    const app = buildTestApp();

    // Totals: counted from the stored messages, greeting left out; the first count isn't done yet.
    {
        const { status, data } = await postJson(app, '/api/stats/totals', {});
        assert.equal(status, 200);
        assert.equal(data.filled, false, 'the first count of older chats hasn\'t run');
        assert.equal(data.stats.user_msg_count, 2);
        assert.equal(data.stats.non_user_msg_count, 2, 'the greeting is not a character message');
        assert.equal(data.stats.user_word_count, 4);
        assert.equal(data.stats.non_user_word_count, 7, 'a streamed reply counts the words of its stored text');
        assert.equal(data.stats.total_gen_time, 3000);
        assert.equal(data.stats.gen_time_unknown_count, 1, 'a reply without its generation time is counted as unknown');
        assert.equal(data.stats.date_first_chat, T0 + 1000);
        assert.equal(data.backup, null);
    }

    // The fill counts every stored chat; then the totals say so.
    {
        let result;
        do {
            result = await treeDb.fillMessageStats(directories, 10);
        } while (!result.done);
        const { data } = await postJson(app, '/api/stats/totals', {});
        assert.equal(data.filled, true);
        assert.equal(data.stats.user_msg_count, 2, 'the fill recounts to the same numbers');
    }

    // /get: upstream's per-character shape, for the characters named and with none named.
    {
        const named = await postJson(app, '/api/stats/get', { avatars: ['rex.png', 'nobody.png'] });
        assert.equal(named.status, 200);
        assert.equal(typeof named.data.timestamp, 'number');
        assert.equal(named.data['rex.png'].non_user_word_count, 7);
        assert.equal(named.data['rex.png'].total_swipe_count, 0);
        assert.equal(named.data['nobody.png'].user_msg_count, 0, 'a character with no messages answers zeros');

        const all = await postJson(app, '/api/stats/get', {});
        assert.deepEqual(Object.keys(all.data).sort(), ['rex.png', 'timestamp']);
    }

    // /increment and /update are accepted and change nothing: the stored messages are the only source.
    {
        const inc = await postJson(app, '/api/stats/increment', { avatar: 'rex.png', deltas: { user_msg_count: 50 }, wordCount: { is_user: true, text: 'a b c d e f' } });
        assert.equal(inc.status, 200);
        assert.equal(inc.data.user_msg_count, 2);
        const upd = await postJson(app, '/api/stats/update', { 'rex.png': { user_msg_count: 999 } });
        assert.equal(upd.status, 200);
        const after = await postJson(app, '/api/stats/get', { avatars: ['rex.png'] });
        assert.equal(after.data['rex.png'].user_msg_count, 2);
    }

    // The old stats file is kept once, and never written again.
    {
        fs.writeFileSync(path.join(root, 'stats.json'), '{"old":1}');
        keepOldStatsFile(root);
        assert.equal(fs.readFileSync(path.join(root, STATS_BACKUP_FILE), 'utf8'), '{"old":1}');
        fs.writeFileSync(path.join(root, 'stats.json'), '{"old":2}');
        keepOldStatsFile(root);
        assert.equal(fs.readFileSync(path.join(root, STATS_BACKUP_FILE), 'utf8'), '{"old":1}', 'an existing backup is not overwritten');
        const { data } = await postJson(app, '/api/stats/totals', {});
        assert.equal(data.backup, STATS_BACKUP_FILE);
    }

    console.log('stats.test.js: all assertions passed');
}

try {
    await run();
} finally {
    treeDb.disposeMessageTreeStores();
    fs.rmSync(root, { recursive: true, force: true });
}
