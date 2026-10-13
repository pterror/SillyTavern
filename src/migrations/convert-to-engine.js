import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { isChatHeaderEntry, parseChatFile } from '../chat-header.js';
import { KEPT_ITEMIZATION_FILES, TYPE, convertedFileKey } from '../library-codes.js';
import { canonicalJson } from '../character-card-storage.js';
import { bookKey } from '../world-info-keys.js';
import { parseTimestamp } from '../timestamps.js';
import { TAG_SORTS } from '../library-engine-tags.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';
import { BATCH, cardsOf, characterBatches, hasTable, openOld, readGroups, readTags, readsAs, strayCharacterTagRows } from './convert-to-engine/old-library.js';
import { STRAY_OWNER, ZZTEST_GROUP_ID, STRAY_GROUP_CHAT, IVY_OPENING_ID, GROUP_ANCHOR_ID, KEPT, groupOverlay, importChatFile, itemizedEntries, itemizedFilePlans, openTree, ownerIds, readChatRun, unlabeledChatFiles, walkChat, zztestPlans } from './convert-to-engine/old-chats.js';
import { bookmarkLinksOf, backupNames, classify, openBackups } from './convert-to-engine/labels.js';
import { planOwner, writeOwner } from './convert-to-engine/chats.js';
import { worldBooks } from './convert-to-engine/worlds.js';
import { Sink } from './convert-to-engine/sink.js';

// These read config when they load, so a static import would run before the config path is set.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) setConfigFilePath(parseArgs(process.argv.slice(2)).config);
const { characterRecords, groupRecords, ownedBookRecords, tagRecords, worldBookRecords } = await import('./convert-to-engine/records.js');
const { verify } = await import('./convert-to-engine/verify.js');

/**
 * Converts one user's data into the engine store (build path stage 5e): the library, chats, world info and search,
 * read from today's files as they are and written once into `<user>/store/`. A one-off: run once, with the server
 * stopped, then deleted.
 *
 *   node src/migrations/convert-to-engine.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml] [--keep-orphans]
 *   node src/migrations/convert-to-engine.js --apply --server-stopped [the same]
 *
 * The dry run reads only and prints what the apply would do: counts per kind and every warning. The apply builds the
 * store in `<user>/store.converting/` (a run that stopped partway is deleted and built again), checks it against the
 * old stores (counts, every card's canonical hash, every message read back, every bookmark's and pointer's path, the
 * state at every message that held chat metadata, every avatar under its hash), and only then renames it to
 * `<user>/store/`. Any difference stops it, lists what differed and deletes the new store. The old files are never
 * written: the user deletes them after a clean start.
 *
 * Folded in: the fields converter's pass-less tag moves, the world-info sidecar conversion, the group chat repair,
 * the zztest cleanup and the old per-chat prompt itemization files. A character's chat file no label in the tree names
 * converts as a chat of its own. Prompt itemization files whose entries can't be placed for sure stay on disk as they
 * are, listed in the store under `KEPT_ITEMIZATION_FILES`.
 */

const LOG_PREFIX = '[convert-to-engine]';
export const STORE_DIR = 'store';
export const BUILDING_DIR = 'store.converting';
/** Lines listed per warning before the rest are counted. */
const LISTED = 200;
/** The store's size against the old stores', planned for when checking free space (measured on synthetic data). */
const SPACE_FACTOR = 1.5;

/**
 * @typedef {object} Report
 * @property {Record<string, number>} counts
 * @property {Map<string, string[]>} warnings Each kind of warning and its lines.
 * @property {string[]} problems What stops the apply.
 * @property {string[]} lines Other lines to show.
 */

/** @returns {Report} */
function newReport() {
    return { counts: {}, warnings: new Map(), problems: [], lines: [] };
}

/**
 * @param {Report} report
 * @param {string} kind
 * @param {string} line
 */
function warn(report, kind, line) {
    if (!report.warnings.has(kind)) report.warnings.set(kind, []);
    /** @type {string[]} */ (report.warnings.get(kind)).push(line);
}

/**
 * @param {Report} report
 * @param {string} kind
 * @param {number} [n]
 */
function count(report, kind, n = 1) {
    report.counts[kind] = (report.counts[kind] ?? 0) + n;
}

/**
 * The user's directories this conversion reads.
 * @param {string} root
 */
export function userDirectories(root) {
    /** @type {any} */
    const dirs = { root };
    for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) dirs[k] = path.join(root, /** @type {string} */ (v));
    return dirs;
}

/**
 * @typedef {object} ConvertOptions
 * @property {string} root The user's directory.
 * @property {string} handle
 * @property {any} Database better-sqlite3's constructor.
 * @property {any} engine The engine binding (apply only).
 * @property {boolean} apply
 * @property {boolean} keepOrphans Convert owners with no character or group as unowned trees.
 * @property {number} [now]
 * @property {(line: string) => void} [progress]
 */

/**
 * Reads everything and, applying, writes the store at `storeDir`.
 * @param {ConvertOptions & { storeDir?: string }} o
 * @returns {Promise<{ report: Report, sink: Sink, stats: any }>} `stats`: the store's (`Store.stats()`), applying.
 */
