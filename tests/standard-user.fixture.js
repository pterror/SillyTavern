import fs from 'node:fs';
import path from 'node:path';

/**
 * The standard test user, written into a store through the app's own write paths: varied cards (V1, V2, V3, odd
 * dates, lone surrogates, an embedded book, lorebook links to present and missing books), tags with a merge and a key
 * no definition has, groups, world books, and chats with swipes, forks, bookmarks (a repeated label, a pinned
 * checkpoint, one at a tree's root), metadata and variables, a lorebook link in metadata, an itemization, a send key
 * and a chosen card greeting.
 */

/** The card PNG of a character: its image bytes (card reads take the card from the store). */
const png = (/** @type {number} */ n) => Buffer.from(`PNG-${n % 3}`);

/**
 * @param {number} uid
 * @param {string} text
 */
const entry = (uid, text) => ({ uid, key: ['k' + uid, 'shared'], keysecondary: [], comment: `c${uid}`, content: text, displayIndex: uid, extensions: { group: 'g' } });

/**
 * @param {string} name
 * @param {boolean} isUser
 * @param {string} mes
 * @param {object} [more]
 */
const msg = (name, isUser, mes, more = {}) => ({ name, is_user: isUser, is_system: false, send_date: '2024-05-01T10:00:00.000Z', mes, extra: {}, ...more });

/**
 * Writes the standard user into an empty store.
 * @param {{ directories: any, store: import('../src/user-stores.js').UserStore, handle?: string }} user `handle`: the
 * user whose sessions hold the chats' places (default `u`).
 */
