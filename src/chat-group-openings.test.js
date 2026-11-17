import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { fakeOwners } from './chat-test-people.js';

const { ChatEngine, greetingGroup } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-group-openings-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ann = { id: 2n, name: 'Ann', avatar: 'ann.png' };
const bo = { id: 3n, name: 'Bo', avatar: 'bo.png' };
const cy = { id: 4n, name: 'Cy', avatar: 'cy.png' };
const cast = [ann, bo, cy];
const band = 9n;
/** @type {Map<bigint, { greetings: { id: number, text: string }[], defaultId: number | null, defaultEpoch: number }>} */
const models = new Map();
/** @type {bigint[]} */
let members = [];

const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(cast.filter(c => ids.includes(c.id)).map(c => [c.id, c])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(cast.filter(c => avatars.includes(c.avatar)).map(c => [c.avatar, c])),
    greetingModel: async (/** @type {bigint} */ card) => models.get(card) ?? null,
    members: async (/** @type {bigint} */ tree) => (tree === band ? members.map(id => ({ id, avatar: /** @type {any} */ (cast.find(c => c.id === id)).avatar })) : []),
};
/** @type {any} */ (people).owners = fakeOwners(people);

const a = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000d1' };
/**
 * @param {{ name: string, avatar: string }} who
 * @param {string} mes
 * @param {Record<string, any>} [extra]
 */
const by = (who, mes, extra = {}) => ({ name: who.name, is_user: false, is_system: false, mes, original_avatar: who.avatar, extra });

let n = 0;
/**
 * @param {any} engine
 */
