import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

/**
 * @param {string} prefix
 * @returns {Promise<Awaited<ReturnType<typeof emptyUser>>>}
 */
export async function convertedUser(prefix) {
    const user = await emptyUser(prefix);
    await (await import('./standard-user.fixture.js')).buildStandardUser(user);
    return user;
}

/**
 * @param {string} prefix
 * @param {typeof import('../src/user-stores.js')} [stores]
 * @returns {Promise<{ dataRoot: string, root: string, directories: any, user: { directories: any, profile: { handle: string } }, store: import('../src/user-stores.js').UserStore, close: () => Promise<void> }>}
 */
export async function emptyUser(prefix, stores) {
    const engine = (await import('../engine/load.js')).loadEngine().binding;
    stores ??= await import('../src/user-stores.js');
    stores.setStoreEngine(() => engine);
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const root = path.join(dataRoot, 'u');
    /** @type {any} */
    const directories = { root };
    for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) directories[k] = path.join(root, /** @type {string} */ (v));
    for (const d of Object.values(directories)) fs.mkdirSync(d, { recursive: true });
    const store = await stores.userStore(directories, 'u');
    return {
        dataRoot, root, directories, store,
        user: { directories, profile: { handle: 'u' } },
        close: async () => {
            await stores.closeUserStores();
            fs.rmSync(dataRoot, { recursive: true, force: true });
        },
    };
}

/**
 * @param {{ directories: any, store: import('../src/user-stores.js').UserStore }} user
 * @param {string} avatar
 * @param {string} cardJson
 * @param {Buffer} png
 */
export async function writeLibraryCard({ directories, store }, avatar, cardJson, png) {
    fs.writeFileSync(path.join(directories.characters, avatar), png);
    await store.lib.writeCard(directories, avatar, cardJson);
}

/**
 * @param {{ directories: any, store: import('../src/user-stores.js').UserStore }} user
 * @param {string} avatar
 * @param {string} cardJson
 * @param {Buffer} png
 */
export async function writeCardWithImage({ directories, store }, avatar, cardJson, png) {
    const { avatarImage, writeWithAvatar } = await import('../src/character-avatars.js');
    const stored = avatarImage(png);
    return writeWithAvatar(store.lib, directories, avatar, stored, () => store.lib.writeCard(directories, avatar, cardJson, {
        avatarIdentityHash: stored.avatarIdentityHash,
    }));
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 */
export async function treeOf(store, owner) {
    const [tree] = await store.people.trees([owner]);
    if (tree === null || tree === undefined) throw new Error('no such tree');
    return tree;
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string | null} after
 * @param {Record<string, any>[]} contents
 * @param {{ session?: string }} [o]
 * @returns {Promise<string[]>}
 */
export async function seedMessages(store, owner, after, contents, { session } = {}) {
    const tree = await treeOf(store, owner);
    const treeSpeaker = owner.avatar ? (await store.people.byAvatar([owner.avatar])).get(owner.avatar) ?? null : null;
    const { newSessionKey } = await import('../src/chat-engine.js');
    const made = await store.chats.appendMessages({ tree, treeSpeaker, after, contents, actor: { user: 'u', session: session ?? newSessionKey() } });
    if (!made.ok) throw new Error(made.reason);
    return made.node_ids;
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} session
 * @returns {Promise<import('../src/chat-request.js').ChatContext>}
 */
export async function chatContextOf(store, owner, session) {
    const { RequestSession } = await import('../src/request-session.js');
    const tree = await treeOf(store, owner);
    const treeSpeaker = owner.avatar ? (await store.people.byAvatar([owner.avatar])).get(owner.avatar) ?? null : null;
    return { store, tree, treeSpeaker, session: new RequestSession(session, 'u', { session, identifier: session }) };
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} session
 * @returns {Promise<Record<string, any>[]>}
 */
export async function sessionPath(store, owner, session) {
    const tree = await treeOf(store, owner);
    const p = await store.chats.pointer(session);
    if (!p || p.tree !== tree) return [];
    return (await store.chats.load({ tree, at: p.at }))?.messages ?? [];
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} nodeId
 * @returns {Promise<{ node_id: string, mes: unknown }[]>}
 */
export async function repliesOf(store, owner, nodeId) {
    const tree = await treeOf(store, owner);
    const [id] = await store.chats.messageIds([nodeId]);
    if (id === null) return [];
    const { ids } = await store.chats.store.chatRead('children', { tree, parent: id, limit: 500 });
    const out = [];
    for (const external of await store.chats.externalIds(ids)) {
        if (external === null) continue;
        const shown = await store.chats.load({ tree, at: external });
        out.push({ node_id: external, mes: shown?.messages[shown.messages.length - 1]?.mes });
    }
    return out;
}

const branches = new WeakMap();

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @returns {Map<string, string>}
 */
function branchesOf(store) {
    let m = branches.get(store);
    if (!m) branches.set(store, m = new Map());
    return m;
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} name
 * @param {Record<string, any>[]} chat
 */
export async function saveBranch(store, owner, name, chat) {
    const [header, ...messages] = chat;
    if (header?.chat_metadata && Object.keys(header.chat_metadata).length > 0) throw new Error('saveBranch: header metadata is not seeded');
    const { newSessionKey } = await import('../src/chat-engine.js');
    const session = newSessionKey();
    await seedMessages(store, owner, null, messages, { session });
    if (await store.chats.sessionNamed(name) === null) {
        const named = await store.chats.nameSession({ session, name, actor: { user: 'u', session } });
        if (!named.ok || named.name !== name) throw new Error(`saveBranch: couldn't name the branch ${name}`);
    }
    const m = branchesOf(store);
    const key = JSON.stringify([owner, name]);
    m.delete(key);
    m.set(key, session);
    return session;
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} name
 */
export async function loadBranch(store, owner, name) {
    const session = branchesOf(store).get(JSON.stringify([owner, name]));
    if (!session) throw new Error(`loadBranch: no branch ${name}`);
    const messages = await sessionPath(store, owner, session);
    return { branch: { leaf_id: messages.length ? messages[messages.length - 1].node_id : null, session }, messages };
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {unknown} nodeId
 * @returns {Promise<string | null>}
 */
export async function sessionAt(store, nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) return null;
    for (const [key, session] of [...branchesOf(store)].reverse()) {
        const [owner] = JSON.parse(key);
        if ((await sessionPath(store, owner, session)).some(m => m.node_id === nodeId)) return session;
    }
    return null;
}

/**
 * @param {import('../src/user-stores.js').UserStore} store
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} nodeId
 * @param {Record<string, any>} content
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function editMessage(store, owner, nodeId, content) {
    const { newSessionKey } = await import('../src/chat-engine.js');
    const tree = await treeOf(store, owner);
    const treeSpeaker = owner.avatar ? (await store.people.byAvatar([owner.avatar])).get(owner.avatar) ?? null : null;
    const session = (await sessionAt(store, nodeId)) ?? newSessionKey();
    const { refused } = await store.chats.editMessages({ tree, treeSpeaker, edits: [{ node_id: nodeId, content }], actor: { user: 'u', session } });
    return refused.length ? { ok: false, reason: refused[0].reason } : { ok: true };
}
