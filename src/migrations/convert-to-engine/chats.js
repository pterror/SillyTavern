import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { encodeMessage, messageRecords } from '../../chat-codec.js';
import { AUTHOR, MODE, defaultSessionKey, storedForm } from '../../chat-engine.js';
import { descendDefaultSync } from '../../message-tree-db.js';
import { contentsOf, loadOwner, opens } from './old-chats.js';

/**
 * One owner's chats as engine records: its messages (each old id kept as its outside key, numbered in (created_at, id)
 * order so siblings keep their order), send keys, itemizations, chat metadata as state changes at the message that
 * held it, the default children as fork choices and the owner's pointer through its user's deterministic session, and
 * its labels as bookmarks. `planOwner()` is shared by the conversion and its check.
 */

/** State change author bits (`state.rs`): a variable's name. */
const VARIABLE = 8;
/** `chat_metadata` keys the tree owns: never converted as state. */
export const NOT_STATE = new Set(['integrity', 'main_chat', 'fork_point', '_tree_stored', '__is_group']);
const WORLD_INFO = 'world_info';

/**
 * @typedef {import('./old-chats.js').Db} Db
 * @typedef {ReturnType<typeof loadOwner>} Model
 * @typedef {{ name: string, kind: 'twin', end: string, metadata: Record<string, unknown> | null } | { name: string, kind: 'empty', metadata: Record<string, unknown> | null, created: number | null }} Dropped
 * A chat of a group's `chats` the file-to-tree migration left without a name: an exact duplicate of a chat in the
 * tree (`end`: the message its file ends on), or a file with only its header (`created`: its header's `create_date`,
 * null when there is none that reads).
 * @typedef {object} OwnerInput
 * @property {Db} db The tree the owner is read from.
 * @property {string} ownerId
 * @property {string | null} active The chat its character's `active_chat` or its group's `chat_id` names.
 * @property {number | null} openingChoice The card greeting chosen at its root (`opening_choices.card_index`).
 * @property {string | null} repointAnchor The zztest cleanup's anchor, whose default child is `repointTo` instead.
 * @property {string | null} repointTo
 * @property {Dropped[]} dropped
 * @property {(names: string[]) => { modes: Map<string, number>, unsettled: string[] }} classify
 */

/**
 * A metadata object as the state it is: each top-level key a key, the `variables` object a marker (`{}`) and each
 * variable its own key; the tree's own keys left out. Keys map to their value's JSON.
 * @param {unknown} metadata
 * @returns {Map<string, string>} `k\0<key>` and `v\0<name>`.
 */
export function stateOf(metadata) {
    /** @type {Map<string, string>} */
    const out = new Map();
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined || NOT_STATE.has(key)) continue;
        if (key === 'variables' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            out.set('k\0variables', '{}');
            for (const [name, v] of Object.entries(value)) if (v !== undefined) out.set(`v\0${name}`, JSON.stringify(v));
            continue;
        }
        out.set(`k\0${key}`, JSON.stringify(value));
    }
    return out;
}

/**
 * @param {string | null | undefined} json
 * @returns {unknown} The parsed metadata, or undefined when it doesn't parse.
 */
export function parseMetadata(json) {
    if (json === null || json === undefined) return undefined;
    try {
        return JSON.parse(json);
    } catch {
        return undefined;
    }
}

/** A short hash of a value's JSON, for warnings that mustn't show values. */
export function shortHash(/** @type {string | undefined} */ json) {
    return json === undefined ? 'none' : crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
}

/**
 * @typedef {object} OwnerPlan
 * @property {Model} model
 * @property {{ at: string | null, label: string | null, name: string, mode: number, source: string, made: number | null }[]} bookmarks
 * `at`: the old message it is at (null: the root); `source`: the label's row, or the dropped chat's name; `made`:
 * when it was made (ms; null when that isn't stored).
 * @property {string[]} unsettled Label names nothing classified (made following).
 * @property {{ at: string | null, sources: string[], base: Map<string, string>, target: Map<string, string> }[]} states
 * The state each metadata sets at its message (null: the root), in the order they are recorded (an ancestor first;
 * several at one place in label order), each recorded as the changes from `base`.
 * @property {{ at: string | null, earlier: string, later: string, keys: string[] }[]} overrides Keys a later metadata at
 * the same place changes or removes.
 * @property {{ at: string | null, reply: string }[]} forks Default children that aren't the newest reply.
 * @property {{ at: string | null } | null} pointer Where the session's pointer goes (`at` null: the root).
 * @property {string[]} strayDefaults Rows whose default child isn't one of their replies.
 * @property {{ at: string | null, sources: string[], key: string, upper: string, lower: string | undefined }[]} shadows
 * @property {string[]} problems What stops the conversion.
 * @property {boolean} activeUnresolved The active chat names nothing.
 * @property {Map<string | null, Map<string, string>>} placed The state each place reads.
 */

