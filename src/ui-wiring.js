import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { createUi } from '@st/server-ui';
import { backgroundsArea } from '@st/backgrounds/server';
import { settingsArea } from '@st/settings/server';
import { alternativesArea } from '@st/alternatives/server';
import { activationsArea } from '@st/activations/server';
import { worldbuildingArea } from '@st/worldbuilding/server';
import { looksArea } from '@st/looks/server';
import { DRAWN_VIEW } from '@st/looks/protocol';
import { lookImageUrl } from '@st/looks/look';
import { usageStatsArea } from '@st/usage-stats/server';
import { VIEW as USAGE_STATS_VIEW } from '@st/usage-stats/protocol';
import { STATS_BACKUP_FILE } from './old-stats-file.js';
import { helpArea } from '@st/help/server';
import { recentHistoryArea } from '@st/recent-history/server';
import { VIEW as RECENT_HISTORY_VIEW } from '@st/recent-history/protocol';
import { looksPorts } from './looks-store.js';
import { chatReadsBook, resolveChatLinkLooks } from './chat-links.js';
import { sessionHeaderOf } from './request-session.js';
import { References } from './world-info/references.js';
import { placementOf, worldbuildingEntryPorts } from './world-info/worldbuilding-entries.js';
import { entryAsWorld } from './world-info-engine.js';
import { worldbuildingWorldPorts } from './world-info/worldbuilding-worlds.js';
import { withPictureUrls } from './world-info/worldbuilding-pictures.js';
import { worldbuildingSearchPorts } from './world-info/worldbuilding-search.js';
import { worldbuildingBulkPorts } from './world-info/worldbuilding-bulk.js';
import { worldbuildingViewPorts } from './world-info/worldbuilding-views.js';
import { keysThatBroughtUp } from './world-info/activation-record.js';
import { resolvedActivations } from './world-info/activation-references.js';
import { countWithConnection } from './connection-counts.js';
import { matchDefaultsOf } from './world-info/key-matching.js';
import { WORLD_INFO_GLOBAL_DEFAULTS, worldInfoGlobalsOf } from '../public/scripts/world-info-globals.js';
import { unstoredGreetingNodeId } from '../public/scripts/node-identity.js';
import { readUserSettings } from './settings-reads.js';

import { onUserStoreOpened, userStore } from './user-stores.js';
import { TYPE } from './library-engine.js';
import { LOOK_FIELD } from './library-codes.js';
import { clientRelativePath, humanizedDateTime, isPathUnderParent } from './util.js';
import { createFolder, deleteFolder, readFolders, retargetCovers, updateFolder } from './background-folders.js';
import { backgroundOf, changeBackgroundFolders, imageThumbnails, imagesOf, removeImage, renameImage, userImageKey, writeBackground, writeUserImage } from './image-entities.js';
import { settingsDocumentOf } from './settings-documents.js';
import { modelListOf, rememberModelList } from './model-lists.js';
import { default_settings as chatCompletionDefaults } from '../public/scripts/chat-completion-defaults.js';
import { writeNamedSettings, readAllSettings } from './settings-store.js';
import { readCardGreetings } from './opening-state.js';
import { changeGreetings } from './endpoints/characters.js';
import { openTokenizer } from './endpoints/tokenizers-current.js';
import { readTokenizerState } from './connection-state-header.js';
import { TOKEN_KEY_KINDS, readCount, tokenKeyHash } from './token-count-store.js';
import { textMatches } from './text-matches.js';
import { getEngine } from '../engine/load.js';
import { hashGreetingText } from './greeting-ops.js';
import { macrosIn } from '../public/scripts/safe-macros.js';
import { scopeMacroValues } from './message-macros.js';

/** @typedef {import('@st/server-ui').User} User */
/** @typedef {import('@st/server-ui').ViewContext} ViewContext */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'bmp', 'avif']);

const LIST_KEY = 'chat_backgrounds';
const LOCK_KEY = 'custom_background';

/**
 * @param {User} user
 * @returns {import('./users.js').UserDirectoryList}
 */
const directoriesOf = user => /** @type {any} */ (user.directories);

/**
 * @param {ViewContext} context
 */
async function openChat(context) {
    if (!context.chat) return null;
    const store = await userStore(directoriesOf(context.user), context.user.handle);
    const tree = BigInt(context.chat.tree);
    const actor = { user: context.user.handle, session: context.session };
    const at = await store.chats.landingOf(tree, actor);
    return { store, tree, actor, at };
}

/**
 * @param {User} user
 */
const libOf = async user => (await userStore(directoriesOf(user), user.handle)).lib;

/**
 * @param {User} user
 * @param {string} file
 * @param {string} source
 */
async function putBackground(user, file, source) {
    const directories = directoriesOf(user);
    const image = await fs.promises.readFile(source);
    await fs.promises.mkdir(directories.backgrounds, { recursive: true });
    await fs.promises.writeFile(path.join(directories.backgrounds, file), image);
    await writeBackground(await libOf(user), file, image);
}

