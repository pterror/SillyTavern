import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { parseChatFile } from './chat-header.js';
import { newSessionKey } from './chat-engine.js';
import { normalizeGroupRecord, storedGroup } from './group-id.js';
import { TYPE } from './library-engine.js';
import { importImageFiles } from './image-entities.js';

export const UPSTREAM_META = 'upstream_import_pending';
export const MAP_FILE = 'upstream-import.json';
const BATCH = 20;
const PAUSE_MS = 10;

/**
 * @typedef {object} UpstreamImportReport
 * @property {{ groups: number, worlds: number, chats: number, groupChats: number, messages: number, backgrounds: number, personas: number }} imported
 * @property {{ file: string, why: string }[]} present
 * @property {{ file: string, why: string }[]} notImported
 */

/** @type {Map<string, Promise<UpstreamImportReport>>} */
const running = new Map();

/**
 * @param {import('./library-engine.js').LibraryEngine} lib
 */
export async function markUpstreamImportPending(lib) {
    await lib.store.commit([{ kind: 'metaValue', key: UPSTREAM_META, json: 'true' }]);
}

/**
 * @param {import('./library-engine.js').LibraryEngine} lib
 */
export async function upstreamImportPending(lib) {
    const [pending] = await lib.store.meta([UPSTREAM_META]);
    return pending !== null && pending !== undefined;
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<UpstreamImportReport | null>}
 */
export async function resumeUpstreamImport(store, directories) {
    if (!(await upstreamImportPending(store.lib))) return null;
    const report = await importUpstreamData(store, directories);
    await store.lib.store.commit([{ kind: 'metaValue', key: UPSTREAM_META }]);
    return report;
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<UpstreamImportReport>}
 */
export function importUpstreamData(store, directories) {
    const key = path.resolve(directories.root);
    const prior = running.get(key) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => runImport(store, directories));
    running.set(key, run);
    return run.finally(() => {
        if (running.get(key) === run) running.delete(key);
    });
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<UpstreamImportReport>}
 */
