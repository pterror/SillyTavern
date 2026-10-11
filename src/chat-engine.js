import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { textEdit } from './text-edit.js';
import { META, TOP, decodeMessage, encodeMessage, messageRecords } from './chat-codec.js';
import { ITEMIZED_PROMPT_FLAG } from './message-tree-db.js';
import { jsonHash } from '../public/scripts/hash-utils.js';
import { bookKey } from './world-info-keys.js';
import { searchClauses } from './search-clauses.js';

/**
 * Chats on the engine (build path 5b): each character's or group's messages as a tree, sessions and bookmarks as
 * positions in it, the state (`chat_metadata`) at each message. Upstream's chat concepts exist only at the edges:
 * a "chat" read is a position's path assembled in upstream's shape.
 *
 * Ids outside: a message is named by the id it had before the engine (its outside key) or, made since, by its
 * integer as a decimal string; a session by its UUID; a user by their handle. Writes to one tree run one after
 * another, so each reads what the one before it stored.
 */

const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

/** `chatRead('ids')` spaces. */
const SPACE = Object.freeze({ message: 0, session: 1, user: 2 });

/** The namespace of a user's deterministic session in a tree (UUID v5 of `<handle>\0<tree id>`). */
export const SESSION_NAMESPACE = 'b3c3d5a0-6b5e-4f61-9d2e-5a0c1f7e9e21';

/** Bookmark modes. */
export const MODE = Object.freeze({ following: 1, pinned: 2 });

/** Characters of context a message search's snippet shows on each side of the match. */
const SNIPPET_CONTEXT = 80;

/**
 * A message's text around the first of `needles` it holds (lower-cased match), else its start.
 * @param {string} text
 * @param {string[]} needles Lower-cased.
 */