/**
 * @param {User} user
 * @param {string[]} ids
 */
async function knownFolders(user, ids) {
    const known = new Set((await readFolders(user.directories.root)).map(f => f.id));
    return ids.filter(id => known.has(id));
}

/** @type {import('@st/backgrounds/server').Ports} */
const backgroundPorts = {
    files: {
        async list(user) {
            const lib = await libOf(user);
            return (await imagesOf(lib, TYPE.background)).map(backgroundOf).sort((a, b) => Intl.Collator().compare(a.file, b.file));
        },
        async folders(user) {
            return (await readFolders(user.directories.root)).map(f => ({ id: f.id, name: f.name, cover: f.thumbnailFile || null }));
        },
        async save(user, upload) {
            const file = sanitize(upload.name);
            await putBackground(user, file, upload.path);
            return file;
        },
        async copyIn(user, from, name) {
            const directories = directoriesOf(user);
            const source = path.join(directories.root, from);
            if (!isPathUnderParent(directories.userImages, source)) throw new Error(`Not a user image: ${from}`);
            const file = sanitize(name);
            await putBackground(user, file, source);
            return file;
        },
        async rename(user, file, to) {
            const directories = directoriesOf(user);
            const from = path.join(directories.backgrounds, sanitize(file));
            const target = path.join(directories.backgrounds, sanitize(to));
            if (sanitize(file) !== file || sanitize(to) !== to || !fs.existsSync(from) || fs.existsSync(target)) return false;
            await fs.promises.rename(from, target);
            if (!(await renameImage(await libOf(user), TYPE.background, file, to))) {
                await fs.promises.rename(target, from);
                return false;
            }
            await retargetCovers(user.directories.root, file, to);
            return true;
        },
        async remove(user, file) {
            const directories = directoriesOf(user);
            if (sanitize(file) !== file) throw new Error(`Not a background's name: ${file}`);
            await removeImage(await libOf(user), TYPE.background, file);
            await fs.promises.rm(path.join(directories.backgrounds, file), { force: true });
            await retargetCovers(user.directories.root, file, '');
        },
        async createFolder(user, name) {
            await createFolder(user.directories.root, name);
        },
        async renameFolder(user, id, name) {
            await updateFolder(user.directories.root, id, { name });
        },
        async deleteFolder(user, id) {
            await deleteFolder(user.directories.root, id);
            const lib = await libOf(user);
            for (const background of (await imagesOf(lib, TYPE.background)).map(backgroundOf)) {
                if (background.folders.includes(id)) await changeBackgroundFolders(lib, background.file, folders => folders.filter(f => f !== id));
            }
        },
        async setCover(user, id, file) {
            await updateFolder(user.directories.root, id, { thumbnailFile: file });
        },
        async addToFolder(user, id, files) {
            if (!(await knownFolders(user, [id])).length) throw new Error(`Folder '${id}' not found.`);
            const lib = await libOf(user);
            for (const file of files) await changeBackgroundFolders(lib, file, folders => [...folders, id]);
        },
        async removeFromFolder(user, id, files) {
            const lib = await libOf(user);
            for (const file of files) await changeBackgroundFolders(lib, file, folders => folders.filter(f => f !== id));
        },
        async setFolders(user, file, ids) {
            const valid = await knownFolders(user, ids);
            await changeBackgroundFolders(await libOf(user), file, () => valid);
        },
    },
    chat: {
        async read(context) {
            const chat = await openChat(context);
            if (!chat) return null;
            const there = await chat.store.chats.stateAt({ tree: chat.tree, at: chat.at, session: context.session });
            const state = there && 'state' in there ? there.state : {};
            const list = Array.isArray(state[LIST_KEY]) ? state[LIST_KEY].filter(x => typeof x === 'string') : [];
            const locked = typeof state[LOCK_KEY] === 'string' && state[LOCK_KEY] ? state[LOCK_KEY] : null;
            return { list, locked };
        },
        async write(context, change) {
            const chat = await openChat(context);
            if (!chat) throw new Error('No chat is open');
            /** @type {Record<string, unknown>} */
            const set = {};
            /** @type {string[]} */
            const unset = [];
            if (change.list !== undefined) set[LIST_KEY] = change.list;
            if (change.locked === null) unset.push(LOCK_KEY);
            else if (change.locked !== undefined) set[LOCK_KEY] = change.locked;
            const merged = await chat.store.chats.mergeMetadata({ tree: chat.tree, at: chat.at, set, unset, actor: chat.actor });
            if (!merged.ok) throw new Error(`The chat's state wasn't written: ${merged.reason}`);
        },
        async saveImage(context, upload) {
            const chat = await openChat(context);
            if (!chat) throw new Error('No chat is open');
            const directories = directoriesOf(context.user);
            const speaker = (await chat.store.people.speakers([chat.tree])).get(chat.tree);
            const [key] = await chat.store.lib.store.libraryKeys([chat.tree]);
            const folder = sanitize(speaker?.name || key?.key || 'chat');
            const extension = path.extname(upload.name).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(extension.slice(1))) throw new Error(`Not an image to keep: ${upload.name}`);
            const target = path.join(directories.userImages, folder, sanitize(`${folder}_${humanizedDateTime()}${extension}`));
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const image = await fs.promises.readFile(upload.path);
            await fs.promises.writeFile(target, image);
            const relative = clientRelativePath(directories.root, target);
            await writeUserImage(chat.store.lib, relative, image);
            return relative;
        },
        async deleteImage(context, relative) {
            const directories = directoriesOf(context.user);
            const target = path.join(directories.root, relative);
            if (!isPathUnderParent(directories.userImages, target)) throw new Error(`Not a user image: ${relative}`);
            await removeImage(await libOf(context.user), TYPE.userImage, userImageKey(relative));
            await fs.promises.rm(target, { force: true });
        },
        async images(context, paths) {
            const lib = await libOf(context.user);
            const keys = paths.map(userImageKey);
            const shown = await imageThumbnails(lib, TYPE.userImage, keys, 'bg');
            return Object.fromEntries(paths.map((p, i) => {
                const found = shown.get(keys[i]);
                return [p, { thumbnail: found?.thumbnail ?? null, thumbnail_still: found?.thumbnail_still ?? null, animated: (found?.thumbnail_still ?? null) !== null }];
            }));
        },
    },
    options: {
        async read(user) {
            const settings = settingsDocumentOf(user.directories)?.settings ?? readAllSettings(directoriesOf(user));
            const background = settings?.background;
            return background && typeof background === 'object' ? { ...background } : {};
        },
        async write(user, options) {
            await writeNamedSettings(directoriesOf(user), { background: options });
        },
    },
};