/**
 * What converting one owner's chats records, read only.
 * @param {OwnerInput} input
 * @returns {OwnerPlan}
 */
export function planOwner(input) {
    const { db, ownerId } = input;
    const model = loadOwner(db, ownerId);
    const unreachable = new Set(model.unreachable);
    /** @type {OwnerPlan} */
    const plan = { model, bookmarks: [], unsettled: [], states: [], overrides: [], forks: [], pointer: null, strayDefaults: [], shadows: [], problems: [], activeUnresolved: false, placed: new Map() };
    if (model.unreachable.length) plan.problems.push(`${model.unreachable.length} message(s) no anchor reaches (a missing parent, or a cycle): ${model.unreachable.slice(0, 20).join(', ')}`);
    const firstAnchor = model.anchors[0] ?? null;
    const isAnchor = (/** @type {string} */ id) => model.rows.get(id)?.parent === null;
    /** Where a row is, as the engine has it: a message, or the root for an anchor. */
    const at = (/** @type {string} */ id) => (isAnchor(id) ? null : id);

    // Labels, then the chats the old migration left unnamed.
    const labeled = model.sorted.filter(r => r.label !== null && !unreachable.has(r.id));
    const sources = [
        ...labeled.map(r => ({ name: /** @type {string} */ (r.label), at: at(descendDefault(db, model, r.id)), label: r.id, made: r.created })),
        ...input.dropped.map(d => ({ name: d.name, at: d.kind === 'twin' ? d.end : null, label: null, made: d.kind === 'empty' ? d.created : null })),
    ];
    const { modes, unsettled } = input.classify(sources.map(s => s.name));
    plan.unsettled = unsettled;
    // A bookmark's label is free text: old labels convert as they are, repeats included.
    plan.bookmarks = sources.map(s => ({ at: s.at, label: s.label, name: s.name, mode: modes.get(s.name) ?? MODE.following, source: s.label ?? s.name, made: s.made }));

    // Metadata: each row's own, at that row; a dropped chat's at its place. Several at one place are each recorded
    // there in label order (rows by (created_at, id), then the dropped chats), so the last one's values read.
    /** @type {Map<string | null, { source: string, target: Map<string, string> }[]>} */
    const held = new Map();
    const metaRows = model.sorted.filter(r => r.meta);
    const metas = contentsOf(db, metaRows.map(r => r.id));
    const addMeta = (/** @type {string | null} */ where, /** @type {string} */ source, /** @type {unknown} */ value) => {
        const target = stateOf(value);
        const had = held.get(where);
        if (!had) {
            held.set(where, [{ source, target }]);
            return;
        }
        const last = had[had.length - 1];
        if (JSON.stringify([...last.target]) === JSON.stringify([...target])) return;
        had.push({ source, target });
    };
    for (const r of metaRows) {
        if (unreachable.has(r.id)) continue;
        const value = parseMetadata(metas.get(r.id)?.metadata);
        if (value === undefined) {
            plan.problems.push(`chat metadata of ${r.id} isn't JSON`);
            continue;
        }
        addMeta(at(r.id), r.id, value);
    }
    for (const d of input.dropped) if (d.metadata !== null) addMeta(d.kind === 'twin' ? d.end : null, d.name, d.metadata);

    // In the order recorded: the root, then down the tree (an ancestor first).
    const placeOrder = [null, ...model.order.filter(r => r.parent !== null).map(r => r.id)];
    const placed = plan.placed;
    for (const where of placeOrder) {
        const h = held.get(where);
        if (!h) continue;
        const upperAt = placeAbove(model, placed, where);
        const inherited = upperAt === undefined ? new Map() : /** @type {Map<string, string>} */ (placed.get(upperAt));
        const target = h[h.length - 1].target;
        for (const [k, v] of inherited) {
            if (target.get(k) !== v) {
                const upper = held.get(upperAt);
                plan.shadows.push({ at: where, sources: [...(upper?.map(e => e.source) ?? []), ...h.map(e => e.source)], key: k, upper: shortHash(v), lower: target.has(k) ? shortHash(target.get(k)) : undefined });
            }
        }
        let base = inherited;
        for (let i = 0; i < h.length; i++) {
            if (i > 0) {
                const keys = [...base.keys()].filter(k => base.get(k) !== h[i].target.get(k));
                if (keys.length) plan.overrides.push({ at: where, earlier: h[i - 1].source, later: h[i].source, keys });
            }
            plan.states.push({ at: where, sources: [h[i].source], base, target: h[i].target });
            base = h[i].target;
        }
        placed.set(where, target);
    }

    // Default children that aren't the newest reply: the first anchor's at the root, every message's at it.
    for (const r of model.order) {
        if (r.parent === null && r !== firstAnchor) continue;
        let dflt = r.dflt;
        if (r.id === input.repointAnchor) dflt = input.repointTo;
        if (dflt === null) continue;
        const kids = r.parent === null ? model.anchors.flatMap(a => model.children.get(a.id) ?? []) : model.children.get(r.id) ?? [];
        if (!kids.some(k => k.id === dflt)) {
            plan.strayDefaults.push(r.id);
            continue;
        }
        if (kids[kids.length - 1].id !== dflt) plan.forks.push({ at: at(r.id), reply: dflt });
    }

    // The pointer: the active chat's place (a label, else a chat converted from its file); else the root when a card
    // greeting is chosen there.
    if (input.active !== null) {
        const open = opens(db, ownerId, input.active);
        const file = open ? undefined : input.dropped.find(d => d.name === input.active);
        if (open) plan.pointer = { at: at(open.end) };
        else if (file) plan.pointer = { at: file.kind === 'twin' ? file.end : null };
        else plan.activeUnresolved = true;
    }
    if (plan.pointer === null && input.openingChoice !== null) plan.pointer = { at: null };
    return plan;
}

