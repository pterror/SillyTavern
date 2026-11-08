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
        await chats.chooseCardGreeting({ tree, index: null, actor: { user: user.user.profile.handle, session } });

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
    await chats.chooseCardGreeting({ tree, index: 2, actor: { user: user.user.profile.handle, session } });

    const deleted = await post('greetings/delete', { avatar_url: 'Chooser.png', position: 0, expected_hash: yo.body.hashes[0] }, session);
    expect(deleted.body.greetings).toEqual(['Yo', 'Hey']);
    expect(shownText(deleted.body)).toBe('Hey');

    const edited = await post('greetings/edit', { avatar_url: 'Chooser.png', position: 1, expected_hash: deleted.body.hashes[1], text: 'Hey there' }, session);
    expect(shownText(edited.body)).toBe('Hey there');

    const gone = await post('greetings/delete', { avatar_url: 'Chooser.png', position: 1, expected_hash: edited.body.hashes[1] }, session);
    expect(gone.body.greetings).toEqual(['Yo']);
    expect(shownText(gone.body)).toBe('Yo');
});

test('a greeting that a stored opening holds is history: changing or deleting the greeting leaves that opening', async () => {
    const session = '0190a1b2-0000-7000-8000-0000000000f1';
    expect((await post('create', { ch_name: 'Teller', first_mes: 'Once', file_name: 'Teller' }, session)).status).toBe(200);
    const { chats, people } = user.store;
    const [tree] = await people.trees([{ avatar: 'Teller.png' }]);
    const { storedForm } = await import('../src/chat-engine.js');
    await chats.appendMessages({
        tree, treeSpeaker: null, after: null,
        contents: [storedForm({ name: 'Teller', is_user: false, mes: 'Once', extra: {}, send_date: Date.now() }), storedForm({ name: 'You', is_user: true, mes: 'go on', extra: {}, send_date: Date.now() })],
        actor: { user: user.user.profile.handle, session },
    });
    const card = await post('greetings/add', { avatar_url: 'Teller.png', append: true, text: 'Twice' }, session);
    expect(card.body.openings).toMatchObject({ total: 2, stored: 1 });

    const edited = await post('greetings/edit', { avatar_url: 'Teller.png', position: 0, expected_hash: card.body.hashes[0], text: 'Once upon a time' }, session);
    expect(edited.body.openings.alternatives.map((/** @type {any} */ a) => a.mes)).toEqual(['Once', 'Once upon a time', 'Twice']);
    expect(edited.body.openings.stored).toBe(1);

    const deleted = await post('greetings/delete', { avatar_url: 'Teller.png', position: 0, expected_hash: edited.body.hashes[0] }, session);
    expect(deleted.body.openings.alternatives.map((/** @type {any} */ a) => a.mes)).toEqual(['Once', 'Twice']);
    expect(shownText(deleted.body)).toBe('Once');
});