export const SETTINGS_VIEWS = ['settings'];

export const WORLD_LIST_VIEWS = ['worldbuilding.worlds', 'worldbuilding.world'];

// The views that draw a world's entries, which a slash command's entry write changes.
export const WORLD_ENTRY_VIEWS = ['worldbuilding.overview', 'worldbuilding.results', 'worldbuilding.entry', 'worldbuilding.pointingAt', 'worldbuilding.card'];

/**
 * @param {import('@st/protocol').ChatOwner | null} owner
 */
const contextOf = owner => ({ avatar: owner && 'avatar' in owner ? owner.avatar : null, groupId: owner && 'group' in owner ? owner.group : null });

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('express').NextFunction} next
 */
export function rememberModelLists(request, response, next) {
    const source = request.body?.chat_completion_source;
    if (!request.user || typeof source !== 'string') return next();
    const json = response.json.bind(response);
    response.json = body => {
        if (response.statusCode < 400 && Array.isArray(body?.data)) {
            const user = uiUser(request);
            rememberModelList(request.user.directories, source, body.data)
                .then(changed => changed && ui.changed(user, SETTINGS_VIEWS))
                .catch(error => console.error('[model lists] not kept:', error));
        }
        return json(body);
    };
    next();
}

/** @type {import('@st/settings/server').Ports} */
const settingsPorts = {
    async view(user, owner, range) {
        const document = settingsDocumentOf(user.directories);
        if (!document) return { settings: readAllSettings(directoriesOf(user)), sources: {} };
        return document.view(contextOf(owner), range);
    },
    async write(user, owner, range, entries) {
        const document = settingsDocumentOf(user.directories);
        if (!document) throw new Error(`The settings of ${user.handle} aren't open`);
        await document.writeAll(contextOf(owner), range, entries);
    },
    async ownerOf(user, chat) {
        const store = await userStore(directoriesOf(user), user.handle);
        const [key] = await store.lib.store.libraryKeys([BigInt(chat.tree)]);
        if (!key) return null;
        return key.type === TYPE.group ? { group: key.key } : { avatar: key.key };
    },
    models: (user, source) => modelListOf(user.directories, source),
    defaults: () => ({ oai_settings: chatCompletionDefaults, world_info_settings: WORLD_INFO_GLOBAL_DEFAULTS }),
};

export const ALTERNATIVES_VIEWS = ['alternatives.list', 'alternatives.counts', 'alternatives.matches'];

const COUNTING_AT_ONCE = 2;

const WHOLE = { offset: 0, limit: Number.MAX_SAFE_INTEGER };

/**
 * @param {ViewContext} context
 */
async function chatOfTab(context) {
    if (!context.chat) return null;
    const store = await userStore(directoriesOf(context.user), context.user.handle);
    const tree = BigInt(context.chat.tree);
    const [key] = await store.lib.store.libraryKeys([tree]);
    const avatar = key && key.type !== TYPE.group ? key.key : null;
    const groupId = key && key.type === TYPE.group ? key.key : null;
    return { store, tree, avatar, groupId, actor: { user: context.user.handle, session: context.session } };
}

