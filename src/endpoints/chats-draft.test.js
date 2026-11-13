import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import '../fetch-patch.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router } = await import('./chats.js');
const { writeAllSettings } = await import('../settings-store.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { draftFrames } = await import('../chat-drafts.js');
const { convertedUser, writeLibraryCard, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-draft-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;
writeAllSettings(directories, { username: 'Tester' });

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name, firstMes, alternateGreetings = []) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '',
        first_mes: firstMes, mes_example: '', avatar,
        data: {
            name, description: '', personality: '', scenario: '', first_mes: firstMes, mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: alternateGreetings, extensions: {},
        },
    };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'u' } };
    next();
});
app.use('/api/chats', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(route, body, tab) {
    const res = await fetch(`${base}/api/chats/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: tab }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const said = (mes, extra = {}) => ({ name: 'User', is_user: true, mes, send_date: 1, extra });

after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
    setImmediate(() => process.exit(0));
});

test('a draft follows the shown greeting, is kept when the person leaves it, and the send that takes it clears it', async () => {
    await writeCharacter('Ada.png', 'Ada', 'Hello.');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Ada.png' }, tab);
    assert.equal(opened.status, 200);
    const greeting = opened.body.openings.alternatives[0].extra.greeting_id;
    const owner = { greeting, avatar: 'Ada.png' };
    assert.deepEqual(opened.body.draft, { owner, text: '', version: '0.0' });

    const kept = await post('draft', { avatar_url: 'Ada.png', owner, text: 'Hi Ada', version: '0.0' }, tab);
    assert.equal(kept.body.left, 'kept');
    assert.equal(kept.body.text, 'Hi Ada');
    assert.notEqual(kept.body.version, '0.0', 'the answer carries the version the save made');
    await writeCharacter('Eve.png', 'Eve', 'Hey.');
    const away = await post('open', { avatar_url: 'Eve.png', leaving: [{ avatar_url: 'Ada.png', owner, text: 'Hi Ada, how', version: kept.body.version, tab: 't1' }] }, tab);
    assert.equal(away.status, 200, 'the open that leaves a chat keeps its draft');
    const [left] = away.body.left;
    assert.deepEqual({ ...left, version: undefined }, { avatar_url: 'Ada.png', owner, sent: 'Hi Ada, how', tab: 't1', left: 'kept', text: 'Hi Ada, how', version: undefined });
    const other = newSessionKey();
    assert.deepEqual((await post('open', { avatar_url: 'Ada.png' }, other)).body.draft, { owner, text: 'Hi Ada, how', version: left.version }, 'every chat at that greeting shows it');

    const tree = await treeOf(user.store, { avatar: 'Ada.png' });
    const before = user.store.chats.store.commit;
    /** @type {any[][]} */
    const commits = [];
    user.store.chats.store.commit = records => (commits.push(records), before.call(user.store.chats.store, records));
    const sent = await post('message/append', {
        avatar_url: 'Ada.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] },
        messages: [said('Hi Ada, how')], send_keys: ['k1'], draft_sent: { ...owner, version: left.version },
    }, tab);
    user.store.chats.store.commit = before;
    assert.equal(sent.status, 200);
    const [userNode] = sent.body.node_ids;
    assert.deepEqual(sent.body.draft, { owner: { message: userNode }, text: '', version: '0.0' });
    const write = commits.find(records => records.some(r => r.kind === 'messageAppend'));
    assert.ok(write.some(r => r.kind === 'draftValue' && r.text === '' && r.greeting === greeting), 'cleared in the write that stores the send');
    assert.equal((await user.store.chats.draftOf({ tree, greeting })).text, '');
});

test('a draft stays with the message it responds to: each alternative shows its own', async () => {
    await writeCharacter('Bo.png', 'Bo', 'Yo.');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Bo.png' }, tab);
    const sent = await post('message/append', { avatar_url: 'Bo.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] }, messages: [said('Hey')], send_keys: ['k2'] }, tab);
    const [userNode] = sent.body.node_ids;
    const replied = await post('message/append', { avatar_url: 'Bo.png', after_node_id: userNode, messages: [{ name: 'Bo', is_user: false, mes: 'Sure.', send_date: 2, extra: {} }] }, tab);
    const [reply] = replied.body.node_ids;
    assert.deepEqual(replied.body.draft, { owner: { message: reply }, text: '', version: '0.0' });
    const aboutSure = (await post('draft', { avatar_url: 'Bo.png', owner: { message: reply }, text: 'about Sure', version: '0.0' }, tab)).body.version;

    const other = await post('message/append', { avatar_url: 'Bo.png', after_node_id: userNode, messages: [{ name: 'Bo', is_user: false, mes: 'No.', send_date: 3, extra: {} }] }, tab);
    const [alternative] = other.body.node_ids;
    assert.equal(other.body.draft.owner.message, alternative);
    const back = await post('message/select', { avatar_url: 'Bo.png', node_id: reply, leaving: [{ avatar_url: 'Bo.png', owner: { message: alternative }, text: 'about No', version: '0.0' }] }, tab);
    assert.deepEqual(back.body.left.map(l => l.left), ['kept']);
    assert.deepEqual(back.body.draft, { owner: { message: reply }, text: 'about Sure', version: aboutSure }, 'going back shows the first one\'s draft again');
    assert.deepEqual((await post('open', { avatar_url: 'Bo.png' }, tab)).body.draft, { owner: { message: reply }, text: 'about Sure', version: aboutSure });
    const [altId] = await user.store.chats.messageIds([alternative]);
    assert.equal((await user.store.chats.draftOf({ message: altId })).text, 'about No', 'the swipe away keeps what was written about the one left');
});

test('a save goes to the message it names, also after the chat moved on', async () => {
    await writeCharacter('Fay.png', 'Fay', 'Hi from Fay.');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Fay.png' }, tab);
    const sent = await post('message/append', { avatar_url: 'Fay.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] }, messages: [said('Hello')], send_keys: ['kf'] }, tab);
    const [userNode] = sent.body.node_ids;
    const replied = await post('message/append', { avatar_url: 'Fay.png', after_node_id: userNode, messages: [{ name: 'Fay', is_user: false, mes: 'Yes?', send_date: 2, extra: {} }] }, tab);
    const [reply] = replied.body.node_ids;
    const late = await post('draft', { avatar_url: 'Fay.png', owner: { message: userNode }, text: 'typed before the reply', version: '0.0' }, tab);
    assert.equal(late.body.text, 'typed before the reply');
    assert.equal((await user.store.chats.draftOf({ message: (await user.store.chats.messageIds([userNode]))[0] })).text, 'typed before the reply');
    assert.equal((await user.store.chats.draftOf({ message: (await user.store.chats.messageIds([reply]))[0] })).text, '');
});

test('a chat showing nothing keeps its draft at the root; a draft after what the chat can\'t end at is gone', async () => {
    await writeCharacter('Cy.png', 'Cy', '');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Cy.png' }, tab);
    assert.deepEqual(opened.body.draft, { owner: { root: true }, text: '', version: '0.0' });
    const words = (await post('draft', { avatar_url: 'Cy.png', owner: { root: true }, text: 'first words', version: '0.0' }, tab)).body.version;
    assert.deepEqual((await post('open', { avatar_url: 'Cy.png' }, tab)).body.draft, { owner: { root: true }, text: 'first words', version: words });
    assert.deepEqual((await post('draft', { avatar_url: 'Cy.png', owner: { greeting: 0, avatar: 'Ada.png' }, text: 'x', version: '0.0' }, tab)).body, { ok: true, left: 'gone' });
    assert.deepEqual((await post('draft', { avatar_url: 'Cy.png', owner: { message: 'nope' }, text: 'x', version: '0.0' }, tab)).body, { ok: true, left: 'gone' });
    assert.equal((await post('draft', { avatar_url: 'Cy.png', owner: { root: true } }, tab)).status, 400, 'a save carries its text');
});

test('a group chat started opens on a greeting of each member it chose then, and its draft follows the last', async () => {
    await writeCharacter('Dee.png', 'Dee', 'Dee here.', ['Dee again.', 'Dee once more.']);
    await writeCharacter('Eve.png', 'Eve', 'Eve here.');
    await user.store.lib.writeGroup({ id: 'gd', name: 'Pair', members: ['Dee.png', 'Eve.png'] });
    const tab = newSessionKey();
    const started = await post('new', { group_id: 'gd' }, tab);
    assert.equal(started.status, 200);
    const picks = started.body.opened.group_openings;
    assert.deepEqual(picks.map(p => p.avatar), ['Dee.png', 'Eve.png']);
    for (let i = 0; i < 5; i++) {
        assert.deepEqual((await post('open', { group_id: 'gd' }, tab)).body.group_openings, picks, 'each open shows the openings chosen when the chat started');
    }
    const owner = { greeting: picks[1].greeting_id, avatar: 'Eve.png' };
    assert.deepEqual(started.body.opened.draft, { owner, text: '', version: '0.0' });
    const hello = (await post('draft', { group_id: 'gd', owner, text: 'hello both', version: '0.0' }, tab)).body.version;
    assert.deepEqual((await post('open', { group_id: 'gd' }, tab)).body.draft, { owner, text: 'hello both', version: hello });

    const shown = picks.map(p => ({ name: p.avatar, is_user: false, mes: p.text, send_date: 1, original_avatar: p.avatar, extra: { greeting_id: p.greeting_id } }));
    const sent = await post('message/append', { group_id: 'gd', opening: { messages: shown, refs: ['', ''] }, messages: [said('hello both')], send_keys: ['kg'], draft_sent: { ...owner, version: hello } }, tab);
    assert.equal(sent.status, 200);
    const [eve] = await user.store.lib.ids(0, ['Eve.png']);
    assert.equal((await user.store.chats.draftOf({ tree: eve, greeting: owner.greeting })).text, '');
    const tree = await treeOf(user.store, { group: 'gd' });
    const openings = await user.store.chats.store.chatRead('rootGroups', { tree });
    assert.deepEqual(openings.map(g => g.group), [0], 'a member\'s greeting id is not the group\'s greeting group');
    const session = await user.store.chats.sessionId(tab);
    assert.equal(await user.store.chats.store.chatRead('openingChoice', { session, tree, card: eve }), null, 'the choice ends with the send');
});

test('saves of one greeting\'s draft from its own chat and a group chat at once are all kept', async () => {
    await writeCharacter('Gil.png', 'Gil', 'Gil speaking.');
    await user.store.lib.writeGroup({ id: 'gg', name: 'Solo', members: ['Gil.png'] });
    const own = newSessionKey();
    const inGroup = newSessionKey();
    const owner = (await post('open', { avatar_url: 'Gil.png' }, own)).body.draft.owner;
    assert.deepEqual((await post('new', { group_id: 'gg' }, inGroup)).body.opened.draft.owner, owner, 'both chats end at the same greeting');
    const texts = Array.from({ length: 20 }, (_, i) => `[written ${i}]`);
    const answers = await Promise.all(texts.map((text, i) => (i % 2
        ? post('draft', { group_id: 'gg', owner, text, version: '0.0' }, inGroup)
        : post('draft', { avatar_url: 'Gil.png', owner, text, version: '0.0' }, own))));
    assert.ok(answers.every(a => a.status === 200 && a.body.left === 'kept'));
    const [gil] = await user.store.lib.ids(0, ['Gil.png']);
    const draft = (await user.store.chats.draftOf({ tree: gil, greeting: owner.greeting })).text;
    for (const text of texts) assert.ok(draft.includes(text), `${text} is kept`);
});

test('two tabs writing one draft at once both keep what they wrote', async () => {
    await writeCharacter('Hal.png', 'Hal', 'Hal here.');
    const one = newSessionKey();
    const two = newSessionKey();
    const opened = (await post('open', { avatar_url: 'Hal.png' }, one)).body.draft;
    const started = await post('draft', { avatar_url: 'Hal.png', owner: opened.owner, text: 'Dear Hal, the plan.', version: opened.version }, one);
    const { owner } = opened;
    const shared = started.body.version;
    const fromTwo = await post('draft', { avatar_url: 'Hal.png', owner, text: 'Dear Hal, the plan. P.S. bring tea.', version: shared }, two);
    assert.equal(fromTwo.body.text, 'Dear Hal, the plan. P.S. bring tea.', 'over the version it had, a save is kept as it is');
    const fromOne = await post('draft', { avatar_url: 'Hal.png', owner, text: 'Dear Hal, the new plan.', version: shared }, one);
    assert.equal(fromOne.body.text, 'Dear Hal, the new plan. P.S. bring tea.', 'a save over an older version is laid over what was written since');
    assert.notEqual(fromOne.body.version, fromTwo.body.version);
    assert.deepEqual((await post('open', { avatar_url: 'Hal.png' }, two)).body.draft, { owner, text: fromOne.body.text, version: fromOne.body.version });

    const leftover = await post('open', { avatar_url: 'Hal.png', leaving: [{ avatar_url: 'Hal.png', owner, text: 'Dear Hal, the plan. Closed tab says hi.', version: shared, tab: 'closed' }, { avatar_url: 'Hal.png', owner: { message: 'nope' }, text: 'x', version: '0.0' }, { owner }] }, one);
    assert.deepEqual(leftover.body.left.map(l => l.left), ['kept', 'gone', null]);
    assert.equal(leftover.body.left[0].tab, 'closed', 'each is named, so the page knows which copy it was');
    assert.equal(leftover.body.draft.text, 'Dear Hal, the new plan. P.S. bring tea. Closed tab says hi.', 'a closed tab\'s copy merges by its version like any save');
    assert.equal((await post('open', { avatar_url: 'Hal.png' }, one)).body.left, undefined, 'an answer to a request that carried no drafts says nothing of them');
});

test('a save over a version whose history is gone keeps both texts whole', async () => {
    await writeCharacter('Ivy.png', 'Ivy', 'Ivy here.');
    const one = newSessionKey();
    const { owner, version } = (await post('open', { avatar_url: 'Ivy.png' }, one)).body.draft;
    const old = (await post('draft', { avatar_url: 'Ivy.png', owner, text: 'shared start', version }, one)).body.version;
    const whole = await post('draft', { avatar_url: 'Ivy.png', owner, text: 'an entirely other text', version: old }, one);
    assert.equal(whole.body.text, 'an entirely other text');
    const late = await post('draft', { avatar_url: 'Ivy.png', owner, text: 'shared start, and more', version: old }, newSessionKey());
    assert.ok(late.body.text.includes('an entirely other text') && late.body.text.includes('shared start, and more'), late.body.text);
    const unknown = await post('draft', { avatar_url: 'Ivy.png', owner, text: 'no version at all', version: 'nonsense' }, one);
    assert.ok(unknown.body.text.includes(late.body.text) || unknown.body.text.includes('no version at all'));
    assert.ok(unknown.body.text.includes('no version at all'), 'a save with no version it can be laid over is kept whole too');
});

test('a send takes out of the draft only what it sent: what another tab wrote since stays', async () => {
    await writeCharacter('Jo.png', 'Jo', 'Jo here.');
    const one = newSessionKey();
    const opened = await post('open', { avatar_url: 'Jo.png' }, one);
    const { owner } = opened.body.draft;
    const letter = 'Hello Jo. This is a long enough letter that a few words added to it are kept as an edit of it.';
    const mine = (await post('draft', { avatar_url: 'Jo.png', owner, text: letter, version: '0.0' }, one)).body.version;
    await post('draft', { avatar_url: 'Jo.png', owner, text: `${letter} Also this.`, version: mine }, newSessionKey());
    const sent = await post('message/append', {
        avatar_url: 'Jo.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] },
        messages: [said(letter)], send_keys: ['kj'], draft_sent: { ...owner, version: mine },
    }, one);
    assert.equal(sent.status, 200);
    const [jo] = await user.store.lib.ids(0, ['Jo.png']);
    assert.equal((await user.store.chats.draftOf({ tree: jo, greeting: owner.greeting })).text, ' Also this.');
});

test('a send over a version whose history is gone takes nothing out of the draft', async () => {
    await writeCharacter('Kit.png', 'Kit', 'Kit here.');
    const one = newSessionKey();
    const opened = await post('open', { avatar_url: 'Kit.png' }, one);
    const { owner } = opened.body.draft;
    const mine = (await post('draft', { avatar_url: 'Kit.png', owner, text: 'Hi Kit.', version: '0.0' }, one)).body.version;
    await post('draft', { avatar_url: 'Kit.png', owner, text: 'Hi Kit. Also.', version: mine }, newSessionKey());
    await post('message/append', {
        avatar_url: 'Kit.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] },
        messages: [said('Hi Kit.')], send_keys: ['kk'], draft_sent: { ...owner, version: mine },
    }, one);
    const [kit] = await user.store.lib.ids(0, ['Kit.png']);
    assert.equal((await user.store.chats.draftOf({ tree: kit, greeting: owner.greeting })).text, 'Hi Kit. Also.', 'a short draft\'s edit is written whole, so what was sent can\'t be told apart: it stays');
});

test('drafts are told to other sessions, not back to the one that wrote them', async () => {
    const tree = await treeOf(user.store, { avatar: 'Cy.png' });
    const records = [{ kind: 'draftValue', tree, text: 'first words', session: 7n }];
    assert.deepEqual(await draftFrames(user.store, records, 7n), []);
    const [frame] = await draftFrames(user.store, records, 8n);
    assert.deepEqual({ ...frame, version: undefined }, { type: 'draft', tree: { avatar: 'Cy.png' }, owner: { root: true }, text: 'first words', version: undefined });
    assert.match(frame.version, /^\d+\.\d+$/);
});
