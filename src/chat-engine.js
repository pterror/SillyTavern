import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { textEdit } from './text-edit.js';
import { META, TOP, decodeMessage, encodeMessage, messageRecords } from './chat-codec.js';
import { resolveAvatars, withoutShownAvatar } from './avatar-refs.js';
import { ITEMIZED_PROMPT_FLAG } from './prompt-itemization.js';
import { jsonHash } from '../public/scripts/hash-utils.js';
import { bookKey } from './world-info-keys.js';
import { searchClauses } from './search-clauses.js';
import { SPACE, actorIds, idOf } from './actor-ids.js';
import { humanizedDateTime, humanizedTail } from '../public/scripts/humanized-date.js';

export { SPACE };


const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

export const SESSION_NAMESPACE = 'b3c3d5a0-6b5e-4f61-9d2e-5a0c1f7e9e21';

export const MODE = Object.freeze({ following: 1, pinned: 2 });

const DECIMAL = /^(0|[1-9][0-9]*)$/;

const ALTERNATIVE_WINDOW = 5;

/**
 * @param {number} count
 * @param {number} shown
 * @param {boolean} full
 * @returns {[number, number]}
 */
function alternativeWindow(count, shown, full) {
    if (full) return [0, count];
    const at = Math.max(0, shown);
    return [Math.max(0, at - ALTERNATIVE_WINDOW), Math.min(count, at + ALTERNATIVE_WINDOW + 1)];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} uuid
 * @returns {number | null}
 */
export function sessionTime(uuid) {
    if (!UUID.test(uuid) || uuid[14] !== '7') return null;
    return Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}

/**
 * @param {string} name
 * @param {(name: string) => Promise<boolean>} taken
 * @returns {Promise<string>}
 */
export async function freeName(name, taken) {
    if (!await taken(name)) return name;
    const tail = humanizedTail(name);
    for (let i = 1; ; i++) {
        const next = tail === null ? `${name} (${i + 1})` : `${tail.head}${humanizedDateTime(tail.time + i)}`;
        if (!await taken(next)) return next;
    }
}

/**
 * @param {{ group: boolean, name: string }} owner
 * @param {number} time
 */
export function chatNameAt(owner, time) {
    return owner.group ? humanizedDateTime(time) : `${owner.name} - ${humanizedDateTime(time)}`;
}

export const AUTHOR = Object.freeze({ user: 0, script: 1, model: 2, rule: 3, migration: 4 });
const VARIABLE = 8;
const PRODUCED = 16;

const DERIVED_METADATA = new Set(['integrity', 'main_chat', 'fork_point', '_tree_stored']);

const WORLD_INFO = 'world_info';
const LINK = '\u0001';