/**
 * @param {Record<string, any>} entry an alternative as the chat engine reads it
 * @param {string | null} [avatar] the chat's character, whose card greetings an opening naming no `original_avatar` is
 * @returns {import('@st/alternatives/server').Alternative}
 */
const alternativeOf = (entry, avatar = null) => ({
    id: entry.node_id ?? unstoredGreetingNodeId(entry, avatar) ?? '',
    nodeId: entry.node_id ?? null,
    greeting: greetingOf(entry.greeting),
    text: typeof entry.mes === 'string' ? entry.mes : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    isUser: !!entry.is_user,
    isSystem: !!entry.is_system,
    date: typeof entry.send_date === 'string' || typeof entry.send_date === 'number' ? entry.send_date : null,
});

/**
 * @param {unknown} greeting an opening's `greeting`, as the chat engine names the card greeting it is
 * @returns {{ avatar: string, id: number } | null}
 */
function greetingOf(greeting) {
    const g = /** @type {{ avatar?: unknown, id?: unknown } | null | undefined} */ (greeting);
    return typeof g?.avatar === 'string' && g.avatar !== '' && Number.isInteger(g.id) ? { avatar: g.avatar, id: /** @type {number} */ (g.id) } : null;
}

/**
 * @param {string} avatar
 * @param {import('./opening-state.js').CardGreetingsRead} card
 * @returns {import('@st/alternatives/server').ListedCard}
 */
const listedCard = (avatar, card) => ({ avatar, ids: card.ids, greetings: card.texts, defaultPosition: card.defaultIndex });

/**
 * @param {User} user
 * @param {import('@st/alternatives/protocol').TokenizerState} tokenizer
 */
async function tokenizerOf(user, tokenizer) {
    const state = readTokenizerState(tokenizer);
    return state ? openTokenizer(state, directoriesOf(user)) : null;
}

/**
 * @param {import('@st/server-ui').ViewContext} context
 * @param {import('@st/alternatives/protocol').Target} target
 * @returns {Promise<import('@st/alternatives/server').Listed | null>}
 */
async function listedAlternatives(context, target) {
    if ('message' in target) {
        const store = await userStore(directoriesOf(context.user), context.user.handle);
        const found = await store.chats.alternatives({ node_id: target.message });
        if (!found) return null;
        return { alternatives: found.alternatives.map(entry => alternativeOf(entry)), current: found.selected, cards: [], addsTo: null, openings: null };
    }
    const chat = await chatOfTab(context);
    if ('opening' in target) {
        if (!chat) return null;
        const offered = await chat.store.chats.cardGreetings(chat.tree);
        const openings = await chat.store.chats.openingAlternatives({ tree: chat.tree, actor: chat.actor, range: WHOLE, card: offered });
        const avatars = chat.avatar ? [chat.avatar] : [...new Set(offered.avatars.filter(a => a !== ''))];
        const read = await Promise.all(avatars.map(avatar => readCardGreetings(chat.store, avatar)));
        return {
            alternatives: openings.alternatives.map(entry => alternativeOf(entry, chat.avatar)),
            current: openings.total > 0 ? openings.default_index : null,
            cards: avatars.flatMap((avatar, i) => (read[i] ? [listedCard(avatar, /** @type {import('./opening-state.js').CardGreetingsRead} */ (read[i]))] : [])),
            addsTo: chat.avatar && read[0] ? chat.avatar : null,
            openings: null,
        };
    }
    const store = chat?.store ?? await userStore(directoriesOf(context.user), context.user.handle);
    const card = await readCardGreetings(store, target.greetings);
    if (!card) return null;
    const offered = chat ? await chat.store.chats.cardGreetings(chat.tree) : null;
    const inChat = chat && (chat.avatar === target.greetings || offered?.avatars.includes(target.greetings))
        ? await chat.store.chats.openingAlternatives({ tree: chat.tree, actor: chat.actor, range: WHOLE, card: offered ?? undefined })
        : null;
    return {
        alternatives: card.texts.map((text, k) => {
            const greeting = { avatar: target.greetings, id: card.ids[k] };
            return { id: unstoredGreetingNodeId({ extra: { greeting_id: greeting.id } }, greeting.avatar) ?? '', nodeId: null, greeting, text, name: card.name, isUser: false, isSystem: false, date: null };
        }),
        current: card.defaultIndex,
        cards: [listedCard(target.greetings, card)],
        addsTo: target.greetings,
        openings: inChat ? inChat.alternatives.map(entry => greetingOf(entry.greeting)) : null,
    };
}

/**
 * The listed alternatives, each with the values of the macros it draws. They are read out of the chat, so their macros
 * read no messages.
 * @param {import('@st/server-ui').ViewContext} context
 * @param {import('@st/alternatives/protocol').Target} target
 * @param {import('@st/alternatives/server').Listed | null} listed
 * @returns {Promise<import('@st/alternatives/server').Listed | null>}
 */
