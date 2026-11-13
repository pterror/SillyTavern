import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'default', 'config.yaml'));

const { keepOldStatsFile, STATS_BACKUP_FILE } = await import('./old-stats-file.js');
const { ui } = await import('./ui-wiring.js');
const stores = await import('./user-stores.js');
const engineBinding = (await import('../engine/load.js')).loadEngine().binding;
stores.setStoreEngine(() => engineBinding);
const { seedMessages } = await import('../tests/converted-user.fixture.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-test-'));
const directories = { root };
const SESSION = '0b6f3c1e-8a52-4d1b-9c3e-2f7a6d5e4c3b';
const VIEW = 'usageStats.shown';

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: 'default-user' }, directories };
        next();
    });
    app.use('/api/ui/action', ui.router);
    return app;
}

async function postJson(app, urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-ST-Session': SESSION },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

async function shown(app, payload) {
    const { status, data } = await postJson(app, '/api/ui/action', { type: 'usageStats.show', payload });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    return data.views.find(frame => frame.key === VIEW).value;
}

const T0 = Date.parse('2026-09-01T10:00:00.000Z');

async function seed() {
    const store = await stores.userStore(directories, 'default-user');
    await store.lib.writeCard(directories, 'rex.png', JSON.stringify({ name: 'Rex', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Rex' } }));
    await store.lib.writeCard(directories, 'nobody.png', JSON.stringify({ name: 'Nobody', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Nobody' } }));
    const ids = await seedMessages(store, { avatar: 'rex.png' }, null, [
        { name: 'Rex', is_user: false, mes: 'Welcome back.', send_date: T0, extra: {} },
        { name: 'User', is_user: true, mes: 'Hi there Rex', send_date: T0 + 1000, extra: {} },
        {
            name: 'Rex', is_user: false, mes: 'Good to see you, old friend', send_date: T0 + 5000, extra: {},
            gen_started: new Date(T0 + 1000).toISOString(), gen_finished: new Date(T0 + 4000).toISOString(),
        },
        { name: 'User', is_user: true, mes: 'Same', send_date: T0 + 6000, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Indeed', send_date: T0 + 7000, extra: {} },
    ]);
    return { store, ids };
}

async function run() {
    const { store, ids } = await seed();
    const app = buildTestApp();
    const user = { handle: 'default-user', directories };

    {
        const view = await shown(app, { of: 'all' });
        assert.equal(view.of, 'all');        assert.deepEqual(view.counts, {
            firstChat: T0 + 1000,
            generationMs: 3000,
            repliesWithoutTime: 1,
            userMessages: 2,
            characterMessages: 2,
            userWords: 4,
            characterWords: 7,
            swipes: 0,
        });
        assert.equal(view.oldStatsFile, null);
    }

    {
        const rex = await shown(app, { of: 'character', avatar: 'rex.png' });
        assert.equal(rex.avatar, 'rex.png');
        assert.equal(rex.counts.characterWords, 7);
        const nobody = await shown(app, { of: 'character', avatar: 'nobody.png' });
        assert.equal(nobody.counts.userMessages, 0, 'a character with no messages shows zeros');
        assert.equal(nobody.counts.firstChat, null);
        const missing = await shown(app, { of: 'character', avatar: 'missing.png' });
        assert.equal(missing.counts.characterMessages, 0, 'a character that is not stored shows zeros');
    }

    {
        await shown(app, { of: 'character', avatar: 'rex.png' });
        /** @type {any[]} */
        const pushed = [];
        let arrived = () => {};
        const detach = ui.attach(user, SESSION, push => {
            pushed.push(...push.views.filter(frame => frame.key === VIEW));
            arrived();
        });
        try {
            const reached = new Promise(resolve => { arrived = resolve; });
            await seedMessages(store, { avatar: 'rex.png' }, ids.at(-1), [
                { name: 'User', is_user: true, mes: 'One more thing', send_date: T0 + 8000, extra: {} },
            ]);
            await reached;
            assert.equal(pushed.at(-1).value.counts.userMessages, 3, 'a stored message is pushed to the tab showing the stats');
            const { data } = await postJson(app, '/api/ui/action', { type: 'usageStats.close', payload: {} });
            assert.deepEqual(data.views.find(frame => frame.key === VIEW).value, { of: null });
        } finally {
            detach();
        }
    }

    {
        fs.writeFileSync(path.join(root, 'stats.json'), '{"old":1}');
        keepOldStatsFile(root);
        assert.equal(fs.readFileSync(path.join(root, STATS_BACKUP_FILE), 'utf8'), '{"old":1}');
        fs.writeFileSync(path.join(root, 'stats.json'), '{"old":2}');
        keepOldStatsFile(root);
        assert.equal(fs.readFileSync(path.join(root, STATS_BACKUP_FILE), 'utf8'), '{"old":1}', 'an existing backup is not overwritten');
        const view = await shown(app, { of: 'all' });
        assert.equal(view.oldStatsFile, STATS_BACKUP_FILE);
    }

    console.log('usage-stats.test.js: all assertions passed');
}

try {
    await run();
} finally {
    await stores.closeUserStores();
    fs.rmSync(root, { recursive: true, force: true });
}
