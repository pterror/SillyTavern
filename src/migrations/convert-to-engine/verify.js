import fs from 'node:fs';
import path from 'node:path';

import { canonicalCardHash, canonicalJson } from '../../character-card-storage.js';
import { decodeMessage } from '../../chat-codec.js';
import { ChatEngine, defaultSessionKey, storedForm } from '../../chat-engine.js';
import { libraryPeople } from '../../chat-people.js';
import { LibraryEngine, HASH } from '../../library-engine.js';
import { TYPE } from '../../library-codes.js';
import { normalizeFav, normalizeTagIds } from '../../../public/scripts/hash-utils.js';
import { characterBatches, readsAs } from './old-library.js';
import { contentsOf, pathTo } from './old-chats.js';
import { planOwner, stateOf } from './chats.js';

/**
 * Checks the new store against the old stores, reading both: every card by its canonical hash and its avatar under
 * its hash, every group, tag and world book, every message read back as it was stored, every bookmark's and
 * pointer's path, every fork choice and the state at every message that held chat metadata.
 */

/**
 * @param {unknown[]} a
 * @param {unknown[]} b
 */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Group keys that aren't the group's own values (the library's or the sessions'). */
const GROUP_READ_KEYS = ['id', 'fav', 'tag_ids', 'date_added', 'create_date', 'date_last_chat', 'chat_size', 'chat_id', 'chats'];

/**
 * @param {object} v
 * @param {any} v.store
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle | null} v.meta
 * @param {string} v.avatarsDir
 * @param {string} v.charactersDir
 * @param {import('./old-library.js').OldTags | null} v.tags
 * @param {import('./old-library.js').OldGroup[]} v.groups
 * @param {() => Iterable<import('./worlds.js').WorldBook>} v.books The world books, read again.
 * @param {Set<string>} v.bookNames The ones converted.
 * @param {{ input: import('./chats.js').OwnerInput, tree: bigint, files: Map<string, Record<string, any>> }[]} v.owners
 * @param {string} v.handle
 * @param {Record<string, number>} v.counts
 * @param {(line: string) => void} v.progress
 * @returns {Promise<string[]>} What differs.
 */