async function withMacroValues(context, target, listed) {
    if (!listed) return listed;
    const wanted = listed.alternatives.map(a => ({ texts: [a.text], speaker: a.isUser ? null : a.name }));
    if (!wanted.some(each => macrosIn(each.texts[0]).length > 0)) return listed;
    const chat = await chatOfTab(context);
    const owner = 'greetings' in target ? { avatar: target.greetings, groupId: null, pageFacts: undefined } : { avatar: chat?.avatar ?? null, groupId: chat?.groupId ?? null, pageFacts: undefined };
    const bySpeaker = new Map((await scopeMacroValues(directoriesOf(context.user), owner, wanted)).map(each => [each.speaker, each.values]));
    return { ...listed, alternatives: listed.alternatives.map((a, i) => ({ ...a, macros: bySpeaker.get(wanted[i].speaker) ?? {} })) };
}

/** @type {import('@st/alternatives/server').Ports} */
const alternativesPorts = {
    async list(context, target) {
        return withMacroValues(context, target, await listedAlternatives(context, target));
    },
    hash: text => hashGreetingText(text),
    counts: {
        async stored(user, tokenizer, texts) {
            const opened = await tokenizerOf(user, tokenizer);
            const identity = opened ? await opened.identity() : null;
            if (identity === null) return texts.map(() => null);
            return Promise.all(texts.map(text => text === ''
                ? 0
                : readCount(directoriesOf(user), identity, tokenKeyHash(TOKEN_KEY_KINDS.TEXT, text)).catch(() => null)));
        },
        async count(user, tokenizer, texts, each) {
            const opened = await tokenizerOf(user, tokenizer);
            if (!opened) {
                texts.forEach((_, i) => each(i, null));
                return;
            }
            const counter = await opened.storedCounter();
            let next = 0;
            let stopped = false;
            const worker = async () => {
                for (let i = next++; i < texts.length && !stopped; i = next++) {
                    const text = texts[i];
                    if (!each(i, text === '' ? 0 : await counter.countText(text).catch(() => null))) stopped = true;
                    await new Promise(resolve => setImmediate(resolve));
                }
            };
            await Promise.all(Array.from({ length: COUNTING_AT_ONCE }, worker));
            await opened.writeCounted();
        },
    },
    match: (query, texts) => textMatches(getEngine(), query, texts),
    async greeting(context, avatar, op) {
        const directories = directoriesOf(context.user);
        const store = await userStore(directories, context.user.handle);
        const actor = { user: context.user.handle, session: context.session };
        const chat = await chatOfTab(context);
        const group = chat?.groupId ? { tree: chat.tree, groupId: chat.groupId } : undefined;
        const { result, opening } = await changeGreetings({ directories, store, actor, avatar, change: op, group });
        if (result.ok) return { ok: true, opening: opening && group ? { ...opening, group_id: group.groupId } : opening };
        return { ok: false, reason: result.reason ?? 'The greetings changed.', ...(Number.isInteger(result.same) ? { same: { id: /** @type {number} */ (result.sameId), position: /** @type {number} */ (result.same) } } : {}) };
    },
    async move(context, nodeId, place) {
        const chat = await chatOfTab(context);
        if (!chat) return { ok: false, reason: 'No chat is open.' };
        return chat.store.chats.placeMessage({ tree: chat.tree, node_id: nodeId, place, actor: chat.actor });
    },
};

const START_LENGTH = 200;

/**
 * @param {unknown} content
 * @returns {string}
 */
function startOf(content) {
    if (typeof content !== 'string') return '';
    const text = content.trim();
    return text.length > START_LENGTH ? `${text.slice(0, START_LENGTH).trimEnd()}…` : text;
}

/**
 * @param {any[]} sources
 * @returns {import('@st/activations/protocol').Where[]}
 */
const whereOf = sources => sources.flatMap(s => {
    if (typeof s?.node === 'string') return [{ message: s.node, spans: Array.isArray(s.spans) ? s.spans : [] }];
    if (typeof s?.field === 'string') return [{ field: s.field }];
    if (typeof s?.inject === 'string') return [{ inject: s.inject }];
    return [];
});

/** @type {import('@st/activations/server').Ports} */
const activationsPorts = {
    looksOf: (context, view, things) => looks.looksOf(context, view, things),
    async panel(user, message) {
        const store = await userStore(directoriesOf(user), user.handle);
        const record = await resolvedActivations(store, message);
        if (!record) return null;
        const refs = [...record.entries, ...record.cut].map(entry => entry.ref);
        const descriptions = new Map();
        for (const ref of refs) {
            if (!ref || descriptions.has(ref.entry)) continue;
            const [entry, world] = await Promise.all([
                store.lib.store.worldRead('worldbuildingEntry', { book: BigInt(ref.book), entry: BigInt(ref.entry) }),
                worldbuildingPorts.readWorld(user, ref.book),
            ]);
            if (entry && !entry.deleted && world) descriptions.set(ref.entry, {
                label: entry.label,
                world: { thing: ref.book, text: world.name, shownAs: 'name' },
                start: startOf(entry.text),
                open: ref,
            });
        }
        const described = ref => descriptions.get(ref?.entry) ?? {
            label: { thing: null, text: 'An unavailable entry' },
            world: { thing: null, text: 'A lorebook' },
            start: '',
            open: null,
        };

        return {
            entries: record.entries.map(e => ({
                ...described(e.ref),
                why: e.why,
                keys: (Array.isArray(e.keys) ? e.keys : []).map(k => ({ key: String(k.key), where: whereOf(Array.isArray(k.in) ? k.in : []) })),
                via: Array.isArray(e.via) ? e.via.filter(v => Number.isInteger(v)) : [],
            })),
            cut: (Array.isArray(record.cut) ? record.cut : []).map(c => ({ ...described(c.ref), why: c.why })),
        };
    },
};

