import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { getStringHash } from '../public/scripts/hash-utils.js';

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/endpoints/characters.js').readCardContent} */
let readCardContent;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/request-session.js').SESSION_HEADER} */
let SESSION_HEADER;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// writeCharacterData()'s DEFAULT_AVATAR_PATH fallback ('./public/img/ai4.png') is repo-root-relative, not
// tests/-relative - same reasoning/fix as characters-cross-reflink.test.js's own chdir.
const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router, readCardContent } = await import('../src/endpoints/characters.js'));
    cardParser = await import('../src/character-card-parser.js');
    fixture = await import('./converted-user.fixture.js');
    ({ SESSION_HEADER } = await import('../src/request-session.js'));

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
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-characters-active-chat-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    await user.close();
});

/**
 * Two chats of Alice, each a session of its own: the tab's, and one the tests move it to (`name`).
 * @param {string} name The other chat's name.
 * @returns {Promise<{ tab: string, other: string }>}
 */
async function twoChats(name) {
    const owner = { avatar: 'Alice.png' };
    const tab = await fixture.saveBranch(user.store, owner, 'tab chat', [{}, { name: 'User', is_user: true, mes: 'in the tab', send_date: 'x', extra: {} }]);
    const other = await fixture.saveBranch(user.store, owner, name, [{}, { name: 'User', is_user: true, mes: `in ${name}`, send_date: 'x', extra: {} }]);
    return { tab, other };
}

/** The messages the tab shows in Alice's tree. */
async function shownBy(tab) {
    return (await fixture.sessionPath(user.store, { avatar: 'Alice.png' }, tab)).map(m => m.mes);
}

/**
 * @param {object} body
 */
async function create(body) {
    return fetch(`${baseUrl}/api/characters/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * @param {string} avatarUrl
 * @param {object} body
 */
async function edit(avatarUrl, body, tab) {
    return fetch(`${baseUrl}/api/characters/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) },
        body: JSON.stringify({ avatar_url: avatarUrl, ...body }),
    });
}

/**
 * @param {object} body
 */
async function setChat(body, tab) {
    return fetch(`${baseUrl}/api/characters/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) },
        body: JSON.stringify(body),
    });
}

/**
 * @param {object} body
 */
async function mergeAttributes(body, tab) {
    return fetch(`${baseUrl}/api/characters/merge-attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) },
        body: JSON.stringify(body),
    });
}

describe('POST /api/characters/chat (dedicated active-chat write path)', () => {
    test('happy path: 200 with the tab\'s chat id, and the tab\'s session is at the chat', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);
        const { tab } = await twoChats('Alice - Some Chat');

        const response = await setChat({ avatar: 'Alice.png', chat: 'Alice - Some Chat' }, tab);
        expect(response.status).toBe(200);

        expect(await shownBy(tab)).toEqual(['in Alice - Some Chat']);
    });

    test('404 for an untracked avatar', async () => {
        const response = await setChat({ avatar: 'Ghost.png', chat: 'Some Chat' });
        expect(response.status).toBe(404);
    });

    test('400 for a missing avatar', async () => {
        const response = await setChat({ chat: 'Some Chat' });
        expect(response.status).toBe(400);
    });

    test('400 for a missing chat', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const response = await setChat({ avatar: 'Alice.png' });
        expect(response.status).toBe(400);
    });
});