function snippetOf(text, needles) {
    const low = text.toLowerCase();
    const at = needles.map(n => low.indexOf(n)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const from = Math.max(0, at - SNIPPET_CONTEXT);
    const to = Math.min(text.length, at + SNIPPET_CONTEXT * 2);
    return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/** Names `nameSession()` tries before giving up, as upstream's `getUniqueName()`'s `maxTries`. */
const SESSION_NAME_TRIES = 1000;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** State change author kinds (`state.rs`), and the bit naming a variable. */
export const AUTHOR = Object.freeze({ user: 0, script: 1, model: 2, rule: 3, migration: 4 });
const VARIABLE = 8;
/** The author bit marking a change made while producing the message it hangs on (`state::PRODUCED`). */
const PRODUCED = 16;

/** `chat_metadata` keys the engine derives (`integrity` is the session's UUID): never stored, set or removed. */
const DERIVED_METADATA = new Set(['integrity', 'main_chat', 'fork_point', '_tree_stored']);

/**
 * The chat-bound lorebook (`chat_metadata.world_info`): a name is recorded as a link to the book its key finds, so it
 * follows the book's renames: `LINK`, the book's id, then a space and the name's JSON when the name isn't the key
 * itself (JSON text never starts with `LINK`). Any other value is recorded as it is.
 */
const WORLD_INFO = 'world_info';
const LINK = '\u0001';

/**
 * A new session's UUID (v7: its time, then random bits).
 */
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
 * A UUID v5.
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
 * A user's deterministic session in a tree: what a caller with no session lands through.
 * @param {string} handle
 * @param {bigint} tree
 */
export function defaultSessionKey(handle, tree) {
    return uuidV5(SESSION_NAMESPACE, `${handle}\0${tree}`);
}

/**
 * @typedef {{ key: string, variable?: boolean, value?: unknown }} StateOp A key set to a value, or removed (no
 * `value`); `variable`: the key is a chat variable's name.
 * @typedef {{ key: string, variable: boolean, json: string | null }} ProducedChange A change as recorded: the value's
 * JSON, null for a removal.
 */

/**
 * A state key's place in a map of the state: a variable and a metadata key of the same name are different keys.
 * @param {boolean} variable
 * @param {string} key
 */
function stateKey(variable, key) {
    return `${variable ? 'v' : 'k'}\u0000${key}`;
}

/**
 * The changes `ops` record against `state` (updated with them): each that changes a key's value, in order. The keys
 * the engine derives are never set.
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
 * Whether `base` is a save's base: a list of `{ id, alternatives? }`, every id a string.
 * @param {unknown} base
 * @returns {base is SaveBase}
 */
function isSaveBase(base) {
    return Array.isArray(base) && base.every(e => e && typeof e === 'object' && typeof e.id === 'string'
        && (e.alternatives === undefined || (Array.isArray(e.alternatives) && e.alternatives.every((/** @type {unknown} */ a) => typeof a === 'string'))));
}

/**
 * A message's identity among its siblings: who said it and its text (a user's by persona, else by name).
 * @param {Record<string, any>} m
 */
function identityOf(m) {
    const speaker = m?.is_user ? `u\u0001${m?.persona ?? m?.name ?? ''}` : `c\u0001${m?.name ?? ''}`;
    return `${speaker}\u0000${m?.mes ?? ''}`;
}

/**
 * A message as it is stored: without what reads derive (ids, swipe arrays, `branches`, `bookmark_link`, the
 * itemized flag, a token count).
 * @param {Record<string, any>} msg
 * @returns {Record<string, any>}
 */
export function storedForm(msg) {
    const clone = { ...msg };
    for (const k of ['node_id', 'swipes', 'swipe_id', 'swipe_info', 'swipe_speaker_default', '_unchanged']) delete clone[k];
    if (clone.extra && typeof clone.extra === 'object') {
        clone.extra = { ...clone.extra };
        for (const k of ['branches', 'bookmark_link', ITEMIZED_PROMPT_FLAG, 'token_count']) delete clone.extra[k];
    }
    return JSON.parse(JSON.stringify(clone));
}

/**
 * A message of upstream's chat array as the alternatives it stands for, each as stored: its `swipes` (a hole is one
 * the page wasn't sent, left out; the shown one's text is `mes`), with their `swipe_info`, and which is shown, and
 * the id each claims (`swipe_info[i].node_id`, the shown one's also `node_id`).
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
    for (let i = 0; i < rawSwipes.length; i++) {
        if (typeof rawSwipes[i] !== 'string') continue;
        const info = rawInfo[i];
        kept.push({
            text: i === rawSel && typeof msg.mes === 'string' ? msg.mes : rawSwipes[i],
            info,
            wasSelected: i === rawSel,
            nodeId: info && typeof info === 'object' && info.node_id != null ? info.node_id : (i === rawSel ? msg.node_id ?? null : null),
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
 * Whether writing `incoming` over `stored` would replace its text with nothing: a page echoing a slot it wasn't
 * sent, not an edit.
 * @param {Record<string, any>} stored
 * @param {Record<string, any>} incoming
 */
function blanksText(stored, incoming) {
    return (stored?.mes ?? '').length > 0 && (incoming?.mes ?? '').length === 0;
}

/**
 * An alternative as the alternatives and openings lists show it.
 * @param {string} nodeId
 * @param {Record<string, any>} o The message.
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
 * @typedef {object} People Who speaks: characters by entity id and by avatar.
 * @property {(ids: bigint[]) => Promise<Map<bigint, Speaker>>} speakers
 * @property {(avatars: string[]) => Promise<Map<string, Speaker>>} byAvatar
 * @property {Books} [books] World books, for lorebook links (without: a lorebook name is an ordinary value).
 */

/**
 * @typedef {object} Books
 * @property {<T>(keys: string[], fn: () => Promise<T>) => Promise<T>} lane Runs `fn` in these book keys' lanes.
 * @property {(key: string) => Promise<bigint | null>} find The book (or unresolved name) a key finds.
 * @property {() => bigint} newId An entity id for an unresolved name made here.
 * @property {(ids: bigint[]) => Promise<({ key: string | null } | null)[]>} resolved Each book as it resolves.
 */

/**
 * @typedef {object} Actor Who acts, and through which session (none: the change moves no pointer).
 * @property {string} user The user's handle.
 * @property {string | null} [session] The session's UUID.
 */

/**
 * @typedef {object} EditRequest A deleting edit of a tree.
 * @property {bigint} tree
 * @property {Actor} actor
 * @property {boolean} [preview] Answers what the edit would drop besides the messages, writing nothing.
 * @property {{ bookmarks?: string[], changes?: string[] } | 'any'} [confirm] The ids of what it drops besides the
 * messages, as a preview named them: an edit dropping anything else is refused. `'any'`: a caller that can't confirm
 * (upstream's compat paths) applies it whatever it drops, and the answer lists the drops.
 */

/**
 * @typedef {{ bookmarks: { id: string, name: string | null, node_id: string }[], changes: { id: string, key: string | number, variable: boolean, node_id: string | null }[] }} Drops
 * @typedef {{ ok: true, preview?: true, drops?: Drops } | { ok: false, reason: string, drops?: Drops }} EditAnswer
 * @typedef {{ id: string, alternatives?: string[] }[]} SaveBase The messages a page knew, in its chat's order: each
 * its shown message's id and its alternatives' ids.
 */

export class ChatEngine {
    /**
     * @param {any} store The engine's `Store`.
     * @param {People} people
     * @param {{ message: bigint, position: bigint, user: bigint, change: bigint }} next
     */
    constructor(store, people, next) {
        this.store = store;
        this.people = people;
        this.next = { ...next };
        /** @type {Map<string, Promise<unknown>>} */
        this.writing = new Map();
        this.now = () => Date.now();
    }

    /**
     * @param {any} store
     * @param {People} people
     */
    static async open(store, people) {
        return new ChatEngine(store, people, await store.chatRead('nextIds', {}));
    }

    /**
     * Runs `write` after every earlier write to the same tree (or session, named `session:<uuid>`) has settled.
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

    // ---- ids ----

    /**
     * The integer of each outside message id, or null.
     * @param {string[]} externals
     * @returns {Promise<(bigint | null)[]>}
     */
    async messageIds(externals) {
        const mapped = await this.store.chatRead('ids', { space: SPACE.message, keys: externals });
        const decimals = externals.map((e, i) => (mapped[i] === null && DECIMAL.test(e) ? BigInt(e) : null));
        const toCheck = decimals.filter(d => d !== null);
        const found = toCheck.length ? await this.store.chatRead('messages', { ids: toCheck }) : [];
        const exists = new Set(found.filter(Boolean).map(m => m.id));
        return externals.map((_, i) => mapped[i] ?? (decimals[i] !== null && exists.has(decimals[i]) ? decimals[i] : null));
    }

    /**
     * A message's outside id.
     * @param {{ id: bigint, oldKey: string | null }} stored
     */
    externalId(stored) {
        return stored.oldKey ?? String(stored.id);
    }

    /**
     * The id of an outside key in a space, and the records making it when it names nothing yet.
     * @param {number} space
     * @param {string} key
     * @param {'position' | 'user'} counter
     * @param {object[]} records Gets the `keyMap` record of a new id.
     */
    async idOf(space, key, counter, records) {
        const [id] = await this.store.chatRead('ids', { space, keys: [key] });
        if (id !== null) return id;
        const made = this.next[counter]++;
        records.push({ kind: 'keyMap', [space === SPACE.user ? 'user' : 'session']: made, key: Buffer.from(key, 'utf8') });
        return made;
    }

    /**
     * The actor's ids, making the user's and session's keys when they have none.
     * @param {Actor} actor
     * @param {object[]} records
     */
    async actorIds(actor, records) {
        const user = await this.idOf(SPACE.user, actor.user, 'user', records);
        const session = actor.session ? await this.idOf(SPACE.session, actor.session, 'position', records) : null;
        return { user, session };
    }

    // ---- sessions ----

    /**
     * The session a request acts through, and the identifier upstream's compat values name it by
     * (`getCurrentChatId()`, `characters[].chat`, `group.chat_id`):
     * - an `X-ST-Session` header's UUID: that session;
     * - `none` (a tab with no session yet), or a deleted session's UUID (`gone` says so): no session, so the tree is
     *   landed in through the cascade, and the identifier is the user's deterministic one in the tree; a write then
     *   acts through a new session (`newSessionKey()`), which the tab keeps;
     * - no header (a caller with no tab): the user's last session in the tree, else the deterministic one, made on
     *   its first move.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.user The user's handle.
     * @param {string | null | undefined} p.header
     * @returns {Promise<{ session: string | null, identifier: string, gone?: true }>}
     */
    async resolveSession({ tree, user, header }) {
        if (header === undefined || header === null) {
            const [uid] = await this.store.chatRead('ids', { space: SPACE.user, keys: [user] });
            const last = uid === null ? null : await this.store.chatRead('userInTree', { user: uid, tree });
            if (last !== null) {
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
     * Where a session's pointer is: its tree and the message's outside id (null: the tree's root); null for a
     * session that hasn't moved.
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
     * The session named exactly `name` (its UUID), or null: what a route taking a chat name resolves it to. Names
     * are unique in the store, which is the owner's: every user acting in it shares them, as upstream's chat file
     * names in a user data directory, so a session moving between trees keeps its name and never clashes.
     * @param {string} name
     * @returns {Promise<string | null>}
     */
    async sessionNamed(name) {
        const ids = await this.store.chatRead('sessionsNamed', { name });
        if (ids.length === 0) return null;
        const [row] = await this.store.chatRead('sessions', { ids: [ids[0]] });
        return row?.key ?? null;
    }

    // ---- reads ----

    /**
     * Stored messages by id (absent ones left out).
     * @param {bigint[]} ids
     * @returns {Promise<Map<bigint, any>>}
     */
    async stored(ids) {
        const unique = [...new Set(ids)];
        const found = unique.length ? await this.store.chatRead('messages', { ids: unique }) : [];
        return new Map(found.filter(Boolean).map(m => [m.id, m]));
    }

    /**
     * Each stored message's upstream object.
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
        return stored.map(s => JSON.parse(decodeMessage(s, id => speakers.get(id) ?? null)));
    }

    /**
     * Every reply of a message (null: the tree's openings), in order.
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
     * The speaker of a message about to be stored: the character named by its `original_avatar`, else (a
     * character's message in a character's tree) the tree's character.
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
     * The actor's ids where they have them (nothing is made).
     * @param {Actor} actor
     * @returns {Promise<{ user: bigint | null, session: bigint | null }>}
     */
    async knownActorIds(actor) {
        const [user] = await this.store.chatRead('ids', { space: SPACE.user, keys: [actor.user] });
        const [session] = actor.session ? await this.store.chatRead('ids', { space: SPACE.session, keys: [actor.session] }) : [null];
        return { user, session };
    }

    // ---- alternatives and openings ----

    /**
     * The alternatives at a message: every reply sharing its parent (the tree's openings for an opening), in order,
     * a window of them, and the message's index.
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
     * The tree's openings in order, each stored and as upstream's object.
     * @param {bigint} tree
     */
    async openings(tree) {
        const ids = await this.children(tree, null);
        const stored = await this.stored(ids);
        const decoded = await this.decoded(ids.map(id => stored.get(id)));
        return ids.map((id, i) => ({ id, stored: stored.get(id), message: decoded[i] }));
    }

    /**
     * The card's greetings that no stored opening already is (same speaker and text), as stored.
     * @param {{ message: Record<string, any> }[]} rows The stored openings.
     * @param {Record<string, any>[]} cardGreetings
     */
    unstoredGreetings(rows, cardGreetings) {
        const seen = new Set(rows.map(r => identityOf(r.message)));
        const out = [];
        for (const greeting of Array.isArray(cardGreetings) ? cardGreetings : []) {
            const o = storedForm(greeting);
            const key = identityOf(o);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(o);
        }
        return out;
    }

    /**
     * The openings a tree can start on: its stored openings, then the card's greetings no stored opening already is
     * (`node_id` null), windowed around the default (or around `around`, a stored opening with that speaker and
     * text). The default is the opening of where the actor's session lands in the tree; at the tree's root, the card
     * greeting the session chose there (`default_chosen`), else the first.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Actor} p.actor
     * @param {{ offset?: number, limit?: number, around?: Record<string, any> }} [p.range]
     * @param {Record<string, any>[]} [p.cardGreetings]
     */
    async openingAlternatives({ tree, actor, range = {}, cardGreetings = [] }) {
        // Anything saved: the tree stores a message (upstream's meaning: a chat file exists).
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
        // At the root, a card greeting the session chose shows the text the card has at its position now.
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
     * Where a chat showing a card greeting lands among the tree's openings (stored first, then the card's
     * greetings no stored opening already is), from the whole list:
     * 1. the first opening with exactly the shown text (so a stored one before a card greeting);
     * 2. else, when this page's own edit took the shown text elsewhere, the first opening with the edit's new text,
     *    or with the text now at the edit's card position;
     * 3. else the opening at the index the chat was on, clamped to the openings there are now.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Record<string, any>[]} p.cardGreetings
     * @param {string[]} p.cardTexts The card's greeting list, by card position.
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

    // ---- writes ----

    /**
     * Makes sure these openings exist in the tree, each as stored, without showing them to anyone: one with the
     * same speaker and text as a stored opening is that opening; one with blank text is left out (`null`).
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
                records.push(...messageRecords(id, encodeMessage(content, time, speaker), { parent: null, owner: tree, time, session: null, user, sendKey: null }));
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
     * Stores messages after a message (null: as the tree's openings), each after the one before, each with the state
     * changes made while producing it (hung on it, marked as its own). A message whose send key the tree already
     * stored is not stored again. A message matching a reply already there (same speaker and text, and the same
     * changes made while producing it) is that reply, so nothing is recorded twice; the same text with other changes
     * is stored as an alternative of its own. Through a session, the session moves to each and chooses it.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker The tree's character (null for a group).
     * @param {string | null} p.after The outside id of the message to reply to.
     * @param {Record<string, any>[]} p.contents Messages as stored today (after `sanitizeForStorage()`).
     * @param {(string | null)[]} [p.sendKeys]
     * @param {(StateOp[] | null | undefined)[]} [p.changes] Per message, the state changes made while producing it,
     * in order (as `changeState`'s ops: a key whose value is already that records nothing).
     * @param {number} [p.author] The changes' author kind.
     * @param {string | null} [p.ref] The changes' author reference.
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: boolean, reason?: string, node_ids: string[], already_stored?: string[] }>}
     */
    appendMessages({ tree, treeSpeaker, after, contents, sendKeys = [], changes = [], author = AUTHOR.user, ref = null, actor }) {
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
            // The state at the cursor, while it is a message made in this write (null: read it from the store).
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
                const twin = await this.twinOf(tree, cursor, content, ids, produced);
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
                records.push(...messageRecords(id, encodeMessage(content, time, speaker), { parent: cursor, owner: tree, time, session, user, sendKey: key }));
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
            if (records.length) await this.store.commit(records);
            const external = await this.externalIds(ids);
            const answer = { ok: true, node_ids: external };
            if (already.length) answer.already_stored = already.map(id => external[ids.indexOf(id)]);
            return answer;
        }));
    }

    /**
     * The state at a message (null: the tree's root) as shown, each key (`stateKey()`) to its value's JSON.
     * @param {bigint} tree
     * @param {bigint | null} at
     */
    async stateMap(tree, at) {
        const state = await this.shownState(await this.store.chatRead('state', { tree, ...(at === null ? {} : { at }) }));
        return new Map(state.map(e => [stateKey(e.variable, e.field), e.json]));
    }

    /**
     * The records choosing `reply` at its fork and moving the session to it.
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
     * A reply of `parent` (null: an opening of the tree) with the same speaker and text as `content`, or null.
     * With `produced`, the reply's own changes (those made while producing it) must be those too.
     * @param {bigint} tree
     * @param {bigint | null} parent
     * @param {Record<string, any>} content
     * @param {bigint[]} written Ids made earlier in this write (not stored yet: they can't be twins).
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
     * Each id's outside id.
     * @param {bigint[]} ids
     */
    async externalIds(ids) {
        const stored = await this.stored(ids);
        return ids.map(id => {
            const s = stored.get(id);
            return s ? this.externalId(s) : String(id);
        });
    }

    /**
     * The records turning a stored message into `content`: only the values that differ.
     * @param {any} stored
     * @param {Record<string, any>} content
     * @param {Speaker | null} speaker
     */
    editRecords(stored, content, speaker) {
        const id = stored.id;
        const before = new Map(stored.values.map(v => [v.field, v.json]));
        const beforeTimes = new Map(stored.times.map(t => [t.field, t.delta]));
        const beforeText = stored.texts.find(t => t.field === TOP.mes)?.text;
        const enc = encodeMessage(content, stored.time, speaker);
        const records = [];
        // The append's fixed slots are never rewritten: a change of them is a value of its own.
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
     * Replaces messages' contents, each its own outside id; refuses one that would blank stored text or match a
     * sibling, and reports it. An edit's `changes` are the state changes made while producing it (a reply
     * continued), hung on the message as its own, as `appendMessages()` hangs a reply's, in the same commit.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {{ node_id: string, content: Record<string, any>, changes?: StateOp[] | null }[]} p.edits
     * @param {number} [p.author] The changes' author kind.
     * @param {string | null} [p.ref] The changes' author reference.
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
                const next = JSON.parse(JSON.stringify(edit.content));
                const now = /** @type {Record<string, any>} */ (decoded.get(id));
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
                if (s.parent !== null) {
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
            if (records.length) await this.store.commit(records);
            return { ok: true, applied, refused };
        }));
    }

    /**
     * Chooses a reply at its fork through a session (the route resolves which): swiping. The choice is recorded, and
     * the session goes down that branch along the fork choices (its own, else its user's, else anyone's last, else the
     * newest reply) to its end, so swiping back restores the conversation: no choice made below is dropped.
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
            await this.store.commit(records);
            return true;
        });
    }

    /**
     * Moves a session to a message of the tree (null: its root, nothing shown yet), as opening a search result
     * does. Nothing is written when it is there already.
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
            records.push(id === null ? { kind: 'pointerRoot', session, user, tree } : { kind: 'pointerMove', session, user, target: id });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * Steps a session back (or forward) in its history: its pointer goes to the nearest entry in that direction whose
     * target is still there, and no entry is added.
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
            records.push({ kind: 'historyStep', session, user, n: reached.n });
            await this.store.commit(records);
            return { ok: true, tree, at: reached.target === null ? null : (await this.externalIds([reached.target]))[0] };
        });
    }

    /**
     * Chooses, for a session, the card greeting at `index` in the card's greeting list, with no message stored: the
     * session goes to the tree's root and shows that greeting's text as the card has it, until a reply is sent from
     * it (which stores it) or a stored opening is chosen.
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
            if (!atRoot) records.push({ kind: 'pointerRoot', session, user, tree });
            records.push({ kind: 'openingChoice', session, user, tree, index });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * Inserts a message between `after` and its reply `before`, which moves under it.
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
            let id = await this.twinOf(tree, a, content, []);
            if (id === null) {
                id = this.next.message++;
                const time = this.now();
                const speaker = await this.speakerFor(content, treeSpeaker);
                records.push(...messageRecords(id, encodeMessage(content, time, speaker), { parent: a, owner: tree, time, session, user, sendKey: sendKey ? Buffer.from(sendKey, 'utf8') : null }));
            } else if (session !== null) {
                records.push(...this.moveTo(session, user, a, id));
            }
            records.push({ kind: 'messageParent', message: b, parent: id, user, ...(session === null ? {} : { session }) });
            if (session !== null) records.push(...this.moveTo(session, user, id, b));
            await this.store.commit(records);
            return { ok: true, node_id: (await this.externalIds([id]))[0] };
        });
    }

    /**
     * Takes `first` .. `last` (a run of replies, each the next's parent) out of the path: the reply of `last`
     * that a session follows moves under `first`'s parent.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.first
     * @param {string} p.last
     * @param {Actor} p.actor
     */
    degraftRange({ tree, first, last, actor }) {
        return this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            const [f, l] = await this.messageIds([first, last]);
            const stored = await this.stored([f, l].filter(x => x !== null));
            const sf = f === null ? undefined : stored.get(f);
            if (!sf || sf.owner !== tree || sf.parent === null) return { ok: false, reason: 'unknown node' };
            let cur = /** @type {bigint} */ (f);
            const seen = new Set([cur]);
            while (cur !== l) {
                const next = await this.followedReply(tree, cur, session, user);
                if (next === null || seen.has(next)) return { ok: false, reason: 'not on default path' };
                seen.add(next);
                cur = next;
            }
            const child = await this.followedReply(tree, cur, session, user);
            if (child === null) return { ok: false, reason: 'use end-path instead' };
            records.push({ kind: 'messageParent', message: child, parent: sf.parent, user, ...(session === null ? {} : { session }) });
            if (session !== null) records.push(...this.moveTo(session, user, sf.parent, child));
            await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * The reply followed below a message by a session and user.
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
     * Swaps a message and its reply (the reply moves up, and the message under it).
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
            await this.store.commit(records);
            return { ok: true };
        });
    }

    // ---- deletes and cuts ----
    //
    // An operation on a path removes only what belongs to it alone; a message another branch passes through stays.
    // Deleting a subtree is one `subtreeDelete` record per root, carried out in slices by the engine; what is at its
    // messages moves to the root's parent, except pinned bookmarks (and following ones with nowhere to move), which
    // go. Whatever goes besides the messages (those bookmarks, the state changes on the messages) is the answer of a
    // `preview`, and a delete that drops any of it is refused unless `confirm` names exactly those, so the warning
    // the page shows lists exactly what goes even when someone else changed the tree meanwhile.

    /**
     * What deleting the subtrees of `roots` drops besides the messages (the subtrees of `keep` left out: they move
     * away first), and with `root` what clearing the tree's root state drops: bookmarks (`id`, `name`, the message
     * it is at) and state changes (`id`, `key`, whether a variable's, the message it hangs on, null at the root).
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
     * Previews or applies a planned edit: `records` first (copies, moves, choices, a pointer move), then a
     * `subtreeDelete` of each root, then with `root` a `rootStateClear` of the tree.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {{ roots: bigint[], keep?: bigint[], records?: object[], root?: boolean }} p.plan
     * @param {{ user: bigint, session: bigint | null }} p.who
     * @param {object[]} p.keys The actor's new outside keys.
     * @param {boolean} [p.preview]
     * @param {{ bookmarks?: string[], changes?: string[] }} [p.confirm]
     * @returns {Promise<EditAnswer>}
     */
    async applyEdit({ tree, plan, who, keys, preview, confirm }) {
        const drops = await this.dropsOf(tree, plan.roots, plan.keep ?? [], plan.root);
        if (preview) return { ok: true, preview: true, drops };
        const same = (/** @type {string[] | undefined} */ named, /** @type {{ id: string }[]} */ found) =>
            new Set(named ?? []).size === found.length && found.every(x => (named ?? []).includes(x.id));
        const any = confirm === 'any';
        if (!any && (drops.bookmarks.length || drops.changes.length) && !(same(confirm?.bookmarks, drops.bookmarks) && same(confirm?.changes, drops.changes))) {
            return { ok: false, reason: 'confirm', drops };
        }
        const actorPart = { user: who.user, ...(who.session === null ? {} : { session: who.session }) };
        const records = [...keys, ...(plan.records ?? []), ...plan.roots.map(message => ({ kind: 'subtreeDelete', message, ...actorPart }))];
        if (plan.root && drops.changes.some(c => c.node_id === null)) records.push({ kind: 'rootStateClear', tree });
        if (records.length > keys.length) await this.store.commit(records);
        return any ? { ok: true, drops } : { ok: true };
    }

    /**
     * A message of the tree, stored, or null.
     * @param {bigint} tree
     * @param {string} nodeId
     */
    async messageOf(tree, nodeId) {
        const [id] = await this.messageIds([nodeId]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        return s && s.owner === tree ? s : null;
    }

    /**
     * The path a session shows in the tree (root to its pointer), or null when it isn't in the tree.
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
     * Runs an edit of the tree: `plan` gets the actor's ids and answers the edit, or a refusal.
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
     * Deletes this message and everything below it ("delete this swipe and all descendants").
     * @param {EditRequest & { node_id: string }} p
     */
    deleteSubtree(p) {
        return this.edit(p, async () => {
            const s = await this.messageOf(p.tree, p.node_id);
            return s ? { roots: [s.id] } : { ok: false, reason: 'unknown node' };
        });
    }

    /**
     * Deletes every alternative at this message's position and everything below them ("delete all swipes from
     * here and all descendants"); at an opening, every opening: the whole tree.
     * @param {EditRequest & { node_id: string }} p
     */
    deleteAlternatives(p) {
        return this.edit(p, async () => {
            const s = await this.messageOf(p.tree, p.node_id);
            return s ? { roots: await this.children(p.tree, s.parent) } : { ok: false, reason: 'unknown node' };
        });
    }

    /**
     * Deletes a whole tree (its character or group deleted with its chats): every opening and everything below, the
     * bookmarks at its root and the state changes hanging there. Applied whatever it drops; the answer lists the
     * drops.
     * @param {{ tree: bigint, actor: Actor }} p
     */
    deleteTree({ tree, actor }) {
        return this.edit({ tree, actor, confirm: 'any' }, async () => {
            /** @type {object[]} */
            const records = [];
            let after;
            for (;;) {
                const page = await this.bookmarks({ tree, after, limit: 500 });
                for (const b of page.rows) if (b.at === null) records.push({ kind: 'positionDelete', id: BigInt(b.id) });
                if (!page.more) break;
                after = page.rows[page.rows.length - 1].id;
            }
            return { roots: await this.children(tree, null), records, root: true };
        });
    }

    /**
     * Deletes everything below this message, every branch; the message stays ("delete all descendants but keep
     * swipe").
     * @param {EditRequest & { node_id: string }} p
     */
    deleteBelow(p) {
        return this.edit(p, async () => {
            const s = await this.messageOf(p.tree, p.node_id);
            return s ? { roots: await this.children(p.tree, s.id) } : { ok: false, reason: 'unknown node' };
        });
    }

    /**
     * Deletes the session's path from this message down to its end, only the messages no other branch uses: from
     * the end up to the first message with another branch under it ("delete this path"). The path is what the
     * session shows (root to its pointer); replies below the pointer are other branches.
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
     * Cuts `first` .. `last` out of the session's path ("cut from this path", upstream's `/cut`): the path forks at
     * the message before the cut and goes on as a new branch without it; messages after the cut that other branches
     * share get their own copies on the new branch (with the state changes in effect on them), and those only this
     * path uses move under them; other paths are untouched; the cut messages go only where nothing else passes
     * through them.
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
            // Messages from `k` to the end are this path's alone (none after a cut that reaches the end).
            let k = end + 1;
            if (li < end && replies(end) === 0) {
                k = end;
                while (k - 1 > li && replies(k - 1) === 1) k--;
            }
            const before = fi > 0 ? path[fi - 1] : null;
            const records = [];
            /** @type {bigint | null} */
            let parent = before;
            /** @type {bigint | null} */
            let first = null;
            for (let i = li + 1; i < k; i++) {
                const id = this.next.message++;
                records.push(...await this.copyRecords(stored.get(path[i]), id, parent, user));
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
                records.push(newEnd === null ? { kind: 'pointerRoot', session, user, tree: p.tree } : { kind: 'pointerMove', session, user, target: newEnd });
            }
            // The cut messages nothing else passes through once the tail moved away: from the cut's last up.
            const moved = k === li + 1 && k <= end;
            if (replies(li) - (moved ? 1 : 0) > 0) return { roots: [], records };
            let t = li;
            while (t - 1 >= fi && replies(t - 1) === 1) t--;
            return { roots: [path[t]], keep: moved ? [path[k]] : [], records };
        });
    }

    /**
     * Cuts `first` .. `last` out of the tree ("cut everywhere"): every path through them closes the gap, each reply
     * of theirs that isn't the next of them moving under the message before the cut, and they go.
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
     * The session's path and the places of `first` and `last` on it, or a refusal.
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
     * The records of a copy of a stored message under `parent` (null: an opening), made by `user`: its append, every
     * value, text and time it holds, its itemization and the state changes in effect on it. Nothing is shown by it.
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

    // ---- bookmarks ----

    /**
     * The name a bookmark of the tree can take: `name`, or with upstream's suffix (`getUniqueName()`: `name (1)`,
     * `name (2)`, ... up to 1000 tries) when another bookmark of the tree holds it; null when none is free.
     * @param {bigint} tree
     * @param {string} name
     * @param {bigint | null} self The bookmark being named (it may keep its own name).
     */
    async freeBookmarkName(tree, name, self) {
        for (let i = 0; i < SESSION_NAME_TRIES; i++) {
            const candidate = i === 0 ? name : `${name} (${i})`;
            const held = await this.store.chatRead('bookmarksNamed', { tree, name: candidate });
            if (held.every((/** @type {bigint} */ b) => b === self)) return candidate;
        }
        return null;
    }

    /**
     * Makes a bookmark at a message, or at the tree's root (`node_id` null). Bookmark names are unique in a tree (as
     * upstream's chat names were per character): a name another bookmark holds gets upstream's suffix.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.node_id
     * @param {string | null} p.name
     * @param {number} [p.mode]
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, bookmark: bigint, name: string | null } | { ok: false, reason: 'unknown node' | 'no free name' }>}
     */
    createBookmark({ tree, node_id, name, mode = MODE.following, actor }) {
        return this.serialized(tree, async () => {
            const s = node_id === null ? null : await this.messageOf(tree, node_id);
            if (node_id !== null && !s) return { ok: false, reason: 'unknown node' };
            const records = [];
            const actorIds = await this.actorIds(actor, records);
            if (actorIds.session === null) throw new Error('A bookmark is made through a session');
            const free = name === null ? null : await this.freeBookmarkName(tree, name, null);
            if (name !== null && free === null) return { ok: false, reason: 'no free name' };
            const b = this.next.position++;
            const where = s === null ? { kind: 'positionRoot', tree } : { kind: 'positionCreate', pointer: s.id };
            records.push({ id: b, mode, session: actorIds.session, user: actorIds.user, ...where });
            if (free !== null) records.push({ kind: 'positionName', id: b, name: free });
            await this.store.commit(records);
            return { ok: true, bookmark: b, name: free };
        });
    }

    /**
     * What a route's chat name names in the tree: the bookmark with that name, else the session with that name in
     * the store, else nothing (upstream's "not found").
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.name
     * @returns {Promise<{ bookmark: bigint } | { session: string } | null>}
     */
    async resolveChatName({ tree, name }) {
        const [b] = await this.store.chatRead('bookmarksNamed', { tree, name });
        if (b !== undefined) return { bookmark: b };
        const session = await this.sessionNamed(name);
        return session === null ? null : { session };
    }

    // ---- a whole chat saved (upstream's `saveChat`) ----

    /**
     * Stores upstream's whole chat array (`[header, ...messages]`) as the session's conversation in the tree, writing
     * only what differs: each message matched by its id when it still replies to the message before it (its
     * alternatives by their ids, a changed one edited unless that would blank stored text, one matching a sibling's
     * speaker and text taken as that sibling), anything else stored as new; the shown alternative at each message
     * chosen; a message's `bookmark_link` a bookmark made there; the session moved to the last message; the header's
     * `chat_metadata` the state there (keys it lacks removed). A header whose `integrity` isn't the session's UUID
     * is refused unless `force`. The deletes the chat asks for are applied first (`saveDeletes()`): what they dropped
     * is answered in `dropped`, those refused in `deletes_refused`.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {any[]} p.chat
     * @param {Actor} p.actor Through a session.
     * @param {boolean} [p.force]
     * @param {SaveBase} [p.base] The messages the page knew; absent for a caller that isn't our page.
     * @returns {Promise<{ ok: true, integrity: string, assigned_node_ids: { index: number, node_id: string }[], dropped?: Drops, deletes_refused?: { node_id: string, reason: string }[] } | { ok: false, reason: 'integrity' | 'bad base' } | { empty: true }>}
     */
    async saveChat({ tree, treeSpeaker, chat, actor, force = false, base }) {
        if (!actor.session) throw new Error('A chat is saved through a session');
        if (!Array.isArray(chat) || chat.length === 0) return { empty: true };
        const header = chat[0] ?? {};
        const incoming = header.chat_metadata?.integrity;
        if (!force && typeof incoming === 'string' && incoming !== actor.session) return { ok: false, reason: 'integrity' };
        if (base !== undefined && !isSaveBase(base)) return { ok: false, reason: 'bad base' };
        const messages = chat.slice(1);
        const { dropped, refused } = await this.saveDeletes(tree, messages, actor, base);
        const written = await this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            const sessionId = /** @type {bigint} */ (session);
            const now = this.now();
            /** @type {{ index: number, id: bigint }[]} */
            const assigned = [];
            /** @type {bigint | null} */
            let parent = null;
            let movedByAppend = false;
            const claimed = await this.messageIds(messages.map(m => (m?.node_id == null ? '' : String(m.node_id))));
            const known = await this.stored(claimed.filter(id => id !== null));
            for (const [i, msg] of messages.entries()) {
                const id = claimed[i];
                const row = id === null ? undefined : known.get(id);
                const level = await this.level(tree, parent);
                if (row && row.owner === tree && row.parent === parent) {
                    let chosen = row.id;
                    if (msg._unchanged !== true) {
                        const { contents, selected, nodeIds } = alternativesOf(msg);
                        const ids = await this.messageIds(nodeIds.map(n => n ?? ''));
                        for (const [k, content] of contents.entries()) {
                            const existing = ids[k] !== null && level.byId.has(ids[k]) ? ids[k] : null;
                            let sid;
                            if (existing !== null) {
                                sid = existing;
                                const before = level.byId.get(existing);
                                if (JSON.stringify(before) !== JSON.stringify(content) && !blanksText(before, content)) {
                                    const twin = level.twin(content, existing);
                                    if (twin !== null) sid = twin;
                                    else {
                                        const changed = this.editRecords(level.stored.get(existing), content, await this.speakerFor(content, treeSpeaker));
                                        records.push(...changed.map(r => ({ ...r, session: sessionId, user })));
                                        level.set(existing, content);
                                    }
                                }
                            } else {
                                sid = level.twin(content, null);
                                if (sid === null) {
                                    sid = this.next.message++;
                                    const time = now + k;
                                    const through = k === selected ? sessionId : null;
                                    records.push(...messageRecords(sid, encodeMessage(content, time, await this.speakerFor(content, treeSpeaker)), { parent, owner: tree, time, session: through, user, sendKey: null }));
                                    level.add(sid, content);
                                }
                            }
                            if (k === selected) chosen = sid;
                        }
                        await this.bookmarkLinkRecords(tree, msg, chosen, sessionId, user, records);
                    }
                    movedByAppend = await this.chooseIn(records, tree, parent, chosen, sessionId, user);
                    parent = chosen;
                    continue;
                }
                if (msg?._unchanged === true) continue;
                const { contents, selected } = alternativesOf(msg);
                let chosen = null;
                for (const [k, content] of contents.entries()) {
                    let sid = level.twin(content, null);
                    if (sid === null) {
                        sid = this.next.message++;
                        const time = now + k;
                        const through = k === selected ? sessionId : null;
                        records.push(...messageRecords(sid, encodeMessage(content, time, await this.speakerFor(content, treeSpeaker)), { parent, owner: tree, time, session: through, user, sendKey: null }));
                        level.add(sid, content);
                    }
                    if (k === selected) chosen = sid;
                }
                const chosenId = /** @type {bigint} */ (chosen);
                assigned.push({ index: i, id: chosenId });
                movedByAppend = await this.chooseIn(records, tree, parent, chosenId, sessionId, user);
                await this.bookmarkLinkRecords(tree, msg, chosenId, sessionId, user, records);
                parent = chosenId;
            }
            if (!movedByAppend) {
                const [where] = await this.store.chatRead('sessions', { ids: [sessionId] });
                const there = !!where && where.tree === tree && where.at === parent;
                if (!there) records.push(parent === null ? { kind: 'pointerRoot', session: sessionId, user, tree } : { kind: 'pointerMove', session: sessionId, user, target: parent });
            }
            if (records.some(r => r.kind !== 'keyMap')) await this.store.commit(records);
            return { at: parent, assigned };
        });
        const metadata = { ...(header.chat_metadata ?? {}) };
        const atExternal = written.at === null ? null : (await this.externalIds([written.at]))[0];
        const current = await this.metadata(tree, written.at);
        const unset = Object.keys(current).filter(k => !Object.hasOwn(metadata, k));
        // A whole chat's save replaces its metadata, as upstream's does: a variable it lacks is removed.
        const had = current.variables && typeof current.variables === 'object' ? Object.keys(current.variables) : [];
        const sent = metadata.variables && typeof metadata.variables === 'object' && !Array.isArray(metadata.variables) ? metadata.variables : null;
        const variables = { unset: sent ? had.filter(name => !Object.hasOwn(sent, name)) : [] };
        await this.mergeMetadata({ tree, at: atExternal, set: metadata, unset, variables, actor });
        const external = await this.externalIds(written.assigned.map(a => a.id));
        return {
            ok: true, integrity: actor.session, assigned_node_ids: written.assigned.map((a, i) => ({ index: a.index, node_id: external[i] })),
            ...(dropped.bookmarks.length || dropped.changes.length ? { dropped } : {}),
            ...(refused.length ? { deletes_refused: refused } : {}),
        };
    }

    /**
     * The deletes a whole chat's save asks for (upstream deletes by saving the chat without the messages or swipes:
     * `deleteMessage()`, `/del`, `/cut`, `deleteSwipe()`), applied before the save stores the rest. With `base`, the
     * messages the page knew (in its chat's order, each its shown id and its alternatives' ids), a save deletes only
     * what the page knew and left out: a message none of whose ids the chat holds is cut from the path the page knew
     * (`cutFromPath()`; the session first moved onto that path when it is elsewhere), and an alternative the chat
     * lacks of a message it holds goes with what is below it (`deleteSubtree()`), unless something below it is
     * something the page didn't know or still holds; what can't be done is refused and answered with its reason.
     * With no base (a caller that isn't our page), upstream's whole replace: the session's shown messages the chat
     * lacks are cut from its path, and the alternatives the chat lacks of a shown message it holds are deleted with
     * what is below them, only when the chat is this path's (it holds its opening). Applied whatever they drop.
     * @param {bigint} tree
     * @param {any[]} messages
     * @param {Actor} actor
     * @param {SaveBase | undefined} base
     * @returns {Promise<{ dropped: Drops, refused: { node_id: string, reason: string }[] }>}
     */
    async saveDeletes(tree, messages, actor, base) {
        /** @type {Drops} */
        const dropped = { bookmarks: [], changes: [] };
        /** @type {{ node_id: string, reason: string }[]} */
        const refused = [];
        const took = (/** @type {EditAnswer} */ answer, /** @type {string} */ nodeId) => {
            if (!answer.ok) refused.push({ node_id: nodeId, reason: answer.reason });
            else if (answer.drops) {
                dropped.bookmarks.push(...answer.drops.bookmarks);
                dropped.changes.push(...answer.drops.changes);
            }
        };
        const sent = new Set();
        for (const m of messages) {
            if (m?.node_id != null) sent.add(String(m.node_id));
            for (const info of Array.isArray(m?.swipe_info) ? m.swipe_info : []) if (info?.node_id != null) sent.add(String(info.node_id));
        }
        if (base === undefined) {
            const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [String(actor.session)] });
            const path = sid === null ? null : await this.shownPath(tree, sid);
            if (!path || path.length === 0) return { dropped, refused };
            const shown = await this.externalIds(path);
            if (!sent.has(shown[0])) return { dropped, refused };
            for (const [i, id] of path.entries()) {
                if (!sent.has(shown[i])) continue;
                const level = await this.children(tree, i === 0 ? null : path[i - 1]);
                const ext = await this.externalIds(level);
                for (const [k, other] of level.entries()) {
                    if (other === id || sent.has(ext[k])) continue;
                    took(await this.deleteSubtree({ tree, actor, node_id: ext[k], confirm: 'any' }), ext[k]);
                }
            }
            await this.cutRuns(tree, actor, shown.map(id => !sent.has(id)), took);
            return { dropped, refused };
        }
        const entries = base.map(e => [...new Set([e.id, ...(e.alternatives ?? [])])]);
        const known = new Set(entries.flat());
        const ids = [...known];
        const internal = await this.messageIds(ids);
        const stored = await this.stored(internal.filter(id => id !== null));
        /** @type {Map<string, any>} */
        const resolved = new Map();
        for (const [i, id] of internal.entries()) {
            const row = id === null ? undefined : stored.get(id);
            if (row && row.owner === tree) resolved.set(ids[i], row);
        }
        // Alternatives the chat lacks of the messages it holds.
        for (const entry of entries) {
            const held = entry.find(id => sent.has(id) && resolved.has(id));
            if (held === undefined) continue;
            const parent = resolved.get(held).parent;
            for (const alt of entry) {
                if (sent.has(alt)) continue;
                if (!resolved.has(alt)) {
                    refused.push({ node_id: alt, reason: 'unresolved' });
                    continue;
                }
                took(await this.edit({ tree, actor, confirm: 'any' }, async () => {
                    const s = await this.messageOf(tree, alt);
                    if (!s) return { ok: false, reason: 'unresolved' };
                    if (s.parent !== parent) return { ok: false, reason: 'moved since' };
                    const below = await this.unseenBelow(tree, s.id, known, sent);
                    return below === null ? { roots: [s.id] } : { ok: false, reason: below };
                }), alt);
            }
        }
        // Messages the chat lacks entirely: cut from the path the page knew.
        const missing = entries.filter(entry => !entry.some(id => sent.has(id)));
        if (missing.length === 0) return { dropped, refused };
        const last = [...base].reverse().map(e => e.id).find(id => resolved.has(id));
        if (last === undefined) {
            for (const entry of missing) refused.push({ node_id: entry[0], reason: 'unresolved' });
            return { dropped, refused };
        }
        const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [String(actor.session)] });
        let path = sid === null ? null : await this.shownPath(tree, sid);
        if (!path || !path.includes(resolved.get(last).id)) {
            await this.goTo({ tree, node_id: last, actor });
            const [moved] = await this.store.chatRead('ids', { space: SPACE.session, keys: [String(actor.session)] });
            path = await this.shownPath(tree, moved);
        }
        const onPath = new Set(path ?? []);
        /** @type {Set<bigint>} */
        const cut = new Set();
        for (const entry of missing) {
            const there = entry.filter(id => resolved.has(id) && onPath.has(resolved.get(id).id));
            if (there.length) for (const id of there) cut.add(resolved.get(id).id);
            else refused.push({ node_id: entry[0], reason: entry.some(id => resolved.has(id)) ? 'moved since' : 'unresolved' });
        }
        await this.cutRuns(tree, actor, (path ?? []).map(id => cut.has(id)), took);
        return { dropped, refused };
    }

    /**
     * Cuts each run of the session's shown path marked in `marks` from it, the last run first.
     * @param {bigint} tree
     * @param {Actor} actor
     * @param {boolean[]} marks Per message of the session's shown path, root first.
     * @param {(answer: EditAnswer, nodeId: string) => void} took
     */
    async cutRuns(tree, actor, marks, took) {
        const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [String(actor.session)] });
        const path = sid === null ? null : await this.shownPath(tree, sid);
        if (!path) return;
        const shown = await this.externalIds(path);
        /** @type {[number, number][]} */
        const runs = [];
        for (let i = 0; i < shown.length; i++) {
            if (!marks[i]) continue;
            if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i;
            else runs.push([i, i]);
        }
        for (const [first, last] of runs.reverse()) {
            took(await this.cutFromPath({ tree, actor, first: shown[first], last: shown[last], confirm: 'any' }), shown[first]);
        }
    }

    /**
     * Why a save may not delete what is below message `m` (null: it may): a message the page didn't know (`replied
     * since`), or one its chat still holds (`kept below`). Walks only messages the page knew.
     * @param {bigint} tree
     * @param {bigint} m
     * @param {Set<string>} known
     * @param {Set<string>} sent
     * @returns {Promise<string | null>}
     */
    async unseenBelow(tree, m, known, sent) {
        const stack = [m];
        while (stack.length) {
            const below = await this.children(tree, /** @type {bigint} */ (stack.pop()));
            const ext = await this.externalIds(below);
            for (const [i, c] of below.entries()) {
                if (!known.has(ext[i])) return 'replied since';
                if (sent.has(ext[i])) return 'kept below';
                stack.push(c);
            }
        }
        return null;
    }

    /**
     * The replies of a message (null: the tree's openings) as upstream's objects, kept current while a save adds to
     * and edits them.
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
            /** The reply other than `except` with the speaker and text of `content`, or null. */
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
     * Makes `reply` the session's choice at its fork: an append of it through the session already did; otherwise a
     * choice record, unless the session already follows it. Answers whether the append moved the session to it.
     * @param {object[]} records
     * @param {bigint} tree
     * @param {bigint | null} fork
     * @param {bigint} reply
     * @param {bigint} session
     * @param {bigint} user
     */
    async chooseIn(records, tree, fork, reply, session, user) {
        if (records.some(r => r.kind === 'messageAppend' && r.id === reply && r.session === session)) return true;
        records.push(...await this.choiceRecords(tree, fork, reply, session, user));
        return false;
    }

    /**
     * The record choosing `reply` at its fork through the session, when it doesn't already follow it.
     * @param {bigint} tree
     * @param {bigint | null} fork
     * @param {bigint} reply
     * @param {bigint} session
     * @param {bigint} user
     */
    async choiceRecords(tree, fork, reply, session, user) {
        const followed = await this.store.chatRead('followed', { tree, ...(fork === null ? {} : { at: fork }), session, user });
        if (followed === reply) return [];
        return [this.moveTo(session, user, fork, reply)[0]];
    }

    /**
     * A bookmark named by the message's `extra.bookmark_link`, made at `at`, when no bookmark of the tree is named
     * that already.
     * @param {bigint} tree
     * @param {Record<string, any>} msg
     * @param {bigint} at
     * @param {bigint} session
     * @param {bigint} user
     * @param {object[]} records
     */
    async bookmarkLinkRecords(tree, msg, at, session, user, records) {
        const link = msg?.extra?.bookmark_link;
        if (typeof link !== 'string' || link === '') return;
        // Names are unique in the tree: a bookmark with that name, wherever it is, is the one the link names.
        if ((await this.store.chatRead('bookmarksNamed', { tree, name: link })).length) return;
        if (records.some(r => r.kind === 'positionName' && r.name === link)) return;
        const b = this.next.position++;
        records.push({ kind: 'positionCreate', id: b, mode: MODE.following, session, user, pointer: at }, { kind: 'positionName', id: b, name: link });
    }

    // ---- state ----

    /**
     * Records state changes at a position (state layer 1), each a key set to a value or removed (`value`
     * absent), a chat variable when `variable`; a change that leaves its key as it is isn't recorded.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at The message (null: the tree's root).
     * @param {{ key: string, variable?: boolean, value?: unknown }[]} p.ops
     * @param {Actor} p.actor
     * @param {number} [p.author]
     * @param {string | null} [p.ref] The author's reference (a command, a macro, an extension).
     * @returns {Promise<{ ok: true, changes: string[] } | { ok: false, reason: string }>} The ids of the changes
     * recorded.
     */
    changeState({ tree, at, ops, actor, author = AUTHOR.user, ref = null }) {
        return this.serialized(tree, async () => {
            let message = null;
            if (at !== null) {
                [message] = await this.messageIds([at]);
                const s = message === null ? undefined : (await this.stored([message])).get(message);
                if (!s || s.owner !== tree) return { ok: false, reason: 'unknown node' };
            }
            const state = await this.shownState(await this.store.chatRead('state', { tree, ...(message === null ? {} : { at: message }) }));
            const now = new Map(state.map(e => [`${e.variable ? 'v' : 'k'}\u0000${e.field}`, e.json]));
            const lorebooks = (Array.isArray(ops) ? ops : []).filter(op => op?.key === WORLD_INFO && !op.variable).map(op => op.value);
            return this.withWorldLinks(lorebooks, async link => {
                const records = [];
                const { user, session } = await this.actorIds(actor, records);
                const where = message === null ? { tree } : { message };
                const time = this.now();
                const ids = [];
                for (const op of ops) {
                    if (typeof op?.key !== 'string' || (!op.variable && DERIVED_METADATA.has(op.key))) continue;
                    const json = op.value === undefined ? undefined : JSON.stringify(op.value);
                    const k = `${op.variable ? 'v' : 'k'}\u0000${op.key}`;
                    if (now.get(k) === json) continue;
                    now.set(k, json);
                    const id = this.next.change++;
                    /** @type {Record<string, unknown>} */
                    const r = { kind: 'stateChange', id, ...where, time, author: author | (op.variable ? VARIABLE : 0), key: op.key, user };
                    if (ref !== null) r.ref = ref;
                    if (session !== null) r.session = session;
                    if (json !== undefined) r.value = !op.variable && op.key === WORLD_INFO ? await link(json, records) : json;
                    records.push(r);
                    ids.push(String(id));
                }
                if (ids.length) await this.store.commit(records);
                return { ok: true, changes: ids };
            });
        });
    }

    /**
     * Reverts a recorded change (or a revert, restoring what it reverted): the state is as if it never happened.
     * @param {object} p
     * @param {string} p.change The change's id.
     * @param {Actor} p.actor
     * @param {number} [p.author]
     * @param {string | null} [p.ref]
     * @returns {Promise<{ ok: true, change: string } | { ok: false, reason: string }>} The revert's own id.
     */
    async revertChange({ change, actor, author = AUTHOR.user, ref = null }) {
        if (!DECIMAL.test(change)) return { ok: false, reason: 'unknown change' };
        const records = [];
        const { user, session } = await this.actorIds(actor, records);
        const id = this.next.change++;
        /** @type {Record<string, unknown>} */
        const r = { kind: 'stateRevert', id, reverts: BigInt(change), time: this.now(), author, user };
        if (ref !== null) r.ref = ref;
        if (session !== null) r.session = session;
        records.push(r);
        try {
            await this.store.commit(records);
        } catch (e) {
            if (String(e?.message ?? e).includes('no change')) return { ok: false, reason: 'unknown change' };
            throw e;
        }
        return { ok: true, change: String(id) };
    }

    /**
     * The state at a position as `chat_metadata` with its hash (`jsonHash()`, as the page hashes its copy), or
     * `unchanged` when it is `ifHash`.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @param {string | null} [p.session] Adds `integrity`.
     * @param {number} [p.ifHash]
     * @returns {Promise<{ state: Record<string, unknown>, hash: number } | { unchanged: true } | null>} null when the
     * message isn't the tree's.
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
     * Sets and removes `chat_metadata` keys at a position, as state changes: only the keys whose value differs. A
     * chat variable is a key of its own: one is removed only when named, so tabs changing different variables keep
     * each other's.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at The message (null: the tree's root).
     * @param {Record<string, unknown>} p.set A `variables` object here sets the variables it holds.
     * @param {string[]} p.unset `variables` here removes the object and every variable.
     * @param {{ set?: Record<string, unknown>, unset?: string[] }} [p.variables] Variables set and removed by name.
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
            // Each key touched, in the order first touched, with the value it ends with.
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
                // The object itself, empty or not, is a marker.
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
                await this.store.commit(records);
            });
            return { ok: true };
        });
    }

    /**
     * State entries as `chat_metadata` shows them: a lorebook link as the name of the book it resolves as (or its
     * own name).
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
     * Runs `fn` with the lanes of the books the `world_info` values in `values` would link held, giving it what to
     * record for a `world_info` value's JSON: a link to the book its key finds (an unresolved name made in
     * `records` when there is none), or the JSON itself.
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
     * The state at a position as `chat_metadata`: its keys in order, `variables` holding the chat variables (an
     * object since it was first set, even when empty), and, read through a session, `integrity`: the session's UUID.
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
     * Of these send keys, the ones the tree has a stored message for (at most the first 100 strings are looked up).
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
     * Every message of a tree, in batches of up to `size` ids (each a message's replies or a part of them), parents
     * before their replies.
     * @param {bigint} tree
     * @param {number} size
     * @returns {AsyncGenerator<bigint[]>}
     */
    async* treeMessages(tree, size) {
        /** @type {{ parent: bigint | null, after?: bigint }[]} */
        const stack = [{ parent: null }];
        while (stack.length) {
            const top = stack[stack.length - 1];
            const page = await this.store.chatRead('children', { tree, ...(top.parent === null ? {} : { parent: top.parent }), ...(top.after === undefined ? {} : { after: top.after }), limit: size });
            if (page.more) top.after = page.ids[page.ids.length - 1];
            else stack.pop();
            if (!page.ids.length) continue;
            yield page.ids;
            for (const id of page.ids) stack.push({ parent: id });
        }
    }

    /**
     * A group member's messages in the group's tree become another character's: each message whose
     * `original_avatar` is `oldAvatar` gets `newAvatar` and `newName`, and `force_avatar`'s path follows.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.oldAvatar
     * @param {string} p.newAvatar
     * @param {string} p.newName
     * @returns {Promise<number>} How many messages were the member's.
     */
    renameMemberInMessages({ tree, oldAvatar, newAvatar, newName }) {
        return this.serialized(tree, async () => {
            const oldEncoded = encodeURIComponent(oldAvatar);
            const newEncoded = encodeURIComponent(newAvatar);
            let updated = 0;
            for await (const ids of this.treeMessages(tree, 256)) {
                const stored = await this.stored(ids);
                const list = ids.map(id => stored.get(id));
                const decoded = await this.decoded(list);
                const records = [];
                for (const [i, msg] of decoded.entries()) {
                    if (msg?.original_avatar !== oldAvatar) continue;
                    const next = { ...msg, name: newName, original_avatar: newAvatar };
                    if (typeof next.force_avatar === 'string') next.force_avatar = next.force_avatar.replace(oldEncoded, newEncoded);
                    records.push(...this.editRecords(list[i], next, await this.speakerFor(next, null)));
                    updated++;
                }
                if (records.length) await this.store.commit(records);
            }
            return updated;
        });
    }

    // ---- prompt itemizations ----

    /**
     * Stores a message's itemization (zstd-compressed JSON, without `mesId`), replacing the one it had; nothing is
     * written when it is the one stored.
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
     * Changes some fields of a message's itemization; nothing is written when they already have these values.
     * @param {object} p
     * @param {string} p.node_id
     * @param {Record<string, unknown>} p.fields
     * @returns {Promise<'written' | 'unchanged' | 'no-itemization'>}
     */
    async updateItemizationFields({ node_id, fields }) {
        const [id] = await this.messageIds([node_id]);
        const s = id === null ? undefined : (await this.stored([id])).get(id);
        if (!s) return 'no-itemization';
        return this.serialized(s.owner, async () => {
            const now = await this.store.chatRead('itemization', { message: id });
            if (!now) return 'no-itemization';
            const merged = { ...JSON.parse((await zstdDecompress(now.data)).toString('utf8')), ...fields };
            delete merged.mesId;
            const data = await zstdCompress(Buffer.from(JSON.stringify(merged)));
            if (Buffer.compare(Buffer.from(now.data), data) === 0) return 'unchanged';
            await this.store.commit([{ kind: 'itemization', message: id, raw: Boolean(merged.rawPrompt), data }]);
            return 'written';
        });
    }

    /**
     * A message's itemization, and the nearest message above it whose itemization holds the prompt as sent.
     * @param {object} p
     * @param {string} p.node_id
     * @returns {Promise<{ entry: Record<string, unknown>, previous_node_id: string | null } | null>} null when it has
     * none.
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
     * The itemizations of a position's messages, each with its message's place on the path.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @returns {Promise<{ index: number, node_id: string, entry: Record<string, unknown> }[] | null>} null when the
     * message isn't the tree's.
     */
    async chatItemizations({ tree, at }) {
        const ids = await this.pathIds(tree, at);
        if (!ids) return null;
        const stored = await this.stored(ids);
        const out = [];
        for (const [index, id] of ids.entries()) {
            if (!stored.get(id)?.itemized) continue;
            const found = await this.store.chatRead('itemization', { message: id });
            out.push({ index, node_id: this.externalId(stored.get(id)), entry: JSON.parse((await zstdDecompress(found.data)).toString('utf8')) });
        }
        return out;
    }

    /**
     * Removes the itemizations of a position's messages.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at
     * @returns {Promise<number | null>} How many were removed; null when the message isn't the tree's.
     */
    deleteChatItemizations({ tree, at }) {
        return this.serialized(tree, async () => {
            const ids = await this.pathIds(tree, at);
            if (!ids) return null;
            const stored = await this.stored(ids);
            const records = ids.filter(id => stored.get(id)?.itemized).map(message => ({ kind: 'itemization', message, raw: false }));
            if (records.length) await this.store.commit(records);
            return records.length;
        });
    }

    /**
     * Removes every itemization, in batches of `batch` with `pause` ms between them.
     * @param {{ batch?: number, pause?: number }} [p]
     * @returns {Promise<number>} How many were removed.
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
     * The message ids from the tree's root down to a message of the tree (null: none), or null when it isn't one.
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

    // ---- sessions and bookmarks as lists ----

    /**
     * List rows of sessions at positions: name, where (tree and message), message count, the message's text and
     * time.
     * @param {{ sid: bigint, position: bigint, tree: bigint | null, at: bigint | null }[]} entries
     * @param {boolean} withMetadata Adds each position's state as `chat_metadata`.
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
     * The session list filtered by a tree: a page of the sessions with meaningful activity there, the most recent
     * first, each at its position in the tree; `before` is the last row's `position` of the page before. (Upstream's
     * chat list is `chatList()`.)
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
     * The id of a tab's session (its UUID), or null when it has none yet.
     * @param {string | undefined} session
     */
    async sessionId(session) {
        if (session === undefined) return null;
        const [sid] = await this.store.chatRead('ids', { space: SPACE.session, keys: [session] });
        return sid;
    }

    /**
     * Rows of chat list items: a bookmark (`bookmark`, its id) or a tab's session (`session`, its UUID), its name,
     * where it is, the message count there, the message's text and time; `position` is a bookmark's id (the `after`
     * of the next page).
     * @param {bigint} tree
     * @param {{ bookmark: bigint | null, session: bigint | null, at: bigint | null }[]} items
     * @param {boolean} withMetadata Adds each position's state as `chat_metadata`.
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
                Object.assign(row, { bookmark: String(item.bookmark), session: null, name: b?.name ?? null, position: item.bookmark });
            } else {
                const s = sessionRows[si++];
                Object.assign(row, { bookmark: null, session: s?.key ?? null, name: s?.name ?? null, position: null });
            }
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
     * Upstream's chat list of a character or group (`/api/characters/chats`, `/api/chats/group/info`, the chat
     * pickers): the tree's bookmarks in the order they were made, and first the tab's session when it is in the tree
     * and no bookmark is at its message (so `getCurrentChatId()`'s chat is listed). `after` is the last row's
     * `position` of the page before.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} [p.session] The tab's session (its UUID).
     * @param {bigint} [p.after]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     */
    async chatList({ tree, session, after, limit, withMetadata = false }) {
        return this.searchChatList({ tree, search: '', session, after, limit, withMetadata });
    }

    /**
     * The chat list (`chatList()`) searched: an item matches by its name (every clause's text inside it,
     * lower-cased, as upstream's file names) or by the path down to it holding every word (whole words; a
     * closed-quote phrase as a phrase) in some message, none of a negated one. `exact` is false when the search's
     * work limit cut it short (results "~"); `more` and `next` read on.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.search
     * @param {string} [p.session] The tab's session (its UUID).
     * @param {bigint} [p.after]
     * @param {number} p.limit
     * @param {boolean} [p.withMetadata]
     */
    async searchChatList({ tree, search, session, after, limit, withMetadata = false }) {
        const sid = await this.sessionId(session);
        const page = await this.store.chatSearchList({
            tree, clauses: searchClauses(search), limit,
            ...(sid === null ? {} : { session: sid }),
            ...(after === undefined ? {} : { after }),
        });
        return {
            rows: await this.listRows(tree, page.hits, withMetadata),
            more: page.more,
            exact: page.exact,
            ...(page.next === undefined ? {} : { next: page.next }),
        };
    }

    /**
     * A tree's messages a search string matches: from the index, best first (whole words; a closed-quote phrase as
     * a phrase), then what a substring scan of the messages' texts (newest first, each clause's text lower-cased
     * inside the message's, as upstream matched) adds, under a cap of text bytes read (`scanBytes`). Each row is a
     * message with its context: its id, speaker, time, depth and a snippet of its text around the first match;
     * opening one moves the session there (`goTo`). Index pages read on with `after` (no scan); when the scan
     * stops (cap or `limit`) the answer is `partial` ("~") with a `scanCursor`, and passing that back scans on from
     * there alone.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.search
     * @param {number} p.limit
     * @param {string} [p.after] The `after` of the page before.
     * @param {string} [p.scanCursor]
     * @param {number} [p.scanBytes]
     */
    async searchMessages({ tree, search, limit, after, scanCursor, scanBytes }) {
        const clauses = searchClauses(search);
        const afterAt = after === undefined ? null : /^s([^:]+):(\d+)$/.exec(after);
        if (after !== undefined && !afterAt) throw new Error('invalid cursor');
        if (scanCursor !== undefined && !/^m\d+$/.test(scanCursor)) throw new Error('invalid scan cursor');
        const found = await this.store.chatSearchMessages({
            tree, clauses, limit,
            ...(afterAt ? { after: { score: Number(afterAt[1]), doc: BigInt(afterAt[2]) } } : {}),
            ...(scanCursor === undefined ? {} : { scanBelow: BigInt(scanCursor.slice(1)) }),
            ...(scanBytes === undefined ? {} : { scanBytes }),
        });
        const ids = [...found.hits.map(h => h.message), ...found.scanned];
        const stored = await this.stored(ids);
        const decoded = new Map((await this.decoded(ids.map(id => stored.get(id)).filter(Boolean))).map((d, i) => [ids.filter(id => stored.get(id))[i], d]));
        const depths = new Map((ids.length ? await this.store.chatRead('messages', { ids }) : []).filter(Boolean).map(m => [m.id, m.depth]));
        const needles = clauses.filter(c => !c.negate).map(c => c.text.toLowerCase()).filter(t => t.trim());
        const row = (/** @type {bigint} */ id, /** @type {number | null} */ score) => {
            const m = stored.get(id);
            const d = decoded.get(id);
            if (!m || !d) return null;
            return { id: this.externalId(m), score, name: d.name ?? null, is_user: !!d.is_user, time: m.time, depth: depths.get(id) ?? null, snippet: snippetOf(String(d.mes ?? ''), needles) };
        };
        const last = found.hits[found.hits.length - 1];
        return {
            rows: [...found.hits.map(h => row(h.message, h.score)), ...found.scanned.map(id => row(id, null))].filter(Boolean),
            more: found.more,
            ...(found.more && last ? { after: `s${last.score}:${last.message}` } : {}),
            total: found.total,
            totalExact: found.totalExact,
            ...(found.scan === undefined ? {} : { partial: true, scanCursor: `m${found.scan}` }),
        };
    }

    /**
     * Starts a new chat for a session: it goes to the tree's root with the card's first greeting chosen
     * provisionally (`chooseCardGreeting()`), nothing stored until a reply is sent from it; no bookmark is made. A
     * group's tree has no card: the session goes to its root, where the page shows the members' greetings
     * provisionally, in upstream's order, stored only when the conversation continues.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Actor} p.actor
     * @param {boolean} [p.group] The tree is a group's.
     */
    newChat({ tree, actor, group = false }) {
        return group ? this.goTo({ tree, node_id: null, actor }) : this.chooseCardGreeting({ tree, index: 0, actor });
    }

    /**
     * A page of every session by its last move, the most recent first, each where its pointer is.
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
     * Names a session (null: no name). A name another session holds gets upstream's suffix (`getUniqueName()`:
     * `name`, then `name (1)`, `name (2)`, ... up to 1000 tries). Answers the name given; nothing is written when the
     * session already has it.
     * @param {object} p
     * @param {string} p.session
     * @param {string | null} p.name
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: true, name: string | null } | { ok: false, reason: 'no free name' }>}
     */
    nameSession({ session, name, actor }) {
        // Names are checked and written in one lane for the store, so two sessions never take the same one.
        return this.serialized('session-names', () => this.serialized(`session:${session}`, async () => {
            const records = [];
            const { session: sid } = await this.actorIds({ ...actor, session }, records);
            let free = name;
            if (name !== null) {
                free = null;
                for (let i = 0; i < SESSION_NAME_TRIES; i++) {
                    const candidate = i === 0 ? name : `${name} (${i})`;
                    const held = await this.store.chatRead('sessionsNamed', { name: candidate });
                    if (held.every((/** @type {bigint} */ s) => s === sid)) {
                        free = candidate;
                        break;
                    }
                }
                if (free === null) return { ok: false, reason: 'no free name' };
            }
            const [now] = await this.store.chatRead('sessions', { ids: [sid] });
            if ((now?.name ?? null) === free) return { ok: true, name: free };
            records.push({ kind: 'positionName', id: sid, ...(free === null ? {} : { name: free }) });
            await this.store.commit(records);
            return { ok: true, name: free };
        }));
    }

    /**
     * Deletes a session: its pointer, history, remembered positions and its own choices; its UUID then says it was
     * deleted.
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
     * A page of a tree's bookmarks in the order they were made: id (a decimal string), name, mode, the message it is
     * at and the one it was made at; `after` is the last id of the page before.
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
        // A bookmark at the tree's root is at no message, and was made at none.
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
     * A bookmark of the tree, or null.
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
     * Renames a bookmark (null: no name; a name another bookmark of the tree holds gets upstream's suffix, and the
     * answer says the name it took), makes it following or pinned, or deletes it; nothing is written when nothing
     * changes.
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
                    name = change.name === null ? null : await this.freeBookmarkName(tree, change.name, b.id);
                    if (change.name !== null && name === null) return { ok: false, reason: 'no free name' };
                    if (name !== b.name) records.push({ kind: 'positionName', id: b.id, ...(name === null ? {} : { name }) });
                }
                if (change.mode !== undefined && change.mode !== b.mode) records.push({ kind: 'positionMode', id: b.id, mode: change.mode });
            }
            if (records.length) await this.store.commit(records);
            return change.delete ? { ok: true } : { ok: true, name };
        });
    }

    // ---- reading a position ----

    /**
     * A position's messages in upstream's shape: the path from the tree's root down to `at` (nothing below it),
     * each with every alternative's text in `swipes`, its outside id, and the bookmarks made at it; and the state
     * there as `chat_metadata` (with `integrity` when read through a session).
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at The message (null: the tree's root, no message).
     * @param {string | null} [p.session] The session's UUID.
     */
    async load({ tree, at, session = null }) {
        let atId = null;
        if (at !== null) {
            [atId] = await this.messageIds([at]);
            if (atId === null) return null;
        }
        const ids = atId === null ? [] : await this.store.chatRead('path', { tree, at: atId });
        const stored = await this.stored(ids);
        /** @type {Map<string, bigint[]>} parent → replies */
        const siblings = new Map();
        for (const id of ids) {
            const s = stored.get(id);
            const key = String(s.parent);
            if (siblings.has(key)) continue;
            // A message on the path with one reply has only the next one on the path.
            const parent = s.parent === null ? undefined : stored.get(s.parent);
            siblings.set(key, parent?.replies === 1 ? [id] : await this.children(tree, s.parent));
        }
        const allIds = [...new Set([...siblings.values()].flat())];
        const others = await this.stored(allIds.filter(id => !stored.has(id)));
        const all = new Map([...stored, ...others]);
        const decodedList = await this.decoded(allIds.map(id => all.get(id)));
        const decoded = new Map(allIds.map((id, i) => [id, decodedList[i]]));
        const bookmarkIds = [...new Set(ids.flatMap(id => all.get(id).branches))];
        const bookmarks = bookmarkIds.length ? await this.store.chatRead('bookmarks', { ids: bookmarkIds }) : [];
        const names = new Map(bookmarkIds.map((b, i) => [b, bookmarks[i]?.name ?? null]));
        const messages = [];
        for (const id of ids) {
            const s = all.get(id);
            const msg = { ...decoded.get(id) };
            msg.node_id = this.externalId(s);
            const sibs = siblings.get(String(s.parent));
            if (sibs.length > 1) {
                msg.swipes = sibs.map(x => decoded.get(x).mes ?? '');
                msg.swipe_info = sibs.map(x => {
                    const o = decoded.get(x);
                    const extra = { ...(o.extra && typeof o.extra === 'object' && !Array.isArray(o.extra) ? o.extra : {}) };
                    if (all.get(x).itemized) extra[ITEMIZED_PROMPT_FLAG] = true;
                    return { send_date: o.send_date, extra, name: o.name, is_user: !!o.is_user, node_id: this.externalId(all.get(x)) };
                });
                msg.swipe_id = sibs.indexOf(id);
            }
            const made = s.branches.map(b => names.get(b)).filter(n => typeof n === 'string');
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