export async function convert(o) {
    const report = newReport();
    const progress = o.progress ?? (() => {});
    const now = o.now ?? Date.now();
    let phaseStart = performance.now();
    /** @type {string[]} */
    const phases = [];
    const phase = (/** @type {string} */ name) => {
        const t = performance.now();
        phases.push(`${name} ${((t - phaseStart) / 1000).toFixed(1)} s`);
        phaseStart = t;
    };
    const dirs = userDirectories(o.root);
    const metaPath = path.join(o.root, 'character-metadata.sqlite');
    const treePath = path.join(o.root, 'message-tree.sqlite');
    const meta = fs.existsSync(metaPath) ? openOld(o.Database, metaPath) : null;
    const tree = fs.existsSync(treePath) ? openTree(o.Database, treePath) : null;
    const store = o.apply ? await o.engine.Store.open(/** @type {string} */ (o.storeDir)) : null;
    const sink = new Sink(store);
    /** @type {import('./convert-to-engine/records.js').Ids} */
    const ids = { nextId: 1n };
    /** @type {import('../endpoints/sqlite-engine.js').SqliteEngineHandle[]} */
    const backups = [];
    let overlay = null;
    /** @type {Parameters<typeof verify>[0]['owners']} */
    let chatChecks = [];
    /** @type {{ file: string, reason: string, entries: number }[]} */
    const keptItemizations = [];
    try {
        // ---- groups and tags ----
        const groupRead = meta ? readGroups(meta, dirs.groups) : { groups: [], unread: [], rowsWithoutFile: [] };
        for (const u of groupRead.unread) warn(report, 'group files not read (today\'s server doesn\'t read them either)', `${u.file}: ${u.reason}`);
        for (const id of groupRead.rowsWithoutFile) warn(report, 'group rows with no group file (today\'s server lists no such group)', id);
        const groupIds = new Set(groupRead.groups.map(g => g.group.id));
        const tags = meta ? await readTags(o.Database, meta, groupIds) : null;
        if (tags) {
            for (const w of tags.passLess.warnings) warn(report, 'queued tag moves (applied as the fields converter applied them)', w);
            if (tags.passLess.applied) report.lines.push(`queued tag moves with no reorder pass, applied: ${tags.passLess.applied}`);
            for (const id of tags.unreadable) warn(report, 'tag rows whose definition isn\'t a JSON object (kept as a key with no definition)', id);
            for (const r of tags.strayGroupTags) warn(report, 'group tag rows read as no group\'s (a .png id, or no group file)', `${r.entity} -> ${r.tag}`);
        }
        /** @type {Map<string, bigint>} */
        const tagIds = new Map();
        const loadTag = async (/** @type {string} */ key) => {
            const known = tagIds.get(key);
            if (known !== undefined) return known;
            const id = ids.nextId++;
            tagIds.set(key, id);
            const def = tags?.definitions.get(key);
            await sink.toLoad(def ? tagRecords(id, /** @type {any} */ (def), now) : [{ kind: 'entityCreate', entity: id, type: TYPE.tag, key, added: now }]);
            count(report, def ? 'tag definitions' : 'tag keys with no definition');
            return id;
        };
        if (tags) {
            for (const key of tags.definitions.keys()) await loadTag(key);
            for (const [key, into] of tags.deletions) {
                await loadTag(key);
                if (into !== null) await loadTag(into);
            }
        }
        /**
         * The tag ids an entity carries: its rows as they read today, each once.
         * @param {string[]} rows
         */
        const carried = async rows => {
            const out = new Set();
            for (const t of rows) {
                const reads = tags ? readsAs(tags, t) : t;
                if (reads !== null) out.add(await loadTag(reads));
            }
            return [...out];
        };

        // ---- characters ----
        /** @type {Map<string, import('../chat-codec.js').Speaker>} */
        const speakers = new Map();
        /** @type {Map<string, string>} A character's tree's owner key and its avatar. */
        const byStem = new Map();
        /** @type {Map<string, string>} */
        const activeChats = new Map();
        /** @type {Map<bigint, string>} */
        const links = new Map();
        /** @type {string[]} */
        const withBooks = [];
        /** @type {{ name: string, size: number, mtimeMs: number }[]} The files of `characters/` converted, as they are now. */
        const convertedFiles = [];
        if (meta) {
            let done = 0;
            for (const batch of characterBatches(meta)) {
                for (const c of batch) {
                    if (c.card === null) {
                        report.problems.push(`character ${c.avatar}: its stored card can't be read`);
                        continue;
                    }
                    const id = ids.nextId++;
                    const imageFile = path.join(dirs.characters, c.avatar);
                    if (fs.existsSync(imageFile)) {
                        const st = fs.statSync(imageFile);
                        convertedFiles.push({ name: c.avatar, size: st.size, mtimeMs: st.mtimeMs });
                    } else {
                        warn(report, 'characters with no image file in characters/ (shown with the default avatar)', c.avatar);
                    }
                    const built = characterRecords(id, c.avatar, c.card, { fav: c.fav, dateAdded: c.dateAdded, contentHash: c.contentHash, avatarIdentityHash: c.avatarIdentityHash, directories: dirs });
                    const records = built.records;
                    for (const t of await carried(c.tags)) records.push({ kind: 'tagAssign', entity: id, tag: t, assigned: true });
                    await sink.toLoad(records);
                    speakers.set(c.avatar, { id, name: built.name, avatar: c.avatar });
                    const stem = c.avatar.replace('.png', '');
                    const other = byStem.get(stem);
                    if (other !== undefined) report.problems.push(`characters ${other} and ${c.avatar} both read the chats of owner ${stem}`);
                    byStem.set(stem, c.avatar);
                    if (c.activeChat !== null) activeChats.set(c.avatar, c.activeChat);
                    if (built.linkKey) links.set(id, built.linkKey);
                    if (built.book) withBooks.push(c.avatar);
                    count(report, 'characters');
                }
                done += batch.length;
                progress(`characters read: ${done}`);
            }
            for (const r of strayCharacterTagRows(meta)) warn(report, 'character tag rows of no character', `${r.entity} -> ${r.tag}`);
        }

        // ---- groups ----
        /** @type {Map<string, bigint>} */
        const groupEntity = new Map();
        for (const g of groupRead.groups) {
            const id = ids.nextId++;
            groupEntity.set(g.group.id, id);
            const records = groupRecords(id, g.group, g.dateAdded);
            for (const t of await carried(tags?.groupTags.get(g.group.id) ?? [])) records.push({ kind: 'tagAssign', entity: id, tag: t, assigned: true });
            await sink.toLoad(records);
            count(report, 'groups');
        }

        // ---- chat owners ----
        const owners = tree ? ownerIds(tree) : [];
        /** @type {Map<string, { id: bigint, kind: 'character' | 'group' | 'unowned', speaker: import('../chat-codec.js').Speaker | null }>} */
        const trees = new Map();
        /** @type {string[]} */
        const orphans = [];
        const zz = tree ? zztestPlans(tree, { characterFileExists: fs.existsSync(path.join(dirs.characters, `${STRAY_OWNER}.png`)), characterRowExists: speakers.has(`${STRAY_OWNER}.png`) }, groupRead.groups.find(g => g.group.id === ZZTEST_GROUP_ID)?.group) : null;
        for (const ownerId of owners) {
            if (ownerId === STRAY_OWNER && zz?.stray.status === 'change') continue;
            const avatar = byStem.get(ownerId);
            const group = groupEntity.get(ownerId);
            if (avatar !== undefined && group !== undefined) {
                report.problems.push(`owner ${ownerId} is read as both character ${avatar}'s chats and group ${ownerId}'s`);
                continue;
            }
            if (avatar !== undefined) {
                const s = /** @type {import('../chat-codec.js').Speaker} */ (speakers.get(avatar));
                trees.set(ownerId, { id: s.id, kind: 'character', speaker: s });
            } else if (group !== undefined) {
                trees.set(ownerId, { id: group, kind: 'group', speaker: null });
            } else {
                orphans.push(ownerId);
                if (o.keepOrphans) {
                    const id = ids.nextId++;
                    trees.set(ownerId, { id, kind: 'unowned', speaker: null });
                    await sink.toLoad([{ kind: 'entityCreate', entity: id, type: TYPE.tree, key: ownerId, added: now }]);
                }
            }
        }
        // Groups with no rows yet still get the chats the old migration left unnamed.
        for (const g of groupRead.groups) {
            if (!trees.has(g.group.id)) trees.set(g.group.id, { id: /** @type {bigint} */ (groupEntity.get(g.group.id)), kind: 'group', speaker: null });
        }

        if (report.problems.length && o.apply) throw new Stop(report);
        phase('reading the library');
        progress('installing the bulk load');
        const loadStats = await sink.finishLoad();
        if (loadStats) report.lines.push(`bulk load: ${loadStats.records} records, ${loadStats.totalMs.toFixed(0)} ms (derive ${loadStats.deriveMs.toFixed(0)} ms of CPU, merge ${loadStats.mergeMs.toFixed(0)} ms, numberings ${loadStats.numbersMs.toFixed(0)} ms), ${loadStats.logBytes} log bytes, ${loadStats.runBytes} run bytes`);

        phase('installing the bulk load');
        // ---- after the load: merges, the tag pass, marks ----
        if (tags) {
            for (const [key, into] of tags.deletions) {
                await sink.commit([
                    { kind: 'tagMerge', tag: /** @type {bigint} */ (tagIds.get(key)), ...(into === null ? {} : { into: /** @type {bigint} */ (tagIds.get(into)) }) },
                    { kind: 'entityDelete', entity: /** @type {bigint} */ (tagIds.get(key)) },
                ]);
                count(report, 'deleted tags (kept as merged)');
            }
            if (tags.pass) {
                const mode = /** @type {Record<string, number>} */ (TAG_SORTS)[tags.pass.mode];
                if (mode === undefined) report.problems.push(`the recorded tag reorder pass has a mode the engine has no order for: ${tags.pass.mode}`);
                else {
                    const records = [{ kind: 'tagPass', pass: tags.pass.id, mode, phase: 0, n: 0 }];
                    for (const [i, q] of tags.queue.entries()) {
                        const tag = await tagIdOrNull(tagIds, q.tag);
                        const anchor = q.anchor === null ? null : await tagIdOrNull(tagIds, q.anchor);
                        if (tag === null || (q.anchor !== null && anchor === null)) {
                            warn(report, 'queued tag moves naming a tag that isn\'t there (dropped, as the pass would refuse them)', `move ${q.seq}`);
                            continue;
                        }
                        records.push(/** @type {any} */ ({ kind: 'tagQueue', seq: i + 1, tag, after: q.side === 'after', ...(anchor === null ? { value: q.value } : { anchor }) }));
                    }
                    await sink.commit(records);
                    report.lines.push(`tag reorder pass ${tags.pass.id} recorded, ${records.length - 1} queued move(s); the server runs it after it starts`);
                }
            }
            for (const m of tags.meta) {
                await sink.commit([{ kind: 'metaValue', key: m.key, json: m.key === 'tags_seed_pending' ? 'true' : JSON.stringify(m.value) }]);
            }
        }

        // ---- world books, links, characters' own books ----
        /** @type {Map<string, bigint>} */
        const books = new Map();
        /** @type {Set<string>} */
        const bookNames = new Set();
        for (const wb of worldBooks(dirs.worlds)) {
            if ('unread' in wb) {
                warn(report, 'world info files not converted (today\'s server can\'t read them either)', `${wb.file}: ${wb.unread}`);
                continue;
            }
            const key = bookKey(wb.name);
            if (books.has(key)) {
                warn(report, 'world info files whose name another file\'s takes', wb.file);
                continue;
            }
            const id = ids.nextId++;
            books.set(key, id);
            bookNames.add(wb.name);
            await sink.commit(await worldBookRecords(ids, id, key, wb.book, now));
            count(report, 'world books');
        }
        /** @type {Map<string, bigint>} */
        const unresolved = new Map();
        /**
         * The book a lorebook name links: the world book its key finds, else an unresolved name made once.
         * @param {string} key
         * @param {string} where
         * @param {object[]} records
         */
        const bookFor = (key, where, records) => {
            const found = books.get(key) ?? unresolved.get(key);
            if (found === undefined || !books.has(key)) warn(report, 'lorebook names no world book has (kept as unresolved links)', `${where}: ${key}`);
            if (found !== undefined) return found;
            const id = ids.nextId++;
            unresolved.set(key, id);
            records.push({ kind: 'entityCreate', entity: id, type: TYPE.book, key, added: now });
            return id;
        };
        {
            const avatarOf = new Map([...speakers.values()].map(s => [s.id, s.avatar]));
            /** @type {object[]} */
            let records = [];
            for (const [entity, key] of links) {
                records.push({ kind: 'bookLink', entity, book: bookFor(key, `character ${avatarOf.get(entity)}`, records) });
                count(report, 'character lorebook links');
                if (records.length >= 2000) {
                    await sink.commit(records);
                    records = [];
                }
            }
            if (records.length) await sink.commit(records);
        }
        if (meta) {
            for (let i = 0; i < withBooks.length; i += BATCH) {
                const cards = cardsOf(meta, withBooks.slice(i, i + BATCH));
                for (const [avatar, card] of cards) {
                    const s = speakers.get(avatar);
                    if (!s || !card) continue;
                    await sink.commit(await ownedBookRecords(ids, s.id, card.data.character_book));
                    count(report, 'characters\' own books');
                }
            }
        }
        for (const f of convertedFiles) {
            await sink.commit([{ kind: 'metaValue', key: convertedFileKey(f.name), json: JSON.stringify([f.size, f.mtimeMs]) }]);
            count(report, 'character files recorded as converted (a rescan leaves them)');
        }

        phase('tags, world books, links and own books');
        // ---- chats ----
        if (tree) {
            const groupIdList = groupRead.groups.map(g => g.group.id);
            // A character's chat files no label in the tree names: each converts as a chat of its own.
            const unlabeled = unlabeledChatFiles(tree, dirs.chats).filter(f => !(f.ownerId === STRAY_OWNER && zz?.stray.status === 'change'));
            const importOwners = new Set(unlabeled.filter(f => byStem.has(f.ownerId)).map(f => f.ownerId));
            overlay = await groupOverlay(o.Database, tree, dirs, groupIdList, [...importOwners]);
            for (const it of overlay.result.restored) report.lines.push(`group chat repaired: group ${it.groupId} chat "${it.chatId}": ${it.text}`);
            for (const it of overlay.result.unrestorable) warn(report, 'group chats the repair can\'t restore (converted as they are)', `group ${it.groupId} chat "${it.chatId}": ${it.text}`);
            for (const it of overlay.result.notices) warn(report, 'group chat repair notes', `group ${it.groupId} chat "${it.chatId}": ${it.text}`);
            const repaired = /** @type {any} */ (overlay.db);
            const dbOf = (/** @type {string} */ ownerId) => (groupEntity.has(ownerId) || importOwners.has(ownerId) ? repaired : tree);
            /** @type {Map<string, import('./convert-to-engine/chats.js').Dropped[]>} */
            const importedAsBookmarks = new Map();
            for (const f of unlabeled) {
                const avatar = byStem.get(f.ownerId);
                if (avatar === undefined) {
                    warn(report, 'chat files with no label in the tree and no character (left where they are)', f.file);
                    continue;
                }
                const run = readChatRun(fs.readFileSync(f.file, 'utf8'));
                if (run.stopsAt !== null) warn(report, 'chat files read only up to a line that isn\'t a JSON object (the rest not converted; the file is left where it is)', `${f.file}: stops at line ${run.stopsAt}, ${run.rest} line(s) not converted`);
                const metadata = run.header && typeof run.header.chat_metadata === 'object' && run.header.chat_metadata !== null && !Array.isArray(run.header.chat_metadata) ? run.header.chat_metadata : null;
                const asBookmark = (/** @type {import('./convert-to-engine/chats.js').Dropped} */ d) => {
                    if (!importedAsBookmarks.has(f.ownerId)) importedAsBookmarks.set(f.ownerId, []);
                    /** @type {any[]} */ (importedAsBookmarks.get(f.ownerId)).push(d);
                };
                let how;
                if (run.messages.length === 0) {
                    asBookmark({ name: f.name, kind: 'empty', metadata, created: parseTimestamp(run.header?.create_date) || null });
                    how = 'no messages: a bookmark at the tree\'s root';
                } else {
                    const walked = walkChat(repaired, f.ownerId, run.messages);
                    if (walked.end !== null) {
                        asBookmark({ name: f.name, kind: 'twin', end: walked.end, metadata });
                        how = `its messages are a path in the tree: a bookmark at its last${walked.bySwipe ? ` (${walked.bySwipe} found by their shown swipe's text)` : ''}`;
                    } else {
                        const r = importChatFile(repaired, { ownerId: f.ownerId, avatar, name: f.name, file: f.file, header: run.header, messages: run.messages }, now);
                        if ('reason' in r) {
                            warn(report, 'chat files with no label in the tree that can\'t be converted (left where they are)', `${f.file}: ${r.reason}`);
                            continue;
                        }
                        how = 'its messages written as a branch of their own, with every swipe';
                    }
                }
                warn(report, 'chat files with no label in the tree, converted as chats of their own (the file is left where it is)', `${f.file}: ${run.messages.length} message(s); ${how}`);
                count(report, 'chat files with no label converted');
                if (!trees.has(f.ownerId)) {
                    const s = /** @type {import('../chat-codec.js').Speaker} */ (speakers.get(avatar));
                    trees.set(f.ownerId, { id: s.id, kind: 'character', speaker: s });
                }
            }
            if (zz) {
                for (const [name, plan] of /** @type {[string, any][]} */ ([['the group anchor\'s default child', zz.repoint], ['owner zztestchar\'s rows', zz.stray]])) {
                    if (plan.status === 'change') report.lines.push(`zztest leftovers: ${name} not converted as it was (${plan.lines.join('; ')})`);
                    else if (plan.status === 'refused' && tree.get('SELECT 1 AS ok FROM messages WHERE owner_id IN (?, ?) LIMIT 1', [ZZTEST_GROUP_ID, STRAY_OWNER])) warn(report, 'zztest leftovers the cleanup would refuse (converted as they are)', `${name}: ${plan.reason}`);
                }
                if (zz.strayChat) report.lines.push(`zztest leftovers: chat "${STRAY_GROUP_CHAT}" of group ${ZZTEST_GROUP_ID} not converted`);
            }
            const itemizedDir = path.join(o.root, 'itemized prompts');
            /** @type {Map<string, import('./convert-to-engine/old-chats.js').ItemizedFilePlan[]>} */
            const itemizedByOwner = new Map();
            for (const plan of itemizedFilePlans(tree, dbOf, itemizedDir)) {
                if (plan.unreadable) {
                    warn(report, 'prompt itemization files that can\'t be read (left where they are)', `${plan.file}: ${plan.unreadable}`);
                    continue;
                }
                if (plan.kept !== undefined) {
                    keptItemizations.push({ file: plan.file, reason: plan.kept, entries: plan.entries });
                    continue;
                }
                for (const l of plan.left) warn(report, 'prompt itemization entries not converted', `${plan.file} message ${String(l.mesId)}: ${l.reason}`);
                if (plan.ownerId !== null && plan.convert.length) {
                    if (!itemizedByOwner.has(plan.ownerId)) itemizedByOwner.set(plan.ownerId, []);
                    /** @type {any[]} */ (itemizedByOwner.get(plan.ownerId)).push(plan);
                }
            }
            /** @type {Map<string, number>} */
            const openingChoices = new Map();
            if (hasTable(tree, 'opening_choices')) {
                for (const r of /** @type {Iterable<{ owner_id: string, card_index: number }>} */ (tree.iterate('SELECT owner_id, card_index FROM opening_choices'))) openingChoices.set(r.owner_id, Number(r.card_index));
            }
            backups.push(...openBackups(o.Database, dirs.backups));
            const ctx = {
                ids: { message: firstMessageId(tree), position: 1n, change: 1n },
                user: 1n,
                handle: o.handle,
                now,
                speakers,
                link: (/** @type {string} */ json, /** @type {string} */ where, /** @type {object[]} */ records) => {
                    const value = JSON.parse(json);
                    const key = typeof value === 'string' ? bookKey(value) : '';
                    if (!key) return json;
                    const id = bookFor(key, `chat metadata at ${where}`, records);
                    return value === key ? `\u0001${id}` : `\u0001${id} ${json}`;
                },
                load: (/** @type {object[]} */ records) => sink.toLoad(records),
            };
            const decimals = ctx.ids.message - 1n;
            report.lines.push(`message ids not UUIDs (kept as outside keys): ${countNonUuidIds(tree)}${decimals > 0n ? `; new message ids start above ${decimals}` : ''}`);
            await sink.commit([{ kind: 'keyMap', user: ctx.user, key: Buffer.from(o.handle, 'utf8') }]);
            let doneOwners = 0;
            /** @type {object[]} */
            const afterLoad = [];
            /** @type {{ time: number, record: object }[]} */
            const conversations = [];
            /** @type {Parameters<typeof verify>[0]['owners']} */
            const checks = [];
            for (const [ownerId, t] of trees) {
                const db = dbOf(ownerId);
                const group = t.kind === 'group' ? groupRead.groups.find(g => g.group.id === ownerId)?.group : undefined;
                const active = t.kind === 'character' ? activeChats.get(/** @type {any} */ (t.speaker).avatar) ?? null : typeof group?.chat_id === 'string' ? group.chat_id : null;
                const dropped = group ? droppedChats(report, db, dirs, ownerId, group, zz?.strayChat && ownerId === ZZTEST_GROUP_ID) : (importedAsBookmarks.get(ownerId) ?? []);
                const input = {
                    db,
                    ownerId,
                    active,
                    openingChoice: openingChoices.get(ownerId) ?? null,
                    repointAnchor: ownerId === ZZTEST_GROUP_ID && zz?.repoint.status === 'change' ? GROUP_ANCHOR_ID : null,
                    repointTo: ownerId === ZZTEST_GROUP_ID && zz?.repoint.status === 'change' ? IVY_OPENING_ID : null,
                    dropped,
                    classify: (/** @type {string[]} */ names) => classify(names, () => bookmarkLinksOf(ownerFiles(dirs, ownerId, group)), () => backupNames(backups, ownerId)),
                };
                const plan = planOwner(input);
                for (const p of plan.problems) report.problems.push(`owner ${ownerId}: ${p}`);
                if (plan.problems.length && o.apply) throw new Stop(report);
                for (const name of plan.unsettled) warn(report, 'bookmark names nothing classified (made following)', `${t.kind} ${ownerId}: ${name}`);
                if (plan.activeUnresolved) warn(report, 'active chats that name nothing in the tree (no pointer)', `${t.kind} ${ownerId}`);
                if (plan.strayDefaults.length) warn(report, 'default children that aren\'t one of their message\'s replies (no fork choice)', `${t.kind} ${ownerId}: ${plan.strayDefaults.join(', ')}`);
                for (const s of plan.overrides) warn(report, 'chat metadata a later chat at the same message overrides (both recorded there, the later one read)', `${t.kind} ${ownerId} at ${s.at ?? 'the root'} (${s.earlier} -> ${s.later}): keys ${s.keys.map(k => `${k.slice(2)}${k.startsWith('v') ? ' (variable)' : ''}`).join(', ')}`);
                for (const s of plan.shadows) warn(report, 'chat metadata a deeper chat\'s shadows below it (each kept at its own message)', `${t.kind} ${ownerId} at ${s.at ?? 'the root'} (${s.sources.join(', ')}): key ${s.key.slice(2)}${s.key.startsWith('v') ? ' (variable)' : ''}, ${s.upper} -> ${s.lower ?? 'removed'}`);
                // Files giving one message the same entry place it once; differing ones place none there.
                /** @type {Map<string, { entry: Record<string, any>, json: string, files: string[], differ: boolean }>} */
                const byNode = new Map();
                for (const fp of itemizedByOwner.get(ownerId) ?? []) {
                    for (const [node, entry] of itemizedEntries(itemizedDir, fp)) {
                        const json = canonicalJson(entry);
                        const seen = byNode.get(node);
                        if (!seen) byNode.set(node, { entry, json, files: [fp.file], differ: false });
                        else {
                            seen.files.push(fp.file);
                            if (seen.json !== json) seen.differ = true;
                        }
                    }
                }
                const fileItemizations = new Map();
                /** @type {Map<string, number>} */
                const conflicting = new Map();
                for (const [node, v] of byNode) {
                    if (!v.differ) fileItemizations.set(node, v.entry);
                    else for (const file of v.files) conflicting.set(file, (conflicting.get(file) ?? 0) + 1);
                }
                for (const [file, n] of conflicting) keptItemizations.push({ file, reason: KEPT.conflict, entries: n });
                const counts = await writeOwner(ctx, input, plan, t, fileItemizations);
                if (counts.unreadable.length) {
                    report.problems.push(`owner ${ownerId}: message(s) whose stored JSON can't be read: ${counts.unreadable.join(', ')}`);
                    if (o.apply) throw new Stop(report);
                }
                checks.push({ input, tree: t.id, files: fileItemizations });
                for (const r of counts.later) afterLoad.push(r);
                for (const a of counts.active) conversations.push(a);
                for (const node of counts.badSendKeys) warn(report, 'send keys that aren\'t UUIDs (not converted: a draft re-sent with one may store the message again)', `${t.kind} ${ownerId} message ${node}`);
                count(report, 'messages', counts.messages);
                count(report, 'bookmarks', counts.bookmarks);
                count(report, 'bookmarks at a tree\'s root', counts.rootBookmarks);
                count(report, 'state changes', counts.changes);
                count(report, 'fork choices', counts.forks);
                count(report, 'itemizations', counts.itemizations);
                count(report, 'send keys', counts.sendKeys);
                count(report, 'messages whose stored token count is dropped (derived for display)', counts.tokenCounts);
                count(report, 'sessions', counts.sessions);
                count(report, `${t.kind} trees`);
                if (plan.pointer) count(report, 'pointers');
                if (t.kind === 'unowned') report.lines.push(`unowned tree kept: owner ${ownerId}, ${counts.messages} message(s), ${counts.bookmarks} bookmark(s)`);
                if (++doneOwners % 200 === 0) progress(`chat owners: ${doneOwners} of ${trees.size}`);
            }
            for (const ownerId of orphans) {
                if (o.keepOrphans) continue;
                const n = /** @type {{ m: number, l: number }} */ (tree.get('SELECT COUNT(*) AS m, COUNT(label) AS l FROM messages WHERE owner_id = ? AND parent_id IS NOT NULL', [ownerId]));
                warn(report, 'owners with no character or group (left out; --keep-orphans keeps them as unowned trees)', `owner ${ownerId}: ${n.m} message(s), ${n.l} label(s)`);
            }
            if (zz?.stray.status === 'change') report.lines.push(`zztest leftovers: owner ${STRAY_OWNER} not converted`);
            progress('installing the chats\' bulk load');
            const chatLoad = await sink.finishLoad();
            if (chatLoad) report.lines.push(`chats' bulk load: ${chatLoad.records} records, ${chatLoad.totalMs.toFixed(0)} ms (derive ${chatLoad.deriveMs.toFixed(0)} ms of CPU, merge ${chatLoad.mergeMs.toFixed(0)} ms), ${chatLoad.logBytes} log bytes, ${chatLoad.runBytes} run bytes`);
            // The conversations last, by the time of their last messages (a stable sort: ties stay in owner order).
            conversations.sort((a, b) => a.time - b.time);
            for (const a of conversations) afterLoad.push(a.record);
            count(report, 'conversations listed in recent chats', conversations.length);
            for (let i = 0; i < afterLoad.length; i += 2000) await sink.commit(afterLoad.slice(i, i + 2000));
            chatChecks = checks;
            if (keptItemizations.length) {
                await sink.commit([{ kind: 'metaValue', key: KEPT_ITEMIZATION_FILES, json: JSON.stringify(keptItemizations) }]);
                /** @type {Map<string, { files: number, entries: number }>} */
                const byReason = new Map();
                for (const k of keptItemizations) {
                    const r = byReason.get(k.reason) ?? { files: 0, entries: 0 };
                    r.files++;
                    r.entries += k.entries;
                    byReason.set(k.reason, r);
                }
                for (const [reason, r] of byReason) {
                    warn(report, `prompt itemization entries kept unplaced, not dropped (each file left on disk as it is and listed in the store's "${KEPT_ITEMIZATION_FILES}")`, `${reason}: ${r.entries} entries in ${r.files} file(s)`);
                }
            }
        }
        for (const dir of [dirs.chats, dirs.groupChats]) {
            for (const f of jsonlLeftovers(dir)) warn(report, 'chat files today\'s server doesn\'t read (left where they are; import them through the chat import)', f);
        }
        await sink.flush();
        phase('chats');
        if (o.apply) {
            progress('checking the store against the old files');
            const differs = await verify({
                store, meta, charactersDir: dirs.characters, tags, groups: groupRead.groups,
                books: () => worldBooks(dirs.worlds), bookNames, owners: chatChecks, keptItemizations, handle: o.handle, now, counts: report.counts, progress,
            });
            report.problems.push(...differs);
            phase('the check');
        }
        report.lines.push(`time: ${phases.join(', ')}`);
        return { report, sink, stats: store?.stats() ?? null };
    } finally {
        await store?.close();
        meta?.close();
        tree?.close();
        overlay?.db.close();
        for (const b of backups) b.close();
    }
}

/**
 * @param {string} line
 * @returns {unknown}
 */
function parseOrNull(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/**
 * @param {Map<string, bigint>} tagIds
 * @param {string} key
 */
function tagIdOrNull(tagIds, key) {
    return tagIds.get(key) ?? null;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids are below 2^63 in the engine. */
const MAX_ID = (1n << 63n) - 1n;

/**
 * The first new message id: above every old id that is a canonical decimal string, so a new message's id (its
 * decimal string outside) never equals an old one.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} tree
 */
function firstMessageId(tree) {
    let max = 0n;
    for (const r of /** @type {Iterable<{ id: string }>} */ (tree.iterate('SELECT id FROM messages WHERE id GLOB \'[0-9]*\''))) {
        if (!DECIMAL.test(r.id)) continue;
        const n = BigInt(r.id);
        if (n > max) max = n;
    }
    if (max >= MAX_ID) throw new Error(`an old message id is a decimal number too large for the engine's ids: ${max}`);
    return max + 1n;
}

/**
 * How many messages' old ids aren't UUIDs.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} tree
 */
function countNonUuidIds(tree) {
    let n = 0;
    for (const r of /** @type {Iterable<{ id: string }>} */ (tree.iterate('SELECT id FROM messages WHERE parent_id IS NOT NULL'))) if (!UUID.test(r.id)) n++;
    return n;
}

/**
 * The old chat files of an owner: a character's `chats/<owner>/`, a group's chats in `group chats/`.
 * @param {any} dirs
 * @param {string} ownerId
 * @param {Record<string, any> | undefined} group
 * @returns {string[]}
 */
function ownerFiles(dirs, ownerId, group) {
    const suffix = '.jsonl.pre-migration';
    if (group) {
        const names = Array.isArray(group.chats) ? group.chats.filter((/** @type {unknown} */ c) => typeof c === 'string' && path.basename(c) === c) : [];
        return names.map((/** @type {string} */ c) => path.join(dirs.groupChats, `${c}${suffix}`)).filter((/** @type {string} */ f) => fs.existsSync(f));
    }
    const dir = path.join(dirs.chats, ownerId);
    if (path.basename(ownerId) !== ownerId || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith(suffix)).map(f => path.join(dir, f));
}

/**
 * `.jsonl` chat files left in the chats folders.
 * @param {string} dir
 * @returns {string[]}
 */
function jsonlLeftovers(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
        else if (e.isDirectory()) {
            for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.endsWith('.jsonl')) out.push(path.join(dir, e.name, f));
        }
    }
    return out.sort();
}

/**
 * The chats of a group's `chats` with no label in its tree that the old migration left unnamed, read from their
 * `.pre-migration` files: one whose messages are a path in the tree from its first anchor (a twin's exact duplicate),
 * or one holding only its header. Any other is listed.
 * @param {Report} report
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {any} dirs
 * @param {string} ownerId
 * @param {Record<string, any>} group
 * @param {boolean} skipStray The zztest cleanup drops its stray chat.
 * @returns {import('./convert-to-engine/chats.js').Dropped[]}
 */
function droppedChats(report, db, dirs, ownerId, group, skipStray) {
    const kind = 'group chats listed with no label that can\'t be converted (no bookmark made; the file is left where it is)';
    /** @type {import('./convert-to-engine/chats.js').Dropped[]} */
    const out = [];
    const names = Array.isArray(group.chats) ? [...new Set(group.chats.filter((/** @type {unknown} */ c) => typeof c === 'string'))] : [];
    for (const name of /** @type {string[]} */ (names)) {
        if (skipStray && name === STRAY_GROUP_CHAT) continue;
        if (db.get('SELECT 1 AS ok FROM messages WHERE owner_id = ? AND label = ? LIMIT 1', [ownerId, name])) continue;
        const file = path.join(dirs.groupChats, `${name}.jsonl.pre-migration`);
        if (path.basename(name) !== name || !fs.existsSync(file)) {
            warn(report, kind, `group ${ownerId} chat "${name}": no original file`);
            continue;
        }
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim());
        const headerOnly = lines.length === 1 && isChatHeaderEntry(parseOrNull(lines[0]));
        const parsed = headerOnly ? { header: parseOrNull(lines[0]), messages: [] } : parseChatFile(raw);
        if ('error' in parsed) {
            warn(report, kind, `group ${ownerId} chat "${name}": its original can't be read whole: ${parsed.error}`);
            continue;
        }
        const header = /** @type {any} */ (parsed.header);
        const metadata = header && typeof header.chat_metadata === 'object' && header.chat_metadata !== null && !Array.isArray(header.chat_metadata) ? header.chat_metadata : null;
        if (parsed.messages.length === 0) {
            out.push({ name, kind: 'empty', metadata, created: parseTimestamp(header?.create_date) || null });
            report.lines.push(`group ${ownerId} chat "${name}" (header only): a bookmark at the tree's root`);
            continue;
        }
        const walked = walkChat(db, ownerId, /** @type {any[]} */ (parsed.messages));
        if (walked.end === null) {
            warn(report, kind, `group ${ownerId} chat "${name}": its messages aren't a path in the tree`);
            continue;
        }
        out.push({ name, kind: 'twin', end: walked.end, metadata });
        report.lines.push(`group ${ownerId} chat "${name}" (a duplicate of a chat in the tree${walked.bySwipe ? `, ${walked.bySwipe} message(s) found by their shown swipe's text` : ''}): a bookmark at the message it ends on`);
    }
    return out;
}


class Stop extends Error {
    /** @param {Report} report */
    constructor(report) {
        super('stopped: problems found');
        this.report = report;
    }
}

/**
 * The bytes in a directory's files, recursively.
 * @param {string} dir
 */
function sizeOfDir(dir) {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) n += sizeOfDir(full);
        else if (e.isFile()) n += fs.statSync(full).size;
    }
    return n;
}

