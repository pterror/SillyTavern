import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { fakeOwners } from './chat-test-people.js';

const { ChatEngine } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-same-alternative-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ivy = { id: 2n, name: 'Ivy', avatar: 'ivy.png' };
const rowan = { id: 3n, name: 'Ivy', avatar: 'rowan.png' };
const cast = [ivy, rowan];
const greetings = [{ id: 5, text: 'Greeting 1' }, { id: 7, text: 'Greeting 2' }, { id: 9, text: 'Greeting 3' }];
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(cast.filter(c => ids.includes(c.id)).map(c => [c.id, c])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(cast.filter(c => avatars.includes(c.avatar)).map(c => [c.avatar, c])),
    greetingModel: async () => ({ greetings, defaultId: 5, defaultEpoch: 0 }),
};
/** @type {any} */ (people).owners = fakeOwners(people);
const a = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000c1' };
const said = (/** @type {string} */ mes, /** @type {Record<string, any>} */ extra = {}) => ({ name: mes.startsWith('u') ? 'You' : 'Ivy', is_user: mes.startsWith('u'), is_system: false, mes, extra });

let n = 0;
/**
 * @param {any} engine
 */
async function fresh(engine) {
    const store = await engine.Store.open(path.join(root, `s${n++}`));
    const chats = await ChatEngine.open(store, /** @type {any} */ (people));
    let clock = 1_760_090_000_000;
    chats.now = () => (clock += 1000);
    const t = ivy.id;
    /** @type {Record<string, string>} */
    const id = {};
    const send = async (/** @type {string | null} */ after, /** @type {(string | Record<string, any>)[]} */ given) => {
        const contents = given.map(x => (typeof x === 'string' ? said(x) : x));
        const ids = (await chats.appendMessages({ tree: t, treeSpeaker: ivy, after: after === null ? null : id[after], contents, actor: a })).node_ids;
        contents.forEach((x, i) => (id[x.mes] = ids[i]));
    };
    const shown = async () => {
        const at = (await chats.pointer(a.session))?.at ?? null;
        return (await chats.load({ tree: t, at })).messages.map((/** @type {any} */ m) => m.mes);
    };
    const textOf = async (/** @type {string} */ node) => {
        const [s] = (await chats.stored((await chats.messageIds([node])).filter(x => x !== null))).values();
        return (await chats.decoded([s]))[0].mes;
    };
    const edit = (/** @type {string} */ node, /** @type {string} */ mes, finished = true) => chats.editMessages({ tree: t, treeSpeaker: ivy, edits: [{ node_id: node, patch: { mes }, finished }], actor: a });
    const card = async () => chats.cardGreetings(t);
    const chosen = async () => {
        const [session] = await store.chatRead('ids', { space: 1, keys: [a.session] });
        return chats.cardChoice(session, t);
    };
    return { store, chats, t, id, send, shown, textOf, edit, card, chosen };
}

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: a reply edited to another reply's exact text goes to that one when finished, and is refused while typed`, async () => {
        const { store, chats, t, id, send, shown, textOf, edit } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2']);
        await send('u1', ['b1x']);
        assert.deepEqual(await shown(), ['g', 'u1', 'b1x']);

        const typed = await edit(id.b1x, 'b1', false);
        assert.deepEqual(typed.refused, [{ node_id: id.b1x, reason: 'an alternative with this text already exists', same: { node_id: id.b1 } }]);
        assert.deepEqual(typed.shown, []);
        assert.equal(await textOf(id.b1x), 'b1x');
        assert.deepEqual(await shown(), ['g', 'u1', 'b1x'], 'an edit still being typed moves no one');

        const done = await edit(id.b1x, 'b1');
        assert.deepEqual([done.applied, done.refused, done.shown], [0, [], [{ node_id: id.b1x, same: { node_id: id.b1 } }]]);
        assert.equal(await textOf(id.b1x), 'b1x', 'the edit is not stored as a duplicate');
        assert.deepEqual(await shown(), ['g', 'u1', 'b1', 'u2'], 'the session shows the one with that text, with what is under it');

        for (const text of [' b1', 'b1 ', 'b1\n']) {
            const kept = await edit(id.b1x, text);
            assert.deepEqual([kept.applied, kept.shown], [1, []], `${JSON.stringify(text)} differs from "b1"`);
            assert.equal(await textOf(id.b1x), text);
        }

        await chats.select({ tree: t, node_id: id.b1x, actor: a });
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: id.u1, content: said('b1!'), typing: false, actor: a }), null);
        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: id.u1, content: said('b1'), typing: false, actor: a }), { node_id: id.b1 }, 'a new alternative typed with a reply\'s text is that reply');
        assert.deepEqual(await shown(), ['g', 'u1', 'b1', 'u2']);
        assert.equal((await chats.children(t, (await chats.messageIds([id.u1]))[0])).length, 2);
        await store.close();
    });

    test(`${kind}: a stored opening edited to another stored opening's exact text goes to that one`, async () => {
        const { store, id, send, shown, textOf, edit } = await fresh(engine);
        await send(null, ['Own A']);
        await send(null, ['Own B']);
        await send('Own B', ['u1']);
        assert.deepEqual(await shown(), ['Own B', 'u1']);

        assert.deepEqual((await edit(id['Own B'], 'Own A', false)).refused.map(r => r.same), [{ node_id: id['Own A'] }]);
        const done = await edit(id['Own B'], 'Own A');
        assert.deepEqual(done.shown, [{ node_id: id['Own B'], same: { node_id: id['Own A'] } }]);
        assert.equal(await textOf(id['Own B']), 'Own B');
        assert.deepEqual(await shown(), ['Own A']);

        const spaced = await edit(id['Own B'], 'Own A ');
        assert.deepEqual([spaced.applied, spaced.shown], [1, []]);
        assert.equal(await textOf(id['Own B']), 'Own A ');
        await store.close();
    });

    test(`${kind}: a stored opening edited to a card greeting's exact text shows that greeting; one with other whitespace stays an edit`, async () => {
        const { store, chats, t, id, send, shown, textOf, edit, card, chosen } = await fresh(engine);
        await send(null, [said('Greeting 2, edited', { greeting_id: 7 })]);
        await send('Greeting 2, edited', ['u1']);
        assert.deepEqual(await shown(), ['Greeting 2, edited', 'u1']);

        const done = await edit(id['Greeting 2, edited'], 'Greeting 2');
        assert.deepEqual(done.shown, [{ node_id: id['Greeting 2, edited'], same: { greeting_id: 7 } }]);
        assert.equal(await textOf(id['Greeting 2, edited']), 'Greeting 2, edited');
        assert.deepEqual(await shown(), [], 'the session is at the root');
        assert.deepEqual(await chosen(), { card: t, id: 7, epoch: 0 });
        const openings = /** @type {any} */ (await chats.openingAlternatives({ tree: t, actor: a, range: { limit: 10 }, card: await card() }));
        assert.deepEqual(openings.alternatives.map((/** @type {any} */ x) => [x.mes, x.node_id === null]), [['Greeting 1', true], ['Greeting 2', true], ['Greeting 2, edited', false], ['Greeting 3', true]]);
        assert.equal(openings.alternatives[openings.default_index].mes, 'Greeting 2');

        const spaced = await edit(id['Greeting 2, edited'], 'Greeting 2 ');
        assert.deepEqual([spaced.applied, spaced.shown], [1, []]);
        assert.equal(await textOf(id['Greeting 2, edited']), 'Greeting 2 ');
        await store.close();
    });

    test(`${kind}: a card greeting's edit stored as an opening goes to the alternative with its exact text: a stored opening, or another card greeting`, async () => {
        const { store, chats, t, id, send, shown, chosen } = await fresh(engine);
        await send(null, ['Own A']);
        const count = async () => (await chats.children(t, null)).length;
        const from = (/** @type {number} */ greetingId, /** @type {string} */ mes) => said(mes, { greeting_id: greetingId });

        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, 'Greeting 1'), typing: false, actor: a }), null, 'a greeting unedited is itself');
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, 'Own A '), typing: false, actor: a }), null);
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, ' Greeting 2'), typing: false, actor: a }), null);

        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, 'Own A'), typing: true, actor: a }), { node_id: id['Own A'] });
        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, 'Greeting 2'), typing: true, actor: a }), { greeting_id: 7 });
        assert.deepEqual(await shown(), ['Own A'], 'while typed, the session stays');

        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, 'Greeting 2'), typing: false, actor: a }), { greeting_id: 7 });
        assert.deepEqual([await shown(), await chosen()], [[], { card: t, id: 7, epoch: 0 }]);
        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(9, 'Own A'), typing: false, actor: a }), { node_id: id['Own A'] });
        assert.deepEqual(await shown(), ['Own A']);
        assert.equal(await count(), 1, 'nothing is stored');

        await send(null, [said('Greeting 3', { greeting_id: 9 })]);
        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: from(5, 'Greeting 3'), typing: false, actor: a }), { node_id: id['Greeting 3'] }, 'a greeting held by a stored opening is that opening');
        await store.close();
    });
    test(`${kind}: an edit with another alternative's text by another author stays an edit: a persona by its avatar key, a character by its id, never by name`, async () => {
        const { store, chats, t, id, send, shown, textOf, edit } = await fresh(engine);
        const as = (/** @type {string} */ mes, /** @type {Record<string, any>} */ who) => ({ ...said(mes), ...who });
        await send(null, ['g']);
        await send('g', [as('hi', { is_user: true, name: 'You', persona: 'a.png' })]);
        await send('g', [as('hi there', { is_user: true, name: 'You', persona: 'b.png' })]);
        await send('g', [as('hello', { is_user: true, name: 'You', persona: 'a.png' })]);
        assert.deepEqual(await shown(), ['g', 'hello']);

        const otherPersona = await edit(id['hi there'], 'hi');
        assert.deepEqual([otherPersona.applied, otherPersona.shown], [1, []], 'a persona with the same name is another author');
        assert.equal(await textOf(id['hi there']), 'hi');
        const samePersona = await edit(id.hello, 'hi');
        assert.deepEqual(samePersona.shown, [{ node_id: id.hello, same: { node_id: id.hi } }]);
        assert.deepEqual(await shown(), ['g', 'hi']);

        await send('hi', [as('b1', { original_avatar: rowan.avatar }), 'b2']);
        const otherCharacter = await edit(id.b2, 'b1');
        assert.deepEqual([otherCharacter.applied, otherCharacter.shown], [1, []], 'a character with the same name is another author');
        assert.equal(await textOf(id.b2), 'b1');
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: id.hi, content: said('b1'), typing: false, actor: a }), null);
        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: id.hi, content: as('b1', { original_avatar: rowan.avatar }), typing: false, actor: a }), { node_id: id.b1 });
        await store.close();
    });

    test(`${kind}: a card greeting's author is the character: a user's opening with its text, or another character's, stays an edit`, async () => {
        const { store, chats, t, id, send, shown, textOf, edit, chosen } = await fresh(engine);
        await send(null, [{ ...said('Mine'), is_user: true, name: 'You', persona: 'a.png' }]);
        await send(null, [{ ...said('Theirs'), original_avatar: rowan.avatar }]);
        assert.deepEqual([(await edit(id.Mine, 'Greeting 2')).shown, await textOf(id.Mine)], [[], 'Greeting 2']);
        assert.deepEqual([(await edit(id.Theirs, 'Greeting 3')).shown, await textOf(id.Theirs)], [[], 'Greeting 3']);
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: ivy, after: null, content: { ...said('Greeting 2', { greeting_id: 5 }), is_user: true, persona: 'b.png' }, typing: false, actor: a }), null);
        assert.deepEqual(await shown(), ['Greeting 3'], 'the session stays on the edited opening');
        assert.equal(await chosen(), null);
        await store.close();
    });

    test(`${kind}: an opening with a card greeting's text but for whitespace is not linked to it, and the greeting stays listed`, async () => {
        const { store, chats, t, id, send, card } = await fresh(engine);
        await send(null, [said(' Greeting 2\n', { greeting_id: 7 })]);
        const [opening] = await chats.openings(t);
        assert.deepEqual(opening.message.extra, { greeting_id: 7 }, 'it keeps the greeting it came from, unlinked');
        const listed = async () => (/** @type {any} */ (await chats.openingAlternatives({ tree: t, actor: a, range: { limit: 10 }, card: await card() }))).alternatives.map((/** @type {any} */ x) => [x.mes, x.node_id === null]);
        assert.deepEqual(await listed(), [['Greeting 1', true], ['Greeting 2', true], [' Greeting 2\n', false], ['Greeting 3', true]]);
        await chats.editMessages({ tree: t, treeSpeaker: ivy, edits: [{ node_id: id[' Greeting 2\n'], patch: { mes: 'Greeting 3 ' }, finished: true }], actor: a });
        assert.deepEqual(await listed(), [['Greeting 1', true], ['Greeting 2', true], ['Greeting 3 ', false], ['Greeting 3', true]], 'an edit is linked the same way');
        await store.close();
    });

    test(`${kind}: a message sent with an alternative's text and author is that alternative; a name never counts`, async () => {
        const { store, chats, t, id, send } = await fresh(engine);
        const user = (/** @type {string} */ name, /** @type {string} */ persona) => ({ ...said('u1'), is_user: true, name, persona });
        const append = async (/** @type {Record<string, any>} */ content, after = id.g) => (await chats.appendMessages({ tree: t, treeSpeaker: ivy, after, contents: [content], actor: a })).node_ids[0];
        await send(null, ['g']);
        const first = await append(user('You', 'a.png'));
        assert.equal(await append(user('Renamed', 'a.png')), first, 'the same persona under another name');
        assert.notEqual(await append(user('You', 'b.png')), first, 'another persona with the same name');
        const unrecorded = await append({ ...said('u1'), is_user: true, name: 'You' });
        assert.notEqual(unrecorded, first);
        assert.equal(await append({ ...said('u1'), is_user: true, name: 'Renamed' }), unrecorded, 'messages that record no persona are one author');
        const reply = await append(said('b1'), first);
        assert.equal(await append({ ...said('b1'), name: 'Renamed' }, first), reply, 'the same character under another name');
        assert.notEqual(await append({ ...said('b1'), original_avatar: rowan.avatar }, first), reply, 'another character with the same name');
        await store.close();
    });

    test(`${kind}: a message grafted with an alternative's text and author is that alternative; a name never counts`, async () => {
        const { store, chats, t, id, send } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1']);
        await send('g', ['x']);
        const graft = async (/** @type {Record<string, any>} */ content) => (/** @type {any} */ (await chats.graftMessage({ tree: t, treeSpeaker: ivy, after: id.g, before: id.u1, content, actor: a }))).node_id;
        assert.equal(await graft({ ...said('x'), name: 'Renamed' }), id.x);
        assert.notEqual(await graft({ ...said('x'), original_avatar: rowan.avatar }), id.x);
        await store.close();
    });

    test(`${kind}: an opening added with a stored opening's text and author is that opening; a name never counts`, async () => {
        const { store, chats, t } = await fresh(engine);
        const add = async (/** @type {Record<string, any>} */ content) => (await chats.addOpenings({ tree: t, treeSpeaker: ivy, contents: [content], actor: { user: a.user } })).node_ids[0];
        const hi = await add(said('Hi'));
        assert.equal(await add({ ...said('Hi'), name: 'Renamed' }), hi);
        const theirs = await add({ ...said('Hi'), original_avatar: rowan.avatar });
        assert.notEqual(theirs, hi, 'another character with the same name');
        const mine = await add({ ...said('Hi'), is_user: true, name: 'You', persona: 'a.png' });
        assert.notEqual(mine, hi);
        assert.equal(await add({ ...said('Hi'), is_user: true, name: 'Renamed', persona: 'a.png' }), mine);
        assert.notEqual(await add({ ...said('Hi'), is_user: true, name: 'You', persona: 'b.png' }), mine);
        await store.close();
    });

    test(`${kind}: an import keeps alternatives apart by author and merges them by author, whatever their names`, async () => {
        const { store, chats, t } = await fresh(engine);
        const child = async (/** @type {string | null} */ parent) => {
            const [p] = parent === null ? [null] : await chats.messageIds([parent]);
            return chats.externalIds(await chats.children(t, p));
        };
        const imported = async (/** @type {Record<string, any>[]} */ messages) => /** @type {any} */ (await chats.importChat({ tree: t, treeSpeaker: ivy, name: null, messages, metadata: {}, actor: a, bookmark: false })).node_ids;
        const [g1, u1] = await imported([said('g'), { ...said('u1'), is_user: true, name: 'You', persona: 'a.png' }]);
        const [g2, u2] = await imported([{ ...said('g'), name: 'Renamed' }, { ...said('u1'), is_user: true, name: 'Renamed', persona: 'a.png' }]);
        assert.deepEqual([g2, u2], [g1, u1], 'the same authors under other names');
        const [g3, u3] = await imported([{ ...said('g'), original_avatar: rowan.avatar }, { ...said('u1'), is_user: true, name: 'You', persona: 'b.png' }]);
        assert.notEqual(g3, g1, 'another character with the same name');
        assert.deepEqual(await child(g3), [u3]);
        const [, u4] = await imported([said('g'), { ...said('u1'), is_user: true, name: 'You', persona: 'b.png' }]);
        assert.notEqual(u4, u1, 'another persona with the same name');
        assert.deepEqual((await child(null)).length, 2);
        assert.deepEqual((await child(g1)).length, 2);
        await store.close();
    });
}
