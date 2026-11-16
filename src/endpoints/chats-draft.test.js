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
const { newSessionKey, greetingGroup } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { draftFrames } = await import('../chat-drafts.js');
const { shownMacrosAnswer } = await import('../message-macros.js');
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
app.post('/api/chats/shown-macros', async (req, res) => res.send(await shownMacrosAnswer(req, req.body.shown)));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(route, body, tab) {
    const res = await fetch(`${base}/api/chats/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: tab }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const said = (mes, extra = {}) => ({ name: 'User', is_user: true, mes, send_date: 1, extra });

/**
 * A text with the change from the draft it was written over, as a tab's editor gives it: one replacement of what
 * differs
 * @param {string} base
 * @param {string} text
 */
function over(base, text) {
    let start = 0;
    while (start < base.length && start < text.length && base[start] === text[start]) start++;
    let end = 0;
    while (end < base.length - start && end < text.length - start && base[base.length - 1 - end] === text[text.length - 1 - end]) end++;
    const changes = base === text ? [] : [{ from: start, to: base.length - end, insert: text.slice(start, text.length - end), deleted: base.slice(start, base.length - end) }];
    return { text, changes };
}

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
    assert.deepEqual(opened.body.draft, { owner, text: '' });

    const kept = await post('draft', { avatar_url: 'Ada.png', owner, ...over('', 'Hi Ada') }, tab);
    assert.deepEqual(kept.body, { ok: true, left: 'kept', text: 'Hi Ada' });
    await writeCharacter('Eve.png', 'Eve', 'Hey.');
    const away = await post('open', { avatar_url: 'Eve.png', leaving: [{ avatar_url: 'Ada.png', owner, ...over('Hi Ada', 'Hi Ada, how'), tab: 't1', change: 'p/1:3' }] }, tab);
    assert.equal(away.status, 200, 'the open that leaves a chat keeps its draft');
    assert.deepEqual(away.body.left, [{ avatar_url: 'Ada.png', owner, sent: 'Hi Ada, how', tab: 't1', change: 'p/1:3', left: 'kept', text: 'Hi Ada, how' }]);
    const other = newSessionKey();
    assert.deepEqual((await post('open', { avatar_url: 'Ada.png' }, other)).body.draft, { owner, text: 'Hi Ada, how' }, 'every chat at that greeting shows it');

    const tree = await treeOf(user.store, { avatar: 'Ada.png' });
    const before = user.store.chats.store.commit;
    /** @type {any[][]} */
    const commits = [];
    user.store.chats.store.commit = (/** @type {any[]} */ records) => (commits.push(records), before.call(user.store.chats.store, records));
    const sent = await post('message/append', {
        avatar_url: 'Ada.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] },
        messages: [said('Hi Ada, how')], send_keys: ['k1'], draft_sent: { ...owner, ...over('Hi Ada, how', 'Hi Ada, how') },
    }, tab);
    user.store.chats.store.commit = before;
    assert.equal(sent.status, 200);
    const [userNode] = sent.body.node_ids;
    assert.deepEqual(sent.body.draft, { owner: { message: userNode }, text: '' });
    const write = commits.find(records => records.some(r => r.kind === 'messageAppend'));
    assert.ok(write.some(r => r.kind === 'draftValue' && r.text === '' && r.greeting === greeting), 'cleared in the write that stores the send');
    assert.equal(await user.store.chats.draftOf({ tree, greeting }), '');
});

test('a greeting taken out of its card takes its draft with it, in the same write; the greetings kept keep theirs', async () => {
    await writeCharacter('Gia.png', 'Gia', 'One.', ['Two.', 'Three.']);
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Gia.png' }, tab);
    const idOf = (/** @type {string} */ text) => opened.body.openings.alternatives.find((/** @type {any} */ a) => a.mes === text).extra.greeting_id;
    for (const text of ['One.', 'Two.', 'Three.']) {
        const kept = await post('draft', { avatar_url: 'Gia.png', owner: { greeting: idOf(text), avatar: 'Gia.png' }, ...over('', `after ${text}`) }, tab);
        assert.equal(kept.body.left, 'kept');
    }
    const tree = await treeOf(user.store, { avatar: 'Gia.png' });
    const before = user.store.lib.store.commit;
    /** @type {any[][]} */
    const commits = [];
    user.store.lib.store.commit = (/** @type {any[]} */ records) => (commits.push(records), before.call(user.store.lib.store, records));
    await writeCharacter('Gia.png', 'Gia', 'Three.', ['One.']);
    user.store.lib.store.commit = before;
    assert.equal(await user.store.chats.draftOf({ tree, greeting: idOf('Two.') }), '');
    assert.equal(await user.store.chats.draftOf({ tree, greeting: idOf('One.') }), 'after One.', 'a greeting no longer the default keeps its draft');
    assert.equal(await user.store.chats.draftOf({ tree, greeting: idOf('Three.') }), 'after Three.', 'a greeting made the default keeps its draft');
    const write = commits.find(records => records.some(r => r.kind === 'itemDelete'));
    assert.ok(write?.some(r => r.kind === 'draftValue' && r.text === '' && r.greeting === idOf('Two.')), 'dropped in the write that takes the greeting out');
    assert.deepEqual((await post('draft', { avatar_url: 'Gia.png', owner: { greeting: idOf('Two.'), avatar: 'Gia.png' }, ...over('', 'late') }, tab)).body, { ok: true, left: 'gone' });
});

test('a draft comes with the values of the macros in it, as the person\'s message after the chat\'s end; what is only known when sent is null', async () => {
    await writeCharacter('Mac.png', 'Mac', '');
    const tab = newSessionKey();
    await post('open', { avatar_url: 'Mac.png' }, tab);
    await post('draft', { avatar_url: 'Mac.png', owner: { root: true }, ...over('', 'Hi {{char}}, {{input}}') }, tab);
    const opened = await post('open', { avatar_url: 'Mac.png' }, tab);
    assert.deepEqual({ ...opened.body.draft, macro_values: undefined }, { owner: { root: true }, text: 'Hi {{char}}, {{input}}', macro_values: undefined });
    assert.equal(opened.body.draft.macro_values['{{char}}'], 'Mac');
    assert.equal(opened.body.draft.macro_values['{{input}}'], null);
    const answered = await post('shown-macros', { shown: { avatar_url: 'Mac.png', scopes: [{ avatar_url: 'Mac.png', speaker: null, sources: ['{{char}}', '{{user}}', '{{input}}'] }] } }, tab);
    const [person] = answered.body.macro_values;
    assert.deepEqual([person.avatar_url, person.speaker, person.values['{{char}}'], person.values['{{user}}'], person.values['{{input}}']], ['Mac.png', null, 'Mac', 'Tester', null], 'an answer that may change them carries the values of the macros the page holds, the person\'s with the box\'s');
    await post('draft', { avatar_url: 'Mac.png', owner: { root: true }, ...over('Hi {{char}}, {{input}}', 'plain') }, tab);
    assert.deepEqual((await post('open', { avatar_url: 'Mac.png' }, tab)).body.draft, { owner: { root: true }, text: 'plain' }, 'one with no macros comes with none');
});

test('a draft stays with the message it responds to: each alternative shows its own', async () => {
    await writeCharacter('Bo.png', 'Bo', 'Yo.');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Bo.png' }, tab);
    const sent = await post('message/append', { avatar_url: 'Bo.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] }, messages: [said('Hey')], send_keys: ['k2'] }, tab);
    const [userNode] = sent.body.node_ids;
    const replied = await post('message/append', { avatar_url: 'Bo.png', after_node_id: userNode, messages: [{ name: 'Bo', is_user: false, mes: 'Sure.', send_date: 2, extra: {} }] }, tab);
    const [reply] = replied.body.node_ids;
    assert.deepEqual(replied.body.draft, { owner: { message: reply }, text: '' });
    await post('draft', { avatar_url: 'Bo.png', owner: { message: reply }, ...over('', 'about Sure') }, tab);

    const other = await post('message/append', { avatar_url: 'Bo.png', after_node_id: userNode, messages: [{ name: 'Bo', is_user: false, mes: 'No.', send_date: 3, extra: {} }] }, tab);
    const [alternative] = other.body.node_ids;
    assert.equal(other.body.draft.owner.message, alternative);
    const back = await post('message/select', { avatar_url: 'Bo.png', node_id: reply, leaving: [{ avatar_url: 'Bo.png', owner: { message: alternative }, ...over('', 'about No') }] }, tab);
    assert.deepEqual(back.body.left.map(l => l.left), ['kept']);
    assert.deepEqual(back.body.draft, { owner: { message: reply }, text: 'about Sure' }, 'going back shows the first one\'s draft again');
    const [altId] = await user.store.chats.messageIds([alternative]);
    assert.equal(await user.store.chats.draftOf({ message: altId }), 'about No', 'the swipe away keeps what was written about the one left');
});

test('a save goes to the message it names, also after the chat moved on', async () => {
    await writeCharacter('Fay.png', 'Fay', 'Hi from Fay.');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Fay.png' }, tab);
    const sent = await post('message/append', { avatar_url: 'Fay.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] }, messages: [said('Hello')], send_keys: ['kf'] }, tab);
    const [userNode] = sent.body.node_ids;
    const replied = await post('message/append', { avatar_url: 'Fay.png', after_node_id: userNode, messages: [{ name: 'Fay', is_user: false, mes: 'Yes?', send_date: 2, extra: {} }] }, tab);
    const [reply] = replied.body.node_ids;
    const late = await post('draft', { avatar_url: 'Fay.png', owner: { message: userNode }, ...over('', 'typed before the reply') }, tab);
    assert.equal(late.body.text, 'typed before the reply');
    assert.equal(await user.store.chats.draftOf({ message: (await user.store.chats.messageIds([userNode]))[0] }), 'typed before the reply');
    assert.equal(await user.store.chats.draftOf({ message: (await user.store.chats.messageIds([reply]))[0] }), '');
});

test('a chat showing nothing keeps its draft at the root; a draft after what the chat can\'t end at is gone; a save whose changes don\'t fit is refused', async () => {
    await writeCharacter('Cy.png', 'Cy', '');
    const tab = newSessionKey();
    const opened = await post('open', { avatar_url: 'Cy.png' }, tab);
    assert.deepEqual(opened.body.draft, { owner: { root: true }, text: '' });
    await post('draft', { avatar_url: 'Cy.png', owner: { root: true }, ...over('', 'first words') }, tab);
    assert.deepEqual((await post('open', { avatar_url: 'Cy.png' }, tab)).body.draft, { owner: { root: true }, text: 'first words' });
    assert.deepEqual((await post('draft', { avatar_url: 'Cy.png', owner: { greeting: 0, avatar: 'Ada.png' }, ...over('', 'x') }, tab)).body, { ok: true, left: 'gone' });
    assert.deepEqual((await post('draft', { avatar_url: 'Cy.png', owner: { message: 'nope' }, ...over('', 'x') }, tab)).body, { ok: true, left: 'gone' });
    const refused = [
        { text: 'x' },
        { text: 'abc', changes: [{ from: 0, to: 1, insert: 'Z', deleted: 'a' }] },
        { text: 'abc', changes: [{ from: 0, to: 2, insert: 'a', deleted: 'q' }] },
        { text: 'abc', changes: [{ from: 1, to: 1, insert: 'b', deleted: '' }, { from: 0, to: 0, insert: 'a', deleted: '' }] },
        { text: 'abc', changes: 'all of it' },
    ];
    for (const save of refused) {
        assert.equal((await post('draft', { avatar_url: 'Cy.png', owner: { root: true }, ...save }, tab)).status, 400, JSON.stringify(save));
    }
    const carried = await post('open', { avatar_url: 'Cy.png', leaving: [{ avatar_url: 'Cy.png', owner: { root: true }, ...refused[1] }] }, tab);
    assert.deepEqual(carried.body.left.map((/** @type {any} */ l) => l.left), [null], 'one carried with an open is not kept, and the page keeps its copy');
    assert.equal(carried.body.draft.text, 'first words');
});

test('a group chat started opens on its first member\'s default greeting, and its draft follows the greeting shown', async () => {
    await writeCharacter('Dee.png', 'Dee', 'Dee here.', ['Dee again.', 'Dee once more.']);
    await writeCharacter('Eve.png', 'Eve', 'Eve here.');
    await user.store.lib.writeGroup({ id: 'gd', name: 'Pair', members: ['Dee.png', 'Eve.png'] });
    const tab = newSessionKey();
    const started = await post('new', { group_id: 'gd' }, tab);
    assert.equal(started.status, 200);
    const { openings } = started.body.opened;
    assert.deepEqual(openings.alternatives.map((/** @type {any} */ a) => [a.original_avatar, a.mes]), [['Dee.png', 'Dee here.'], ['Dee.png', 'Dee again.'], ['Dee.png', 'Dee once more.'], ['Eve.png', 'Eve here.']]);
    const shown = openings.alternatives[openings.default_index];
    assert.equal(shown.mes, 'Dee here.');
    const owner = { greeting: shown.extra.greeting_id, avatar: 'Dee.png' };
    assert.deepEqual(started.body.opened.draft, { owner, text: '' });
    await post('draft', { group_id: 'gd', owner, ...over('', 'hello both') }, tab);
    assert.deepEqual((await post('open', { group_id: 'gd' }, tab)).body.draft, { owner, text: 'hello both' });

    const opening = { name: 'Dee', is_user: false, mes: shown.mes, send_date: 1, original_avatar: 'Dee.png', extra: { greeting_id: owner.greeting } };
    const sent = await post('message/append', { group_id: 'gd', opening: { messages: [opening], refs: [''] }, messages: [said('hello both')], send_keys: ['kg'], draft_sent: { ...owner, ...over('hello both', 'hello both') } }, tab);
    assert.equal(sent.status, 200);
    const [dee] = await user.store.lib.ids(0, ['Dee.png']);
    assert.equal(await user.store.chats.draftOf({ tree: dee, greeting: owner.greeting }), '');
    const tree = await treeOf(user.store, { group: 'gd' });
    const groups = await user.store.chats.store.chatRead('rootGroups', { tree });
    assert.deepEqual(groups.map(g => g.group), [greetingGroup(tree, dee, owner.greeting)], 'the opening is kept in its member\'s greeting\'s group');
    const session = await user.store.chats.sessionId(tab);
    assert.equal(await user.store.chats.store.chatRead('openingChosen', { session, tree }), null, 'the choice ends with the send');
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
        ? post('draft', { group_id: 'gg', owner, ...over('', text) }, inGroup)
        : post('draft', { avatar_url: 'Gil.png', owner, ...over('', text) }, own))));
    assert.ok(answers.every(a => a.status === 200 && a.body.left === 'kept'));
    const [gil] = await user.store.lib.ids(0, ['Gil.png']);
    const draft = await user.store.chats.draftOf({ tree: gil, greeting: owner.greeting });
    for (const text of texts) assert.ok(draft.includes(text), `${text} is kept`);
});

test('two tabs typing in one draft both keep what they wrote; the same copy carried twice changes nothing', async () => {
    await writeCharacter('Hal.png', 'Hal', 'Hal here.');
    const one = newSessionKey();
    const two = newSessionKey();
    const { owner } = (await post('open', { avatar_url: 'Hal.png' }, one)).body.draft;
    await post('draft', { avatar_url: 'Hal.png', owner, ...over('', 'Dear Hal, the plan.') }, one);
    const shared = 'Dear Hal, the plan.';
    const fromTwo = await post('draft', { avatar_url: 'Hal.png', owner, ...over(shared, 'Dear Hal, the plan. P.S. bring tea.') }, two);
    assert.equal(fromTwo.body.text, 'Dear Hal, the plan. P.S. bring tea.');
    const fromOne = await post('draft', { avatar_url: 'Hal.png', owner, ...over(shared, 'Dear Hal, the new plan.') }, one);
    assert.equal(fromOne.body.text, 'Dear Hal, the new plan. P.S. bring tea.', 'what one wrote is laid over what the other wrote since');
    assert.deepEqual((await post('open', { avatar_url: 'Hal.png' }, two)).body.draft, { owner, text: fromOne.body.text });

    const crashed = { avatar_url: 'Hal.png', owner, ...over(shared, 'Dear Hal, the plan. Closed tab says hi.'), tab: 'closed' };
    const leftover = await post('open', { avatar_url: 'Hal.png', leaving: [crashed, { avatar_url: 'Hal.png', owner: { message: 'nope' }, ...over('', 'x') }, { owner }] }, one);
    assert.deepEqual(leftover.body.left.map(l => l.left), ['kept', 'gone', null]);
    assert.equal(leftover.body.left[0].tab, 'closed', 'each is named, so the page knows which copy it was');
    assert.equal(leftover.body.draft.text, 'Dear Hal, the new plan. P.S. bring tea. Closed tab says hi.', 'a crashed tab\'s copy merges like any save');
    const again = await post('open', { avatar_url: 'Hal.png', leaving: [crashed] }, two);
    assert.equal(again.body.draft.text, leftover.body.draft.text, 'carried a second time, from another tab, it changes nothing');
    const repeat = await post('draft', { avatar_url: 'Hal.png', owner, ...over(shared, 'Dear Hal, the new plan.') }, one);
    assert.equal(repeat.body.text, leftover.body.draft.text, 'a save sent again changes nothing');
    assert.equal((await post('open', { avatar_url: 'Hal.png' }, one)).body.left, undefined, 'an answer to a request that carried no drafts says nothing of them');
});

test('short drafts merge as long ones do, however they are stored', async () => {
    await writeCharacter('Ivy.png', 'Ivy', 'Ivy here.');
    const one = newSessionKey();
    const { owner } = (await post('open', { avatar_url: 'Ivy.png' }, one)).body.draft;
    await post('draft', { avatar_url: 'Ivy.png', owner, ...over('', 'ok') }, one);
    await post('draft', { avatar_url: 'Ivy.png', owner, ...over('ok', 'ok!') }, newSessionKey());
    const late = await post('draft', { avatar_url: 'Ivy.png', owner, ...over('ok', 'so ok') }, one);
    assert.equal(late.body.text, 'so ok!');
    const deleted = await post('draft', { avatar_url: 'Ivy.png', owner, ...over('so ok!', 'so!') }, one);
    assert.equal(deleted.body.text, 'so!');
    const stale = await post('draft', { avatar_url: 'Ivy.png', owner, ...over('ok', 'ok?') }, newSessionKey());
    assert.equal(stale.body.text, 'so!?', 'a deletion made since stays deleted');
});

test('the send "Hi Kit." takes out only what it sent: " Also." written in another tab stays', async () => {
    await writeCharacter('Kit.png', 'Kit', 'Kit here.');
    const one = newSessionKey();
    const opened = await post('open', { avatar_url: 'Kit.png' }, one);
    const { owner } = opened.body.draft;
    await post('draft', { avatar_url: 'Kit.png', owner, ...over('', 'Hi Kit.') }, one);
    await post('draft', { avatar_url: 'Kit.png', owner, ...over('Hi Kit.', 'Hi Kit. Also.') }, newSessionKey());
    await post('message/append', {
        avatar_url: 'Kit.png', opening: { messages: [opened.body.openings.alternatives[0]], refs: [''] },
        messages: [said('Hi Kit.')], send_keys: ['kk'], draft_sent: { ...owner, ...over('Hi Kit.', 'Hi Kit.') },
    }, one);
    const [kit] = await user.store.lib.ids(0, ['Kit.png']);
    assert.equal(await user.store.chats.draftOf({ tree: kit, greeting: owner.greeting }), ' Also.');
});

test('every draft written is told to every tab, with the tab and edit of the save it came from', async () => {
    await writeCharacter('Lu.png', 'Lu', 'Lu here.');
    const tab = newSessionKey();
    const { owner } = (await post('open', { avatar_url: 'Lu.png' }, tab)).body.draft;
    const before = user.store.chats.store.commit;
    /** @type {any[][]} */
    const commits = [];
    user.store.chats.store.commit = (/** @type {any[]} */ records) => (commits.push(records), before.call(user.store.chats.store, records));
    await post('draft', { avatar_url: 'Lu.png', owner, ...over('', 'one'), tab: 'ta', change: 'p/1:2' }, tab);
    await post('draft', { avatar_url: 'Lu.png', owner, ...over('', 'two') }, newSessionKey());
    user.store.chats.store.commit = before;
    const frames = [];
    for (const records of commits) frames.push(...await draftFrames(user.store, records));
    assert.deepEqual(frames, [
        { type: 'draft', tree: { avatar: 'Lu.png' }, owner, text: 'one', tab: 'ta', change: 'p/1:2' },
        { type: 'draft', tree: { avatar: 'Lu.png' }, owner, text: 'onetwo' },
    ]);
});