async function runImport(store, directories) {
    /** @type {UpstreamImportReport} */
    const report = { imported: { groups: 0, worlds: 0, chats: 0, groupChats: 0, messages: 0, backgrounds: 0, personas: 0 }, present: [], notImported: [] };
    const images = await importImageFiles(store.lib, directories);
    report.imported.backgrounds = images.backgrounds;
    report.imported.personas = images.personas;
    report.notImported.push(...images.failed.map(f => ({ file: f.file, why: `not a readable image: ${f.why}` })));
    const mapPath = path.join(directories.root, MAP_FILE);
    const map = readMap(mapPath);
    const actor = { user: store.handle, session: newSessionKey() };
    const rel = (/** @type {string} */ p) => path.relative(directories.root, p).split(path.sep).join('/');
    let done = 0;
    const paced = async () => {
        if (++done % BATCH === 0) await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
    };

    /** @type {Map<string, string[]>} */
    const groupChats = new Map();
    for (const file of jsonFiles(directories.groups)) {
        const where = rel(file);
        try {
            const group = normalizeGroupRecord(JSON.parse(await fs.promises.readFile(file, 'utf8')));
            const id = typeof group?.id === 'string' || typeof group?.id === 'number' ? String(group.id) : '';
            if (!id) {
                report.notImported.push({ file: where, why: 'the group has no id' });
                continue;
            }
            group.id = id;
            groupChats.set(id, Array.isArray(group.chats) ? group.chats.map(String) : []);
            const [had] = await store.lib.ids(TYPE.group, [id]);
            if (had !== null && had !== undefined) {
                report.present.push({ file: where, why: `group ${id} is in the store already` });
            } else {
                await store.lib.writeGroup(storedGroup(group), { dateAdded: Math.round((await fs.promises.stat(file)).birthtimeMs) });
                report.imported.groups++;
            }
        } catch (err) {
            report.notImported.push({ file: where, why: `unreadable group file: ${messageOf(err)}` });
        }
        await paced();
    }

    await importWorlds(store, directories, report, actor, paced);

    /**
     * @param {string} file
     * @param {bigint} tree
     * @param {import('./chat-codec.js').Speaker | null} treeSpeaker
     * @param {string} name
     * @param {'chats' | 'groupChats'} kind
     */
    const importChatFile = async (file, tree, treeSpeaker, name, kind) => {
        const where = rel(file);
        if (map.chats[where]) {
            report.present.push({ file: where, why: `imported before, as ${map.chats[where]}` });
            return;
        }
        const named = await store.lib.store.chatRead('bookmarksNamed', { tree, name });
        if (named.length) {
            report.present.push({ file: where, why: `its owner has a chat named "${name}" already` });
            return;
        }
        const parsed = parseChatFile(await fs.promises.readFile(file, 'utf8'));
        if ('error' in parsed) {
            report.notImported.push({ file: where, why: parsed.error });
            return;
        }
        const header = /** @type {Record<string, any> | null} */ (parsed.header);
        const imported = await store.chats.importChat({
            tree, treeSpeaker, name, messages: /** @type {Record<string, any>[]} */ (parsed.messages), metadata: header?.chat_metadata, actor,
        });
        if (!imported.ok) {
            report.notImported.push({ file: where, why: `the chat couldn't be stored (${imported.reason})` });
            return;
        }
        map.chats[where] = `b${imported.bookmark}`;
        report.imported[kind]++;
        report.imported.messages += parsed.messages.length;
        if (done % BATCH === 0) await writeMap(mapPath, map, report);
    };

    for (const folder of directoriesIn(directories.chats)) {
        const files = chatFiles(path.join(directories.chats, folder));
        if (!files.length) continue;
        const avatar = `${folder}.png`;
        const [tree] = await store.people.trees([{ avatar }]);
        if (tree === null || tree === undefined) {
            for (const file of files) report.notImported.push({ file: rel(file), why: `no character with the avatar ${avatar}` });
            continue;
        }
        const treeSpeaker = (await store.people.byAvatar([avatar])).get(avatar) ?? null;
        for (const file of files) {
            try {
                await importChatFile(file, tree, treeSpeaker, path.parse(file).name, 'chats');
            } catch (err) {
                report.notImported.push({ file: rel(file), why: messageOf(err) });
            }
            await paced();
        }
    }

    /** @type {Map<string, string>} */
    const chatGroup = new Map();
    for (const [group, ids] of groupChats) for (const id of ids) chatGroup.set(id, group);
    for (const file of chatFiles(directories.groupChats)) {
        const id = path.parse(file).name;
        const group = chatGroup.get(id);
        try {
            const [tree] = group === undefined ? [null] : await store.people.trees([{ group }]);
            if (tree === null || tree === undefined) {
                report.notImported.push({ file: rel(file), why: group === undefined ? 'no group lists this chat' : `group ${group} isn't in the store` });
                continue;
            }
            await importChatFile(file, tree, null, id, 'groupChats');
        } catch (err) {
            report.notImported.push({ file: rel(file), why: messageOf(err) });
        }
        await paced();
    }

    await writeMap(mapPath, map, report);
    const { groups, worlds, chats, groupChats: gc, messages, backgrounds, personas } = report.imported;
    if (groups + worlds + chats + gc + backgrounds + personas > 0 || report.notImported.length) {
        console.info(`[upstream-import] ${directories.root}: imported ${groups} group(s), ${worlds} book(s), ${chats} chat(s) and ${gc} group chat(s), ${messages} message(s), ${backgrounds} background(s) and ${personas} persona image(s); ${report.present.length} file(s) already in the store.`);
    }
    if (report.notImported.length) {
        console.warn(`[upstream-import] ${report.notImported.length} file(s) were NOT imported:\n${report.notImported.map(n => `  ${n.file}: ${n.why}`).join('\n')}`);
    }
    return report;
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {UpstreamImportReport} report
 * @param {import('./world-info-engine.js').Actor} actor
 * @param {() => Promise<void>} paced
 */
async function importWorlds(store, directories, report, actor, paced) {
    for (const file of jsonFiles(directories.worlds)) {
        const where = path.relative(directories.root, file).split(path.sep).join('/');
        const name = path.parse(file).name;
        try {
            const content = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            if (!content || typeof content !== 'object' || !('entries' in content)) {
                report.notImported.push({ file: where, why: 'not a World Info book (no entries)' });
            } else if (await store.lib.books.exists(name)) {
                report.present.push({ file: where, why: `a book named "${name}" is in the store already` });
            } else if (await store.lib.books.write(name, content, actor) === 'card copy') {
                report.notImported.push({ file: where, why: 'a copy of a character\'s embedded lorebook; the character keeps its own' });
            } else {
                report.imported.worlds++;
            }
        } catch (err) {
            report.notImported.push({ file: where, why: `unreadable book file: ${messageOf(err)}` });
        }
        await paced();
    }
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<UpstreamImportReport>}
 */
export async function importUpstreamWorlds(store, directories) {
    /** @type {UpstreamImportReport} */
    const report = { imported: { groups: 0, worlds: 0, chats: 0, groupChats: 0, messages: 0, backgrounds: 0, personas: 0 }, present: [], notImported: [] };
    await importWorlds(store, directories, report, { user: store.handle, session: newSessionKey() }, async () => {});
    if (report.imported.worlds > 0) console.info(`[upstream-import] ${directories.root}: imported ${report.imported.worlds} book(s) before the settings.`);
    if (report.notImported.length) console.warn(`[upstream-import] ${report.notImported.length} book file(s) were NOT imported:\n${report.notImported.map(n => `  ${n.file}: ${n.why}`).join('\n')}`);
    return report;
}

/**
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
export function importedChatBookmarks(root) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    for (const [file, bookmark] of Object.entries(readMap(path.join(root, MAP_FILE)).chats)) {
        const id = path.basename(file).replace(/\.jsonl$/i, '');
        const list = out.get(id);
        if (list) list.push(bookmark);
        else out.set(id, [bookmark]);
    }
    return out;
}

/**
 * @param {string} mapPath
 * @returns {{ chats: Record<string, string> }}
 */
function readMap(mapPath) {
    try {
        const read = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        if (read && typeof read.chats === 'object' && read.chats !== null) return { chats: read.chats };
    } catch {
        // None yet.
    }
    return { chats: {} };
}

/**
 * @param {string} mapPath
 * @param {{ chats: Record<string, string> }} map
 * @param {UpstreamImportReport} report
 */
async function writeMap(mapPath, map, report) {
    await writeFileAtomic(mapPath, JSON.stringify({ chats: map.chats, notImported: report.notImported }, null, 4));
}

/** @param {string} dir */
function jsonFiles(dir) {
    return filesIn(dir).filter(f => f.toLowerCase().endsWith('.json'));
}

/** @param {string} dir */
function chatFiles(dir) {
    return filesIn(dir).filter(f => f.toLowerCase().endsWith('.jsonl'));
}

/** @param {string} dir */
function filesIn(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => path.join(dir, d.name)).sort();
    } catch {
        return [];
    }
}

/** @param {string} dir */
function directoriesIn(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch {
        return [];
    }
}

/** @param {unknown} err */
function messageOf(err) {
    return err instanceof Error ? err.message : String(err);
}