export function newSessionKey() {
    const b = crypto.randomBytes(16);
    const ms = BigInt(Date.now());
    for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * @param {string} namespace
 * @param {string} name
 */
export function uuidV5(namespace, name) {
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const h = hash.subarray(0, 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * @param {string} handle
 * @param {bigint} tree
 */
export function defaultSessionKey(handle, tree) {
    return uuidV5(SESSION_NAMESPACE, `${handle}\0${tree}`);
}

/**
 * @typedef {{ key: string, variable?: boolean, value?: unknown }} StateOp
 * @typedef {{ key: string, variable: boolean, json: string | null }} ProducedChange
 */

/**
 * @param {boolean} variable
 * @param {string} key
 */
function stateKey(variable, key) {
    return `${variable ? 'v' : 'k'}\u0000${key}`;
}

/**
 * @param {StateOp[] | null | undefined} ops
 * @param {Map<string, string>} state
 * @returns {ProducedChange[]}
 */
function producedChanges(ops, state) {
    /** @type {ProducedChange[]} */
    const out = [];
    for (const op of Array.isArray(ops) ? ops : []) {
        if (typeof op?.key !== 'string' || (!op.variable && DERIVED_METADATA.has(op.key))) continue;
        const variable = !!op.variable;
        const json = op.value === undefined ? undefined : JSON.stringify(op.value);
        const k = stateKey(variable, op.key);
        if (state.get(k) === json) continue;
        if (json === undefined) state.delete(k);
        else state.set(k, json);
        out.push({ key: op.key, variable, json: json ?? null });
    }
    return out;
}

/**
 * @param {Record<string, any>} now
 * @param {{ content?: unknown, patch?: unknown, unset?: unknown }} edit
 * @returns {Record<string, any> | null}
 */
function patchedContent(now, edit) {
    if (edit.content && typeof edit.content === 'object') return JSON.parse(JSON.stringify(edit.content));
    const patch = edit.patch && typeof edit.patch === 'object' && !Array.isArray(edit.patch) ? edit.patch : null;
    const unset = Array.isArray(edit.unset) ? edit.unset.filter(k => typeof k === 'string') : [];
    if (patch === null && unset.length === 0) return null;
    const inExtra = (/** @type {string} */ k) => k.startsWith('extra.') && k.length > 6;
    const next = { ...now };
    for (const [k, v] of Object.entries(patch ?? {})) if (!inExtra(k)) next[k] = v;
    for (const k of unset) if (!inExtra(k)) delete next[k];
    const extraKeys = [...Object.keys(patch ?? {}), ...unset].filter(inExtra);
    if (extraKeys.length) {
        const extra = next.extra && typeof next.extra === 'object' && !Array.isArray(next.extra) ? { ...next.extra } : {};
        for (const [k, v] of Object.entries(patch ?? {})) if (inExtra(k)) extra[k.slice(6)] = v;
        for (const k of unset) if (inExtra(k)) delete extra[k.slice(6)];
        next.extra = extra;
    }
    return storedForm(next);
}

/**
 * @param {Record<string, any>} m
 */
function identityOf(m) {
    const speaker = m?.is_user ? `u\u0001${m?.persona ?? m?.name ?? ''}` : `c\u0001${m?.name ?? ''}`;
    return `${speaker}\u0000${m?.mes ?? ''}`;
}

/**
 * @param {Record<string, any>} m
 */
function isToolTurn(m) {
    return Array.isArray(m?.extra?.tool_invocations);
}

/**
 * @param {Record<string, any>} msg
 * @returns {Record<string, any>}
 */
export function storedForm(msg) {
    const clone = { ...msg };
    for (const k of ['node_id', 'swipes', 'swipe_id', 'swipe_info', 'swipe_speaker_default']) delete clone[k];
    if (clone.extra && typeof clone.extra === 'object') {
        clone.extra = { ...clone.extra };
        for (const k of ['branches', 'bookmark_link', ITEMIZED_PROMPT_FLAG, 'token_count']) delete clone.extra[k];
    }
    return JSON.parse(JSON.stringify(clone));
}

/**
 * @param {Record<string, any>} msg
 * @returns {{ contents: Record<string, any>[], selected: number, nodeIds: (string | null)[] }}
 */
function alternativesOf(msg) {
    const rawSwipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    const single = { contents: [storedForm(msg)], selected: 0, nodeIds: [msg.node_id ?? null] };
    if (rawSwipes === null || rawSwipes.length === 0) return single;
    const rawSel = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    const rawInfo = Array.isArray(msg.swipe_info) ? msg.swipe_info : [];
    const kept = [];
    const slotId = (/** @type {any} */ info) => (info && typeof info === 'object' && info.node_id != null ? info.node_id : null);
    const claimedElsewhere = msg.node_id != null && rawInfo.some((info, i) => i !== rawSel && slotId(info) === msg.node_id);
    for (let i = 0; i < rawSwipes.length; i++) {
        if (typeof rawSwipes[i] !== 'string') continue;
        const info = rawInfo[i];
        kept.push({
            text: i === rawSel && typeof msg.mes === 'string' ? msg.mes : rawSwipes[i],
            info,
            wasSelected: i === rawSel,
            nodeId: slotId(info) ?? (i === rawSel && !claimedElsewhere ? msg.node_id ?? null : null),
        });
    }
    if (kept.length === 0) return single;
    const def = msg.swipe_speaker_default;
    const defName = def && def.name !== undefined ? def.name : msg.name;
    const defIsUser = def ? (def.is_user ?? false) : (msg.is_user ?? false);
    const contents = kept.map(({ text, info }) => {
        const alt = { ...msg, mes: text, name: defName, is_user: defIsUser };
        if (info && typeof info === 'object') {
            if (info.send_date !== undefined) alt.send_date = info.send_date;
            if (info.extra && typeof info.extra === 'object') alt.extra = { ...(msg.extra || {}), ...info.extra };
            if (info.gen_started !== undefined) alt.gen_started = info.gen_started;
            if (info.gen_finished !== undefined) alt.gen_finished = info.gen_finished;
            if (info.name !== undefined) alt.name = info.name;
            if (info.is_user !== undefined) alt.is_user = !!info.is_user;
        }
        return storedForm(alt);
    });
    const selected = Math.max(0, kept.findIndex(k => k.wasSelected));
    return { contents, selected, nodeIds: kept.map(k => k.nodeId) };
}

/**
 * @param {string} nodeId
 * @param {Record<string, any>} o
 * @param {boolean} itemized
 */
function alternativeEntry(nodeId, o, itemized) {
    /** @type {Record<string, any>} */
    const entry = { node_id: nodeId, mes: o?.mes ?? '', send_date: o?.send_date, extra: o?.extra ?? {}, name: o?.name, is_user: !!o?.is_user };
    if (itemized) entry.extra = { ...(entry.extra && typeof entry.extra === 'object' ? entry.extra : {}), [ITEMIZED_PROMPT_FLAG]: true };
    return entry;
}

/**
 * @typedef {import('./chat-codec.js').Speaker} Speaker
 * @typedef {object} People
 * @property {(ids: bigint[]) => Promise<Map<bigint, Speaker>>} speakers
 * @property {(avatars: string[]) => Promise<Map<string, Speaker>>} byAvatar
 * @property {(ids: bigint[]) => Promise<Map<bigint, { group: boolean, name: string, created: number }>>} owners
 * @property {Books} [books]
 */

/**
 * @typedef {object} Books
 * @property {<T>(keys: string[], fn: () => Promise<T>) => Promise<T>} lane
 * @property {(key: string) => Promise<bigint | null>} find
 * @property {() => bigint} newId
 * @property {(ids: bigint[]) => Promise<({ key: string | null } | null)[]>} resolved
 */

/**
 * @typedef {object} Actor
 * @property {string} user
 * @property {string | null} [session]
 */

/**
 * @typedef {object} EditRequest
 * @property {bigint} tree
 * @property {Actor} actor
 * @property {boolean} [preview]
 * @property {{ bookmarks?: string[], changes?: string[] } | 'any'} [confirm]
 */

/**
 * @typedef {{ bookmarks: { id: string, name: string | null, node_id: string }[], changes: { id: string, key: string | number, variable: boolean, node_id: string | null }[] }} Drops
 * @typedef {{ ok: true, preview?: true, drops?: Drops, copied?: Record<string, string> } | { ok: false, reason: string, drops?: Drops }} EditAnswer
 */

export class ChatEngine {
    /**
     * @param {any} store
     * @param {People} people
     * @param {import('./actor-ids.js').NextIds} next
     */
    constructor(store, people, next) {
        this.store = store;
        this.people = people;
        this.next = next;
        /** @type {Map<string, Promise<unknown>>} */
        this.writing = new Map();
        this.now = () => Date.now();
    }

    /**
     * @param {any} store
     * @param {People} people
     * @param {import('./actor-ids.js').NextIds} [next]
     */
    static async open(store, people, next) {
        return new ChatEngine(store, people, next ?? await store.chatRead('nextIds', {}));
    }

    /**
     * @template T
     * @param {bigint | string} tree
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    serialized(tree, write) {
        const id = String(tree);
        const before = this.writing.get(id) ?? Promise.resolve();
        const run = before.then(write, write);
        const settled = run.then(() => {}, () => {});
        this.writing.set(id, settled);
        settled.then(() => {
            if (this.writing.get(id) === settled) this.writing.delete(id);
        });
        return run;
    }


    /**
     * @param {string[]} externals
     * @returns {Promise<(bigint | null)[]>}
     */
    async messageIds(externals) {
        return this.store.chatRead('ids', { space: SPACE.message, keys: externals });
    }

    /**
     * @param {object[]} records
     * @param {bigint} id
     */
    keyNew(records, id) {
        records.push({ kind: 'keyMap', message: id, key: Buffer.from(newSessionKey(), 'utf8') });
    }

    /**
     * @param {{ id: bigint, oldKey: string | null }} stored
     */
    externalId(stored) {
        if (typeof stored.oldKey !== 'string') throw new Error(`Message ${stored.id} has no key`);
        return stored.oldKey;
    }

    /**
     * @param {number} space
     * @param {string} key
     * @param {'position' | 'user'} counter
     * @param {object[]} records
     */
    async idOf(space, key, counter, records) {
        return idOf(this.store, this.next, space, key, counter, records);
    }

    /**
     * @param {Actor} actor
     * @param {object[]} records
     */
    async actorIds(actor, records) {
        return actorIds(this.store, this.next, actor, records);
    }


    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.user
     * @param {string | null | undefined} p.header
     * @returns {Promise<{ session: string | null, identifier: string, gone?: true }>}
     */
    async resolveSession({ tree, user, header }) {
        if (header === undefined || header === null) {
            const [uid] = await this.store.chatRead('ids', { space: SPACE.user, keys: [user] });
            const last = uid === null ? null : await this.store.chatRead('userInTree', { user: uid, tree });
            if (last !== null && last.session !== null) {
                const [s] = await this.store.chatRead('sessions', { ids: [last.session] });
                if (s) return { session: s.key, identifier: s.key };
            }
            const v5 = defaultSessionKey(user, tree);
            return { session: v5, identifier: v5 };
        }
        if (header === 'none') return { session: null, identifier: defaultSessionKey(user, tree) };
        const [state] = await this.store.chatRead('keyStates', { space: SPACE.session, keys: [header] });
        if (state === 'gone') return { session: null, identifier: defaultSessionKey(user, tree), gone: true };
        return { session: header, identifier: header };
    }

    /**
     * @param {string | null | undefined} session
     * @param {bigint} tree
     * @returns {Promise<bigint | null>}
     */
    async currentChat(session, tree) {
        const sid = session ? await this.sessionId(session) : null;
        return sid === null ? null : await this.store.chatRead('currentChat', { session: sid, tree });
    }

    /**
     * @param {bigint} _tree
     * @param {(bigint | number | string)[]} bookmarks
     * @returns {Promise<Map<string, string>>}
     */
    async bookmarkChatIds(_tree, bookmarks) {
        const ids = [...new Set(bookmarks.map(b => BigInt(b)))];
        /** @type {Map<string, string>} */
        const out = new Map();
        if (ids.length === 0) return out;
        const rows = await this.store.chatRead('bookmarks', { ids });
        for (const [i, id] of ids.entries()) out.set(String(id), rows[i]?.name ?? '');
        return out;
    }

    /**
     * @param {bigint} tree
     * @param {bigint | number | string} bookmark
     * @returns {Promise<string>}
     */
    async bookmarkChatId(tree, bookmark) {
        return /** @type {string} */ ((await this.bookmarkChatIds(tree, [bookmark])).get(String(BigInt(bookmark))));
    }

    /**
     * @param {bigint} tree
     * @param {{ bookmark?: bigint | string | null, session?: string | null }[]} rows
     * @returns {Promise<string[]>}
     */
    async chatIdsOf(tree, rows) {
        const labels = await this.bookmarkChatIds(tree, rows.flatMap(r => (r.bookmark != null ? [r.bookmark] : [])));
        const out = [];
        for (const r of rows) {
            out.push(r.bookmark != null ? /** @type {string} */ (labels.get(String(BigInt(r.bookmark)))) : await this.conversationName(String(r.session), String(r.session), tree));
        }
        return out;
    }

    /**
     * @param {bigint} tree
     */
    async owner(tree) {
        const owner = (await this.people.owners([tree])).get(tree);
        if (!owner) throw new Error(`Tree ${tree} is no character's or group's`);
        return owner;
    }

    /**
     * @param {bigint} tree
     * @param {string} name
     * @param {{ bookmark: bigint } | { session: bigint } | null} [except]
     */
    async nameTaken(tree, name, except = null) {
        const group = (await this.owner(tree)).group;
        const rows = (await this.store.chatRead('chatsNamed', { name, limit: 64 })).filter((/** @type {any} */ r) => !(except !== null && ('bookmark' in except ? r.bookmark === except.bookmark : r.session === except.session)));
        if (!group) return rows.some((/** @type {any} */ r) => r.tree === tree);
        const owners = await this.people.owners([...new Set(rows.map((/** @type {any} */ r) => r.tree))]);
        return rows.some((/** @type {any} */ r) => owners.get(r.tree)?.group === true);
    }

    /**
     * @param {string | null | undefined} session
     * @param {string} identifier
     * @param {bigint} tree
     */
    async conversationName(session, identifier, tree) {
        const sid = session ? await this.sessionId(session) : null;
        if (sid !== null) {
            const stored = await this.store.chatRead('conversationName', { session: sid, tree });
            if (stored !== null) return /** @type {string} */ (stored);
        }
        const owner = await this.owner(tree);
        const base = chatNameAt(owner, sessionTime(identifier) ?? owner.created);
        return freeName(base, name => this.nameTaken(tree, name, sid === null ? null : { session: sid }));
    }

    /**
     * @param {object[]} records
     * @param {bigint} tree
     * @param {Actor} actor
     * @param {{ user: bigint, session: bigint | null }} ids
     */
    async claimConversation(records, tree, actor, ids) {
        if (ids.session === null || !actor.session || !records.some(r => /** @type {any} */ (r).kind !== 'keyMap')) return;
        if (await this.store.chatRead('currentChat', { session: ids.session, tree }) !== null) return;
        if (await this.store.chatRead('conversationName', { session: ids.session, tree }) !== null) return;
        const name = await this.conversationName(actor.session, actor.session, tree);
        records.push({ kind: 'conversationName', session: ids.session, user: ids.user, tree, name });
    }

    /**
     * @param {string | null | undefined} session
     * @param {string} identifier
     * @param {bigint} tree
     */
    async compatChatId(session, identifier, tree) {
        const current = await this.currentChat(session, tree);
        return current === null ? this.conversationName(session, identifier, tree) : this.bookmarkChatId(tree, current);
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {bigint | string | null} p.bookmark
     * @param {Actor} p.actor
     */
    setCurrentChat({ tree, bookmark, actor }) {
        return this.serialized(tree, async () => {
            const b = bookmark === null ? null : BigInt(bookmark);
            const known = await this.knownActorIds(actor);
            const now = known.session === null ? null : await this.store.chatRead('currentChat', { session: known.session, tree });
            if (now === b) return { ok: true };
            /** @type {object[]} */
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A current chat is a session\'s');
            records.push({ kind: 'currentChat', session, user, tree, ...(b === null ? {} : { bookmark: b }) });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @param {string} p.user
     * @returns {Promise<{ ok: true } | { ok: false, reason: 'unknown node' }>}
     */
    rememberUserPosition({ tree, at, user }) {
        return this.serialized(tree, async () => {
            /** @type {object[]} */
            const records = [];
            const uid = await this.idOf(SPACE.user, user, 'user', records);
            const m = at === null ? null : await this.messageOf(tree, at);
            if (at !== null && !m) return { ok: false, reason: 'unknown node' };
            records.push({ kind: 'userPosition', user: uid, tree, ...(m ? { at: m.id } : {}) });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * @param {string} session
     */
    async pointer(session) {
        const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [session] });
        if (sid === null) return null;
        const [s] = await this.store.chatRead('sessions', { ids: [sid] });
        if (!s || s.tree === null) return null;
        return { tree: s.tree, at: s.at === null ? null : (await this.externalIds([s.at]))[0] };
    }

    /**
     * @param {string} session
     * @returns {Promise<{ length: number, cursor: number } | null>}
     */
    async sessionPlace(session) {
        const sid = await this.sessionId(session);
        if (sid === null) return null;
        const [s] = await this.store.chatRead('sessions', { ids: [sid] });
        return s ? { length: s.length, cursor: s.cursor ?? 0 } : null;
    }

    /**
     * @param {string} session
     * @returns {AsyncGenerator<{ tree: bigint, bookmark: string }[]>}
     */
    async* currentChats(session) {
        const sid = await this.sessionId(session);
        if (sid === null) return;
        const limit = 256;
        /** @type {bigint | undefined} */
        let after;
        for (;;) {
            const page = await this.store.chatRead('currentChats', { session: sid, limit, ...(after === undefined ? {} : { after }) });
            const live = page.filter((/** @type {any} */ c) => c.bookmark !== null).map((/** @type {any} */ c) => ({ tree: c.tree, bookmark: String(c.bookmark) }));
            if (live.length) yield live;
            if (page.length < limit) return;
            after = page[page.length - 1].tree;
        }
    }

    /**
     * @param {object} p
     * @param {string} p.from
     * @param {number} p.length
     * @param {number} p.cursor
     * @param {{ tree: bigint, bookmark: string }[]} p.chats
     * @param {string} p.user
     * @returns {Promise<{ ok: true, session: string } | { ok: false, reason: string }>}
     */
    forkSession({ from, length, cursor, chats, user }) {
        const session = newSessionKey();
        return this.serialized(`session:${from}`, async () => {
            const [state] = await this.store.chatRead('keyStates', { space: SPACE.session, keys: [from] });
            if (state === null || state === 'gone') return { ok: false, reason: 'unknown session' };
            const records = [];
            const ids = await this.actorIds({ user, session }, records);
            const sid = /** @type {bigint} */ (ids.session);
            if (length > 0) records.push({ kind: 'sessionFork', session: sid, from: state.id, user: ids.user, length, cursor, time: this.now() });
            for (const { tree, bookmark } of chats) {
                if (await this.bookmarkOf(tree, bookmark)) records.push({ kind: 'currentChat', session: sid, user: ids.user, tree, bookmark: BigInt(bookmark) });
            }
            await this.store.commit(records);
            return { ok: true, session };
        });
    }

    /**
     * @param {bigint} from
     * @param {string} user
     * @returns {Promise<string>}
     */
    async sessionAt(from, user) {
        const session = newSessionKey();
        const [s] = await this.store.chatRead('sessions', { ids: [from] });
        if (!s || s.tree === null) return session;
        return this.serialized(s.tree, async () => {
            const records = [];
            const ids = await this.actorIds({ user, session }, records);
            const [now] = await this.store.chatRead('sessions', { ids: [from] });
            if (!now || now.tree === null) return session;
            records.push(now.at === null
                ? { kind: 'pointerRoot', session: ids.session, user: ids.user, tree: now.tree, time: this.now() }
                : { kind: 'pointerMove', session: ids.session, user: ids.user, target: now.at });
            await this.store.commit(records);
            return session;
        });
    }

    /**
     * @param {object} p
     * @param {bigint} [p.before]
     * @param {number} p.limit
     */
    async recentSessionKeys({ before, limit }) {
        const page = await this.store.chatRead('recent', { limit, ...(before === undefined ? {} : { before }) });
        const rows = page.length ? await this.store.chatRead('sessions', { ids: page.map((/** @type {any} */ e) => e.session) }) : [];
        return page.map((/** @type {any} */ e, /** @type {number} */ i) => ({ position: e.position, id: e.session, session: rows[i]?.key ?? null }));
    }

    /**
     * @param {string} name
     * @returns {Promise<string | null>}
     */
    async sessionNamed(name) {
        const ids = await this.store.chatRead('sessionsNamed', { name });
        if (ids.length !== 1) return null;
        const [row] = await this.store.chatRead('sessions', { ids: [ids[0]] });
        return row?.key ?? null;
    }


    /**
     * @param {bigint[]} ids
     * @returns {Promise<Map<bigint, any>>}
     */
    async stored(ids) {
        const unique = [...new Set(ids)];
        const found = unique.length ? await this.store.chatRead('messages', { ids: unique }) : [];
        return new Map(found.filter(Boolean).map(m => [m.id, m]));
    }

    /**
     * @param {any[]} stored
     * @returns {Promise<Record<string, any>[]>}
     */
    async decoded(stored) {
        const speakerIds = new Set();
        for (const s of stored) {
            if (s.speaker !== null) speakerIds.add(s.speaker);
            const over = s.values.find(v => v.field === META.speaker);
            const overId = over ? JSON.parse(over.json) : null;
            if (overId !== null) speakerIds.add(BigInt(overId));
        }
        const speakers = speakerIds.size ? await this.people.speakers([...speakerIds]) : new Map();
        const messages = stored.map(s => JSON.parse(decodeMessage(s, id => speakers.get(id) ?? null)));
        return resolveAvatars(this.store, messages);
    }

    /**
     * @param {Record<string, any>} content
     * @param {number} time
     * @param {Speaker | null} speaker
     */
    encoded(content, time, speaker) {
        return encodeMessage(withoutShownAvatar(content), time, speaker);
    }

    /**
     * @param {bigint} tree
     * @param {bigint | null} parent
     * @returns {Promise<bigint[]>}
     */
    async children(tree, parent) {
        const out = [];
        let after;
        for (;;) {
            const page = await this.store.chatRead('children', { tree, ...(parent === null ? {} : { parent }), ...(after === undefined ? {} : { after }), limit: 500 });
            out.push(...page.ids);
            if (!page.more) return out;
            after = page.ids[page.ids.length - 1];
        }
    }

    /**
     * @param {Record<string, any>} content
     * @param {Speaker | null} treeSpeaker
     */
    async speakerFor(content, treeSpeaker) {
        if (content?.is_user === true) return null;
        if (typeof content?.original_avatar === 'string') {
            const found = await this.people.byAvatar([content.original_avatar]);
            const s = found.get(content.original_avatar);
            if (s) return s;
        }
        return treeSpeaker;
    }

    /**
     * @param {Actor} actor
     * @returns {Promise<{ user: bigint | null, session: bigint | null }>}
     */
    async knownActorIds(actor) {
        const [user] = await this.store.chatRead('ids', { space: SPACE.user, keys: [actor.user] });
        const [session] = actor.session ? await this.store.chatRead('ids', { space: SPACE.session, keys: [actor.session] }) : [null];
        return { user, session };
    }


    /**
     * @param {object} p
     * @param {string} p.node_id
     * @param {number} [p.offset]
     * @param {number} [p.limit]
     * @returns {Promise<{ selected: number, total: number, alternatives: Record<string, any>[] } | null>}
     */
    async alternatives({ node_id, offset, limit }) {
        const [id] = await this.messageIds([node_id]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        if (!s) return null;
        const siblings = await this.children(s.owner, s.parent);
        const selected = siblings.indexOf(/** @type {bigint} */ (id));
        const from = Math.max(0, offset ?? 0);
        const to = limit !== undefined ? from + limit : siblings.length;
        const window = siblings.slice(from, to);
        const stored = await this.stored(window);
        const decoded = await this.decoded(window.map(x => stored.get(x)));
        const alternatives = window.map((x, i) => alternativeEntry(this.externalId(stored.get(x)), decoded[i], !!stored.get(x).itemized));
        return { selected: selected < 0 ? 0 : selected, total: siblings.length, alternatives };
    }

    /**
     * @param {bigint} tree
     */
    async openings(tree) {
        const ids = await this.children(tree, null);
        const stored = await this.stored(ids);
        const decoded = await this.decoded(ids.map(id => stored.get(id)));
        return ids.map((id, i) => ({ id, stored: stored.get(id), message: decoded[i] }));
    }

    /**
     * @param {{ message: Record<string, any> }[]} rows
     * @param {Record<string, any>[]} cardGreetings
     */
    unstoredGreetings(rows, cardGreetings) {
        const shownIdentity = (/** @type {Record<string, any>} */ m) => identityOf({ ...m, mes: typeof m?.mes === 'string' ? m.mes.trim() : m?.mes });
        const seen = new Set(rows.map(r => shownIdentity(r.message)));
        const out = [];
        for (const greeting of Array.isArray(cardGreetings) ? cardGreetings : []) {
            const o = storedForm(greeting);
            const key = shownIdentity(o);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(o);
        }
        return out;
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Actor} p.actor
     * @param {{ offset?: number, limit?: number, around?: Record<string, any> }} [p.range]
     * @param {Record<string, any>[]} [p.cardGreetings]
     */
    async openingAlternatives({ tree, actor, range = {}, cardGreetings = [] }) {
        const hasSavedChats = (await this.store.chatRead('children', { tree, limit: 1 })).ids.length > 0;
        const rows = await this.openings(tree);
        const virtual = this.unstoredGreetings(rows, cardGreetings);
        const { user, session } = await this.knownActorIds(actor);
        const lands = await this.store.chatRead('landing', { tree, ...(session === null ? {} : { session }), ...(user === null ? {} : { user }) });
        const shown = lands === null ? null : (await this.store.chatRead('path', { tree, at: lands }))[0];
        let defaultIndex = Math.max(0, rows.findIndex(r => r.id === shown));
        const all = [
            ...rows.map(r => ({ ...alternativeEntry(this.externalId(r.stored), r.message, false), is_system: !!r.message?.is_system })),
            ...virtual.map(o => alternativeEntry(/** @type {any} */ (null), o, false)),
        ];
        let defaultNodeId = rows.length ? this.externalId(rows[defaultIndex].stored) : null;
        const choice = lands === null && session !== null ? await this.store.chatRead('openingChoice', { session, tree }) : null;
        let chosen = false;
        const cardTexts = (Array.isArray(cardGreetings) ? cardGreetings : []).map(g => g?.mes).filter(t => typeof t === 'string');
        if (choice !== null && cardTexts.length > 0) {
            const text = cardTexts[Math.min(choice, cardTexts.length - 1)];
            const at = all.findIndex(o => o.mes === text);
            if (at >= 0) {
                defaultIndex = at;
                defaultNodeId = all[at].node_id;
                chosen = true;
            }
        }
        const aroundKey = range.around ? identityOf(storedForm(range.around)) : null;
        const aroundIndex = aroundKey === null ? -1 : rows.findIndex(r => identityOf(r.message) === aroundKey);
        const center = aroundIndex >= 0 ? aroundIndex : defaultIndex;
        const width = Number.isInteger(range.limit) ? /** @type {number} */ (range.limit) : 11;
        const from = Number.isInteger(range.offset) ? Math.max(0, /** @type {number} */ (range.offset)) : Math.max(0, center - Math.floor(width / 2));
        const to = Math.min(all.length, from + width);
        const alternatives = all.slice(from, to).map((entry, i) => {
            const row = rows[from + i];
            return row?.stored.itemized ? { ...entry, extra: { ...(entry.extra && typeof entry.extra === 'object' ? entry.extra : {}), [ITEMIZED_PROMPT_FLAG]: true } } : entry;
        });
        return {
            has_saved_chats: hasSavedChats,
            total: all.length,
            stored: rows.length,
            default_index: defaultIndex,
            default_node_id: defaultNodeId,
            default_chosen: chosen,
            offset: from,
            alternatives,
        };
    }

    /**
     * @param {bigint} tree
     * @param {Actor} actor
     * @returns {Promise<string | null>}
     */
    async landingOf(tree, actor) {
        const { user, session } = await this.knownActorIds(actor);
        const lands = await this.store.chatRead('landing', { tree, ...(session === null ? {} : { session }), ...(user === null ? {} : { user }) });
        return lands === null ? null : (await this.externalIds([lands]))[0];
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Record<string, any>[]} p.cardGreetings
     * @param {string[]} p.cardTexts
     * @param {{ shownText: string, index: number, edits: { from: string, to: string, index?: number }[] }} p.request
     * @returns {Promise<{ index: number, opening: Record<string, any> | null }>}
     */
    async openingToLandOn({ tree, cardGreetings, cardTexts, request }) {
        const rows = await this.openings(tree);
        const virtual = this.unstoredGreetings(rows, cardGreetings);
        const texts = [...rows.map(r => r.message?.mes ?? ''), ...virtual.map(o => o?.mes ?? '')];
        const total = texts.length;
        if (total === 0) return { index: -1, opening: null };
        const edit = request.edits.findLast(e => e.from === request.shownText);
        const editCardText = edit && Number.isInteger(edit.index) ? cardTexts[/** @type {number} */ (edit.index)] : undefined;
        const first = (/** @type {unknown} */ text) => (typeof text === 'string' ? texts.indexOf(text) : -1);
        let target = first(request.shownText);
        if (target < 0 && edit) {
            target = first(edit.to);
            if (target < 0) target = first(editCardText);
        }
        if (target < 0) target = Math.min(Math.max(request.index, 0), total - 1);
        if (target >= rows.length) return { index: target, opening: alternativeEntry(/** @type {any} */ (null), virtual[target - rows.length], false) };
        const row = rows[target];
        return { index: target, opening: alternativeEntry(this.externalId(row.stored), row.message, !!row.stored.itemized) };
    }


    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {Record<string, any> | Record<string, any>[]} p.contents
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, node_ids: (string | null)[], added: number, total: number }>}
     */
    addOpenings({ tree, treeSpeaker, contents, actor }) {
        return this.serialized(tree, async () => {
            const list = Array.isArray(contents) ? contents : [contents];
            const records = [];
            const user = await this.idOf(SPACE.user, actor.user, 'user', records);
            const rows = await this.openings(tree);
            /** @type {Map<string, bigint>} */
            const byIdentity = new Map();
            for (const r of rows) if (!byIdentity.has(identityOf(r.message))) byIdentity.set(identityOf(r.message), r.id);
            /** @type {(bigint | null)[]} */
            const ids = [];
            const now = this.now();
            let added = 0;
            for (const content of list) {
                if (!String(content?.mes ?? '').trim()) {
                    ids.push(null);
                    continue;
                }
                const key = identityOf(content);
                const existing = byIdentity.get(key);
                if (existing !== undefined) {
                    ids.push(existing);
                    continue;
                }
                const id = this.next.message++;
                const time = now + added;
                const speaker = await this.speakerFor(content, treeSpeaker);
                records.push(...messageRecords(id, this.encoded(content, time, speaker), { parent: null, owner: tree, time, session: null, user, sendKey: null }));
                this.keyNew(records, id);
                byIdentity.set(key, id);
                ids.push(id);
                added++;
            }
            if (added) await this.store.commit(records);
            const external = await this.externalIds(ids.filter(id => id !== null));
            let at = 0;
            return { ok: true, node_ids: ids.map(id => (id === null ? null : external[at++])), added, total: rows.length + added };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {string | null} p.after
     * @param {Record<string, any>[]} p.contents
     * @param {(string | null)[]} [p.sendKeys]
     * @param {(StateOp[] | null | undefined)[]} [p.changes]
     * @param {number} [p.author]
     * @param {string | null} [p.ref]
     * @param {boolean} [p.regenerated]
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: boolean, reason?: string, node_ids: string[], already_stored?: string[] }>}
     */
    appendMessages({ tree, treeSpeaker, after, contents, sendKeys = [], changes = [], author = AUTHOR.user, ref = null, regenerated = false, actor }) {
        const lorebooks = changes.flatMap(ops => (Array.isArray(ops) ? ops : [])).filter(op => op?.key === WORLD_INFO && !op.variable).map(op => op.value);
        return this.serialized(tree, () => this.withWorldLinks(lorebooks, async link => {
            /** @type {object[]} */
            const records = [];
            let cursor = null;
            if (after !== null) {
                [cursor] = await this.messageIds([after]);
                const s = cursor === null ? null : (await this.stored([cursor])).get(cursor);
                if (!s || s.owner !== tree) return { ok: false, reason: 'unknown anchor', node_ids: [] };
            }
            const { user, session } = await this.actorIds(actor, records);
            const keys = sendKeys.map(k => (typeof k === 'string' && k !== '' ? Buffer.from(k, 'utf8') : null));
            const present = keys.filter(k => k !== null);
            const sent = present.length ? await this.store.chatRead('sent', { owner: tree, keys: present }) : [];
            const sentBy = new Map(present.map((k, i) => [k.toString('utf8'), sent[i]]));
            const ids = [];
            const already = [];
            const now = this.now();
            /** @type {Map<string, string> | null} */
            let state = null;
            for (const [i, content] of contents.entries()) {
                const key = keys[i];
                const stored = key ? sentBy.get(key.toString('utf8')) ?? null : null;
                if (stored !== null) {
                    ids.push(stored);
                    already.push(stored);
                    cursor = stored;
                    state = null;
                    continue;
                }
                state ??= await this.stateMap(tree, cursor);
                const produced = producedChanges(changes[i], state);
                const twin = isToolTurn(content) ? null : await this.twinOf(tree, cursor, content, ids, regenerated ? produced : undefined);
                if (twin !== null) {
                    if (session !== null) records.push(...this.moveTo(session, user, cursor, twin));
                    ids.push(twin);
                    cursor = twin;
                    state = null;
                    continue;
                }
                const id = this.next.message++;
                const time = now + i;
                const speaker = await this.speakerFor(content, treeSpeaker);
                records.push(...messageRecords(id, this.encoded(content, time, speaker), { parent: cursor, owner: tree, time, session, user, sendKey: key }));
                this.keyNew(records, id);
                for (const c of produced) {
                    /** @type {Record<string, unknown>} */
                    const r = { kind: 'stateChange', id: this.next.change++, message: id, time, author: author | PRODUCED | (c.variable ? VARIABLE : 0), key: c.key, user };
                    if (ref !== null) r.ref = ref;
                    if (session !== null) r.session = session;
                    if (c.json !== null) r.value = !c.variable && c.key === WORLD_INFO ? await link(c.json, records) : c.json;
                    records.push(r);
                }
                ids.push(id);
                cursor = id;
            }
            await this.claimConversation(records, tree, actor, { user, session });
            if (records.length) await this.store.commit(records);
            const external = await this.externalIds(ids);
            const answer = { ok: true, node_ids: external };
            if (already.length) answer.already_stored = already.map(id => external[ids.indexOf(id)]);
            return answer;
        }));
    }

    /**
     * @param {bigint} tree
     * @param {bigint | null} at
     */
    async stateMap(tree, at) {
        const state = await this.shownState(await this.store.chatRead('state', { tree, ...(at === null ? {} : { at }) }));
        return new Map(state.map(e => [stateKey(e.variable, e.field), e.json]));
    }

    /**
     * @param {bigint} session
     * @param {bigint} user
     * @param {bigint | null} fork
     * @param {bigint} reply
     */
    moveTo(session, user, fork, reply) {
        /** @type {Record<string, unknown>} */
        const choice = { kind: 'forkSelection', reply, session, user };
        if (fork !== null) choice.message = fork;
        return [choice, { kind: 'pointerMove', session, user, target: reply }];
    }

    /**
     * @param {bigint} tree
     * @param {bigint | null} parent
     * @param {Record<string, any>} content
     * @param {bigint[]} written
     * @param {ProducedChange[]} [produced]
     */
    async twinOf(tree, parent, content, written, produced) {
        if (parent !== null && written.includes(parent)) return null;
        const siblings = await this.children(tree, parent);
        if (!siblings.length) return null;
        const decoded = await this.decoded([...(await this.stored(siblings)).values()]);
        const want = identityOf(content);
        const same = siblings.filter((_, i) => identityOf(decoded[i]) === want);
        if (!same.length || produced === undefined) return same[0] ?? null;
        const theirs = await this.store.chatRead('produced', { messages: same });
        const wanted = JSON.stringify(produced);
        for (const [i, list] of theirs.entries()) {
            const shown = await this.shownState(list.filter(c => c.value !== null).map(c => ({ variable: c.variable, field: c.key, json: c.value })));
            let k = 0;
            const changes = list.map(c => ({ key: c.key, variable: c.variable, json: c.value === null ? null : shown[k++].json }));
            if (JSON.stringify(changes) === wanted) return same[i];
        }
        return null;
    }

    /**
     * @param {bigint[]} ids
     * @returns {Promise<(string | null)[]>}
     */
    async externalIds(ids) {
        const stored = await this.stored(ids);
        return ids.map(id => {
            const s = stored.get(id);
            return s ? this.externalId(s) : null;
        });
    }

    /**
     * @param {any} stored
     * @param {Record<string, any>} content
     * @param {Speaker | null} speaker
     */
    editRecords(stored, content, speaker) {
        const id = stored.id;
        const before = new Map(stored.values.map(v => [v.field, v.json]));
        const beforeTimes = new Map(stored.times.map(t => [t.field, t.delta]));
        const beforeText = stored.texts.find(t => t.field === TOP.mes)?.text;
        const enc = this.encoded(content, stored.time, speaker);
        const records = [];
        if (enc.flags !== stored.flags) enc.values.set(META.flags, JSON.stringify(enc.flags));
        const appendSpeaker = stored.speaker;
        if (enc.speaker !== appendSpeaker) enc.values.set(META.speaker, JSON.stringify(enc.speaker === null ? null : Number(enc.speaker)));
        const storedName = before.has(META.nameFromSpeaker) ? null : stored.texts.find(t => t.field === TOP.name)?.text ?? stored.name;
        if (enc.name === null && storedName !== null) enc.values.set(META.nameFromSpeaker, 'true');
        if (enc.name !== null && enc.name !== storedName) records.push({ kind: 'textValue', message: id, field: TOP.name, text: enc.name });
        const textNow = (enc.flags >>> 8 & 3) === 0 ? enc.text : undefined;
        if (textNow !== beforeText) {
            if (textNow === undefined) records.push({ kind: 'valueDelete', message: id, field: TOP.mes });
            else if (beforeText === undefined) records.push({ kind: 'textValue', message: id, field: TOP.mes, text: textNow });
            else records.push({ kind: 'textEdit', message: id, field: TOP.mes, ...textEdit(beforeText, textNow) });
        }
        for (const [field, json] of enc.values) {
            if (before.get(field) !== json) records.push({ kind: 'jsonValue', message: id, field, json });
        }
        for (const field of before.keys()) {
            if (!enc.values.has(field)) records.push({ kind: 'valueDelete', message: id, field });
        }
        for (const [field, delta] of enc.times) {
            if (beforeTimes.get(field) !== delta) records.push({ kind: 'messageTime', message: id, field, delta });
        }
        for (const field of beforeTimes.keys()) {
            if (!enc.times.has(field) && !enc.values.has(field)) records.push({ kind: 'valueDelete', message: id, field });
        }
        return records;
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {{ node_id: string, content?: Record<string, any>, patch?: Record<string, any>, unset?: string[], changes?: StateOp[] | null }[]} p.edits
     * @param {number} [p.author]
     * @param {string | null} [p.ref]
     * @param {Actor} p.actor
     */
    editMessages({ tree, treeSpeaker, edits, author = AUTHOR.user, ref = null, actor }) {
        const lorebooks = edits.flatMap(e => (Array.isArray(e.changes) ? e.changes : [])).filter(op => op?.key === WORLD_INFO && !op.variable).map(op => op.value);
        return this.serialized(tree, () => this.withWorldLinks(lorebooks, async link => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            const ids = await this.messageIds(edits.map(e => String(e.node_id ?? '')));
            const stored = await this.stored(ids.filter(id => id !== null));
            const decoded = new Map((await this.decoded([...stored.values()])).map((d, i) => [[...stored.keys()][i], d]));
            let applied = 0;
            const refused = [];
            for (const [i, edit] of edits.entries()) {
                const id = ids[i];
                const s = id === null ? undefined : stored.get(id);
                if (!s || s.owner !== tree) {
                    refused.push({ node_id: edit.node_id, reason: 'unknown node' });
                    continue;
                }
                const now = /** @type {Record<string, any>} */ (decoded.get(id));
                const next = patchedContent(now, edit);
                if (next === null) {
                    refused.push({ node_id: edit.node_id, reason: 'no content' });
                    continue;
                }
                const recordProduced = async () => {
                    for (const c of producedChanges(edit.changes, await this.stateMap(tree, id))) {
                        /** @type {Record<string, unknown>} */
                        const r = { kind: 'stateChange', id: this.next.change++, message: id, time: this.now(), author: author | PRODUCED | (c.variable ? VARIABLE : 0), key: c.key, user };
                        if (ref !== null) r.ref = ref;
                        if (session !== null) r.session = session;
                        if (c.json !== null) r.value = !c.variable && c.key === WORLD_INFO ? await link(c.json, records) : c.json;
                        records.push(r);
                    }
                };
                if (JSON.stringify(now) === JSON.stringify(next)) {
                    await recordProduced();
                    applied++;
                    continue;
                }
                if (typeof now.mes === 'string' && now.mes.length > 0 && (next.mes ?? '') === '') {
                    refused.push({ node_id: edit.node_id, reason: 'refused to blank stored text' });
                    continue;
                }
                if (s.parent !== null && !isToolTurn(next)) {
                    const twin = await this.twinOf(tree, s.parent, next, []);
                    if (twin !== null && twin !== id) {
                        refused.push({ node_id: edit.node_id, reason: 'an alternative with this text already exists', twin: (await this.externalIds([twin]))[0] });
                        continue;
                    }
                }
                await recordProduced();
                const speaker = await this.speakerFor(next, treeSpeaker);
                const changed = this.editRecords(s, next, speaker);
                for (const r of changed) {
                    if (session !== null) Object.assign(r, { session, user });
                    else Object.assign(r, { user });
                }
                records.push(...changed);
                applied++;
            }
            await this.claimConversation(records, tree, actor, { user, session });
            if (records.length) await this.store.commit(records);
            return { ok: true, applied, refused };
        }));
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.node_id
     * @param {Actor} p.actor
     */
    select({ tree, node_id, actor }) {
        return this.serialized(tree, async () => {
            const s = await this.messageOf(tree, node_id);
            if (!s) return false;
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A choice is made through a session');
            const end = await this.store.chatRead('branchEnd', { tree, at: s.id, session, user });
            records.push(this.moveTo(session, user, s.parent, s.id)[0], { kind: 'pointerMove', session, user, target: end });
            await this.claimConversation(records, tree, actor, { user, session });
            await this.store.commit(records);
            return true;
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.node_id
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    goTo({ tree, node_id, actor }) {
        return this.serialized(tree, async () => {
            let id = null;
            if (node_id !== null) {
                const s = await this.messageOf(tree, node_id);
                if (!s) return { ok: false, reason: 'unknown node' };
                id = s.id;
            }
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A session moves through itself');
            const [now] = await this.store.chatRead('sessions', { ids: [session] });
            if (now && now.tree === tree && now.at === id) return { ok: true };
            records.push(id === null ? { kind: 'pointerRoot', session, user, tree, time: this.now() } : { kind: 'pointerMove', session, user, target: id });
            await this.claimConversation(records, tree, actor, { user, session });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * @param {object} p
     * @param {boolean} p.back
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, tree: bigint, at: string | null } | { ok: false, reason: string }>}
     */
    async step({ back, actor }) {
        const { session } = await this.knownActorIds(actor);
        const reached = session === null ? null : await this.store.chatRead('historyStep', { session, back });
        if (reached === null) return { ok: false, reason: back ? 'nothing back' : 'nothing forward' };
        const tree = reached.target === null ? reached.tree : (await this.stored([reached.target])).get(reached.target).owner;
        return this.serialized(tree, async () => {
            const now = await this.store.chatRead('historyStep', { session, back });
            if (now?.n !== reached.n) return { ok: false, reason: 'moved meanwhile' };
            const records = [];
            const { user } = await this.actorIds(actor, records);
            records.push({ kind: 'historyStep', session, user, n: reached.n, time: this.now() });
            await this.store.commit(records);
            return { ok: true, tree, at: reached.target === null ? null : (await this.externalIds([reached.target]))[0] };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {number} p.index
     * @param {Actor} p.actor
     */
    chooseCardGreeting({ tree, index, actor }) {
        return this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A greeting is chosen through a session');
            const [now] = await this.store.chatRead('sessions', { ids: [session] });
            const atRoot = !!now && now.tree === tree && now.at === null;
            const chosen = now ? await this.store.chatRead('openingChoice', { session, tree }) : null;
            if (atRoot && chosen === index) return { ok: true };
            if (!atRoot) records.push({ kind: 'pointerRoot', session, user, tree, time: this.now() });
            records.push({ kind: 'openingChoice', session, user, tree, index });
            await this.claimConversation(records, tree, actor, { user, session });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {string} p.after
     * @param {string} p.before
     * @param {Record<string, any>} p.content
     * @param {string | null} [p.sendKey]
     * @param {Actor} p.actor
     */
    graftMessage({ tree, treeSpeaker, after, before, content, sendKey = null, actor }) {
        return this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (sendKey) {
                const [stored] = await this.store.chatRead('sent', { owner: tree, keys: [Buffer.from(sendKey, 'utf8')] });
                if (stored !== null) return { ok: true, node_id: (await this.externalIds([stored]))[0], already_stored: true };
            }
            const [a, b] = await this.messageIds([after, before]);
            const stored = await this.stored([a, b].filter(x => x !== null));
            const sa = a === null ? undefined : stored.get(a);
            const sb = b === null ? undefined : stored.get(b);
            if (!sa || sa.owner !== tree) return { ok: false, reason: 'unknown after node' };
            if (!sb || sb.owner !== tree) return { ok: false, reason: 'unknown before node' };
            if (sb.parent !== a) return { ok: false, reason: 'not adjacent' };
            const [now] = session === null ? [null] : await this.store.chatRead('sessions', { ids: [session] });
            const moves = session !== null && !(now?.tree === tree && now.at !== null && await this.store.chatRead('within', { message: b, at: now.at }));
            let id = await this.twinOf(tree, a, content, []);
            if (id === null) {
                id = this.next.message++;
                const time = this.now();
                const speaker = await this.speakerFor(content, treeSpeaker);
                records.push(...messageRecords(id, this.encoded(content, time, speaker), { parent: a, owner: tree, time, session: moves ? session : null, user, sendKey: sendKey ? Buffer.from(sendKey, 'utf8') : null }));
                this.keyNew(records, id);
            } else if (moves) {
                records.push(...this.moveTo(session, user, a, id));
            }
            records.push({ kind: 'messageParent', message: b, parent: id, user, ...(session === null ? {} : { session }) });
            if (moves) records.push(...this.moveTo(session, user, id, b));
            await this.claimConversation(records, tree, actor, { user, session });
            await this.store.commit(records);
            return { ok: true, node_id: (await this.externalIds([id]))[0] };
        });
    }


    /**
     * @param {bigint} tree
     * @param {bigint} at
     * @param {bigint | null} session
     * @param {bigint} user
     * @returns {Promise<bigint | null>}
     */
    followedReply(tree, at, session, user) {
        return this.store.chatRead('followed', { tree, at, ...(session === null ? {} : { session }), user });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.upper
     * @param {string} p.lower
     * @param {Actor} p.actor
     */
    swapAdjacent({ tree, upper, lower, actor }) {
        return this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            const [u, l] = await this.messageIds([upper, lower]);
            const stored = await this.stored([u, l].filter(x => x !== null));
            const su = u === null ? undefined : stored.get(u);
            const sl = l === null ? undefined : stored.get(l);
            if (!su || !sl || su.owner !== tree || sl.owner !== tree) return { ok: false, reason: 'unknown node' };
            if (sl.parent !== u) return { ok: false, reason: 'not adjacent' };
            if (su.parent === null) return { ok: false, reason: 'not on default path' };
            const child = await this.followedReply(tree, /** @type {bigint} */ (l), session, user);
            const actorPart = { user, ...(session === null ? {} : { session }) };
            records.push({ kind: 'messageParent', message: l, parent: su.parent, ...actorPart });
            records.push({ kind: 'messageParent', message: u, parent: l, ...actorPart });
            if (child !== null) records.push({ kind: 'messageParent', message: child, parent: u, ...actorPart });
            if (session !== null) {
                records.push(...this.moveTo(session, user, su.parent, /** @type {bigint} */ (l)));
                records.push(...this.moveTo(session, user, l, /** @type {bigint} */ (u)));
                if (child !== null) records.push(...this.moveTo(session, user, u, child));
            }
            await this.claimConversation(records, tree, actor, { user, session });
            await this.store.commit(records);
            return { ok: true };
        });
    }


    /**
     * @param {bigint} tree
     * @param {bigint[]} roots
     * @param {bigint[]} keep
     * @param {boolean} [root]
     */
    async dropsOf(tree, roots, keep, root = false) {
        if (!roots.length && !root) return { bookmarks: [], changes: [] };
        const d = await this.store.chatRead('subtreeDrops', { tree, roots, keep, root });
        const marks = d.bookmarks.length ? await this.store.chatRead('bookmarks', { ids: d.bookmarks.map((/** @type {any} */ b) => b.id) }) : [];
        const onMessages = d.changes.filter((/** @type {any} */ c) => c.message !== null);
        const at = await this.externalIds([...d.bookmarks.map((/** @type {any} */ b) => b.at), ...onMessages.map((/** @type {any} */ c) => c.message)]);
        const changeAt = new Map(onMessages.map((/** @type {any} */ c, /** @type {number} */ i) => [c, at[d.bookmarks.length + i]]));
        return {
            bookmarks: d.bookmarks.map((/** @type {any} */ b, /** @type {number} */ i) => ({ id: String(b.id), name: marks[i]?.name ?? null, node_id: at[i] })),
            changes: d.changes.map((/** @type {any} */ c) => ({ id: String(c.id), key: c.key, variable: c.variable, node_id: changeAt.get(c) ?? null })),
        };
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {{ roots: bigint[], keep?: bigint[], records?: object[], root?: boolean, rootBookmarks?: { id: string, name: string | null }[], copies?: [bigint, bigint][] }} p.plan
     * @param {{ user: bigint, session: bigint | null }} p.who
     * @param {object[]} p.keys
     * @param {boolean} [p.preview]
     * @param {{ bookmarks?: string[], changes?: string[] }} [p.confirm]
     * @returns {Promise<EditAnswer>}
     */
    async applyEdit({ tree, plan, who, keys, preview, confirm }) {
        const drops = await this.dropsOf(tree, plan.roots, plan.keep ?? [], plan.root);
        for (const b of plan.rootBookmarks ?? []) drops.bookmarks.push({ ...b, node_id: null });
        if (preview) return { ok: true, preview: true, drops };
        const same = (/** @type {string[] | undefined} */ named, /** @type {{ id: string }[]} */ found) =>
            new Set(named ?? []).size === found.length && found.every(x => (named ?? []).includes(x.id));
        const any = confirm === 'any';
        if (!any && (drops.bookmarks.length || drops.changes.length) && !(same(confirm?.bookmarks, drops.bookmarks) && same(confirm?.changes, drops.changes))) {
            return { ok: false, reason: 'confirm', drops };
        }
        const actorPart = { user: who.user, ...(who.session === null ? {} : { session: who.session }) };
        const time = this.now();
        const records = [...keys, ...(plan.records ?? []), ...plan.roots.map(message => ({ kind: 'subtreeDelete', message, ...actorPart, time }))];
        if (plan.root && drops.changes.some(c => c.node_id === null)) records.push({ kind: 'rootStateClear', tree });
        if (records.length > keys.length) await this.store.commit(records);
        const copied = plan.copies?.length ? await this.copiedIds(plan.copies) : null;
        return { ok: true, ...(any ? { drops } : {}), ...(copied ? { copied } : {}) };
    }

    /**
     * @param {[bigint, bigint][]} copies
     * @returns {Promise<Record<string, string>>}
     */
    async copiedIds(copies) {
        const outside = await this.externalIds(copies.flat());
        return Object.fromEntries(copies.map((_, i) => [outside[2 * i], outside[2 * i + 1]]));
    }

    /**
     * @param {bigint} tree
     * @param {string} nodeId
     */
    async messageOf(tree, nodeId) {
        const [id] = await this.messageIds([nodeId]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        return s && s.owner === tree ? s : null;
    }

    /**
     * @param {bigint} tree
     * @param {string} nodeId
     * @returns {Promise<Record<string, any> | null>}
     */
    async shownMessage(tree, nodeId) {
        const s = await this.messageOf(tree, nodeId);
        if (!s) return null;
        const [message] = await this.decoded([s]);
        if (s.itemized) message.extra = { ...(message.extra && typeof message.extra === 'object' ? message.extra : {}), [ITEMIZED_PROMPT_FLAG]: true };
        return message;
    }

    /**
     * @param {bigint} tree
     * @param {bigint | null} session
     * @returns {Promise<bigint[] | null>}
     */
    async shownPath(tree, session) {
        if (session === null) return null;
        const [now] = await this.store.chatRead('sessions', { ids: [session] });
        if (!now || now.tree !== tree) return null;
        return now.at === null ? [] : this.store.chatRead('path', { tree, at: now.at });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Actor} p.actor
     * @param {boolean} [p.preview]
     * @param {{ bookmarks?: string[], changes?: string[] } | 'any'} [p.confirm]
     * @param {(who: { user: bigint, session: bigint | null }) => Promise<{ roots: bigint[], keep?: bigint[], records?: object[], root?: boolean } | { ok: false, reason: string }>} plan
     * @returns {Promise<EditAnswer>}
     */
    edit({ tree, actor, preview, confirm }, plan) {
        return this.serialized(tree, async () => {
            const keys = [];
            const who = await this.actorIds(actor, keys);
            const planned = await plan(who);
            if ('ok' in planned) return planned;
            return this.applyEdit({ tree, plan: planned, who, keys, preview, confirm });
        });
    }

    /**
     * @param {EditRequest & { node_id: string }} p
     */
    deleteSubtree(p) {
        return this.edit(p, async () => {
            const s = await this.messageOf(p.tree, p.node_id);
            return s ? { roots: [s.id] } : { ok: false, reason: 'unknown node' };
        });
    }

    /**
     * @param {EditRequest & { node_id: string }} p
     */
    deleteAlternatives(p) {
        return this.edit(p, async () => {
            const s = await this.messageOf(p.tree, p.node_id);
            return s ? { roots: await this.children(p.tree, s.parent) } : { ok: false, reason: 'unknown node' };
        });
    }

    /**
     * @param {{ tree: bigint, actor: Actor }} p
     */
    deleteTree({ tree, actor }) {
        return this.edit({ tree, actor, confirm: 'any' }, async () => {
            /** @type {object[]} */
            const records = [];
            /** @type {{ id: string, name: string | null }[]} */
            const rootBookmarks = [];
            let after;
            for (;;) {
                const page = await this.bookmarks({ tree, after, limit: 500 });
                for (const b of page.rows) {
                    if (b.at !== null) continue;
                    records.push({ kind: 'positionDelete', id: BigInt(b.id) });
                    rootBookmarks.push({ id: String(b.id), name: b.name ?? null });
                }
                if (!page.more) break;
                after = page.rows[page.rows.length - 1].id;
            }
            return { roots: await this.children(tree, null), records, root: true, rootBookmarks };
        });
    }

    /**
     * @param {EditRequest & { node_id: string }} p
     */
    deleteBelow(p) {
        return this.edit(p, async () => {
            const s = await this.messageOf(p.tree, p.node_id);
            return s ? { roots: await this.children(p.tree, s.id) } : { ok: false, reason: 'unknown node' };
        });
    }

    /**
     * @param {EditRequest & { node_id: string }} p
     */
    deletePath(p) {
        return this.edit(p, async ({ session }) => {
            const s = await this.messageOf(p.tree, p.node_id);
            if (!s) return { ok: false, reason: 'unknown node' };
            const path = await this.shownPath(p.tree, session);
            const from = path ? path.indexOf(s.id) : -1;
            if (!path || from < 0) return { ok: false, reason: 'not on the path' };
            const stored = await this.stored(path);
            const replies = (/** @type {number} */ i) => stored.get(path[i]).replies;
            let t = path.length - 1;
            if (replies(t) > 0) return { roots: [] };
            while (t - 1 >= from && replies(t - 1) === 1) t--;
            return { roots: [path[t]] };
        });
    }

    /**
     * @param {EditRequest & { first: string, last: string }} p
     */
    cutFromPath(p) {
        return this.edit(p, async ({ user, session }) => {
            const range = await this.cutRange(p, session);
            if ('ok' in range) return range;
            const { path, fi, li } = range;
            const end = path.length - 1;
            const stored = await this.stored(path);
            const replies = (/** @type {number} */ i) => stored.get(path[i]).replies;
            let k = end + 1;
            if (li < end && replies(end) === 0) {
                k = end;
                while (k - 1 > li && replies(k - 1) === 1) k--;
            }
            const before = fi > 0 ? path[fi - 1] : null;
            const records = [];
            /** @type {[bigint, bigint][]} */
            const copies = [];
            /** @type {bigint | null} */
            let parent = before;
            /** @type {bigint | null} */
            let first = null;
            for (let i = li + 1; i < k; i++) {
                const id = this.next.message++;
                copies.push([path[i], id]);
                records.push(...await this.copyRecords(stored.get(path[i]), id, parent, user));
                this.keyNew(records, id);
                first ??= id;
                parent = id;
            }
            if (k <= end) {
                records.push({ kind: 'messageParent', message: path[k], user, ...(parent === null ? {} : { parent }), ...(session === null ? {} : { session }) });
                first ??= path[k];
            }
            if (first !== null) records.push(this.moveTo(/** @type {bigint} */ (session), user, before, first)[0]);
            const newEnd = k <= end ? path[end] : parent;
            if (newEnd !== path[end]) {
                records.push(newEnd === null ? { kind: 'pointerRoot', session, user, tree: p.tree, time: this.now() } : { kind: 'pointerMove', session, user, target: newEnd });
            }
            const moved = k === li + 1 && k <= end;
            if (replies(li) - (moved ? 1 : 0) > 0) return { roots: [], records, copies };
            let t = li;
            while (t - 1 >= fi && replies(t - 1) === 1) t--;
            return { roots: [path[t]], keep: moved ? [path[k]] : [], records, copies };
        });
    }

    /**
     * @param {EditRequest & { first: string, last: string }} p
     */
    cutEverywhere(p) {
        return this.edit(p, async ({ user, session }) => {
            const range = await this.cutRange(p, session);
            if ('ok' in range) return range;
            const { path, fi, li } = range;
            const before = fi > 0 ? path[fi - 1] : null;
            const actorPart = { user, ...(session === null ? {} : { session }) };
            const records = [];
            const keep = [];
            for (let i = fi; i <= li; i++) {
                for (const c of await this.children(p.tree, path[i])) {
                    if (i < li && c === path[i + 1]) continue;
                    records.push({ kind: 'messageParent', message: c, ...(before === null ? {} : { parent: before }), ...actorPart });
                    keep.push(c);
                }
            }
            if (li < path.length - 1) records.push(this.moveTo(/** @type {bigint} */ (session), user, before, path[li + 1])[0]);
            return { roots: [path[fi]], keep, records };
        });
    }

    /**
     * @param {EditRequest & { first: string, last: string }} p
     * @param {bigint | null} session
     * @returns {Promise<{ path: bigint[], fi: number, li: number } | { ok: false, reason: string }>}
     */
    async cutRange(p, session) {
        if (session === null) throw new Error('A path is cut through a session');
        const [a, b] = await Promise.all([this.messageOf(p.tree, p.first), this.messageOf(p.tree, p.last)]);
        if (!a || !b) return { ok: false, reason: 'unknown node' };
        const path = await this.shownPath(p.tree, session);
        const fi = path ? path.indexOf(a.id) : -1;
        const li = path ? path.indexOf(b.id) : -1;
        if (!path || fi < 0 || li < fi) return { ok: false, reason: 'not on the path' };
        return { path, fi, li };
    }

    /**
     * @param {any} s
     * @param {bigint} id
     * @param {bigint | null} parent
     * @param {bigint} user
     */
    async copyRecords(s, id, parent, user) {
        const inAppend = ((s.flags >>> 8) & 3) === 0;
        /** @type {Record<string, unknown>} */
        const append = { kind: 'messageAppend', id, owner: s.owner, time: s.time, flags: s.flags, user, text: '' };
        if (parent !== null) append.parent = parent;
        if (s.speaker !== null) append.speaker = s.speaker;
        if (s.name !== null) append.name = s.name;
        const records = [append];
        for (const t of s.texts) {
            if (inAppend && t.field === TOP.mes) append.text = t.text;
            else records.push({ kind: 'textValue', message: id, field: t.field, text: t.text });
        }
        for (const v of s.values) records.push({ kind: 'jsonValue', message: id, field: v.field, json: v.json });
        for (const t of s.times) records.push({ kind: 'messageTime', message: id, field: t.field, delta: t.delta });
        if (s.itemized) {
            const it = await this.store.chatRead('itemization', { message: s.id });
            if (it) records.push({ kind: 'itemization', message: id, raw: it.raw, data: it.data });
        }
        for (const c of await this.store.chatRead('activeChanges', { message: s.id })) {
            /** @type {Record<string, unknown>} */
            const r = { kind: 'stateChange', id: this.next.change++, message: id, time: c.time, author: c.author, key: c.key, user };
            if (c.ref !== null) r.ref = c.ref;
            if (c.confidence !== null) r.confidence = c.confidence;
            if (c.value !== null) r.value = c.value;
            records.push(r);
        }
        return records;
    }


    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.node_id
     * @param {string | null} p.name
     * @param {boolean} [p.suggested]
     * @param {number} [p.mode]
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, bookmark: bigint, name: string } | { ok: false, reason: 'unknown node' | 'name taken' }>}
     */
    createBookmark({ tree, node_id, name, suggested = false, mode = MODE.following, actor }) {
        return this.serialized(tree, async () => {
            const s = node_id === null ? null : await this.messageOf(tree, node_id);
            if (node_id !== null && !s) return { ok: false, reason: 'unknown node' };
            const records = [];
            const actorIds = await this.actorIds(actor, records);
            if (actorIds.session === null) throw new Error('A bookmark is made through a session');
            let label = name ?? chatNameAt(await this.owner(tree), this.now());
            if (suggested || name === null) label = await freeName(label, n => this.nameTaken(tree, n));
            else if (await this.nameTaken(tree, label)) return { ok: false, reason: 'name taken' };
            const b = this.next.position++;
            const where = s === null ? { kind: 'positionRoot', tree, time: this.now() } : { kind: 'positionCreate', pointer: s.id };
            records.push({ id: b, mode, session: actorIds.session, user: actorIds.user, ...where });
            records.push({ kind: 'positionName', id: b, name: label });
            await this.store.commit(records);
            return { ok: true, bookmark: b, name: label };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.name
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, name: string } | { ok: false, reason: 'name taken' | 'a current chat' }>}
     */
    nameConversation({ tree, name, actor }) {
        return this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A conversation is a session\'s');
            if (await this.store.chatRead('currentChat', { session, tree }) !== null) return { ok: false, reason: 'a current chat' };
            const own = { session };
            let label;
            if (name === null) label = await freeName(chatNameAt(await this.owner(tree), this.now()), n => this.nameTaken(tree, n, own));
            else if (await this.nameTaken(tree, name, own)) return { ok: false, reason: 'name taken' };
            else label = name;
            if (await this.store.chatRead('conversationName', { session, tree }) === label) return { ok: true, name: label };
            records.push({ kind: 'conversationName', session, user, tree, name: label });
            await this.store.commit(records);
            return { ok: true, name: label };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Actor} p.actor
     * @param {boolean} [p.group]
     * @param {string | null} [p.node_id]
     * @param {boolean} [p.keep]
     * @returns {Promise<{ ok: true, name: string, kept: string | null } | { ok: false, reason: 'unknown node' }>}
     */
    startChat({ tree, actor, group = false, node_id = null, keep = true }) {
        return this.serialized(tree, async () => {
            let target = null;
            if (node_id !== null) {
                const s = await this.messageOf(tree, node_id);
                if (!s) return { ok: false, reason: 'unknown node' };
                target = s.id;
            }
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A chat is started through a session');
            const [now] = await this.store.chatRead('sessions', { ids: [session] });
            const here = now && now.tree === tree ? now : null;
            const current = await this.store.chatRead('currentChat', { session, tree });
            const stored = /** @type {string | null} */ (await this.store.chatRead('conversationName', { session, tree }));
            let kept = null;
            if (keep && current === null && stored !== null && here !== null && here.at !== null && (await this.stored([here.at])).get(here.at)?.parent != null) {
                const b = this.next.position++;
                records.push({ id: b, mode: MODE.following, session, user, kind: 'positionCreate', pointer: here.at });
                records.push({ kind: 'positionName', id: b, name: stored });
                kept = stored;
            }
            if (target !== null) {
                if (here?.at !== target) records.push({ kind: 'pointerMove', session, user, target });
            } else {
                if (here === null || here.at !== null) records.push({ kind: 'pointerRoot', session, user, tree, time: this.now() });
                if (!group) records.push({ kind: 'openingChoice', session, user, tree, index: 0 });
            }
            if (current !== null) records.push({ kind: 'currentChat', session, user, tree });
            const name = await freeName(chatNameAt(await this.owner(tree), this.now()), n => n === kept || this.nameTaken(tree, n, { session }));
            records.push({ kind: 'conversationName', session, user, tree, name });
            await this.store.commit(records);
            return { ok: true, name, kept };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {string | null} p.name
     * @param {Record<string, any>[]} p.messages
     * @param {Record<string, unknown>} [p.metadata]
     * @param {Actor} p.actor
     * @param {boolean} [p.bookmark]
     * @returns {Promise<{ ok: true, bookmark: bigint | null, name: string | null, node_ids: string[] } | { ok: false, reason: string }>}
     */
    async importChat({ tree, treeSpeaker, name, messages, metadata, actor, bookmark = true }) {
        const shown = await this.serialized(tree, async () => {
            const records = [];
            const { user } = await this.actorIds({ user: actor.user }, records);
            const now = this.now();
            /** @type {bigint[]} */
            const chosen = [];
            /** @type {bigint | null} */
            let parent = null;
            let written = 0;
            for (const msg of messages) {
                const level = await this.level(tree, parent);
                const { contents, selected } = alternativesOf(msg);
                /** @type {bigint | null} */
                let pick = null;
                for (const [k, content] of contents.entries()) {
                    let sid = level.twin(content, null);
                    if (sid === null) {
                        sid = this.next.message++;
                        const time = now + written++;
                        records.push(...messageRecords(sid, this.encoded(content, time, await this.speakerFor(content, treeSpeaker)), { parent, owner: tree, time, session: null, user, sendKey: null }));
                        this.keyNew(records, sid);
                        level.add(sid, content);
                    }
                    if (k === selected) pick = sid;
                }
                parent = /** @type {bigint} */ (pick);
                chosen.push(parent);
            }
            if (records.length) await this.store.commit(records);
            return this.externalIds(chosen);
        });
        const last = shown.length ? shown[shown.length - 1] : null;
        if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
            await this.mergeMetadata({ tree, at: last, set: metadata, unset: [], actor });
        }
        if (!bookmark) return { ok: true, bookmark: null, name: null, node_ids: shown };
        const made = await this.createBookmark({ tree, node_id: last, name, suggested: true, actor });
        if (!made.ok) return made;
        return { ok: true, bookmark: made.bookmark, name: made.name, node_ids: shown };
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.name
     * @param {{ session: string | null, identifier: string }} [p.own]
     * @returns {Promise<{ bookmark: bigint } | { session: string, derived?: true } | null>}
     */
    async resolveChatName({ tree, name, own }) {
        const [state] = await this.store.chatRead('keyStates', { space: SPACE.session, keys: [name] });
        if (state !== null && state !== 'gone') return { session: name };
        const rows = (await this.store.chatRead('chatsNamed', { name, limit: 64 })).filter((/** @type {any} */ r) => r.tree === tree);
        if (rows.length > 1) return null;
        if (rows.length === 1) {
            if (rows[0].bookmark !== null) return { bookmark: rows[0].bookmark };
            const [s] = await this.store.chatRead('sessions', { ids: [rows[0].session] });
            return s ? { session: s.key, derived: true } : null;
        }
        if (own && name === await this.conversationName(own.session, own.identifier, tree)) return { session: own.identifier, derived: true };
        const session = await this.sessionNamed(name);
        return session === null ? null : { session };
    }

    /**
     * @param {bigint} tree
     * @param {bigint | null} parent
     */
    async level(tree, parent) {
        const ids = await this.children(tree, parent);
        const stored = await this.stored(ids);
        const decoded = await this.decoded(ids.map(id => stored.get(id)));
        /** @type {Map<bigint, Record<string, any>>} */
        const byId = new Map(ids.map((id, i) => [id, decoded[i]]));
        return {
            stored,
            byId,
            twin: (/** @type {Record<string, any>} */ content, /** @type {bigint | null} */ except) => {
                const want = identityOf(content);
                for (const [id, m] of byId) if (id !== except && identityOf(m) === want) return id;
                return null;
            },
            add: (/** @type {bigint} */ id, /** @type {Record<string, any>} */ content) => byId.set(id, content),
            set: (/** @type {bigint} */ id, /** @type {Record<string, any>} */ content) => byId.set(id, content),
        };
    }


    /**
     * @param {Record<string, any>} record
     * @returns {Promise<{ tree: bigint | null, at: string | null } | null>}
     */
    async stateChangePlace(record) {
        if (record.kind !== 'stateChange') return { tree: null, at: null };
        if (record.message === undefined) return { tree: record.tree, at: null };
        const s = (await this.stored([record.message])).get(record.message);
        return s ? { tree: s.owner, at: this.externalId(s) } : null;
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @param {string | null} [p.session]
     * @param {number} [p.ifHash]
     * @returns {Promise<{ state: Record<string, unknown>, hash: number } | { unchanged: true } | null>}
     */
    async stateAt({ tree, at, session = null, ifHash }) {
        let message = null;
        if (at !== null) {
            [message] = await this.messageIds([at]);
            const s = message === null ? undefined : (await this.stored([message])).get(message);
            if (!s || s.owner !== tree) return null;
        }
        const state = await this.metadata(tree, message, session);
        const hash = jsonHash(state);
        return ifHash === hash ? { unchanged: true } : { state, hash };
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @param {Record<string, unknown>} p.set
     * @param {string[]} p.unset
     * @param {{ set?: Record<string, unknown>, unset?: string[] }} [p.variables]
     * @param {Actor} p.actor
     * @param {number} [p.author]
     */
    mergeMetadata({ tree, at, set, unset, variables, actor, author = AUTHOR.user }) {
        return this.serialized(tree, async () => {
            let message = null;
            if (at !== null) {
                [message] = await this.messageIds([at]);
                if (message === null) return { ok: false, reason: 'unknown chat' };
            }
            const state = await this.shownState(await this.store.chatRead('state', { tree, ...(message === null ? {} : { at: message }) }));
            const now = new Map(state.filter(e => !e.variable).map(e => [e.field, e.json]));
            const vars = new Map(state.filter(e => e.variable).map(e => [e.field, e.json]));
            /** @type {Map<string, [string, string | undefined, boolean]>} */
            const touched = new Map();
            const change = (/** @type {string} */ key, /** @type {string | undefined} */ value, variable = false) => {
                const held = variable ? vars : now;
                if (value === undefined) held.delete(key);
                else held.set(key, value);
                touched.set(`${variable ? 'v' : 'k'}\u0000${key}`, [key, value, variable]);
            };
            const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
            const setVariables = (/** @type {Record<string, unknown>} */ values) => {
                if (!now.has('variables')) change('variables', '{}');
                for (const [name, v] of Object.entries(values)) {
                    if (v !== undefined) change(name, JSON.stringify(v), true);
                }
            };
            for (const [key, value] of Object.entries(set ?? {})) {
                if (value === undefined || DERIVED_METADATA.has(key)) continue;
                if (key === 'variables' && isObject(value)) {
                    setVariables(/** @type {Record<string, unknown>} */ (value));
                    continue;
                }
                change(key, JSON.stringify(value));
            }
            for (const key of Array.isArray(unset) ? unset : []) {
                if (typeof key !== 'string' || DERIVED_METADATA.has(key)) continue;
                if (key === 'variables') {
                    for (const name of [...vars.keys()]) change(name, undefined, true);
                }
                change(key, undefined);
            }
            if (isObject(variables?.set)) setVariables(/** @type {Record<string, unknown>} */ (variables?.set));
            for (const name of Array.isArray(variables?.unset) ? variables.unset : []) {
                if (typeof name === 'string') change(name, undefined, true);
            }
            const before = new Map(state.map(e => [`${e.variable ? 'v' : 'k'}\u0000${e.field}`, e.json]));
            const changes = [...touched].filter(([k, [, value]]) => before.get(k) !== value).map(([, c]) => c);
            if (changes.length === 0) return { ok: true };
            const lorebooks = changes.filter(([key, , variable]) => key === WORLD_INFO && !variable).map(([, value]) => (value === undefined ? undefined : JSON.parse(value)));
            await this.withWorldLinks(lorebooks, async link => {
                const records = [];
                const { user, session } = await this.actorIds(actor, records);
                const where = message === null ? { tree } : { message };
                const time = this.now();
                for (const [key, value, variable] of changes) {
                    /** @type {Record<string, unknown>} */
                    const r = { kind: 'stateChange', id: this.next.change++, ...where, time, author: author | (variable ? VARIABLE : 0), key, user };
                    if (session !== null) r.session = session;
                    if (value !== undefined) r.value = !variable && key === WORLD_INFO ? await link(value, records) : value;
                    records.push(r);
                }
                await this.claimConversation(records, tree, actor, { user, session });
                await this.store.commit(records);
            });
            return { ok: true };
        });
    }

    /**
     * @param {{ variable: boolean, field: string, json: string }[]} state
     */
    async shownState(state) {
        const isLink = (/** @type {{ variable: boolean, field: string, json: string }} */ e) => !e.variable && e.field === WORLD_INFO && e.json.startsWith(LINK);
        const links = state.filter(isLink);
        const resolved = links.length && this.people.books ? await this.people.books.resolved(links.map(e => BigInt(e.json.slice(1).split(' ')[0]))) : [];
        let i = 0;
        return state.map(e => {
            if (!isLink(e)) return e;
            const [id, ...own] = e.json.slice(1).split(' ');
            const name = own.length ? JSON.parse(own.join(' ')) : resolved[i]?.key ?? id;
            i++;
            return { ...e, json: JSON.stringify(name) };
        });
    }

    /**
     * @template T
     * @param {unknown[]} values
     * @param {(link: (json: string, records: object[]) => Promise<string>) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    withWorldLinks(values, fn) {
        const books = this.people.books;
        const keys = books ? values.filter(v => typeof v === 'string').map(v => bookKey(/** @type {string} */ (v))).filter(Boolean) : [];
        /** @type {Map<string, bigint>} */
        const made = new Map();
        const link = async (/** @type {string} */ json, /** @type {object[]} */ records) => {
            const value = JSON.parse(json);
            const key = books && typeof value === 'string' ? bookKey(value) : '';
            if (!key || !books) return json;
            let id = made.get(key) ?? await books.find(key);
            if (id === null) {
                id = books.newId();
                records.push({ kind: 'entityCreate', entity: id, type: 3, key, added: Date.now() });
            }
            made.set(key, id);
            return value === key ? `${LINK}${id}` : `${LINK}${id} ${json}`;
        };
        return keys.length && books ? books.lane(keys, () => fn(link)) : fn(link);
    }

    /**
     * @param {bigint} tree
     * @param {bigint | null} at
     * @param {string | null} [session]
     */
    async metadata(tree, at, session = null) {
        const state = await this.shownState(await this.store.chatRead('state', { tree, ...(at === null ? {} : { at }) }));
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const e of state) {
            if (e.variable) {
                if (!out.variables || typeof out.variables !== 'object') out.variables = {};
                /** @type {Record<string, unknown>} */ (out.variables)[e.field] = JSON.parse(e.json);
            } else if (e.field === 'variables' && e.json === '{}') {
                if (!out.variables || typeof out.variables !== 'object') out.variables = {};
            } else out[e.field] = JSON.parse(e.json);
        }
        if (session !== null) out.integrity = session;
        return out;
    }

    /**
     * @param {bigint} tree
     * @param {unknown} keys
     * @returns {Promise<string[]>}
     */
    async storedSendKeys(tree, keys) {
        const wanted = Array.isArray(keys) ? keys.filter(k => typeof k === 'string' && k !== '').slice(0, 100) : [];
        if (!wanted.length) return [];
        const found = await this.store.chatRead('sent', { owner: tree, keys: wanted.map(k => Buffer.from(k, 'utf8')) });
        return wanted.filter((_, i) => found[i] !== null);
    }


    /**
     * @param {object} p
     * @param {string} p.node_id
     * @param {Record<string, unknown>} p.entry
     * @returns {Promise<'written' | 'unchanged' | 'no-message'>}
     */
    async recordItemization({ node_id, entry }) {
        const [id] = await this.messageIds([node_id]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        if (!s) return 'no-message';
        const stored = { ...entry };
        delete stored.mesId;
        const data = await zstdCompress(Buffer.from(JSON.stringify(stored)));
        return this.serialized(s.owner, async () => {
            const now = await this.store.chatRead('itemization', { message: id });
            if (now && Buffer.compare(Buffer.from(now.data), data) === 0) return 'unchanged';
            if (!(await this.stored([s.id])).has(s.id)) return 'no-message';
            await this.store.commit([{ kind: 'itemization', message: id, raw: Boolean(stored.rawPrompt), data }]);
            return 'written';
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @param {Record<string, unknown>[]} p.entries
     * @returns {Promise<{ stored: number, unchanged: number, unmatched: { entry: number, mesId: unknown, why: string }[] } | null>}
     */
    importItemizations({ tree, at, entries }) {
        return this.serialized(tree, async () => {
            const ids = await this.pathIds(tree, at);
            if (!ids) return null;
            const stored = await this.stored(ids);
            const result = { stored: 0, unchanged: 0, unmatched: /** @type {{ entry: number, mesId: unknown, why: string }[]} */ ([]) };
            const records = [];
            const seen = new Set();
            for (const [i, entry] of entries.entries()) {
                const mesId = entry?.mesId;
                const index = Number(mesId);
                const leave = (/** @type {string} */ why) => result.unmatched.push({ entry: i, mesId: mesId ?? null, why });
                if (!Number.isInteger(index) || index < 0) { leave('no message position (mesId)'); continue; }
                if (seen.has(index)) { leave('a later entry for a message that had one (upstream showed the first)'); continue; }
                seen.add(index);
                const s = index < ids.length ? stored.get(ids[index]) : undefined;
                if (!s) { leave(`past the chat's end (${ids.length} messages)`); continue; }
                const kept = { ...entry };
                delete kept.mesId;
                const data = await zstdCompress(Buffer.from(JSON.stringify(kept)));
                if (s.itemized) {
                    const now = await this.store.chatRead('itemization', { message: s.id });
                    if (now && Buffer.compare(Buffer.from(now.data), data) === 0) result.unchanged++;
                    else leave('the message has another itemization already');
                    continue;
                }
                records.push({ kind: 'itemization', message: s.id, raw: Boolean(kept.rawPrompt), data });
                result.stored++;
            }
            if (records.length) await this.store.commit(records);
            return result;
        });
    }

    /**
     * @param {object} p
     * @param {string} p.node_id
     * @returns {Promise<{ entry: Record<string, unknown>, previous_node_id: string | null } | null>}
     */
    async readItemization({ node_id }) {
        const [id] = await this.messageIds([node_id]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        if (!s) return null;
        const found = await this.store.chatRead('itemization', { message: id });
        if (!found) return null;
        const above = (await this.store.chatRead('path', { tree: s.owner, at: id })).slice(0, -1).reverse();
        const stored = await this.stored(above);
        const previous = above.find(m => stored.get(m)?.itemized?.raw === true);
        return {
            entry: JSON.parse((await zstdDecompress(found.data)).toString('utf8')),
            previous_node_id: previous === undefined ? null : this.externalId(stored.get(previous)),
        };
    }

    /**
     * @param {{ batch?: number, pause?: number }} [p]
     * @returns {Promise<number>}
     */
    async clearItemizations({ batch = 256, pause = 10 } = {}) {
        let removed = 0;
        for (;;) {
            const page = await this.store.chatRead('itemized', { limit: batch });
            if (!page.ids.length) return removed;
            await this.store.commit(page.ids.map(message => ({ kind: 'itemization', message, raw: false })));
            removed += page.ids.length;
            if (!page.more) return removed;
            await new Promise(resolve => setTimeout(resolve, pause));
        }
    }

    /**
     * @param {bigint} tree
     * @param {string | null} at
     * @returns {Promise<bigint[] | null>}
     */
    async pathIds(tree, at) {
        if (at === null) return [];
        const [id] = await this.messageIds([at]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        if (!s || s.owner !== tree) return null;
        return this.store.chatRead('path', { tree, at: id });
    }


    /**
     * @param {{ sid: bigint, position: bigint, tree: bigint | null, at: bigint | null }[]} entries
     * @param {boolean} withMetadata
     */
    async sessionRows(entries, withMetadata) {
        const sessions = entries.length ? await this.store.chatRead('sessions', { ids: entries.map(e => e.sid) }) : [];
        const ats = entries.map(e => e.at).filter(a => a !== null);
        const stored = await this.stored(/** @type {bigint[]} */ (ats));
        const ids = [...stored.keys()];
        const decoded = new Map((await this.decoded(ids.map(id => stored.get(id)))).map((d, i) => [ids[i], d]));
        const rows = [];
        for (const [i, e] of entries.entries()) {
            const s = sessions[i];
            if (!s || e.tree === null) continue;
            const m = e.at === null ? undefined : stored.get(e.at);
            const count = await this.store.chatRead('messageCount', { tree: e.tree, ...(e.at === null ? {} : { at: e.at }) });
            /** @type {Record<string, any>} */
            const row = {
                session: s.key,
                name: s.name,
                position: e.position,
                tree: e.tree,
                at: m ? this.externalId(m) : null,
                message_count: count.count,
                count_estimate: count.estimate,
                last_mes: m ? decoded.get(e.at)?.mes || null : null,
                last_activity: m ? m.time : null,
            };
            if (withMetadata) row.chat_metadata = await this.metadata(e.tree, e.at, s.key);
            rows.push(row);
        }
        return rows;
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {bigint} [p.before]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     */
    async sessionsInTree({ tree, before, limit, withMetadata = false }) {
        const page = await this.store.chatRead('inTree', { tree, limit: limit + 1, ...(before === undefined ? {} : { before }) });
        const entries = [];
        for (const { position, session } of page.slice(0, limit)) {
            const where = await this.store.chatRead('sessionInTree', { session, tree });
            entries.push({ sid: session, position, tree, at: where?.at ?? null });
        }
        return { rows: await this.sessionRows(entries, withMetadata), more: page.length > limit };
    }

    /**
     * @param {string | undefined} session
     */
    async sessionId(session) {
        if (session === undefined) return null;
        const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [session] });
        return sid;
    }

    /**
     * @param {bigint} tree
     * @param {{ bookmark: bigint | null, session: bigint | null, at: bigint | null, key?: [bigint, bigint] }[]} items
     * @param {boolean} withMetadata
     */
    async listRows(tree, items, withMetadata) {
        const bookmarks = items.filter(i => i.bookmark !== null).map(i => /** @type {bigint} */ (i.bookmark));
        const marks = new Map((bookmarks.length ? await this.store.chatRead('bookmarks', { ids: bookmarks }) : []).filter(Boolean).map(b => [b.id, b]));
        const sessionIds = items.filter(i => i.session !== null).map(i => /** @type {bigint} */ (i.session));
        const sessionRows = sessionIds.length ? await this.store.chatRead('sessions', { ids: sessionIds }) : [];
        const ats = items.map(i => i.at).filter(a => a !== null);
        const stored = await this.stored(/** @type {bigint[]} */ (ats));
        const ids = [...stored.keys()];
        const decoded = new Map((await this.decoded(ids.map(id => stored.get(id)))).map((d, i) => [ids[i], d]));
        const rows = [];
        let si = 0;
        for (const item of items) {
            const m = item.at === null ? undefined : stored.get(item.at);
            const count = await this.store.chatRead('messageCount', { tree, ...(item.at === null ? {} : { at: item.at }) });
            /** @type {Record<string, any>} */
            const row = {};
            if (item.bookmark !== null) {
                const b = marks.get(item.bookmark);
                Object.assign(row, { bookmark: String(item.bookmark), session: null, name: b?.name ?? null });
            } else {
                const s = sessionRows[si++];
                Object.assign(row, { bookmark: null, session: s?.key ?? null, name: s?.name ?? null });
            }
            row.position = item.key ? listCursor(item.key) : null;
            Object.assign(row, {
                tree,
                at: m ? this.externalId(m) : null,
                message_count: count.count,
                count_estimate: count.estimate,
                last_mes: m ? decoded.get(item.at)?.mes || null : null,
                last_activity: m ? m.time : null,
            });
            if (withMetadata) row.chat_metadata = await this.metadata(tree, item.at, row.session);
            rows.push(row);
        }
        return rows;
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} [p.session]
     * @param {string} [p.after]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     */
    async chatList({ tree, session, after, limit, withMetadata = false }) {
        return this.searchChatList({ tree, search: '', session, after, limit, withMetadata });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.search
     * @param {string} [p.session]
     * @param {string} [p.after]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     * @param {string} [p.scanCursor]
     * @param {number} [p.scanBytes]
     */
    async searchChatList({ tree, search, session, after, limit, withMetadata = false, scanCursor, scanBytes }) {
        const sid = await this.sessionId(session);
        const from = after === undefined ? undefined : /^(\d+):(\d+)$/.exec(after);
        if (from === null) throw new Error('invalid cursor');
        if (scanCursor !== undefined && !/^m\d+$/.test(scanCursor)) throw new Error('invalid scan cursor');
        const page = await this.store.chatSearchList({
            tree, clauses: searchClauses(search), limit,
            ...(sid === null ? {} : { session: sid }),
            ...(from === undefined ? {} : { after: [BigInt(from[1]), BigInt(from[2])] }),
            ...(search.trim() ? { scan: true } : {}),
            ...(scanCursor === undefined ? {} : { scanBelow: BigInt(scanCursor.slice(1)) }),
            ...(scanBytes === undefined ? {} : { scanBytes }),
        });
        return {
            rows: await this.listRows(tree, [...page.hits, ...page.scanned], withMetadata),
            more: page.more,
            exact: page.exact && page.scan === undefined,
            ...(page.next === undefined ? {} : { next: listCursor(page.next) }),
            ...(page.scan === undefined ? {} : { scanCursor: `m${page.scan}` }),
        };
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Actor} p.actor
     * @param {boolean} [p.group]
     */
    newChat({ tree, actor, group = false }) {
        return group ? this.goTo({ tree, node_id: null, actor }) : this.chooseCardGreeting({ tree, index: 0, actor });
    }

    /**
     * @param {object} p
     * @param {bigint} [p.before]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     */
    async recentSessions({ before, limit, withMetadata = false }) {
        const page = await this.store.chatRead('recent', { limit: limit + 1, ...(before === undefined ? {} : { before }) });
        const shown = page.slice(0, limit);
        const sessions = shown.length ? await this.store.chatRead('sessions', { ids: shown.map(e => e.session) }) : [];
        const entries = shown.map((e, i) => ({ sid: e.session, position: e.position, tree: sessions[i]?.tree ?? null, at: sessions[i]?.at ?? null }));
        return { rows: await this.sessionRows(entries, withMetadata), more: page.length > limit };
    }

    /**
     * @param {object} p
     * @param {bigint} [p.before]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     */
    async recentConversations({ before, limit, withMetadata = false }) {
        const page = await this.store.chatRead('conversations', { limit: limit + 1, ...(before === undefined ? {} : { before }) });
        const rows = [];
        for (const e of page.slice(0, limit)) {
            let at;
            if (e.bookmark !== null) {
                const [b] = await this.store.chatRead('bookmarks', { ids: [e.bookmark] });
                at = b?.at ?? null;
            } else {
                const where = await this.store.chatRead('sessionInTree', { session: e.session, tree: e.tree });
                at = where?.at ?? null;
            }
            const [row] = await this.listRows(e.tree, [{ bookmark: e.bookmark, session: e.bookmark === null ? e.session : null, at }], withMetadata);
            if (row.bookmark === null && row.session === null) continue;
            rows.push({ ...row, position: e.position, id: e.bookmark === null ? await this.conversationName(row.session, row.session, e.tree) : await this.bookmarkChatId(e.tree, e.bookmark), name: e.bookmark === null ? null : row.name });
        }
        return { rows, more: page.length > limit };
    }

    /**
     * @param {object} p
     * @param {string} p.session
     * @param {string | null} p.name
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, name: string | null }>}
     */
    nameSession({ session, name, actor }) {
        return this.serialized(`session:${session}`, async () => {
            const records = [];
            const { session: sid } = await this.actorIds({ ...actor, session }, records);
            const [now] = await this.store.chatRead('sessions', { ids: [sid] });
            if ((now?.name ?? null) === name) return { ok: true, name };
            records.push({ kind: 'positionName', id: sid, ...(name === null ? {} : { name }) });
            await this.store.commit(records);
            return { ok: true, name };
        });
    }

    /**
     * @param {string} session
     */
    deleteSession(session) {
        return this.serialized(`session:${session}`, async () => {
            const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [session] });
            if (sid === null) return { ok: false, reason: 'unknown session' };
            await this.store.commit([{ kind: 'positionDelete', id: sid }]);
            return { ok: true };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} [p.after]
     * @param {number} p.limit
     */
    async bookmarks({ tree, after, limit }) {
        const page = await this.store.chatRead('treeBookmarks', { tree, limit: limit + 1, ...(after === undefined ? {} : { after: BigInt(after) }) });
        const shown = page.slice(0, limit);
        const external = await this.externalIds(shown.flatMap(b => [b.at, b.createdAt]).filter(id => id !== null));
        let e = 0;
        const next = (/** @type {bigint | null} */ id) => (id === null ? null : external[e++]);
        const rows = shown.map(b => ({
            id: String(b.id),
            name: b.name,
            mode: b.mode === MODE.pinned ? 'pinned' : 'following',
            at: next(b.at),
            made_at: next(b.createdAt),
        }));
        return { rows, more: page.length > limit };
    }

    /**
     * @param {bigint} tree
     * @param {string} bookmark
     */
    async bookmarkOf(tree, bookmark) {
        if (!DECIMAL.test(bookmark)) return null;
        const [b] = await this.store.chatRead('bookmarks', { ids: [BigInt(bookmark)] });
        if (!b) return null;
        if (b.at === null) return b.root === tree ? b : null;
        const s = (await this.stored([b.at])).get(b.at);
        return s && s.owner === tree ? b : null;
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.bookmark
     * @param {{ name?: string | null, mode?: number, delete?: true }} p.change
     */
    changeBookmark({ tree, bookmark, change }) {
        return this.serialized(tree, async () => {
            const b = await this.bookmarkOf(tree, bookmark);
            if (!b) return { ok: false, reason: 'unknown bookmark' };
            const records = [];
            let name = b.name;
            if (change.delete) records.push({ kind: 'positionDelete', id: b.id });
            else {
                if (change.name !== undefined && change.name !== b.name) {
                    if (change.name === null || change.name.trim() === '') return { ok: false, reason: 'a chat needs a name' };
                    if (await this.nameTaken(tree, change.name, { bookmark: b.id })) return { ok: false, reason: 'name taken' };
                    name = change.name;
                    records.push({ kind: 'positionName', id: b.id, ...(name === null ? {} : { name }) });
                }
                if (change.mode !== undefined && change.mode !== b.mode) records.push({ kind: 'positionMode', id: b.id, mode: change.mode });
            }
            if (records.length) await this.store.commit(records);
            return change.delete ? { ok: true } : { ok: true, name };
        });
    }

    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.bookmark
     * @param {string | null} p.node_id
     * @returns {Promise<{ ok: true, moved: boolean } | { ok: false, reason: 'unknown bookmark' | 'unknown message' }>}
     */
    moveBookmark({ tree, bookmark, node_id }) {
        return this.serialized(tree, async () => {
            const b = await this.bookmarkOf(tree, bookmark);
            if (!b) return { ok: false, reason: 'unknown bookmark' };
            let at = null;
            if (node_id !== null) {
                [at] = await this.messageIds([node_id]);
                if (at === null) return { ok: false, reason: 'unknown message' };
            }
            if (at === b.at) return { ok: true, moved: false };
            await this.store.commit([{ kind: 'positionMove', id: b.id, time: this.now(), ...(at === null ? {} : { at }) }]);
            return { ok: true, moved: true };
        });
    }


    /**
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @param {string | null} [p.session]
     * @param {boolean} [p.full]
     */
    async load({ tree, at, session = null, full = false }) {
        let atId = null;
        if (at !== null) {
            [atId] = await this.messageIds([at]);
            if (atId === null) return null;
        }
        const ids = atId === null ? [] : await this.store.chatRead('path', { tree, at: atId });
        const stored = await this.stored(ids);
        /** @type {Map<string, bigint[]>} */
        const siblings = new Map();
        for (const id of ids) {
            const s = stored.get(id);
            const key = String(s.parent);
            if (siblings.has(key)) continue;
            const parent = s.parent === null ? undefined : stored.get(s.parent);
            siblings.set(key, parent?.replies === 1 ? [id] : await this.children(tree, s.parent));
        }
        const sent = new Set(ids);
        for (const id of ids) {
            const sibs = /** @type {bigint[]} */ (siblings.get(String(stored.get(id).parent)));
            const [from, to] = alternativeWindow(sibs.length, sibs.indexOf(id), full);
            for (let k = from; k < to; k++) sent.add(sibs[k]);
        }
        const allIds = [...sent];
        const others = await this.stored(allIds.filter(id => !stored.has(id)));
        const all = new Map([...stored, ...others]);
        const decodedList = await this.decoded(allIds.map(id => all.get(id)));
        const decoded = new Map(allIds.map((id, i) => [id, decodedList[i]]));
        const bookmarkIds = [...new Set(ids.flatMap(id => all.get(id).branches))];
        const bookmarks = bookmarkIds.length ? await this.store.chatRead('bookmarks', { ids: bookmarkIds }) : [];
        const labels = new Map(bookmarkIds.map((b, i) => [b, bookmarks[i]?.name]).filter(([, name]) => name));
        const messages = [];
        for (const id of ids) {
            const s = all.get(id);
            const msg = { ...decoded.get(id) };
            msg.node_id = this.externalId(s);
            const sibs = siblings.get(String(s.parent));
            if (sibs.length > 1) {
                const [from, to] = alternativeWindow(sibs.length, sibs.indexOf(id), full);
                const inWindow = (/** @type {number} */ k) => k >= from && k < to;
                msg.swipes = sibs.map((x, k) => (inWindow(k) ? decoded.get(x).mes ?? '' : null));
                msg.swipe_info = sibs.map((x, k) => {
                    if (!inWindow(k)) return null;
                    const o = decoded.get(x);
                    const extra = { ...(o.extra && typeof o.extra === 'object' && !Array.isArray(o.extra) ? o.extra : {}) };
                    if (all.get(x).itemized) extra[ITEMIZED_PROMPT_FLAG] = true;
                    return { send_date: o.send_date, extra, name: o.name, is_user: !!o.is_user, node_id: this.externalId(all.get(x)) };
                });
                msg.swipe_id = sibs.indexOf(id);
            }
            const made = s.branches.filter(b => labels.has(b)).map(b => labels.get(b));
            if (made.length) {
                if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
                msg.extra.bookmark_link = made[made.length - 1];
                msg.extra.branches = made;
            }
            if (s.itemized) msg.extra = { ...(msg.extra && typeof msg.extra === 'object' ? msg.extra : {}), [ITEMIZED_PROMPT_FLAG]: true };
            messages.push(msg);
        }
        return { messages, metadata: await this.metadata(tree, atId, session), node_id: atId === null ? null : this.externalId(/** @type {any} */ (stored.get(atId))) };
    }
}

/**
 * @param {[bigint, bigint]} key
 */
function listCursor(key) {
    return `${key[0]}:${key[1]}`;
}