/**
 * @typedef {object} ChatContext
 * @property {{ message: bigint, position: bigint, change: bigint }} ids The next ids to give out.
 * @property {bigint} user
 * @property {string} handle
 * @property {number} now
 * @property {Map<string, import('../../chat-codec.js').Speaker>} speakers Characters by avatar.
 * @property {(json: string, where: string, records: object[]) => string} link A `world_info` value's JSON as recorded (a
 * link to its book; `records` gets the create of an unresolved name made for it).
 * @property {(records: object[]) => Promise<void>} load Adds to the bulk load holding the messages.
 */

/**
 * The counts of what an owner's conversion wrote.
 * @typedef {{ messages: number, bookmarks: number, rootBookmarks: number, changes: number, forks: number, itemizations: number, sendKeys: number, badSendKeys: string[], tokenCounts: number, sessions: number, unreadable: string[], later: object[], active: { time: number, record: object }[] }} OwnerCounts
 * `unreadable`: messages whose stored JSON can't be read (nothing of the owner is written past the first); `later`: the
 * session's records, committed once the bulk load holding the messages is in place; `active`: the `conversationActive`
 * record of each conversation made (a bookmark, the pointer's), with the time of its last message: committed last,
 * all owners' together in that order, which is the order recent chats list them in.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes one owner's chats as `planOwner()` planned them.
 * @param {ChatContext} ctx
 * @param {OwnerInput} input
 * @param {OwnerPlan} plan
 * @param {object} tree
 * @param {bigint} tree.id
 * @param {import('../../chat-codec.js').Speaker | null} tree.speaker The tree's character.
 * @param {Map<string, Record<string, any>>} fileItemizations The old per-chat files' entries for its messages.
 * @returns {Promise<OwnerCounts>}
 */