/**
 * @param {import('@st/server-ui').User} user
 */
const referencesOf = async user => new References((await userStore(directoriesOf(user), user.handle)).lib, {
    defaults: matchDefaultsOf(worldInfoGlobalsOf(readUserSettings(directoriesOf(user), ['world_info_settings']).world_info_settings)),
});

/** @param {import('@st/worldbuilding/protocol').OverviewLayout} layout */
const regionLayout = layout => ({
    regionColumns: layout.regionsByNestingLevel.map(region => region.columns),
    regionRows: layout.regionsByNestingLevel.map(region => region.rows),
});
const optionalId = (/** @type {string | null} */ id) => (id === null ? null : BigInt(id));
// The chat's own world, in its metadata.
const CHAT_WORLD_KEY = 'world_info';

onUserStoreOpened(({ events, root, handle }) => {
    /** @type {import('@st/server-ui').User} */
    const user = /** @type {any} */ ({ handle, directories: { root } });
    events.on('worldbuildingJobStep', (/** @type {bigint} */ _book, /** @type {'relations' | 'names' | 'entries'} */ touched) => {
        const also = {
            relations: [],
            names: ['worldbuilding.world', 'worldbuilding.entry', 'worldbuilding.found'],
            entries: ['worldbuilding.world', 'worldbuilding.worlds', 'worldbuilding.entry', 'worldbuilding.found', 'worldbuilding.bulkJobs'],
        }[touched];
        ui.changed(user, ['worldbuilding.loopsLeftByJobs', 'worldbuilding.overview', 'worldbuilding.results', 'worldbuilding.pointingAt', 'worldbuilding.selection', ...also]).catch(error => console.error('Pushing a worldbuilding job step failed.', error));
    });
    events.on('commit', (/** @type {any[]} */ records) => {
        if (!records.some(r => r?.kind === 'bookChoose' || (r?.kind === 'stateChange' && r.key === CHAT_WORLD_KEY))) return;
        ui.changed(user, ['worldbuilding.world']).catch(error => console.error('Pushing which worlds a chat reads failed.', error));
    });
    // A look written by a write of its thing's own (a tag restored with upstream's colors, a world imported) reaches
    // every tab as the looks area's edits do.
    let looksQueued = false;
    events.on('commit', (/** @type {any[]} */ records) => {
        if (looksQueued || !records.some(r => r?.field === LOOK_FIELD)) return;
        looksQueued = true;
        setImmediate(() => {
            looksQueued = false;
            ui.changed(user, [DRAWN_VIEW]).catch(error => console.error('Pushing the looks drawn failed.', error));
        });
    });
    let historyQueued = false;
    events.on('commit', () => {
        if (historyQueued || !recentHistory.showing(root)) return;
        historyQueued = true;
        setImmediate(() => {
            historyQueued = false;
            ui.changed(user, [RECENT_HISTORY_VIEW]).catch(error => console.error('Pushing the recent history failed.', error));
        });
    });
    let statsQueued = false;
    events.on('commit', () => {
        if (statsQueued || !usageStats.showing(root)) return;
        statsQueued = true;
        setImmediate(() => {
            statsQueued = false;
            ui.changed(user, [USAGE_STATS_VIEW]).catch(error => console.error('Pushing the usage stats failed.', error));
        });
    });
});

/**
 * @param {import('./chat-engine.js').HistoryMessage} m
 * @returns {import('@st/recent-history/protocol').Message}
 */
const historyMessageOf = m => ({
    nodeId: m.node_id,
    text: m.mes,
    name: m.name,
    role: m.is_system ? 'system' : m.is_user ? 'user' : 'assistant',
    date: typeof m.send_date === 'string' || typeof m.send_date === 'number' ? m.send_date : null,
});

