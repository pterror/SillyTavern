import crypto from 'node:crypto';

import { textEdit } from './text-edit.js';
import { META, TOP, decodeMessage, encodeMessage, messageRecords } from './chat-codec.js';
import { ITEMIZED_PROMPT_FLAG } from './message-tree-db.js';

/**
 * Chats on the engine (build path 5b): each character's or group's messages as a tree, sessions and bookmarks as
 * positions in it, the state (`chat_metadata`) at each message. Upstream's chat concepts exist only at the edges:
 * a "chat" read is a position's path assembled in upstream's shape.
 *
 * Ids outside: a message is named by the id it had before the engine (its outside key) or, made since, by its
 * integer as a decimal string; a session by its UUID; a user by their handle. Writes to one tree run one after
 * another, so each reads what the one before it stored.
 */

/** `chatRead('ids')` spaces. */
const SPACE = Object.freeze({ message: 0, session: 1, user: 2 });

/** The namespace of a user's deterministic session in a tree (UUID v5 of `<handle>\0<tree id>`). */
export const SESSION_NAMESPACE = 'b3c3d5a0-6b5e-4f61-9d2e-5a0c1f7e9e21';

/** Bookmark modes. */
export const MODE = Object.freeze({ following: 1, pinned: 2 });

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** State change author kinds (`state.rs`), and the bit naming a variable. */
export const AUTHOR = Object.freeze({ user: 0, script: 1, model: 2, rule: 3, migration: 4 });
const VARIABLE = 8;

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
 */