export async function writeOwner(ctx, input, plan, tree, fileItemizations) {
    const { db, ownerId } = input;
    const { model } = plan;
    /** @type {OwnerCounts} */
    const counts = { messages: 0, bookmarks: 0, rootBookmarks: 0, changes: 0, forks: 0, itemizations: 0, sendKeys: 0, badSendKeys: [], tokenCounts: 0, sessions: 0, unreadable: [], later: [], active: [] };
    /** @type {Map<string, bigint>} */
    const ids = new Map();
    for (const r of model.sorted) {
        if (r.parent === null) continue;
        ids.set(r.id, ctx.ids.message++);
    }
    const idOf = (/** @type {string} */ old) => /** @type {bigint} */ (ids.get(old));
    const user = ctx.user;

    /** @type {Map<string, string>} */
    const sendKeys = new Map();
    if (db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = \'send_keys\'')) {
        for (const r of /** @type {Iterable<{ send_key: string, node_id: string }>} */ (db.iterate(
            'SELECT k.send_key, k.node_id FROM send_keys k JOIN messages m ON m.id = k.node_id WHERE m.owner_id = ?', [ownerId]))) {
            if (UUID.test(r.send_key)) sendKeys.set(r.node_id, r.send_key);
            else counts.badSendKeys.push(r.node_id);
        }
    }
    /** @type {Map<string, { data: Buffer, raw: boolean }>} */
    const itemized = new Map();
    if (db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = \'itemizations\'')) {
        for (const r of /** @type {Iterable<{ node_id: string, data: Buffer, has_raw_prompt: number }>} */ (db.iterate(
            'SELECT i.node_id, i.data, i.has_raw_prompt FROM itemizations i JOIN messages m ON m.id = i.node_id WHERE m.owner_id = ?', [ownerId]))) {
            itemized.set(r.node_id, { data: Buffer.from(r.data), raw: !!r.has_raw_prompt });
        }
    }
    for (const [node, entry] of fileItemizations) {
        if (!itemized.has(node)) itemized.set(node, { data: zlib.zstdCompressSync(Buffer.from(JSON.stringify(entry))), raw: Boolean(entry.rawPrompt) });
    }


    // Messages, parents first, a batch at a time.
    const messages = model.order.filter(r => r.parent !== null);
    for (let i = 0; i < messages.length; i += 1000) {
        const batch = messages.slice(i, i + 1000);
        const contents = contentsOf(db, batch.map(r => r.id));
        const records = [];
        for (const r of batch) {
            const raw = contents.get(r.id)?.content ?? '';
            let content;
            try {
                content = JSON.parse(raw);
            } catch {
                counts.unreadable.push(r.id);
                continue;
            }
            if (content?.extra && typeof content.extra === 'object' && Object.hasOwn(content.extra, 'token_count')) counts.tokenCounts++;
            const stored = storedForm(content);
            const id = idOf(r.id);
            const parent = r.parent !== null && model.rows.get(r.parent)?.parent !== null ? idOf(r.parent) : null;
            const enc = encodeMessage(stored, r.created, speakerOf(ctx, stored, tree.speaker));
            const sendKey = sendKeys.get(r.id);
            for (const rec of messageRecords(id, enc, { parent, owner: tree.id, time: r.created, user, sendKey: sendKey ? Buffer.from(sendKey, 'utf8') : null })) records.push(rec);
            records.push({ kind: 'keyMap', message: id, key: Buffer.from(r.id, 'utf8') });
            if (sendKey) counts.sendKeys++;
            const it = itemized.get(r.id);
            if (it) {
                records.push({ kind: 'itemization', message: id, raw: it.raw, data: it.data });
                counts.itemizations++;
            }
            counts.messages++;
        }
        if (counts.unreadable.length) return counts;
        await ctx.load(records);
    }

    // State changes, an ancestor's first.
    /** @type {object[]} */
    const records = [];
    for (const s of plan.states) {
        const where = s.at === null ? { tree: tree.id } : { message: idOf(s.at) };
        const changes = [];
        for (const [k, v] of s.target) if (s.base.get(k) !== v) changes.push([k, v]);
        for (const k of s.base.keys()) if (!s.target.has(k)) changes.push([k, undefined]);
        for (const [k, v] of changes) {
            const variable = k.startsWith('v\0');
            const key = k.slice(2);
            /** @type {Record<string, unknown>} */
            const r = { kind: 'stateChange', id: ctx.ids.change++, ...where, time: ctx.now, author: AUTHOR.migration | (variable ? VARIABLE : 0), key, user };
            if (v !== undefined) r.value = !variable && key === WORLD_INFO ? ctx.link(v, `${ownerId}:${s.at ?? 'root'}`, records) : v;
            records.push(r);
            counts.changes++;
        }
    }
    if (records.length) await ctx.load(records);
    // The session's records come after the load, which they name messages of.
    const later = counts.later;

    const needsSession = plan.bookmarks.length > 0 || plan.forks.length > 0 || plan.pointer !== null || input.openingChoice !== null;
    if (needsSession) {
        const session = ctx.ids.position++;
        counts.sessions++;
        later.push({ kind: 'keyMap', session, key: Buffer.from(defaultSessionKey(ctx.handle, tree.id), 'utf8') });
        for (const f of plan.forks) {
            later.push({ kind: 'forkSelection', ...(f.at === null ? {} : { message: idOf(f.at) }), reply: idOf(f.reply), session, user });
            counts.forks++;
        }
        if (plan.pointer !== null) {
            later.push(plan.pointer.at === null
                ? { kind: 'pointerRoot', session, user, tree: tree.id, time: ctx.now }
                : { kind: 'pointerMove', session, user, target: idOf(plan.pointer.at) });
        }
        if (input.openingChoice !== null) later.push({ kind: 'openingChoice', session, user, tree: tree.id, index: input.openingChoice });
        /** @type {bigint[]} */
        const bookmarkIds = [];
        for (const b of plan.bookmarks) {
            const id = ctx.ids.position++;
            bookmarkIds.push(id);
            later.push(b.at === null
                ? { kind: 'positionRoot', id, mode: b.mode, session, user, tree: tree.id, time: b.made ?? ctx.now }
                : { kind: 'positionCreate', id, mode: b.mode, session, user, pointer: idOf(b.at) });
            later.push({ kind: 'positionName', id, name: b.name });
            counts.bookmarks++;
            if (b.at === null) counts.rootBookmarks++;
        }
        for (const a of activeConversations(model, plan, ctx.now)) {
            counts.active.push({ time: a.time, record: { kind: 'conversationActive', ...(a.bookmark === null ? { session, tree: tree.id } : { bookmark: bookmarkIds[a.bookmark] }) } });
        }
    }
    return counts;
}

