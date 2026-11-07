import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { write as writeCard } from './character-card-parser.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { importUpstreamData, MAP_FILE } = await import('./upstream-import.js');
const { importUpstreamItemizations, fromUpstream } = await import('./upstream-itemizations.js');
const { emptyUser, writeLibraryCard, treeOf } = await import('../tests/converted-user.fixture.js');

const user = await emptyUser('st-upstream-itemizations-test-');
const { directories, store } = user;

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));
async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', avatar,
        data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '', alternate_greetings: [], extensions: {} },
    };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}
const jsonl = (/** @type {object[]} */ lines) => lines.map(l => JSON.stringify(l)).join('\n');
const write = (/** @type {string} */ rel, /** @type {string} */ text) => {
    const file = path.join(directories.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
};

const NIA_CHAT = 'Nia - 2024-01-01@10h00m00s';

const counter = { count: async (/** @type {string} */ text) => text.length, tokenizer: () => ({ name: 'by length' }) };
const importAll = (/** @type {{ chat_id: string, entries: Record<string, unknown>[] }[]} */ chats) => importUpstreamItemizations(store, directories.root, chats, counter);
const GROUP_ID = '1700000000000';

async function itemizationsOf(owner, name) {
    const tree = await treeOf(store, owner);
    const [b] = await store.lib.store.chatRead('bookmarksNamed', { tree, name });
    const [row] = await store.lib.store.chatRead('bookmarks', { ids: [BigInt(b)] });
    const at = row.at === null ? null : (await store.chats.externalIds([row.at]))[0];
    const found = [];
    for (const [index, message] of ((await store.chats.load({ tree, at }))?.messages ?? []).entries()) {
        const read = await store.chats.readItemization({ node_id: message.node_id });
        if (read) found.push([index, read.entry.rawPrompt]);
    }
    return found;
}

test('setup: upstream chats imported, with the map', async () => {
    await writeCharacter('nia.png', 'Nia');
    await writeCharacter('ori.png', 'Ori');
    write(`chats/nia/${NIA_CHAT}.jsonl`, jsonl([
        { chat_metadata: {} },
        { name: 'Nia', is_user: false, mes: 'Hello.', extra: {} },
        { name: 'User', is_user: true, mes: 'Hi!', extra: {} },
        { name: 'Nia', is_user: false, mes: 'Reply.', extra: {} },
    ]));
    write('chats/nia/Same name.jsonl', jsonl([{ name: 'Nia', is_user: false, mes: 'a', extra: {} }]));
    write('chats/ori/Same name.jsonl', jsonl([{ name: 'Ori', is_user: false, mes: 'b', extra: {} }]));
    write(`groups/${GROUP_ID}.json`, JSON.stringify({ id: GROUP_ID, name: 'Party', members: ['nia.png'], chats: ['Party chat'], fav: false }));
    write('group chats/Party chat.jsonl', jsonl([
        { chat_metadata: {} },
        { name: 'User', is_user: true, mes: 'Hey all.', extra: {} },
        { name: 'Nia', is_user: false, mes: 'Hey.', original_avatar: 'nia.png', extra: {} },
    ]));
    const run = await importUpstreamData(store, directories);
    assert.deepEqual(run.notImported, []);
});

test('entries go onto the messages at their positions; the rest is listed with why', async () => {
    const [nia, party] = await importAll([
        {
            chat_id: NIA_CHAT,
            entries: [
                { mesId: 0, rawPrompt: 'p0' },
                { mesId: 2, rawPrompt: 'p2' },
                { mesId: 2, rawPrompt: 'later' },
                { mesId: 9, rawPrompt: 'past' },
                { rawPrompt: 'no position' },
            ],
        },
        { chat_id: 'Party chat', entries: [{ mesId: 1, rawPrompt: 'g1' }] },
    ]);
    assert.equal(nia.status, 'stored');
    assert.equal(nia.stored, 2);
    assert.deepEqual(nia.unmatched.map(u => [u.entry, u.mesId]), [[2, 2], [3, 9], [4, null]]);
    assert.match(nia.unmatched[0].why, /later entry/);
    assert.match(nia.unmatched[1].why, /past the chat's end \(3 messages\)/);
    assert.match(nia.unmatched[2].why, /no message position/);
    assert.deepEqual(await itemizationsOf({ avatar: 'nia.png' }, NIA_CHAT), [[0, 'p0'], [2, 'p2']]);
    assert.equal(party.status, 'stored');
    assert.deepEqual(await itemizationsOf({ group: GROUP_ID }, 'Party chat'), [[1, 'g1']]);
});

test('a second run stores nothing again; a message keeps a different itemization it has', async () => {
    const [again] = await importAll([
        { chat_id: NIA_CHAT, entries: [{ mesId: 0, rawPrompt: 'p0' }, { mesId: 2, rawPrompt: 'other' }] },
    ]);
    assert.deepEqual([again.stored, again.unchanged], [0, 1]);
    assert.match(again.unmatched[0].why, /another itemization already/);
    assert.deepEqual(await itemizationsOf({ avatar: 'nia.png' }, NIA_CHAT), [[0, 'p0'], [2, 'p2']]);
});

test('a chat id naming no chat, or more than one, is left out whole', async () => {
    const results = await importAll([
        { chat_id: 'Nobody - 2020', entries: [{ mesId: 0 }] },
        { chat_id: 'Same name', entries: [{ mesId: 0 }] },
    ]);
    assert.deepEqual(results.map(r => [r.status, r.stored]), [['not-found', 0], ['ambiguous', 0]]);
    assert.match(results[0].why, /no chat is named "Nobody - 2020"/);
    assert.match(results[1].why, /2 imported chat files are named "Same name"/);
});

test('without the map, a character\'s chat is found by its label', async () => {
    fs.rmSync(path.join(directories.root, MAP_FILE));
    const [found] = await importAll([
        { chat_id: NIA_CHAT, entries: [{ mesId: 1, rawPrompt: 'p1' }] },
    ]);
    assert.equal(found.status, 'stored');
    assert.equal(found.stored, 1);
    assert.deepEqual(await itemizationsOf({ avatar: 'nia.png' }, NIA_CHAT), [[0, 'p0'], [1, 'p1'], [2, 'p2']]);
});

test('a batch is one commit, its cost per entry flat', async () => {
    await writeCharacter('big.png', 'Big');
    const n = 2000;
    write('chats/big/Big - long.jsonl', jsonl([{ chat_metadata: {} }, ...Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'User' : 'Big', is_user: i % 2 === 1, mes: `m${i}`, extra: {} }))]));
    await importUpstreamData(store, directories);
    const commit = store.lib.store.commit.bind(store.lib.store);
    let commits = 0;
    store.lib.store.commit = (/** @type {any} */ records) => { commits++; return commit(records); };
    try {
        const [r] = await importAll([
            { chat_id: 'Big - long', entries: Array.from({ length: n }, (_, i) => ({ mesId: i, rawPrompt: `p${i}` })) },
        ]);
        assert.equal(r.stored, n);
    } finally {
        store.lib.store.commit = commit;
    }
    assert.equal(commits, 1);
});

