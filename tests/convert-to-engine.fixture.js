import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

/**
 * A user's data in today's formats, written through today's own write paths: varied cards (V1, V2, V3, odd dates,
 * lone surrogates, embedded books, lorebook links to present and missing books), tags with a pending merge and a
 * queued move, groups, chats with forks, labels, opening choices, metadata, itemizations and send keys, world books
 * in every format, and leftovers the conversion has to list (a deleted character's chats, a `.jsonl` file).
 */

/**
 * @param {string} root The user's directory (made here).
 * @param {object} [o]
 * @param {number} [o.extraCharacters] More plain characters, each with a short chat.
 * @returns {Promise<{ directories: any, names: Record<string, string> }>}
 */
export async function buildOldUser(root, { extraCharacters = 0 } = {}) {
    /** @type {any} */
    const directories = { root };
    for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) directories[k] = path.join(root, /** @type {string} */ (v));
    for (const d of ['characters', 'chats', 'groups', 'groupChats', 'worlds', 'backups']) fs.mkdirSync(directories[d], { recursive: true });
    const meta = await import('../src/character-metadata-db.js');
    const tree = await import('../src/message-tree-db.js');
    const { recordItemization } = await import('../src/itemization-store.js');

    const png = (/** @type {string} */ avatar, /** @type {number} */ n) => fs.writeFileSync(path.join(directories.characters, avatar), Buffer.from(`PNG-${n % 3}`));
    const card = (/** @type {string} */ avatar, /** @type {object} */ c, /** @type {number} */ n) => {
        png(avatar, n);
        return meta.upsertCharacterFromWrite(directories, avatar, JSON.stringify(c));
    };

    // ---- world books ----
    const entry = (/** @type {number} */ uid, /** @type {string} */ text) => ({ uid, key: ['k' + uid, 'shared'], keysecondary: [], comment: `c${uid}`, content: text, displayIndex: uid, extensions: { group: 'g' } });
    fs.writeFileSync(path.join(directories.worlds, 'Lore A.json'), JSON.stringify({ name: 'Lore A', entries: { 0: entry(0, 'alpha'), 7: entry(7, 'lone \ud800 surrogate') } }));
    fs.mkdirSync(path.join(directories.worlds, 'Lore V2.entries'));
    fs.writeFileSync(path.join(directories.worlds, 'Lore V2.entries', '3.abc.json'), JSON.stringify(entry(3, 'from a sidecar')));
    fs.writeFileSync(path.join(directories.worlds, 'Lore V2.json'), JSON.stringify({ name: 'Lore V2', format: 'sidecar-v2', entries: [{ uid: '3', file: '3.abc.json' }], extensions: { x: 1 } }));
    fs.mkdirSync(path.join(directories.worlds, 'Lore V1.entries'));
    fs.writeFileSync(path.join(directories.worlds, 'Lore V1.entries', '1.json'), JSON.stringify(entry(1, 'from the old sidecar')));
    fs.writeFileSync(path.join(directories.worlds, 'Lore V1.json'), JSON.stringify({ format: 'sidecar-v1', entries: [1], name: 'Lore V1' }));
    fs.writeFileSync(path.join(directories.worlds, 'Broken.json'), '{not json');

    // ---- characters ----
    const book = { name: 'own', entries: [{ id: 1, keys: ['a'], content: 'embedded', extensions: { group: 'x' } }, { id: 2, keys: [], content: 'second' }] };
    await card('Alice.png', { name: 'Alice', description: 'A traveller.', spec: 'chara_card_v2', spec_version: '2.0', fav: true, create_date: '2024-1-2 @03h04m05s678ms', data: { name: 'Alice', description: 'A traveller.', tags: ['fantasy'], alternate_greetings: ['Hi!', 'Hello there.'], extensions: { fav: true, world: 'Lore A', depth_prompt: { depth: 4 } }, character_book: book } }, 0);
    await card('Bob.png', { name: 'Bob', description: 'A V1 card.', first_mes: 'Bob here.', tags: 'a, b', create_date: 'garbage', creatorcomment: 'old' }, 1);
    await card('Cara.png', { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Cara \udc00', description: 'lone surrogate', first_mes: 'Greetings.', alternate_greetings: ['Second greeting.'], group_only_greetings: ['g'], extensions: { fav: false, world: 'Lore/Missing?' } } }, 2);
    await card('Gone.png', { name: 'Gone', first_mes: 'I will be deleted.' }, 3);
    for (let i = 0; i < extraCharacters; i++) await card(`extra-${i}.png`, { name: `Extra ${i}`, description: `filler ${i}`, first_mes: `Hi ${i}` }, i);
    await meta.setCharacterFav(directories, 'Bob.png', true);

    // ---- tags: definitions, assignments, a delete merging into another, a queued move with no pass ----
    await meta.createTagDefinition(directories, { id: 'tag-red', name: 'Red', color: '#f00', sort_order: 2 });
    await meta.createTagDefinition(directories, { id: 'tag-blue', name: 'Blue', folder_type: 'OPEN' });
    await meta.createTagDefinition(directories, { id: 'tag-old', name: 'Old' });
    for (const [who, tag] of [['Alice.png', 'tag-red'], ['Bob.png', 'tag-old'], ['Bob.png', 'tag-blue'], ['Cara.png', 'tag-old'], ['Alice.png', 'tag-undefined']]) {
        await meta.assignEntityTag(directories, who, tag);
    }
    await meta.deleteTagDefinition(directories, 'tag-old', 'tag-red');

    // ---- groups ----
    const groupId = '1700000000001';
    const group = { id: groupId, name: 'Party', members: ['Alice.png', 'Bob.png'], disabled_members: [], avatar_url: '', allow_self_responses: false, activation_strategy: 0, generation_mode: 0, chat_id: 'Party chat', chats: ['Party chat', 'Dropped empty', 'Dropped twin'], fav: true, past_metadata: {} };
    await meta.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify(group, null, 4)));
    await meta.assignEntityTag(directories, groupId, 'tag-blue');

    // ---- chats ----
    const msg = (/** @type {string} */ name, /** @type {boolean} */ isUser, /** @type {string} */ mes, /** @type {object} */ more = {}) => ({ name, is_user: isUser, is_system: false, send_date: '2024-05-01T10:00:00.000Z', mes, extra: {}, ...more });
    const header = (/** @type {object} */ chatMetadata) => ({ user_name: 'You', character_name: 'x', chat_metadata: chatMetadata });
    // Alice: a chat with swipes, metadata with variables and a lorebook, a fork, a checkpoint and an unnamed chat.
    const aliceChat = [
        header({ note_prompt: 'Be brief.', variables: { hp: 3 }, world_info: 'Lore A', integrity: 'old' }),
        msg('Alice', false, 'Hi!', { original_avatar: 'Alice.png' }),
        msg('You', true, 'Hello.', { extra: { token_count: 3 } }),
        { ...msg('Alice', false, 'How are you?'), swipes: ['How are you?', 'What brings you?'], swipe_id: 1, swipe_info: [{}, {}] },
        msg('You', true, 'Fine \ud800 thanks.'),
    ];
    const aliceOwner = 'Alice';
    const saved = await tree.saveChatToTree(directories, aliceOwner, 'Alice - 2024-05-01@10h00m00s', aliceChat);
    const ids = /** @type {any} */ (saved).assignedNodeIds.map((/** @type {any} */ a) => a.node_id);
    const sent = await tree.appendMessages(directories, aliceOwner, ids[ids.length - 1], [msg('Alice', false, 'Good to hear.'), msg('You', true, 'Bye.')], { sendKeys: [null, '0190a1b2-0000-7000-8000-0000000000aa'] });
    await tree.appendMessages(directories, aliceOwner, ids[2], [msg('You', true, 'Another way.')], { sendKeys: ['not-a-uuid'] });
    await tree.forkBranch(directories, aliceOwner, ids[1], 'Alice - 2024-05-01@10h00m00s - Branch #1', false, { note_prompt: 'Fork note.', variables: { hp: 1 } });
    await tree.labelNode(directories, sent.node_ids[0], 'Odd name', { ownerId: aliceOwner });
    await tree.labelNode(directories, ids[3], 'Odd name', { ownerId: aliceOwner });
    await tree.setNodeMetadata(directories, aliceOwner, sent.node_ids[0], { note_prompt: 'Deeper.', variables: { hp: 3, mp: 2 } });
    await tree.selectDefaultChild(directories, ids[2]);
    await recordItemization(directories, ids[2], { rawPrompt: 'the prompt', finalPrompt: 'x' });
    await tree.saveChatToTree(directories, aliceOwner, '', [header({ unnamed: true }), msg('Alice', false, 'Unnamed chat start.')]);
    await meta.setCharacterActiveChat(directories, 'Alice.png', 'Alice - 2024-05-01@10h00m00s');
    // The older of two replies chosen: a fork choice that isn't the newest reply.
    await tree.selectDefaultChild(directories, ids[3]);

    // Bob: a card greeting chosen with no row, a checkpoint, and old per-chat itemizations.
    await tree.saveChatToTree(directories, 'Bob', 'Bob - Checkpoint #1', [header({}), msg('Bob', false, 'Bob here.'), msg('You', true, 'Hi Bob.')]);
    await tree.chooseCardOpening(directories, 'Bob', 'Bob here.', 0);
    const itemizedDir = path.join(root, 'itemized prompts');
    fs.mkdirSync(itemizedDir, { recursive: true });
    fs.writeFileSync(path.join(itemizedDir, 'Bob - Checkpoint #1.json.zst'), zlib.zstdCompressSync(Buffer.from(JSON.stringify([{ mesId: 1, rawPrompt: 'old prompt' }, { mesId: 1, rawPrompt: 'later' }, { mesId: 9, rawPrompt: 'past the end' }]))));
    fs.writeFileSync(path.join(itemizedDir, 'nobody.json.zst'), zlib.zstdCompressSync(Buffer.from('[]')));

    // Gone: a chat, then its character is deleted (its rows stay).
    await tree.saveChatToTree(directories, 'Gone', 'Gone chat', [header({}), msg('Gone', false, 'I will be deleted.')]);
    await meta.deleteCharacterRow(directories, 'Gone.png');
    fs.rmSync(path.join(directories.characters, 'Gone.png'));

    // The group: a chat, and two chats listed with no label: one with only its header, one an exact duplicate.
    const groupChat = [header({ __is_group: true, note_prompt: 'Group note.' }), msg('Alice', false, 'Group hello.', { original_avatar: 'Alice.png', force_avatar: '/thumbnail?type=avatar&file=Alice.png' }), msg('You', true, 'Hey all.')];
    await tree.saveChatToTree(directories, groupId, 'Party chat', groupChat, true);
    fs.writeFileSync(path.join(directories.groupChats, 'Dropped empty.jsonl.pre-migration'), JSON.stringify(header({ note_prompt: 'Empty one.' })) + '\n');
    fs.writeFileSync(path.join(directories.groupChats, 'Dropped twin.jsonl.pre-migration'), groupChat.map(x => JSON.stringify(x)).join('\n') + '\n');

    for (let i = 0; i < extraCharacters; i++) {
        await tree.saveChatToTree(directories, `extra-${i}`, `Extra ${i} - 2024-01-01@00h00m00s`, [header({}), msg(`Extra ${i}`, false, `Hi ${i}`), msg('You', true, `Hello ${i}`)]);
    }

    // A chat file today's server doesn't read.
    fs.mkdirSync(path.join(directories.chats, 'Bob'), { recursive: true });
    fs.writeFileSync(path.join(directories.chats, 'Bob', 'leftover.jsonl'), JSON.stringify(header({})) + '\n');

    // A queued tag move with no reorder pass (the old server applied these at boot).
    meta.disposeMetadataStores();
    tree.disposeMessageTreeStores();
    const { getBetterSqlite3 } = await import('../src/endpoints/native-sqlite.js');
    const Database = await getBetterSqlite3();
    const db = new Database(path.join(root, 'character-metadata.sqlite'));
    db.prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id, value) VALUES (?, NULL, NULL, ?)').run('tag-blue', '0.5');
    db.close();
    return { directories, names: { groupId, aliceOwner } };
}