export async function verify(v) {
    /** @type {string[]} */
    const bad = [];
    const lib = new LibraryEngine(v.store, await v.store.libraryNextId());
    const people = libraryPeople(lib);
    const chats = new ChatEngine(v.store, people, await v.store.chatRead('nextIds', {}));

    // ---- characters ----
    let characters = 0;
    if (v.meta) {
        for (const batch of characterBatches(v.meta)) {
            const avatars = batch.map(c => c.avatar);
            const ids = await lib.ids(TYPE.character, avatars);
            const entities = await lib.entities(ids);
            const present = entities.filter(e => e !== null);
            const tagKeys = new Map((await lib.tagKeys(/** @type {any[]} */ (present))).map((k, i) => [(present[i]).id, k]));
            for (const [i, c] of batch.entries()) {
                const e = entities[i];
                if (!e) {
                    bad.push(`character ${c.avatar}: not in the store`);
                    continue;
                }
                characters++;
                const card = await lib.assembled(e);
                if (canonicalCardHash(card) !== canonicalCardHash(c.card)) bad.push(`character ${c.avatar}: its card reads back differently`);
                const want = normalizeTagIds([...new Set(c.tags.map(t => (v.tags ? readsAs(v.tags, t) : t)).filter(t => t !== null))]);
                if (JSON.stringify(tagKeys.get(e.id)) !== JSON.stringify(want)) bad.push(`character ${c.avatar}: its tags read back differently`);
                const image = path.join(v.charactersDir, c.avatar);
                if (fs.existsSync(image)) {
                    const h = e.hashes.find(x => x.which === HASH.avatar)?.hash.toString('hex');
                    const file = h ? path.join(v.avatarsDir, `${h}${path.extname(c.avatar) || '.png'}`) : null;
                    if (!file || !fs.existsSync(file) || fs.statSync(file).size !== fs.statSync(image).size) bad.push(`character ${c.avatar}: its avatar isn't in the store under its hash`);
                }
            }
            v.progress(`checked characters: ${characters}`);
        }
    }

    // ---- groups ----
    const groupRows = await lib.groups(v.groups.map(g => g.group.id));
    for (const [i, g] of v.groups.entries()) {
        const got = groupRows[i];
        if (!got) {
            bad.push(`group ${g.group.id}: not in the store`);
            continue;
        }
        const own = (/** @type {Record<string, unknown>} */ o) => canonicalJson(Object.fromEntries(Object.entries(o).filter(([k, x]) => !GROUP_READ_KEYS.includes(k) && x !== undefined)));
        if (own(got) !== own(g.group)) bad.push(`group ${g.group.id}: its values read back differently`);
        if (got.fav !== normalizeFav(g.group.fav)) bad.push(`group ${g.group.id}: its fav reads back differently`);
        const want = normalizeTagIds([...new Set((v.tags?.groupTags.get(g.group.id) ?? []).map(t => (v.tags ? readsAs(v.tags, t) : t)).filter(t => t !== null))]);
        if (JSON.stringify(got.tag_ids) !== JSON.stringify(want)) bad.push(`group ${g.group.id}: its tags read back differently`);
    }

    // ---- tags ----
    if (v.tags) {
        const keys = [...v.tags.definitions.keys()].filter(k => !v.tags?.deletions.has(k));
        for (let i = 0; i < keys.length; i += 500) {
            const { tags } = await lib.tags.byIds(keys.slice(i, i + 500));
            const byId = new Map(tags.map(t => [t.id, t]));
            for (const k of keys.slice(i, i + 500)) {
                const got = byId.get(k);
                if (!got || canonicalJson(got) !== canonicalJson(v.tags.definitions.get(k))) bad.push(`tag ${k}: its definition reads back differently`);
            }
        }
        const deleted = [...v.tags.deletions.keys()];
        const { merged, gone } = await lib.tags.byIds(deleted);
        for (const [k, into] of v.tags.deletions) {
            if (into === null ? !gone.includes(k) : merged[k] !== into) bad.push(`deleted tag ${k}: doesn't read as merged into ${into ?? 'nothing'}`);
        }
    }

    // ---- world books ----
    for (const wb of v.books()) {
        if (!('book' in wb) || !v.bookNames.has(wb.name)) continue;
        const got = await lib.books.read(wb.name);
        if (JSON.stringify(got) !== JSON.stringify(wb.book)) bad.push(`world book ${wb.name}: reads back differently`);
    }

    // ---- counts ----
    const all = await v.store.libraryPage({ characters: true, groups: false, count: true, limit: 0, cap: Number.MAX_SAFE_INTEGER, sort: { key: 0, desc: false } });
    if (all.total !== (v.counts.characters ?? 0)) bad.push(`characters counted in the store: ${all.total}, converted: ${v.counts.characters ?? 0}`);
    const groups = await v.store.libraryPage({ characters: false, groups: true, count: true, limit: 0, cap: Number.MAX_SAFE_INTEGER, sort: { key: 0, desc: false } });
    if (groups.total !== (v.counts.groups ?? 0)) bad.push(`groups counted in the store: ${groups.total}, converted: ${v.counts.groups ?? 0}`);

    // ---- chats ----
    const [user] = await v.store.chatRead('ids', { space: 2, keys: [v.handle] });
    let checked = 0;
    for (const o of v.owners) {
        for (const line of await verifyOwner(v, chats, o, user)) bad.push(`owner ${o.input.ownerId}: ${line}`);
        if (++checked % 200 === 0) v.progress(`checked chat owners: ${checked} of ${v.owners.length}`);
    }
    return bad;
}

/**
 * @param {Parameters<typeof verify>[0]} v
 * @param {ChatEngine} chats
 * @param {Parameters<typeof verify>[0]['owners'][number]} o
 * @param {bigint | null} user
 * @returns {Promise<string[]>}
 */