/**
 * The conversations an owner's conversion makes that recent chats list: each bookmark (`bookmark`: its index in the
 * plan), then the pointer's (`bookmark` null), each with the time of the message it is at (a root's: when the bookmark
 * was made, else `now`).
 * @param {Model} model
 * @param {OwnerPlan} plan
 * @param {number} now
 * @returns {{ time: number, bookmark: number | null }[]}
 */
export function activeConversations(model, plan, now) {
    const timeOf = (/** @type {string | null} */ at, /** @type {number} */ root) => (at === null ? root : /** @type {any} */ (model.rows.get(at)).created);
    const out = plan.bookmarks.map((b, bookmark) => ({ time: timeOf(b.at, b.made ?? now), bookmark }));
    if (plan.pointer !== null) out.push({ time: timeOf(plan.pointer.at, now), bookmark: null });
    return out;
}

/** Each row's end down its default children, as `descendDefaultSync()` finds it, kept per model. */
const ends = new WeakMap();

/**
 * Where a row's default children lead (`descendDefaultSync()`), read from the owner's rows; a default child outside
 * them is followed in the file as `descendDefaultSync()` follows it.
 * @param {Db} db
 * @param {Model} model
 * @param {string} id
 * @returns {string}
 */
export function descendDefault(db, model, id) {
    if (!ends.has(model)) ends.set(model, new Map());
    /** @type {Map<string, string>} */
    const memo = ends.get(model);
    const walked = [];
    const seen = new Set([id]);
    let current = id;
    let end;
    for (;;) {
        const known = memo.get(current);
        if (known !== undefined) {
            end = known;
            break;
        }
        walked.push(current);
        const next = model.rows.get(current)?.dflt ?? null;
        if (next === null || seen.has(next)) {
            end = current;
            break;
        }
        if (!model.rows.has(next)) {
            // Today's walk follows any row that exists, in whatever owner.
            return descendDefaultSync(db, current);
        }
        seen.add(next);
        current = next;
    }
    // Inside a cycle the end depends on the start; only a path that ended at a row with no default child is kept.
    if (model.rows.get(end)?.dflt === null) for (const w of walked) memo.set(w, end);
    return end;
}

/**
 * The nearest place above `at` whose state is planned: a message, or the root (null); undefined when none is.
 * @param {Model} model
 * @param {Map<string | null, unknown>} placed
 * @param {string | null} at
 * @returns {string | null | undefined}
 */
function placeAbove(model, placed, at) {
    if (at === null) return undefined;
    let up = model.rows.get(at)?.parent;
    while (up !== undefined && up !== null) {
        const row = model.rows.get(up);
        if (!row || row.parent === null) break;
        if (placed.has(up)) return up;
        up = row.parent;
    }
    return placed.has(null) ? null : undefined;
}

/**
 * A message's speaker as `ChatEngine.speakerFor()` finds it: none for a user's, the character its `original_avatar`
 * names, else the tree's character.
 * @param {ChatContext} ctx
 * @param {Record<string, any>} content
 * @param {import('../../chat-codec.js').Speaker | null} treeSpeaker
 */
export function speakerOf(ctx, content, treeSpeaker) {
    if (content?.is_user === true) return null;
    if (typeof content?.original_avatar === 'string') {
        const s = ctx.speakers.get(content.original_avatar);
        if (s) return s;
    }
    return treeSpeaker;
}