const recentHistory = recentHistoryArea({
    async entries(context, of, before, limit) {
        const store = await userStore(directoriesOf(context.user), context.user.handle);
        let chat = null;
        if (of === 'chat') {
            if (!context.chat) return null;
            chat = { tree: BigInt(context.chat.tree), actor: { user: context.user.handle, session: context.session } };
        }
        const page = await store.chats.recentHistory({ of: chat, before, limit });
        const trees = [...new Set(page.entries.map(e => e.tree))];
        const keys = await store.lib.store.libraryKeys(trees);
        /** @type {Map<bigint, import('@st/protocol').ChatOwner>} */
        const owners = new Map();
        trees.forEach((tree, i) => {
            const key = keys[i];
            if (key) owners.set(tree, key.type === TYPE.group ? { group: key.key } : { avatar: key.key });
        });
        /** @type {import('@st/recent-history/server').Listed[]} */
        const entries = [];
        for (const e of page.entries) {
            const owner = owners.get(e.tree);
            if (!owner) continue;
            const chatKey = `${e.tree}:${e.chat.bookmark ?? `s${e.chat.session}`}`;
            entries.push({
                id: e.group ?? `at:${chatKey}`,
                group: e.group,
                chat: { owner, name: e.chat.name },
                message: historyMessageOf(e.message),
                split: e.split === null ? null : e.split.number === null ? { start: true } : { number: e.split.number },
                tips: e.tips,
            });
        }
        return { entries, next: page.next };
    },
    async tips(context, group, before, limit) {
        const store = await userStore(directoriesOf(context.user), context.user.handle);
        const page = await store.chats.historyTips({ group, before, limit });
        return { tips: page.tips.map(historyMessageOf), next: page.next };
    },
});

/** @type {import('@st/usage-stats/server').Stored} */
const NO_STATS = { userMsgs: 0, charMsgs: 0, userWords: 0, charWords: 0, swipes: 0, genMs: 0, genUnknown: 0, firstUserAt: null };

const usageStats = usageStatsArea({
    async totals(user) {
        const { totals } = await (await libOf(user)).store.chatRead('stats', { owners: [] });
        return totals;
    },
    async character(user, avatar) {
        const lib = await libOf(user);
        const [id] = await lib.ids(TYPE.character, [avatar]);
        if (id === null || id === undefined) return NO_STATS;
        const { owners: [stats] } = await lib.store.chatRead('stats', { owners: [id] });
        return stats ?? NO_STATS;
    },
    async oldStatsFile(user) {
        return fs.existsSync(path.join(user.directories.root, STATS_BACKUP_FILE)) ? STATS_BACKUP_FILE : null;
    },
});

export const looks = looksArea(looksPorts({ libOf }));
resolveChatLinkLooks((context, holder, things, o) => looks.looksOf(context, holder, things, o));