/**
 * The report's lines: counts, notes, warnings (each kind's first `LISTED` lines, the rest counted), problems.
 * @param {Report} report
 * @returns {string[]}
 */
export function reportLines(report) {
    const out = [];
    out.push(`${LOG_PREFIX} counts: ${Object.entries(report.counts).map(([k, n]) => `${k} ${n.toLocaleString('en-US')}`).join('; ')}`);
    for (const line of report.lines) out.push(`${LOG_PREFIX} ${line}`);
    for (const [kind, lines] of report.warnings) {
        out.push(`${LOG_PREFIX} WARNING: ${kind}: ${lines.length}`);
        for (const line of lines.slice(0, LISTED)) out.push(`${LOG_PREFIX}   ${line}`);
        if (lines.length > LISTED) out.push(`${LOG_PREFIX}   ... and ${lines.length - LISTED} more`);
    }
    for (const p of report.problems.slice(0, LISTED)) out.push(`${LOG_PREFIX} PROBLEM: ${p}`);
    if (report.problems.length > LISTED) out.push(`${LOG_PREFIX} PROBLEM: ... and ${report.problems.length - LISTED} more`);
    return out;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {boolean} options.serverStopped
 * @param {boolean} [options.keepOrphans]
 * @param {any} options.Database better-sqlite3's constructor, or null when it can't be loaded.
 * @param {() => any} options.engine Loads the engine binding.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @param {(dir: string) => number} [options.freeBytes]
 * @returns {Promise<number>} The exit code: 0 done (or nothing to do), 1 refused or failed.
 */
export async function runConversion(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const freeBytes = options.freeBytes ?? (dir => { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); });
    const root = path.join(options.dataRoot, options.handle);
    const storeDir = path.join(root, STORE_DIR);
    const building = path.join(root, BUILDING_DIR);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${root}`);
    if (!options.Database) {
        warnLine(`${LOG_PREFIX} REFUSED: native better-sqlite3 isn't available`);
        return 1;
    }
    if (!fs.existsSync(root)) {
        warnLine(`${LOG_PREFIX} REFUSED: ${root} doesn't exist`);
        return 1;
    }
    if (fs.existsSync(storeDir)) {
        warnLine(`${LOG_PREFIX} REFUSED: ${storeDir} exists: this user's data is converted already`);
        return 1;
    }
    const started = Date.now();
    const progress = (/** @type {string} */ line) => log(`${LOG_PREFIX} ${line}`);
    if (!options.apply) {
        const { report, sink } = await convert({ root, handle: options.handle, Database: options.Database, engine: null, apply: false, keepOrphans: !!options.keepOrphans, progress });
        for (const line of reportLines(report)) log(line);
        log(`${LOG_PREFIX} records the apply would write: ${(sink.loaded + sink.committed).toLocaleString('en-US')} (bulk load ${sink.loaded.toLocaleString('en-US')}); by kind: ${Object.entries(sink.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}`);
        log(`${LOG_PREFIX} dry run done in ${((Date.now() - started) / 1000).toFixed(1)} s; nothing was written.`);
        return report.problems.length ? 1 : 0;
    }
    if (!options.serverStopped) {
        warnLine(`${LOG_PREFIX} REFUSED: --apply needs --server-stopped (stop the server first; a --port override is not visible to the port probe)`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }
    if (fs.existsSync(building)) {
        log(`${LOG_PREFIX} ${building} is left from a run that stopped; it is built again`);
        fs.rmSync(building, { recursive: true, force: true });
    }
    const old = ['character-metadata.sqlite', 'message-tree.sqlite'].map(f => path.join(root, f)).filter(f => fs.existsSync(f)).reduce((n, f) => n + fs.statSync(f).size, 0) + sizeOfDir(path.join(root, USER_DIRECTORY_TEMPLATE.worlds));
    const needed = Math.ceil(old * SPACE_FACTOR);
    const free = freeBytes(root);
    if (free < needed) {
        warnLine(`${LOG_PREFIX} REFUSED: the store needs about ${(needed / 1e9).toFixed(1)} GB free in ${root}, and ${(free / 1e9).toFixed(1)} GB is free`);
        return 1;
    }
    fs.mkdirSync(building);
    let result;
    try {
        result = await convert({ root, handle: options.handle, Database: options.Database, engine: options.engine(), apply: true, keepOrphans: !!options.keepOrphans, storeDir: building, progress });
    } catch (err) {
        fs.rmSync(building, { recursive: true, force: true });
        if (!(err instanceof Stop)) throw err;
        for (const line of reportLines(err.report)) log(line);
        warnLine(`${LOG_PREFIX} FAILED: problems were found; the new store was deleted and nothing else was changed`);
        return 1;
    }
    const { report, sink, stats } = result;
    for (const line of reportLines(report)) log(line);
    if (report.problems.length) {
        fs.rmSync(building, { recursive: true, force: true });
        warnLine(`${LOG_PREFIX} FAILED: the new store differs from the old files; it was deleted and nothing else was changed`);
        return 1;
    }
    const bytes = sizeOfDir(building);
    fs.renameSync(building, storeDir);
    const dirFd = fs.openSync(root, 'r');
    try {
        fs.fsyncSync(dirFd);
    } catch {
        // Windows can't sync a directory; NTFS journals the rename.
    } finally {
        fs.closeSync(dirFd);
    }
    log(`${LOG_PREFIX} records: ${sink.loaded.toLocaleString('en-US')} bulk loaded, ${sink.committed.toLocaleString('en-US')} committed in ${sink.commits} commits`);
    log(`${LOG_PREFIX} store: ${(bytes / 1e6).toFixed(1)} MB (log ${(stats.logBytes / 1e6).toFixed(1)} MB written by commits, runs ${(stats.runBytes / 1e6).toFixed(1)} MB)`);
    log(`${LOG_PREFIX} done in ${((Date.now() - started) / 1000).toFixed(1)} s, every value checked. The old files are kept; delete them once the server has started cleanly on ${storeDir}.`);
    return 0;
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, serverStopped: false, keepOrphans: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if (arg === '--server-stopped') out.serverStopped = true;
        else if (arg === '--keep-orphans') out.keepOrphans = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[/** @type {'dataRoot' | 'handle' | 'config'} */ ({ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg])] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply --server-stopped  [--data-root ./data] [--handle default-user] [--config ./config.yaml] [--keep-orphans]`);
        process.exitCode = 2;
    } else {
        const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');
        const { loadEngine } = await import('../../engine/load.js');
        process.exitCode = await runConversion({ ...args, Database: await getBetterSqlite3(), engine: () => loadEngine().binding });
    }
}