export async function buildStandardUser({ directories, store, handle = 'u' }) {
    const { lib, chats } = store;
    const { defaultSessionKey, MODE } = await import('../src/chat-engine.js');

    // ---- world books ----
    await lib.books.write('Lore A', { name: 'Lore A', entries: { 0: entry(0, 'alpha'), 7: entry(7, 'lone \ud800 surrogate') } });
    await lib.books.write('Lore V2', { name: 'Lore V2', entries: { 3: entry(3, 'from a sidecar') }, extensions: { x: 1 } });
    await lib.books.write('Lore V1', { name: 'Lore V1', entries: { 1: entry(1, 'from the old sidecar') } });

    // ---- characters ----
    const card = async (/** @type {string} */ avatar, /** @type {object} */ c, /** @type {number} */ n) => {
        fs.writeFileSync(path.join(directories.characters, avatar), png(n));
        await lib.writeCard(directories, avatar, JSON.stringify(c));
    };
    const book = { name: 'own', entries: [{ id: 1, keys: ['a'], content: 'embedded', extensions: { group: 'x' } }, { id: 2, keys: [], content: 'second' }] };
    await card('Alice.png', { name: 'Alice', description: 'A traveller.', spec: 'chara_card_v2', spec_version: '2.0', fav: true, create_date: '2024-1-2 @03h04m05s678ms', data: { name: 'Alice', description: 'A traveller.', tags: ['fantasy'], alternate_greetings: ['Hi!', 'Hello there.'], extensions: { fav: true, world: 'Lore A', depth_prompt: { depth: 4 } }, character_book: book } }, 0);
    await card('Bob.png', { name: 'Bob', description: 'A V1 card.', first_mes: 'Bob here.', tags: 'a, b', create_date: 'garbage', creatorcomment: 'old' }, 1);
    await card('Cara.png', { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Cara \udc00', description: 'lone surrogate', first_mes: 'Greetings.', alternate_greetings: ['Second greeting.'], group_only_greetings: ['g'], extensions: { fav: false, world: 'Lore/Missing?' } } }, 2);
    await lib.setFav(0, 'Bob.png', true);
    // Each card's file recorded as converted, as in a converted store: a rescan leaves it.
    const { convertedFileKey } = await import('../src/library-codes.js');
    for (const avatar of ['Alice.png', 'Bob.png', 'Cara.png']) {
        const st = fs.statSync(path.join(directories.characters, avatar));
        await lib.store.commit([{ kind: 'metaValue', key: convertedFileKey(avatar), json: JSON.stringify([st.size, st.mtimeMs]) }]);
    }

    // ---- groups ----
    const groupId = '1700000000001';
    await lib.writeGroup({ id: groupId, name: 'Party', members: ['Alice.png', 'Bob.png'], disabled_members: [], avatar_url: '', allow_self_responses: false, activation_strategy: 0, generation_mode: 0, chat_id: 'Party chat', chats: ['Party chat', 'Dropped empty', 'Dropped twin'], fav: true, past_metadata: {} });
    const damagedId = '1700000000002';
    await lib.writeGroup({ id: damagedId, name: 'Damaged', members: ['Alice.png'], chats: ['c1'], chat_id: 'c1' });

    // ---- tags: definitions, assignments, one deleted into another, a key no definition has ----
    await lib.tags.create({ id: 'tag-red', name: 'Red', color: '#f00', sort_order: 2 });
    await lib.tags.create({ id: 'tag-blue', name: 'Blue', folder_type: 'OPEN', sort_order: 0.5 });
    await lib.tags.create({ id: 'tag-old', name: 'Old' });
    for (const [who, tag] of [['Alice.png', 'tag-red'], ['Bob.png', 'tag-old'], ['Bob.png', 'tag-blue'], ['Cara.png', 'tag-old'], ['Alice.png', 'tag-undefined'], [groupId, 'tag-blue']]) {
        await lib.tags.assign(who, tag);
    }
    await lib.tags.delete('tag-old', 'tag-red');

    // ---- chats ----
    const header = (/** @type {object} */ chatMetadata) => ({ user_name: 'You', character_name: 'x', chat_metadata: chatMetadata });
    /** @param {{ avatar?: string, group?: string }} owner */
    const treeOf = async owner => {
        const [tree] = await store.people.trees([owner]);
        const treeSpeaker = owner.avatar ? (await store.people.byAvatar([owner.avatar])).get(owner.avatar) ?? null : null;
        const session = defaultSessionKey(handle, tree);
        return { tree, treeSpeaker, actor: { user: handle, session } };
    };
    const ok = (/** @type {any} */ r) => {
        if (r && r.ok === false) throw new Error(`buildStandardUser: ${r.reason}`);
        return r;
    };
    /**
     * A chat (`[header, ...messages]`) stored from the tree's root as the session's conversation, the session at its
     * end: each message's node in `assigned_node_ids`.
     * @param {{ tree: bigint, treeSpeaker: any, actor: { user: string, session: string } }} who
     * @param {any[]} chat
     */
    const storeConversation = async (who, chat) => {
        const imported = ok(await chats.importChat({ ...who, name: null, messages: chat.slice(1), metadata: chat[0]?.chat_metadata, bookmark: false }));
        ok(await chats.goTo({ ...who, node_id: imported.node_ids[imported.node_ids.length - 1] ?? null }));
        return { assigned_node_ids: imported.node_ids.map((/** @type {string} */ node_id, /** @type {number} */ index) => ({ index, node_id })) };
    };

    // Alice: a chat with swipes, metadata with variables and a lorebook, a fork, two bookmarks sharing a label, an
    // itemization, a send key and a chat with no name.
    const alice = await treeOf({ avatar: 'Alice.png' });
    const saved = await storeConversation(alice, [
        header({}),
        msg('Alice', false, 'Hi!', { original_avatar: 'Alice.png' }),
        msg('You', true, 'Hello.', { extra: { token_count: 3 } }),
        { ...msg('Alice', false, 'How are you?'), swipes: ['How are you?', 'What brings you?'], swipe_id: 1, swipe_info: [{}, {}] },
        msg('You', true, 'Fine \ud800 thanks.'),
    ]);
    const ids = saved.assigned_node_ids.map((/** @type {any} */ a) => a.node_id);
    ok(await chats.mergeMetadata({ ...alice, at: ids[0], set: { note_prompt: 'Be brief.', world_info: 'Lore A' }, unset: [], variables: { set: { hp: 3 } } }));
    const sent = ok(await chats.appendMessages({ ...alice, after: ids[3], contents: [msg('Alice', false, 'Good to hear.'), msg('You', true, 'Bye.')], sendKeys: [null, '0190a1b2-0000-7000-8000-0000000000aa'] })).node_ids;
    ok(await chats.appendMessages({ ...alice, after: ids[2], contents: [msg('You', true, 'Another way.')] }));
    ok(await chats.mergeMetadata({ ...alice, at: ids[1], set: { note_prompt: 'Fork note.' }, unset: ['world_info'], variables: { set: { hp: 1 } } }));
    ok(await chats.mergeMetadata({ ...alice, at: sent[0], set: { note_prompt: 'Deeper.' }, unset: ['world_info'], variables: { set: { hp: 3, mp: 2 } } }));
    await chats.recordItemization({ node_id: ids[2], entry: { rawPrompt: 'the prompt', finalPrompt: 'x' } });
    const [start] = ok(await chats.addOpenings({ ...alice, contents: [msg('Alice', false, 'Unnamed chat start.')] })).node_ids;
    ok(await chats.mergeMetadata({ ...alice, at: start, set: { unnamed: true }, unset: [] }));
    ok(await chats.select({ ...alice, node_id: ids[3] }));
    ok(await chats.goTo({ ...alice, node_id: sent[1] }));
    for (const name of ['Alice - 2024-05-01@10h00m00s', 'Alice - 2024-05-01@10h00m00s - Branch #1', 'Odd name', 'Odd name']) {
        ok(await chats.createBookmark({ ...alice, node_id: sent[1], name }));
    }

    // Bob: a checkpoint, and his card greeting chosen.
    const bob = await treeOf({ avatar: 'Bob.png' });
    const bobChat = await storeConversation(bob, [header({}), msg('Bob', false, 'Bob here.'), msg('You', true, 'Hi Bob.')]);
    const bobEnd = bobChat.assigned_node_ids[bobChat.assigned_node_ids.length - 1].node_id;
    ok(await chats.createBookmark({ ...bob, node_id: bobEnd, name: 'Bob - Checkpoint #1', mode: MODE.pinned }));
    ok(await chats.chooseCardGreeting({ ...bob, index: 0 }));

    // The group: a chat, a second bookmark where it ends, and one at the root.
    const party = await treeOf({ group: groupId });
    const partyChat = await storeConversation(party, [
        header({}),
        msg('Alice', false, 'Group hello.', { original_avatar: 'Alice.png', force_avatar: '/thumbnail?type=avatar&file=Alice.png' }),
        msg('You', true, 'Hey all.'),
    ]);
    ok(await chats.mergeMetadata({ ...party, at: partyChat.assigned_node_ids[0].node_id, set: { note_prompt: 'Group note.' }, unset: [] }));
    const partyEnd = partyChat.assigned_node_ids[partyChat.assigned_node_ids.length - 1].node_id;
    ok(await chats.createBookmark({ ...party, node_id: null, name: 'Dropped empty' }));
    ok(await chats.mergeMetadata({ ...party, at: null, set: { note_prompt: 'Empty one.' }, unset: [] }));
    ok(await chats.createBookmark({ ...party, node_id: partyEnd, name: 'Party chat' }));
    ok(await chats.createBookmark({ ...party, node_id: partyEnd, name: 'Dropped twin' }));

    // A second group: a greeting, then a chat with swipes whose first message is another greeting.
    const damaged = await treeOf({ group: damagedId });
    ok(await chats.addOpenings({ ...damaged, contents: [{ name: 'Alice', is_user: false, mes: 'm2b', send_date: 'd2', extra: {} }] }));
    const c1 = await storeConversation(damaged, [
        header({}),
        { name: 'Alice', is_user: false, mes: 'm1b', send_date: 'd1', extra: {}, swipes: ['m1a', 'm1b'], swipe_id: 1 },
        { name: 'Alice', is_user: false, mes: 'm2a', send_date: 'd2', extra: {}, swipes: ['m2a', 'm2b'], swipe_id: 0 },
        { name: 'You', is_user: true, mes: 'm3', send_date: 'd3', extra: {}, swipes: ['m3'], swipe_id: 0 },
    ]);
    ok(await chats.createBookmark({ ...damaged, node_id: c1.assigned_node_ids[c1.assigned_node_ids.length - 1].node_id, name: 'c1' }));
}