/** @type {import('@st/worldbuilding/server').Ports} */
const worldbuildingPorts = {
    looksOf: looks.looksOf,
    ...worldbuildingWorldPorts({
        libOf,
        async booksChanged(user, change) {
            const document = settingsDocumentOf(user.directories);
            return document ? document.booksChanged(change) : change();
        },
    }),
    ...worldbuildingEntryPorts({
        libOf,
        referencesOf,
        async countTokens(user, texts) {
            try {
                return (await countWithConnection(directoriesOf(user), {}, texts))?.counts ?? null;
            } catch (error) {
                console.error('Could not count the entry\'s text:', error);
                return null;
            }
        },
    }),
    ...worldbuildingSearchPorts({ libOf }),
    ...worldbuildingBulkPorts({ libOf }),
    ...worldbuildingViewPorts({ libOf }),
    async chatReadsWorld(context, book) {
        if (!context.chat) return false;
        const store = await userStore(directoriesOf(context.user), context.user.handle);
        return chatReadsBook(directoriesOf(context.user), store, BigInt(context.chat.tree), { user: context.user.handle, session: context.session }, BigInt(book));
    },
    async broughtUpBy(context, reply, entries) {
        if (!context.chat) return entries.map(() => null);
        const store = await userStore(directoriesOf(context.user), context.user.handle);
        const shown = await store.chats.shownMessage(BigInt(context.chat.tree), reply);
        return keysThatBroughtUp(shown ? await resolvedActivations(store, reply) : null, entries);
    },
    async entryIn(user, book, entry) {
        return (await (await libOf(user)).books.entryIn(BigInt(book), BigInt(entry))) !== null;
    },
    async readCard(user, book, entry, shown) {
        const lib = await libOf(user);
        const read = await lib.store.worldRead('worldbuildingEntry', { book: BigInt(book), entry: BigInt(entry) });
        if (read === null || read.deleted) return null;
        const [stored, form] = await Promise.all([lib.books.entryIn(BigInt(book), BigInt(entry)), lib.books.bookForm(BigInt(book))]);
        const { placement } = placementOf(stored && form ? entryAsWorld(stored, form.form) : {});
        return {
            title: read.title,
            keys: read.keys,
            placement: /** @type {import('@st/worldbuilding/protocol').Placement} */ (placement),
            label: read.label,
            picture: read.picture === null ? null : lookImageUrl(read.picture),
            relations: read.relations.slice(0, shown.relations),
            moreRelations: Math.max(0, read.relations.length - shown.relations),
            text: read.text,
            textCut: false,
        };
    },
    async readLoopsLeftByJobs(user, book) {
        return (await libOf(user)).books.jobs.loopsLeft(BigInt(book));
    },
    async readOverview(user, { book, groupBy, sort, firstRank, endRank, layout }) {
        const lib = await libOf(user);
        return withPictureUrls(await lib.store.worldRead('worldbuildingOverview', {
            book: BigInt(book),
            groupBy: groupBy === null ? null : Number(groupBy),
            ...(groupBy === null && sort.by !== 'world' ? { sort: sort.by, descending: sort.descending } : {}),
            firstRank,
            endRank,
            stepLandedOn: null,
            cardTextCharacters: layout.cardTextCharacters,
            ...regionLayout(layout),
        }));
    },
    async stepOverview(user, { book, groupBy, layout, ...step }) {
        const lib = await libOf(user);
        return lib.store.worldRead('worldbuildingStep', { book: BigInt(book), groupBy: groupBy === null ? null : Number(groupBy), ...regionLayout(layout), ...step });
    },
    async readPointingAt(user, { book, entry, layout, endRank, held, maxCards }) {
        const lib = await libOf(user);
        const read = await lib.store.worldRead('worldbuildingPointingAt', {
            book: BigInt(book),
            entry: BigInt(entry),
            firstShown: endRank,
            maxCards,
            held: held.map(range => ({ ...range, kind: Number(range.kind) })),
            cardTextCharacters: layout.cardTextCharacters,
            ...regionLayout(layout),
        });
        return read === null ? null : withPictureUrls(read.sections);
    },
    async stepPointingAt(user, { book, entry, kind, layout, ...step }) {
        const lib = await libOf(user);
        return lib.store.worldRead('worldbuildingStep', { book: BigInt(book), entry: BigInt(entry), groupBy: Number(kind), ...regionLayout(layout), ...step });
    },
    async readRelationKinds(user, book) {
        const lib = await libOf(user);
        return (await lib.books.relationKinds(BigInt(book))).map(kind => ({ id: String(kind.id), name: kind.name, mergingInto: kind.mergingInto === undefined ? null : String(kind.mergingInto) }));
    },
    async createRelationKind({ user }, book, name) {
        const id = await (await libOf(user)).books.createRelationKind(BigInt(book), name);
        return id === 'missing' ? null : String(id);
    },
    async renameRelationKind({ user }, book, kind, name) {
        return (await libOf(user)).books.renameRelationKind(BigInt(book), Number(kind), name);
    },
    async deleteRelationKind({ user }, book, kind) {
        return (await libOf(user)).books.deleteRelationKind(BigInt(book), Number(kind));
    },
    async mergeRelationKind({ user }, book, kind, into) {
        return (await libOf(user)).books.mergeRelationKind(BigInt(book), Number(kind), Number(into));
    },
    async changeRelations({ user, session }, book, changes, loopCheckLimit) {
        const lib = await libOf(user);
        const edits = changes.map(change => ({
            change: change.change,
            entry: BigInt(change.entry),
            kind: Number(change.kind),
            target: BigInt(change.target),
            ...('newTarget' in change ? { newTarget: BigInt(change.newTarget) } : {}),
            ...('after' in change ? { after: optionalId(change.after), before: optionalId(change.before) } : {}),
            ...('weak' in change ? { weak: change.weak } : {}),
        }));
        return lib.books.changeRelations(BigInt(book), edits, loopCheckLimit, { user: user.handle, session });
    },
};

export const ui = createUi([backgroundsArea(backgroundPorts), settingsArea(settingsPorts), alternativesArea(alternativesPorts), activationsArea(activationsPorts), worldbuildingArea(worldbuildingPorts), looks.area, usageStats.area, helpArea(), recentHistory.area], {
    userOf: request => (request.user ? uiUser(request) : null),
    async chatOf(user, owner) {
        const store = await userStore(directoriesOf(user), user.handle);
        const [tree] = await store.people.trees([owner]);
        return tree === null || tree === undefined ? null : { tree: String(tree) };
    },
});

/**
 * The looks of what an old page's answer draws, kept as what that place of the tab draws (`holder`), so a look's edit
 * answers them again. A thing's look is drawn by its entity id; a request with no tab draws none.
 * @param {import('express').Request} request
 * @param {string} holder
 * @param {(string | bigint | null | undefined)[]} things
 * @param {{ adding?: boolean }} [o] more of what the holder draws, kept with what it drew
 * @returns {Promise<import('@st/protocol/looks').Looks>}
 */
export async function pageLooks(request, holder, things, { adding = false } = {}) {
    const session = sessionHeaderOf(request);
    const drawn = [...new Set(things.filter(t => t !== null && t !== undefined).map(String))];
    if (!request.user || session === undefined || session === 'none') return { styles: {}, things: {} };
    return looks.looksOf({ user: uiUser(request), session, chat: null }, holder, drawn, { adding });
}

/**
 * @param {import('express').Request} request
 * @returns {User}
 */
export function uiUser(request) {
    return { handle: request.user.profile.handle, directories: /** @type {any} */ (request.user.directories) };
}
