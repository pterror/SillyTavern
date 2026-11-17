import { test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import path from 'node:path';

/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
let previousDataRoot;
const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    user = await (await import('./converted-user.fixture.js')).convertedUser('st-greeting-openings-test-');
    previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = user.dataRoot;

    const { router } = await import('../src/endpoints/characters.js');
    process.chdir(path.resolve(originalCwd, '..'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    globalThis.DATA_ROOT = previousDataRoot;
    await user.close();
});

/**
 * @param {string} route
 * @param {object} body
 * @param {string} session
 */
async function post(route, body, session) {
    const response = await fetch(`${baseUrl}/api/characters/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': session },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * @param {string} query
 */
async function openStream(query) {
    const request = http.get(`${baseUrl}/api/characters/changes/stream${query}`);
    /** @type {import('node:http').IncomingMessage} */
    const response = await new Promise((resolve, reject) => {
        request.once('response', resolve);
        request.once('error', reject);
    });
    response.setEncoding('utf8');
    const frames = [];
    let buffered = '';
    response.on('data', chunk => {
        buffered += chunk;
        const events = buffered.split('\n\n');
        buffered = events.pop() ?? '';
        for (const event of events) {
            if (event.startsWith('data: ')) frames.push(JSON.parse(event.slice('data: '.length)));
        }
    });
    return { frames, close: () => request.destroy() };
}

/**
 * @param {any[]} frames
 * @param {(frame: any) => boolean} match
 */
async function frameArrives(frames, match, within = 4000) {
    for (let waited = 0; waited < within; waited += 50) {
        if (frames.some(match)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
}

const shownText = (/** @type {any} */ answer) => answer.openings.alternatives[answer.openings.default_index - answer.openings.offset]?.mes;

test('a greeting change answers with the character tree\'s openings, and a tab on that tree is pushed another session\'s', async () => {
    const stream = await openStream('?token=greetingtab01&claim=1');
    try {
        expect(await frameArrives(stream.frames, f => f?.type === 'session')).toBe(true);
        const session = stream.frames.find(f => f?.type === 'session').session;
        expect((await post('create', { ch_name: 'Greeter', first_mes: '', file_name: 'Greeter' }, session)).status).toBe(200);
        const { chats, people } = user.store;
        const [tree] = await people.trees([{ avatar: 'Greeter.png' }]);
        await chats.chooseCardGreeting({ tree, greeting: null, actor: { user: user.user.profile.handle, session } });

        const added = await post('greetings/add', { avatar_url: 'Greeter.png', position: 0, expected_length: 0, text: 'Hi' }, session);
        expect(added.status).toBe(200);
        expect(added.body.default_position).toBe(0);
        expect(added.body.openings).toMatchObject({ total: 1, stored: 0, default_index: 0 });
        expect(shownText(added.body)).toBe('Hi');

        const isOpenings = (/** @type {any} */ f) => f?.type === 'openings' && f.openings?.total === 2;
        const other = '0190a1b2-0000-7000-8000-0000000000cd';
        expect((await post('greetings/add', { avatar_url: 'Greeter.png', append: true, text: 'Yo' }, other)).status).toBe(200);
        expect(await frameArrives(stream.frames, isOpenings)).toBe(true);
        const pushed = stream.frames.find(isOpenings);
        expect(pushed.avatar).toBe('Greeter.png');
        expect(pushed.openings.alternatives.map((/** @type {any} */ a) => a.mes)).toEqual(['Hi', 'Yo']);
        expect(shownText(pushed)).toBe('Hi');
    } finally {
        stream.close();
    }
});

test('a card greeting the session chose stays shown through the session\'s own changes to the greetings', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000ef';
    expect((await post('create', { ch_name: 'Chooser', first_mes: 'Hi', file_name: 'Chooser' }, session)).status).toBe(200);
    const yo = await post('greetings/add', { avatar_url: 'Chooser.png', append: true, text: 'Yo' }, session);
    const hey = await post('greetings/add', { avatar_url: 'Chooser.png', append: true, text: 'Hey' }, session);
    expect(hey.body.greetings).toEqual(['Hi', 'Yo', 'Hey']);
    const { chats, people } = user.store;
    const [tree] = await people.trees([{ avatar: 'Chooser.png' }]);
    const { greetings } = await user.store.lib.greetingModel('Chooser.png');
    await chats.chooseCardGreeting({ tree, greeting: { card: tree, id: greetings[2].id }, actor: { user: user.user.profile.handle, session } });

    const deleted = await post('greetings/delete', { avatar_url: 'Chooser.png', greeting_id: yo.body.ids[0], expected_hash: yo.body.hashes[0] }, session);
    expect(deleted.body.greetings).toEqual(['Yo', 'Hey']);
    expect(shownText(deleted.body)).toBe('Hey');

    const edited = await post('greetings/edit', { avatar_url: 'Chooser.png', greeting_id: deleted.body.ids[1], expected_hash: deleted.body.hashes[1], text: 'Hey there' }, session);
    expect(edited.body.edit).toMatchObject({ id: deleted.body.ids[1], text: 'Hey there' });
    expect(edited.body.greetings).toBeUndefined();
    expect(shownText(await stateOf('Chooser.png', session))).toBe('Hey there');

    const gone = await post('greetings/delete', { avatar_url: 'Chooser.png', greeting_id: edited.body.edit.id, expected_hash: edited.body.edit.hash }, session);
    expect(gone.body.greetings).toEqual(['Yo']);
    expect(shownText(gone.body)).toBe('Yo');
});

test('a card greeting a session chose stays shown through another session\'s adds, moves and deletes, until the card\'s default changes', async () => {
    const mine = '0190a1b2-0000-7000-8000-0000000000e1';
    const theirs = { user: user.user.profile.handle, session: '0190a1b2-0000-7000-8000-0000000000e2' };
    expect((await post('create', { ch_name: 'Shared', first_mes: 'One', file_name: 'Shared' }, mine)).status).toBe(200);
    await post('greetings/add', { avatar_url: 'Shared.png', append: true, text: 'Two' }, mine);
    await post('greetings/add', { avatar_url: 'Shared.png', append: true, text: 'Three' }, mine);
    const { chats, people, lib } = user.store;
    const { changeGreetings } = await import('../src/endpoints/characters.js');
    const { hashGreetingText } = await import('../src/greeting-ops.js');
    const [tree] = await people.trees([{ avatar: 'Shared.png' }]);
    const before = await lib.greetingModel('Shared.png');
    await chats.chooseCardGreeting({ tree, greeting: { card: tree, id: before.greetings[2].id }, epoch: before.defaultEpoch, actor: { user: theirs.user, session: mine } });
    const elsewhere = (/** @type {any} */ change) => changeGreetings({ directories: user.directories, store: user.store, actor: theirs, avatar: 'Shared.png', change });
    const mineNow = async () => {
        const { openingState } = await import('../src/opening-state.js');
        return shownText(await openingState({ store: user.store, tree, actor: { user: theirs.user, session: mine }, avatar: 'Shared.png' }));
    };

    const [one, two, three] = before.greetings.map(g => g.id);
    const zero = (await elsewhere({ op: 'add', text: 'Zero', position: 0, expectedLength: 3 })).result.id;
    await elsewhere({ op: 'move', id: three, hash: hashGreetingText('Three'), side: 'before', target: zero, targetHash: hashGreetingText('Zero') });
    await elsewhere({ op: 'delete', id: one, hash: hashGreetingText('One') });
    expect((await lib.greetingModel('Shared.png')).greetings.map(g => g.text)).toEqual(['Three', 'Zero', 'Two']);
    expect(await mineNow()).toBe('Three');

    await elsewhere({ op: 'default', id: two, hash: hashGreetingText('Two') });
    expect(await mineNow()).toBe('Two');
});

test('a greeting that a stored opening holds is history: changing or deleting the greeting leaves that opening', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f1';
    expect((await post('create', { ch_name: 'Teller', first_mes: 'Once', file_name: 'Teller' }, session)).status).toBe(200);
    const { chats, people } = user.store;
    const [tree] = await people.trees([{ avatar: 'Teller.png' }]);
    const { storedForm } = await import('../src/chat-engine.js');
    await chats.appendMessages({
        tree, treeSpeaker: null, after: null,
        contents: [storedForm({ name: 'Teller', is_user: false, mes: 'Once', extra: { greeting_id: 0 }, send_date: Date.now() }), storedForm({ name: 'You', is_user: true, mes: 'go on', extra: {}, send_date: Date.now() })],
        actor: { user: user.user.profile.handle, session },
    });
    const card = await post('greetings/add', { avatar_url: 'Teller.png', append: true, text: 'Twice' }, session);
    expect(card.body.openings).toMatchObject({ total: 2, stored: 1 });

    const edited = await post('greetings/edit', { avatar_url: 'Teller.png', greeting_id: card.body.ids[0], expected_hash: card.body.hashes[0], text: 'Once upon a time' }, session);
    const afterEdit = await stateOf('Teller.png', session);
    expect(afterEdit.openings.alternatives.map((/** @type {any} */ a) => a.mes)).toEqual(['Once upon a time', 'Once', 'Twice']);
    expect(afterEdit.openings.stored).toBe(1);
    expect(edited.body.openings).toBeUndefined();

    const deleted = await post('greetings/delete', { avatar_url: 'Teller.png', greeting_id: edited.body.edit.id, expected_hash: edited.body.edit.hash }, session);
    expect(deleted.body.openings.alternatives.map((/** @type {any} */ a) => a.mes)).toEqual(['Twice', 'Once']);
    expect(shownText(deleted.body)).toBe('Once');
});

test('an opening written with a card greeting\'s text is that greeting; a card edit links no opening, it only changes what the card offers', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f3';
    expect((await post('create', { ch_name: 'Twins', first_mes: 'Zero', file_name: 'Twins' }, session)).status).toBe(200);
    await post('greetings/add', { avatar_url: 'Twins.png', append: true, text: 'One' }, session);
    const two = await post('greetings/add', { avatar_url: 'Twins.png', append: true, text: 'Two' }, session);
    const { chats, people, lib } = user.store;
    const [tree] = await people.trees([{ avatar: 'Twins.png' }]);
    const { storedForm } = await import('../src/chat-engine.js');
    const before = await lib.greetingModel('Twins.png');
    await chats.appendMessages({
        tree, treeSpeaker: null, after: null,
        contents: [storedForm({ name: 'You', is_user: true, mes: 'Shared', extra: { greeting_id: before.greetings[0].id }, send_date: Date.now() })],
        actor: { user: user.user.profile.handle, session },
    });
    const edited = await post('greetings/edit', { avatar_url: 'Twins.png', greeting_id: two.body.ids[2], expected_hash: two.body.hashes[2], text: 'Shared' }, session);
    expect(edited.body.greeting_edit.moves).toEqual([]);
    const texts = (await stateOf('Twins.png', session)).openings.alternatives.map((/** @type {any} */ a) => [a.mes, a.node_id !== null]);
    expect(texts).toEqual([['Zero', false], ['Shared', true], ['One', false], ['Shared', false]]);

    const mine = await chats.appendMessages({
        tree, treeSpeaker: null, after: null,
        contents: [storedForm({ name: 'You', is_user: true, mes: 'One', extra: {}, send_date: Date.now() })],
        actor: { user: user.user.profile.handle, session },
    });
    expect(mine.ok).toBe(true);
    const { openingState } = await import('../src/opening-state.js');
    const now = await openingState({ store: user.store, tree, actor: { user: user.user.profile.handle, session }, avatar: 'Twins.png' });
    expect(now.openings.alternatives.map((/** @type {any} */ a) => [a.mes, a.node_id !== null])).toEqual([['Zero', false], ['Shared', true], ['One', true], ['Shared', false]]);
});

test('an add or an edit to another greeting\'s exact text is refused and names that greeting; the card is left as it was', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f5';
    expect((await post('create', { ch_name: 'Echo', first_mes: 'Hello', file_name: 'Echo' }, session)).status).toBe(200);
    const two = await post('greetings/add', { avatar_url: 'Echo.png', append: true, text: 'Bye' }, session);
    const added = await post('greetings/add', { avatar_url: 'Echo.png', append: true, text: 'Hello' }, session);
    expect(added).toEqual({ status: 409, body: { ok: false, reason: 'same as greeting 1', same_position: 0, same_id: two.body.ids[0] } });
    const edited = await post('greetings/edit', { avatar_url: 'Echo.png', greeting_id: two.body.ids[1], expected_hash: two.body.hashes[1], text: 'Hello' }, session);
    expect(edited.body).toMatchObject({ ok: false, same_id: two.body.ids[0] });
    expect(edited.body.same_position).toBeUndefined();
    expect(edited.body.revision).toMatch(/^\d+$/);
    expect((await user.store.lib.greetingModel('Echo.png')).greetings.map(g => g.text)).toEqual(['Hello', 'Bye']);
    expect((await post('greetings/add', { avatar_url: 'Echo.png', append: true, text: 'Hello ' }, session)).status).toBe(200);
});

test('a greeting is shown in character info by its id while its text is the one the opening has, and the answer names it', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f6';
    expect((await post('create', { ch_name: 'Shower', first_mes: 'First', file_name: 'Shower' }, session)).status).toBe(200);
    const second = await post('greetings/add', { avatar_url: 'Shower.png', append: true, text: 'Second' }, session);
    const { greetings } = await user.store.lib.greetingModel('Shower.png');
    const shown = await post('greetings/show', { avatar_url: 'Shower.png', greeting_id: greetings[1].id, expected_hash: second.body.hashes[1], order: 1 }, session);
    expect(shown.body).toEqual({ ok: true, greeting_shown: { id: greetings[1].id } });
    const stale = await post('greetings/show', { avatar_url: 'Shower.png', greeting_id: greetings[1].id, expected_hash: second.body.hashes[0], order: 2 }, session);
    expect(stale.status).toBe(409);
    const otherWithText = await post('greetings/show', { avatar_url: 'Shower.png', greeting_id: greetings[0].id, expected_hash: second.body.hashes[1], order: 3 }, session);
    expect(otherWithText.status).toBe(409);
    expect((await post('greetings/show', { avatar_url: 'Shower.png', position: 1, expected_hash: second.body.hashes[1], order: 4 }, session)).status).toBe(400);
});

test('using a card greeting in the chat goes to the opening that holds it, with what is under it, or to the greeting itself', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f7';
    const actor = { user: user.user.profile.handle, session };
    expect((await post('create', { ch_name: 'User', first_mes: 'Alpha', file_name: 'UseIt' }, session)).status).toBe(200);
    await post('greetings/add', { avatar_url: 'UseIt.png', append: true, text: 'Beta' }, session);
    const { chats, people } = user.store;
    const { storedForm } = await import('../src/chat-engine.js');
    const { cardGreetingsOf } = await import('../src/opening-state.js');
    const [tree] = await people.trees([{ avatar: 'UseIt.png' }]);
    const written = await chats.appendMessages({
        tree, treeSpeaker: null, after: null,
        contents: [storedForm({ name: 'User', is_user: false, mes: 'Beta', extra: {}, send_date: Date.now() }), storedForm({ name: 'You', is_user: true, mes: 'reply', extra: {}, send_date: Date.now() })],
        actor,
    });
    const card = await cardGreetingsOf(user.store, 'UseIt.png');

    expect(await chats.useCardGreeting({ tree, greeting: { card: tree, id: card.ids[0] }, actor })).toEqual({ ok: true });
    expect(await chats.landingOf(tree, actor)).toBeNull();
    expect(await chats.cardChoice((await chats.knownActorIds(actor)).session, tree)).toEqual({ card: tree, id: card.ids[0], epoch: (await user.store.lib.greetingModel('UseIt.png')).defaultEpoch });

    expect(await chats.useCardGreeting({ tree, greeting: { card: tree, id: card.ids[1] }, actor })).toEqual({ ok: true });
    expect(await chats.landingOf(tree, actor)).toBe(written.node_ids[1]);

    expect(await chats.useCardGreeting({ tree, greeting: { card: tree, id: 99 }, actor })).toEqual({ ok: false, reason: 'no such greeting' });
});

test('each opening says the card greeting it is, by id, character and the hash of its current text, exactly while it is that greeting', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f8';
    const actor = { user: user.user.profile.handle, session };
    expect((await post('create', { ch_name: 'Linked', first_mes: 'Start', file_name: 'Linked' }, session)).status).toBe(200);
    const { chats, people } = user.store;
    const { storedForm } = await import('../src/chat-engine.js');
    const { hashGreetingText } = await import('../src/greeting-ops.js');
    const [tree] = await people.trees([{ avatar: 'Linked.png' }]);
    await chats.appendMessages({ tree, treeSpeaker: null, after: null, contents: [storedForm({ name: 'Linked', is_user: false, mes: 'Start', extra: {}, send_date: Date.now() })], actor });
    const [start] = (await user.store.lib.greetingModel('Linked.png')).greetings;
    const added = await post('greetings/add', { avatar_url: 'Linked.png', append: true, text: 'Later' }, session);
    const later = (await user.store.lib.greetingModel('Linked.png')).greetings[1];
    expect(added.body.openings.alternatives.map((/** @type {any} */ a) => [a.mes, a.greeting])).toEqual([
        ['Start', { id: start.id, hash: hashGreetingText('Start'), avatar: 'Linked.png' }],
        ['Later', { id: later.id, hash: hashGreetingText('Later'), avatar: 'Linked.png' }],
    ]);
    const edited = await post('greetings/edit', { avatar_url: 'Linked.png', greeting_id: added.body.ids[0], expected_hash: added.body.hashes[0], text: 'Start again' }, session);
    expect(edited.body.openings).toBeUndefined();
    expect((await stateOf('Linked.png', session)).openings.alternatives.map((/** @type {any} */ a) => [a.mes, a.greeting])).toEqual([
        ['Start again', { id: start.id, hash: hashGreetingText('Start again'), avatar: 'Linked.png' }],
        ['Start', null],
        ['Later', { id: later.id, hash: hashGreetingText('Later'), avatar: 'Linked.png' }],
    ]);
});

/** @param {string} avatar @param {string} session */
async function stateOf(avatar, session) {
    const { openingState } = await import('../src/opening-state.js');
    const [tree] = await user.store.people.trees([{ avatar }]);
    return openingState({ store: user.store, tree, actor: { user: user.user.profile.handle, session } });
}