async function verifyOwner(v, chats, o, user) {
    const bad = [];
    const { input, tree } = o;
    const plan = planOwner(input);
    const { model } = plan;
    const messages = model.order.filter(r => r.parent !== null);
    /** @type {Map<string, bigint>} */
    const ids = new Map();
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);
        const found = await v.store.chatRead('ids', { space: 0, keys: batch.map(r => r.id) });
        batch.forEach((r, j) => {
            if (found[j] === null) bad.push(`message ${r.id} has no key`);
            else ids.set(r.id, found[j]);
        });
    }
    const newOf = (/** @type {string | null} */ old) => (old === null ? null : ids.get(old) ?? null);
    const hasTable = (/** @type {string} */ t) => !!input.db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = ?', [t]);
    const itemized = new Set(o.files.keys());
    if (hasTable('itemizations')) {
        for (const r of /** @type {Iterable<{ node_id: string }>} */ (input.db.iterate('SELECT i.node_id FROM itemizations i JOIN messages m ON m.id = i.node_id WHERE m.owner_id = ?', [input.ownerId]))) itemized.add(r.node_id);
    }
    const isAnchor = (/** @type {string} */ id) => model.rows.get(id)?.parent === null;
    const speakerIds = new Map();
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500).filter(r => ids.has(r.id));
        const stored = await v.store.chatRead('messages', { ids: batch.map(r => /** @type {bigint} */ (ids.get(r.id))) });
        const wanted = new Set();
        for (const s of stored) if (s?.speaker !== null && s?.speaker !== undefined && !speakerIds.has(s.speaker)) wanted.add(s.speaker);
        if (wanted.size) for (const [id, s] of await chats.people.speakers([...wanted])) speakerIds.set(id, s);
        const contents = contentsOf(input.db, batch.map(r => r.id));
        for (const [j, r] of batch.entries()) {
            const s = stored[j];
            if (!s) {
                bad.push(`message ${r.id} isn't in the store`);
                continue;
            }
            if (s.owner !== tree) bad.push(`message ${r.id} is in another tree`);
            const parent = r.parent !== null && !isAnchor(r.parent) ? newOf(r.parent) : null;
            if (s.parent !== parent) bad.push(`message ${r.id} has another parent`);
            const want = JSON.stringify(storedForm(JSON.parse(/** @type {any} */ (contents.get(r.id)).content)));
            if (decodeMessage(s, id => speakerIds.get(id) ?? null) !== want) bad.push(`message ${r.id} reads back differently`);
            if ((s.itemized !== null) !== itemized.has(r.id)) bad.push(`message ${r.id} ${s.itemized !== null ? 'has an itemization it didn\'t have' : 'lost its itemization'}`);
        }
    }
    const pathOf = async (/** @type {string | null} */ at) => {
        if (at === null) return { want: [], got: [] };
        const got = await v.store.chatRead('path', { tree, at: newOf(at) });
        return { want: pathTo(input.db, at).map(x => newOf(x)), got };
    };
    for (const b of plan.bookmarks) {
        const [id] = await v.store.chatRead('bookmarksNamed', { tree, name: b.name });
        if (id === undefined) {
            bad.push(`bookmark "${b.name}" isn't there`);
            continue;
        }
        const [row] = await v.store.chatRead('bookmarks', { ids: [id] });
        if (b.at === null ? row.root !== tree : row.at !== newOf(b.at)) bad.push(`bookmark "${b.name}" is elsewhere`);
        if (row.mode !== b.mode) bad.push(`bookmark "${b.name}" has another mode`);
        const p = await pathOf(b.at);
        if (!sameList(p.got, p.want)) bad.push(`bookmark "${b.name}" opens another path`);
    }
    const [session] = await v.store.chatRead('ids', { space: 1, keys: [defaultSessionKey(v.handle, tree)] });
    if (plan.pointer !== null) {
        const where = session === null ? null : await v.store.chatRead('sessionInTree', { session, tree });
        const at = plan.pointer.at === null ? null : newOf(plan.pointer.at);
        if (!where || (where.at ?? null) !== at) bad.push('its pointer is elsewhere');
        const p = await pathOf(plan.pointer.at);
        if (!sameList(p.got, p.want)) bad.push('its pointer opens another path');
    }
    for (const f of plan.forks) {
        const at = f.at === null ? null : newOf(f.at);
        const followed = await v.store.chatRead('followed', { tree, ...(at === null ? {} : { at }), session, user });
        if (followed !== newOf(f.reply)) bad.push(`the fork at ${f.at ?? 'the root'} follows another reply`);
    }
    for (const s of plan.states) {
        const at = s.at === null ? null : newOf(s.at);
        const got = stateOf(await chats.metadata(tree, at));
        if (JSON.stringify([...got].sort()) !== JSON.stringify([...s.target].sort())) bad.push(`the state at ${s.at ?? 'the root'} reads back differently`);
    }
    if (hasTable('send_keys')) {
        const keys = /** @type {{ send_key: string, node_id: string }[]} */ ([...input.db.iterate('SELECT k.send_key, k.node_id FROM send_keys k JOIN messages m ON m.id = k.node_id WHERE m.owner_id = ?', [input.ownerId])])
            .filter(k => UUID.test(k.send_key));
        for (let i = 0; i < keys.length; i += 500) {
            const batch = keys.slice(i, i + 500);
            const sent = await v.store.chatRead('sent', { owner: tree, keys: batch.map(k => Buffer.from(k.send_key, 'utf8')) });
            batch.forEach((k, j) => {
                if (sent[j] !== newOf(k.node_id)) bad.push(`the send key of message ${k.node_id} doesn't find it`);
            });
        }
    }
    return bad;
}
