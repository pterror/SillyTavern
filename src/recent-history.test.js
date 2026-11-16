import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'default', 'config.yaml'));

const { ui } = await import('./ui-wiring.js');
const stores = await import('./user-stores.js');
const engineBinding = (await import('../engine/load.js')).loadEngine().binding;
stores.setStoreEngine(() => engineBinding);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-history-test-'));
const root = path.join(dataRoot, 'default-user');
const directories = { root };
const SESSION = '0190a1b2-0000-7000-8000-0000000000d1';
const OTHER = '0190a1b2-0000-7000-8000-0000000000d2';
const VIEW = 'recentHistory.list';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { profile: { handle: 'default-user' }, directories };
    next();
});
app.use('/api/ui/action', ui.router);

/**
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<any>} the view of recent history the answer brought, the last of its parts
 */
async function act(type, payload) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/ui/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-ST-Session': SESSION },
            body: JSON.stringify({ type, payload }),
        });
        assert.equal(res.status, 200);
        const lines = (await res.text()).split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
        assert.equal(lines[0].ok, true, lines[0].error);
        const frames = lines.flatMap(line => line.views ?? []).filter(frame => frame.key === VIEW);
        return frames.at(-1)?.value;
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

const card = (/** @type {string} */ name) => JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, first_mes: '' } });
const said = (/** @type {string} */ mes) => ({ name: mes.startsWith('u') ? 'You' : 'Rex', is_user: mes.startsWith('u'), mes, extra: {} });

try {
    let store = await stores.userStore(directories, 'default-user');
    await store.lib.writeCard(directories, 'rex.png', card('Rex'));
    await store.lib.writeCard(directories, 'amy.png', card('Amy'));
    const [rex, amy] = await store.people.trees([{ avatar: 'rex.png' }, { avatar: 'amy.png' }]);
    const rexSpeaker = (await store.people.byAvatar(['rex.png'])).get('rex.png');
    const me = { user: 'default-user', session: SESSION };
    /** @type {Record<string, string>} */
    const id = {};
    const send = async (/** @type {string | null} */ after, /** @type {string[]} */ texts, actor = me, tree = rex) => {
        const made = await store.chats.appendMessages({ tree, treeSpeaker: rexSpeaker, after: after === null ? null : id[after], contents: texts.map(said), actor });
        texts.forEach((text, i) => (id[text] = made.node_ids[i]));
    };
    const go = (/** @type {string} */ to) => store.chats.goTo({ tree: rex, node_id: id[to], actor: me });

    await send(null, ['g', 'u1', 'r1']);
    await send('u1', ['r2']);
    await go('r1');
    await send('r1', ['u2', 'r3']);
    await send('r2', ['u3', 'r4']);
    await go('r3');
    await go('r2');
    await send(null, ['a'], { user: 'default-user', session: OTHER }, amy);

    await act('chat.show', { avatar: 'rex.png' });
    const chatName = await store.chats.compatChatId(SESSION, SESSION, rex);
    const shown = (/** @type {any} */ view) => view.entries.map((/** @type {any} */ e) => [e.message.text, e.split, e.others]);

    const one = await act('recentHistory.open', { of: 'chat' });
    assert.equal(one.of, 'chat');
    assert.deepEqual(shown(one), [['r2', null, 0], ['r3', { number: 1 }, 1]], 'where the chat is, then the lines it left off message 1, the swipes of the last message not among them');
    assert.deepEqual(one.entries[0].chat, { owner: { avatar: 'rex.png' }, name: chatName });
    assert.equal(one.entries[0].message.nodeId, id.r2);
    assert.equal(one.more, false);

    const expanded = await act('recentHistory.expand', { id: one.entries[1].id, open: true });
    assert.deepEqual(expanded.entries[1].tips.messages.map((/** @type {any} */ m) => m.text), ['r4']);

    const all = await act('recentHistory.open', { of: 'all' });
    assert.deepEqual(all.entries.map((/** @type {any} */ e) => [e.chat.owner, e.message.text]), [
        [{ avatar: 'amy.png' }, 'a'],
        [{ avatar: 'rex.png' }, 'r2'],
        [{ avatar: 'rex.png' }, 'r3'],
    ]);

    {
        /** @type {any[]} */
        const pushed = [];
        let arrived = () => {};
        const detach = ui.attach({ handle: 'default-user', directories }, SESSION, push => {
            pushed.push(...push.views.filter(frame => frame.key === VIEW));
            arrived();
        });
        try {
            const reached = new Promise(resolve => { arrived = /** @type {() => void} */ (resolve); });
            await go('r4');
            await reached;
            assert.equal(pushed.at(-1).value.entries.find((/** @type {any} */ e) => e.split === null && e.chat.owner.avatar === 'rex.png').message.text, 'r4', 'a move is pushed to the tab showing the history');
            assert.equal((await act('recentHistory.close', {})).of, null);
        } finally {
            detach();
        }
    }

    const before = await store.chats.recentHistory({ of: null, limit: 100 });

    await stores.closeUserStores();
    fs.rmSync(path.join(root, stores.STORE_DIR, stores.RECENT_HISTORY));
    assert.match(await stores.oldFormatLine({ root }) ?? '', /convert-recent-history\.mjs/);
    const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'convert-recent-history.mjs'), '--data-root', dataRoot], { encoding: 'utf8' });
    assert.match(run(), /Users: 1 \(0 already converted\)\. Steps of 2000 moves: 3\./);
    assert.match(run(), /Users: 1 \(1 already converted\)/);
    assert.equal(await stores.oldFormatLine({ root }), null);
    store = await stores.userStore(directories, 'default-user');
    assert.deepEqual(await store.chats.recentHistory({ of: null, limit: 100 }), before, 'the conversion builds from the moves kept what they built');
    console.log('recent history: ok');
} finally {
    await stores.closeUserStores();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