test('an upstream text completion entry becomes the server\'s itemization, its parts counted', async () => {
    const converted = await fromUpstream({
        mesId: 3, main_api: 'textgenerationwebui', rawPrompt: 'STORYWIhistory', finalPrompt: 'STORYWIhistory',
        storyString: 'STORYWI', worldInfoString: 'WI', mesSendString: 'history', allAnchors: '', charDescription: 'desc',
        presetName: 'Preset', this_max_context: 4096, padding: 64, examplesCount: 2, messagesCount: 5,
    }, counter);
    assert.deepEqual(converted, {
        mesId: 3, api: 'textgenerationwebui', preset: 'Preset', sampler_config: {}, tokenizer: { name: 'by length' },
        max_context: 4096, padding: 64, rawPrompt: 'STORYWIhistory', messages_count: 5, examples_count: 2,
        total: 14,
        parts: [
            { part: 'story_string', tokens: 1 }, { part: 'world_info', tokens: 2 }, { part: 'description', tokens: 4 },
            { part: 'chat_history', tokens: 7 },
        ],
    });
});

test('an upstream chat completion entry keeps the counts it was sent with', async () => {
    const converted = await fromUpstream({
        main_api: 'openai', rawPrompt: [{ role: 'system', content: 'x' }], oaiMainTokens: 10, oaiJailbreakTokens: 4,
        oaiConversationTokens: 30, oaiExamplesTokens: 5, oaiPromptTokens: 9, oaiStartTokens: 1, oaiTotalTokens: 60, charDescription: 'abcd',
    }, counter);
    assert.equal(converted.api, 'openai');
    assert.deepEqual(converted.rawPrompt, [{ role: 'system', content: 'x' }]);
    assert.equal(converted.total, 60);
    assert.deepEqual(converted.parts, [
        { part: 'main', tokens: 10 }, { part: 'description', tokens: 4 }, { part: 'other_prompts', tokens: 5 },
        { part: 'examples', tokens: 5 }, { part: 'chat_start', tokens: 1 }, { part: 'chat_history', tokens: 30 },
        { part: 'post_history', tokens: 4 },
    ]);
});