/**
 * @typedef {object} Actor Who acts, and through which session (none: the change moves no pointer).
 * @property {string} user The user's handle.
 * @property {string | null} [session] The session's UUID.
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
     * Runs `write` after every earlier write to the same tree has settled.
     * @template T
     * @param {bigint} tree
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
     * The session a request acts through, by the compat rules (build path 5b): its `X-ST-Session` header's
     * session; `none` (a tab with no session yet) the user's deterministic session in the tree; no header (a third
     * party) the user's last session in the tree, else that deterministic one. A deleted session's UUID is answered
     * as `none`, and `gone` says so; a UUID that names nothing is a new tab's session, made on its first move.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.user The user's handle.
     * @param {string | null | undefined} p.header
     * @returns {Promise<{ session: string, gone?: true }>}
     */
    async resolveSession({ tree, user, header }) {
        if (header === undefined || header === null) {
            const [uid] = await this.store.chatRead('ids', { space: SPACE.user, keys: [user] });
            const last = uid === null ? null : await this.store.chatRead('userInTree', { user: uid, tree });
            if (last !== null) {
                const [s] = await this.store.chatRead('sessions', { ids: [last.session] });
                if (s) return { session: s.key };
            }
            return { session: defaultSessionKey(user, tree) };
        }
        if (header === 'none') return { session: defaultSessionKey(user, tree) };
        const [state] = await this.store.chatRead('keyStates', { space: SPACE.session, keys: [header] });
        if (state === 'gone') return { session: defaultSessionKey(user, tree), gone: true };
        return { session: header };
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
            if (over) speakerIds.add(BigInt(JSON.parse(over.json)));
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
        const hasSavedChats = (await this.store.chatRead('inTree', { tree, limit: 1 })).length > 0;
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
     * Stores messages after a message (null: as the tree's openings), each after the one before. A message whose
     * send key the tree already stored is not stored again; a message matching a reply already there (same
     * speaker and text) is that reply. Through a session, the session moves to each and chooses it.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker The tree's character (null for a group).
     * @param {string | null} p.after The outside id of the message to reply to.
     * @param {Record<string, any>[]} p.contents Messages as stored today (after `sanitizeForStorage()`).
     * @param {(string | null)[]} [p.sendKeys]
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: boolean, reason?: string, node_ids: string[], already_stored?: string[] }>}
     */
    appendMessages({ tree, treeSpeaker, after, contents, sendKeys = [], actor }) {
        return this.serialized(tree, async () => {
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
            for (const [i, content] of contents.entries()) {
                const key = keys[i];
                const stored = key ? sentBy.get(key.toString('utf8')) ?? null : null;
                if (stored !== null) {
                    ids.push(stored);
                    already.push(stored);
                    cursor = stored;
                    continue;
                }
                const twin = await this.twinOf(tree, cursor, content, ids);
                if (twin !== null) {
                    if (session !== null) records.push(...this.moveTo(session, user, cursor, twin));
                    ids.push(twin);
                    cursor = twin;
                    continue;
                }
                const id = this.next.message++;
                const time = now + i;
                const speaker = await this.speakerFor(content, treeSpeaker);
                records.push(...messageRecords(id, encodeMessage(content, time, speaker), { parent: cursor, owner: tree, time, session, user, sendKey: key }));
                ids.push(id);
                cursor = id;
            }
            if (records.length) await this.store.commit(records);
            const external = await this.externalIds(ids);
            const answer = { ok: true, node_ids: external };
            if (already.length) answer.already_stored = already.map(id => external[ids.indexOf(id)]);
            return answer;
        });
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
     * @param {bigint} tree
     * @param {bigint | null} parent
     * @param {Record<string, any>} content
     * @param {bigint[]} written Ids made earlier in this write (not stored yet: they can't be twins).
     */
    async twinOf(tree, parent, content, written) {
        if (parent !== null && written.includes(parent)) return null;
        const siblings = await this.children(tree, parent);
        if (!siblings.length) return null;
        const decoded = await this.decoded([...(await this.stored(siblings)).values()]);
        const want = identityOf(content);
        const at = decoded.findIndex(d => identityOf(d) === want);
        return at < 0 ? null : siblings[at];
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
     * sibling, and reports it.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {Speaker | null} p.treeSpeaker
     * @param {{ node_id: string, content: Record<string, any> }[]} p.edits
     * @param {Actor} p.actor
     */
    editMessages({ tree, treeSpeaker, edits, actor }) {
        return this.serialized(tree, async () => {
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
                if (JSON.stringify(now) === JSON.stringify(next)) {
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
        });
    }

    /**
     * Chooses a reply at its fork through a session (the route resolves which), which moves to it.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.node_id
     * @param {Actor} p.actor
     */
    select({ tree, node_id, actor }) {
        return this.serialized(tree, async () => {
            const [id] = await this.messageIds([node_id]);
            const s = id === null ? undefined : (await this.stored([id])).get(id);
            if (!s || s.owner !== tree) return false;
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A choice is made through a session');
            records.push(...this.moveTo(session, user, s.parent, id));
            await this.store.commit(records);
            return true;
        });
    }

    /**
     * Ends what a session shows at a message (null: at the tree's root, showing nothing yet): its pointer moves
     * there. The replies below it stay, reachable as alternatives.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.node_id
     * @param {Actor} p.actor
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    endPathAt({ tree, node_id, actor }) {
        return this.serialized(tree, async () => {
            let id = null;
            if (node_id !== null) {
                [id] = await this.messageIds([node_id]);
                const s = id === null ? undefined : (await this.stored([id])).get(id);
                if (!s || s.owner !== tree) return { ok: false, reason: 'unknown node' };
            }
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            if (session === null) throw new Error('A path is ended through a session');
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

    /**
     * Deletes a reply no message continues and no bookmark is at, unless the session shows it.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.node_id
     * @param {Actor} p.actor
     */
    deleteAlternative({ tree, node_id, actor }) {
        return this.serialized(tree, async () => {
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            const [id] = await this.messageIds([node_id]);
            const s = id === null ? undefined : (await this.stored([id])).get(id);
            if (!s || s.owner !== tree) return { ok: false, reason: 'unknown node' };
            // What this actor is shown at the fork can't go.
            const shown = await this.store.chatRead('followed', { tree, ...(s.parent === null ? {} : { at: s.parent }), ...(session === null ? {} : { session }), user });
            if (shown === id) return { ok: false, reason: 'is default' };
            if ((await this.store.chatRead('bookmarksAt', { message: id })).length) return { ok: false, reason: 'labeled' };
            if ((await this.children(tree, id)).length) return { ok: false, reason: 'has descendants' };
            records.push({ kind: 'messageDelete', message: id, user, ...(session === null ? {} : { session }) });
            await this.store.commit(records);
            return { ok: true };
        });
    }

    // ---- bookmarks ----

    /**
     * Makes a bookmark at a message.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string} p.node_id
     * @param {string | null} p.name
     * @param {number} [p.mode]
     * @param {Actor} p.actor
     */
    createBookmark({ tree, node_id, name, mode = MODE.following, actor }) {
        return this.serialized(tree, async () => {
            const [id] = await this.messageIds([node_id]);
            const s = id === null ? undefined : (await this.stored([id])).get(id);
            if (!s || s.owner !== tree) return null;
            const records = [];
            const actorIds = await this.actorIds(actor, records);
            if (actorIds.session === null) throw new Error('A bookmark is made through a session');
            const b = this.next.position++;
            records.push({ kind: 'positionCreate', id: b, mode, session: actorIds.session, user: actorIds.user, pointer: id });
            if (name !== null) records.push({ kind: 'positionName', id: b, name });
            await this.store.commit(records);
            return b;
        });
    }

    // ---- state ----

    /**
     * Sets and removes `chat_metadata` keys at a position, as state changes: only the keys whose value differs.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at The message (null: the tree's root).
     * @param {Record<string, unknown>} p.set
     * @param {string[]} p.unset
     * @param {Actor} p.actor
     * @param {number} [p.author]
     */
    mergeMetadata({ tree, at, set, unset, actor, author = AUTHOR.user }) {
        return this.serialized(tree, async () => {
            let message = null;
            if (at !== null) {
                [message] = await this.messageIds([at]);
                if (message === null) return { ok: false, reason: 'unknown chat' };
            }
            const state = await this.store.chatRead('state', { tree, ...(message === null ? {} : { at: message }) });
            const now = new Map(state.filter(e => !e.variable).map(e => [e.field, e.json]));
            const vars = new Map(state.filter(e => e.variable).map(e => [e.field, e.json]));
            const records = [];
            const { user, session } = await this.actorIds(actor, records);
            const where = message === null ? { tree } : { message };
            const time = this.now();
            const change = (/** @type {string} */ key, /** @type {string | undefined} */ value, variable = false) => {
                /** @type {Record<string, unknown>} */
                const r = { kind: 'stateChange', id: this.next.change++, ...where, time, author: author | (variable ? VARIABLE : 0), key, user };
                if (session !== null) r.session = session;
                if (value !== undefined) r.value = value;
                records.push(r);
            };
            for (const [key, value] of Object.entries(set ?? {})) {
                if (value === undefined) continue;
                if (key === 'variables' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
                    // Each chat variable is a key of its own; the object itself, empty or not, a marker.
                    if (!now.has('variables')) change('variables', '{}');
                    for (const [name, v] of Object.entries(value)) {
                        if (v === undefined) continue;
                        const json = JSON.stringify(v);
                        if (vars.get(name) !== json) change(name, json, true);
                    }
                    for (const name of vars.keys()) if (!Object.hasOwn(value, name)) change(name, undefined, true);
                    continue;
                }
                const json = JSON.stringify(value);
                if (now.get(key) !== json) change(key, json);
            }
            for (const key of Array.isArray(unset) ? unset : []) {
                if (typeof key !== 'string') continue;
                if (key === 'variables') {
                    for (const name of vars.keys()) change(name, undefined, true);
                    if (now.has('variables')) change('variables', undefined);
                } else if (now.has(key)) change(key, undefined);
            }
            if (records.some(r => r.kind === 'stateChange')) await this.store.commit(records);
            return { ok: true };
        });
    }

    /**
     * The state at a position as `chat_metadata`: its keys in order, `variables` holding the chat variables (an
     * object since it was first set, even when empty).
     * @param {bigint} tree
     * @param {bigint | null} at
     */
    async metadata(tree, at) {
        const state = await this.store.chatRead('state', { tree, ...(at === null ? {} : { at }) });
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
        return out;
    }

    // ---- reading a position ----

    /**
     * A position's messages in upstream's shape: the path from the tree's root down to `at` (nothing below it),
     * each with every alternative's text in `swipes`, its outside id, and the bookmarks made at it; and the state
     * there as `chat_metadata`.
     * @param {object} p
     * @param {bigint} p.tree
     * @param {string | null} p.at The message (null: the tree's root, no message).
     */
    async load({ tree, at }) {
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
            if (!siblings.has(key)) siblings.set(key, await this.children(tree, s.parent));
        }
        const allIds = [...new Set([...siblings.values()].flat())];
        const all = await this.stored(allIds);
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
        return { messages, metadata: await this.metadata(tree, atId), node_id: atId === null ? null : this.externalId(/** @type {any} */ (stored.get(atId))) };
    }
}