async function fresh(engine) {
    models.clear();
    models.set(ann.id, { greetings: [{ id: 0, text: 'Ann 0' }, { id: 1, text: 'Ann 1' }], defaultId: 1, defaultEpoch: 0 });
    models.set(bo.id, { greetings: [{ id: 0, text: 'Bo 0' }, { id: 4, text: 'Bo 4' }], defaultId: 0, defaultEpoch: 0 });
    models.set(cy.id, { greetings: [{ id: 0, text: 'Cy 0' }], defaultId: 0, defaultEpoch: 0 });
    members = [ann.id, bo.id];
    const store = await engine.Store.open(path.join(root, `s${n++}`));
    const chats = await ChatEngine.open(store, /** @type {any} */ (people));
    let clock = 1_760_090_000_000;
    chats.now = () => (clock += 1000);
    const t = band;
    const listed = async () => {
        const o = /** @type {any} */ (await chats.openingAlternatives({ tree: t, actor: a, range: { limit: 50 } }));
        return { all: o.alternatives.map((/** @type {any} */ x) => [x.original_avatar ?? null, x.mes, x.node_id !== null]), shown: o.alternatives[o.default_index - o.offset] ?? null, o };
    };
    const shown = async () => (await listed()).shown?.mes ?? null;
    const store1 = async (/** @type {Record<string, any>} */ content) => (await chats.appendMessages({ tree: t, treeSpeaker: null, after: null, contents: [content], actor: a })).node_ids[0];
    const decodedOf = async (/** @type {string} */ node) => {
        const [id] = await chats.messageIds([node]);
        const s = (await chats.stored(/** @type {bigint[]} */ ([id]))).get(id);
        return { stored: s, message: (await chats.decoded([s]))[0] };
    };
    const edit = (/** @type {string} */ node, /** @type {string} */ mes, finished = true) => chats.editMessages({ tree: t, treeSpeaker: null, edits: [{ node_id: node, patch: { mes }, finished }], actor: a });
    return { store, chats, t, listed, shown, store1, decodedOf, edit };
}

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: a group's first message offers every member's card greetings, in member order then card order, each by its member`, async () => {
        const { store, chats, t, listed, shown } = await fresh(engine);
        const { all, o } = await listed();
        assert.deepEqual(all, [['ann.png', 'Ann 0', false], ['ann.png', 'Ann 1', false], ['bo.png', 'Bo 0', false], ['bo.png', 'Bo 4', false]]);
        assert.deepEqual(o.alternatives.map((/** @type {any} */ x) => [x.name, x.extra.greeting_id, x.force_avatar]), [
            ['Ann', 0, '/thumbnail?type=avatar&file=ann.png'], ['Ann', 1, '/thumbnail?type=avatar&file=ann.png'],
            ['Bo', 0, '/thumbnail?type=avatar&file=bo.png'], ['Bo', 4, '/thumbnail?type=avatar&file=bo.png'],
        ]);
        assert.equal(await shown(), 'Ann 1', 'a new chat shows its first member\'s default');
        assert.deepEqual(await chats.endOwner({ tree: t, actor: a }), { tree: ann.id, greeting: 1 }, 'text written answers the member\'s greeting');

        members = [bo.id, ann.id];
        assert.deepEqual((await listed()).all.map(x => x[1]), ['Bo 0', 'Bo 4', 'Ann 0', 'Ann 1'], 'members in their order');
        assert.equal(await shown(), 'Bo 0');
        await store.close();
    });

    test(`${kind}: a member's greeting stored is kept by its member in that greeting's group, and its card greeting is that opening`, async () => {
        const { store, chats, t, listed, store1, decodedOf } = await fresh(engine);
        const node = await store1(by(bo, 'Bo 4', { greeting_id: 4 }));
        const { stored, message } = await decodedOf(node);
        assert.equal(stored.speaker, bo.id, 'the opening records its member');
        assert.equal(message.original_avatar, 'bo.png');
        assert.equal(typeof message.extra.greeting_hash, 'number');
        assert.deepEqual((await store.chatRead('rootGroups', { tree: t })).map((/** @type {any} */ g) => g.group), [greetingGroup(t, bo.id, 4)]);
        const { all, shown } = await listed();
        assert.deepEqual(all, [['ann.png', 'Ann 0', false], ['ann.png', 'Ann 1', false], ['bo.png', 'Bo 0', false], ['bo.png', 'Bo 4', true]]);
        assert.equal(shown?.node_id, node, 'the session is at what it stored');
        assert.deepEqual(shown?.greeting, { id: 4, hash: message.extra.greeting_hash, avatar: 'bo.png' });

        const annSaid = await store1(by(ann, 'Bo 4'));
        assert.equal((await decodedOf(annSaid)).message.extra.greeting_hash, undefined, 'another member\'s opening with a greeting\'s text is not that greeting');
        const spaced = await store1(by(bo, 'Bo 0 ', { greeting_id: 0 }));
        assert.equal((await decodedOf(spaced)).message.extra.greeting_hash, undefined, 'only the exact text is the greeting');
        const user = await store1({ name: 'You', is_user: true, is_system: false, mes: 'Ann 0', extra: {} });
        assert.equal((await decodedOf(user)).message.extra.greeting_hash, undefined, 'a user\'s opening in a group is no member\'s greeting');
        assert.deepEqual((await listed()).all, [
            ['ann.png', 'Ann 0', false], ['ann.png', 'Ann 1', false],
            ['bo.png', 'Bo 0', false], ['bo.png', 'Bo 0 ', true], ['bo.png', 'Bo 4', true],
            ['ann.png', 'Bo 4', true], [null, 'Ann 0', true],
        ]);
        await chats.select({ tree: t, node_id: node, actor: a });
        const [session] = await store.chatRead('ids', { space: 1, keys: [a.session] });
        assert.equal(await chats.cardChoice(session, t), null);
        await store.close();
    });

    test(`${kind}: choosing a member's greeting shows it until that card's default changes, and one choice replaces another`, async () => {
        const { store, chats, t, shown } = await fresh(engine);
        await chats.chooseCardGreeting({ tree: t, greeting: { card: bo.id, id: 4 }, actor: a });
        const [session] = await store.chatRead('ids', { space: 1, keys: [a.session] });
        assert.deepEqual(await chats.cardChoice(session, t), { card: bo.id, id: 4, epoch: 0 });
        assert.equal(await shown(), 'Bo 4');
        assert.deepEqual(await chats.endOwner({ tree: t, actor: a }), { tree: bo.id, greeting: 4 });
        await chats.chooseCardGreeting({ tree: t, greeting: { card: ann.id, id: 0 }, actor: a });
        assert.equal(await shown(), 'Ann 0');
        assert.equal(await store.chatRead('openingChoice', { session, tree: t, card: bo.id }), null, 'the member\'s earlier choice is gone');
        await chats.chooseCardGreeting({ tree: t, greeting: { card: bo.id, id: 4 }, actor: a });
        models.set(bo.id, { ...models.get(bo.id), defaultEpoch: 1, defaultId: 4 });
        assert.equal(await shown(), 'Ann 1', 'a choice ends when its card\'s default changes');
        await chats.newChat({ tree: t, actor: a });
        assert.equal(await chats.cardChoice(session, t), null);
        await store.close();
    });

    test(`${kind}: editing a member's greeting not stored stores an opening by that member after it, the greeting staying offered`, async () => {
        const { store, chats, t, listed, decodedOf, edit } = await fresh(engine);
        const added = await chats.appendMessages({ tree: t, treeSpeaker: null, after: null, contents: [by(bo, 'Bo 0, edited', { greeting_id: 0 })], actor: a });
        const node = added.node_ids[0];
        assert.equal((await decodedOf(node)).stored.speaker, bo.id);
        assert.deepEqual((await listed()).all, [['ann.png', 'Ann 0', false], ['ann.png', 'Ann 1', false], ['bo.png', 'Bo 0', false], ['bo.png', 'Bo 0, edited', true], ['bo.png', 'Bo 4', false]]);

        const typed = await edit(node, 'Bo 4', false);
        assert.deepEqual(typed.refused.map((/** @type {any} */ r) => r.same), [{ greeting_id: 4, avatar: 'bo.png' }], 'typing through the member\'s other greeting is refused');
        assert.deepEqual((await edit(node, 'Ann 1')).shown, [], 'another member\'s greeting is another author\'s');
        assert.equal((await decodedOf(node)).message.mes, 'Ann 1');
        const done = await edit(node, 'Bo 4');
        assert.deepEqual(done.shown, []);
        assert.equal(done.applied, 1, 'the existing opening holds the matching greeting');
        assert.equal((await decodedOf(node)).message.mes, 'Bo 4');
        assert.deepEqual((await listed()).all, [['ann.png', 'Ann 0', false], ['ann.png', 'Ann 1', false], ['bo.png', 'Bo 0', false], ['bo.png', 'Bo 4', true]]);
        const [session] = await store.chatRead('ids', { space: 1, keys: [a.session] });
        assert.equal(await chats.cardChoice(session, t), null, 'the session stays on its stored opening');

        assert.deepEqual(await chats.showSameAlternative({ tree: t, treeSpeaker: null, after: null, content: by(bo, 'Bo 0', { greeting_id: 4 }), typing: true, actor: a }), { greeting_id: 0, avatar: 'bo.png' });
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: null, after: null, content: by(ann, 'Bo 0', { greeting_id: 0 }), typing: true, actor: a }), null);
        assert.equal(await chats.showSameAlternative({ tree: t, treeSpeaker: null, after: null, content: by(bo, 'Bo 0', { greeting_id: 0 }), typing: true, actor: a }), null, 'a greeting shown unedited is itself');
        await store.close();
    });

    test(`${kind}: members coming and going: the current members' card greetings are offered, and stored openings stay`, async () => {
        const { store, listed, store1 } = await fresh(engine);
        await store1(by(ann, 'Ann 0', { greeting_id: 0 }));
        await store1(by(ann, 'Ann 1, edited', { greeting_id: 1 }));
        members = [bo.id, cy.id];
        const { all } = await listed();
        assert.deepEqual(all, [
            ['bo.png', 'Bo 0', false], ['bo.png', 'Bo 4', false], ['cy.png', 'Cy 0', false],
            ['ann.png', 'Ann 0', true], ['ann.png', 'Ann 1, edited', true],
        ], 'a former member\'s stored openings come after the members\' greetings, by greeting');
        const { o } = await listed();
        assert.equal(o.alternatives[o.default_index].mes, 'Ann 1, edited', 'the session stays where it was');
        members = [ann.id, bo.id, cy.id];
        assert.deepEqual((await listed()).all.map(x => x[1]), ['Ann 0', 'Ann 1', 'Ann 1, edited', 'Bo 0', 'Bo 4', 'Cy 0'], 'back as a member, its openings are with its greetings again');
        await store.close();
    });
}