describe('/edit no longer writes chat into the card file, but still updates the db row', () => {
    test('the card content never carries a chat field after /edit', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const editResponse = await edit('Alice.png', { ch_name: 'Alice', description: 'desc', avatar_url: 'Alice.png', chat: 'Alice - Edited Chat' });
        expect(editResponse.status).toBe(200);

        // Read through the authoritative seam, not off the PNG. Since the residency migration an /edit that
        // changes no pixels does not rewrite the file at all, so the file still holds whatever /create wrote
        // (which does include a `chat`); what must not carry a chat is the card CONTENT, which is what every
        // reader - and every export - actually sees.
        const card = JSON.parse(await readCardContent(directories, 'Alice.png'));
        expect(card.chat).toBeUndefined();
    });

    test('an exported card never carries a chat field either - the property a user can actually observe', async () => {
        expect((await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' })).status).toBe(200);
        expect((await edit('Alice.png', { ch_name: 'Alice', description: 'desc', avatar_url: 'Alice.png', chat: 'Alice - Edited Chat' })).status).toBe(200);

        const response = await fetch(`${baseUrl}/api/characters/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: 'Alice.png', format: 'png' }),
        });
        expect(response.status).toBe(200);

        const exported = JSON.parse(cardParser.read(Buffer.from(await response.arrayBuffer())));
        expect(exported.chat).toBeUndefined();
    });

    test('the tab\'s session moves to the chat via the write path', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const { tab } = await twoChats('Alice - Edited Chat');

        const editResponse = await edit('Alice.png', { ch_name: 'Alice', description: 'desc', avatar_url: 'Alice.png', chat: 'Alice - Edited Chat' }, tab);
        expect(editResponse.status).toBe(200);

        expect(await shownBy(tab)).toEqual(['in Alice - Edited Chat']);
    });

    test('an /edit with no chat in the request body leaves the existing db active_chat untouched', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);
        const { tab } = await twoChats('Alice - Original Chat');
        await setChat({ avatar: 'Alice.png', chat: 'Alice - Original Chat' }, tab);

        const editResponse = await edit('Alice.png', { ch_name: 'Alice', description: 'now edited', avatar_url: 'Alice.png' }, tab);
        expect(editResponse.status).toBe(200);

        expect(await shownBy(tab)).toEqual(['in Alice - Original Chat']);
    });
});

describe('/merge-attributes carves chat out the same way, and never writes it into the card', () => {
    test('a chat-carrying merge payload updates the db row, not the card content', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const { tab } = await twoChats('Alice - Merged Chat');
        const mergeResponse = await mergeAttributes({ avatar: 'Alice.png', chat: 'Alice - Merged Chat' }, tab);
        expect(mergeResponse.status).toBe(200);

        // Authoritative content, not the PNG - see the /edit sibling test above for why.
        const card = JSON.parse(await readCardContent(directories, 'Alice.png'));
        expect(card.chat).toBeUndefined();

        expect(await shownBy(tab)).toEqual(['in Alice - Merged Chat']);
    });

    test('a merge payload with no chat key leaves the existing db active_chat untouched', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);
        const { tab } = await twoChats('Alice - Original Chat');
        await setChat({ avatar: 'Alice.png', chat: 'Alice - Original Chat' }, tab);

        const mergeResponse = await mergeAttributes({ avatar: 'Alice.png', description: 'now merged' }, tab);
        expect(mergeResponse.status).toBe(200);

        expect(await shownBy(tab)).toEqual(['in Alice - Original Chat']);
    });
});

describe('/merge-attributes issues fresh per-field hashes instead of making the caller compute its own', () => {
    // The client never calls getStringHash() itself for this anymore - it only ever echoes back whatever hash
    // the server most recently handed it. These assertions cover that whole round trip through the one seam
    // that actually issues and checks the hash: this endpoint.

    test('omitting _loadedFieldHashes entirely keeps the old, no-hashes response shape (opt-in, not a breaking change)', async () => {
        expect((await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' })).status).toBe(200);

        const mergeResponse = await mergeAttributes({ avatar: 'Alice.png', description: 'no hashes requested' });
        expect(mergeResponse.status).toBe(200);

        // express's sendStatus(200) body is the literal string 'OK' - not JSON, and definitely no `hashes` key.
        const text = await mergeResponse.text();
        expect(text).toBe('OK');
    });

    test('a successful save with _loadedFieldHashes gets back a `hashes` object with a fresh hash for every field it sent', async () => {
        expect((await create({ ch_name: 'Alice', description: 'v1', file_name: 'Alice', personality: 'p1' })).status).toBe(200);

        const mergeResponse = await mergeAttributes({
            avatar: 'Alice.png',
            data: { description: 'v2', personality: 'p2' },
            _loadedFieldHashes: {
                'data.description': getStringHash(JSON.stringify('v1')),
                'data.personality': getStringHash(JSON.stringify('p1')),
            },
        });
        expect(mergeResponse.status).toBe(200);

        const body = await mergeResponse.json();
        expect(body.hashes).toEqual({
            'data.description': getStringHash(JSON.stringify('v2')),
            'data.personality': getStringHash(JSON.stringify('p2')),
        });
    });

    test('echoing that exact server-issued hash back on the next save succeeds', async () => {
        expect((await create({ ch_name: 'Alice', description: 'v1', file_name: 'Alice' })).status).toBe(200);

        const first = await mergeAttributes({
            avatar: 'Alice.png',
            data: { description: 'v2' },
            _loadedFieldHashes: { 'data.description': getStringHash(JSON.stringify('v1')) },
        });
        expect(first.status).toBe(200);
        const { hashes } = await first.json();

        // Nothing recomputed locally here - `hashes['data.description']` is echoed verbatim, exactly like a
        // client would do on its next edit round.
        const second = await mergeAttributes({
            avatar: 'Alice.png',
            data: { description: 'v3' },
            _loadedFieldHashes: { 'data.description': hashes['data.description'] },
        });
        expect(second.status).toBe(200);

        const card = JSON.parse(await readCardContent(directories, 'Alice.png'));
        expect(card.data.description).toBe('v3');
    });

    test('a stale/wrong echoed hash is still rejected with a 409 conflict - the check itself is unchanged', async () => {
        expect((await create({ ch_name: 'Alice', description: 'v1', file_name: 'Alice' })).status).toBe(200);

        const mergeResponse = await mergeAttributes({
            avatar: 'Alice.png',
            data: { description: 'v2' },
            _loadedFieldHashes: { 'data.description': getStringHash(JSON.stringify('some other value the server never had')) },
        });
        expect(mergeResponse.status).toBe(409);

        const body = await mergeResponse.json();
        expect(body.error).toBe('conflict');
        expect(body.conflictingFields).toEqual(['data.description']);

        // Rejected save must not have landed.
        const card = JSON.parse(await readCardContent(directories, 'Alice.png'));
        expect(card.data.description).toBe('v1');
    });
});
