import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { createUi } from '@st/server-ui';
import { backgroundsArea } from '@st/backgrounds/server';
import { settingsArea } from '@st/settings/server';
import { alternativesArea } from '@st/alternatives/server';
import { activationsArea } from '@st/activations/server';

import { userStore } from './user-stores.js';
import { TYPE } from './library-engine.js';
import { clientRelativePath, humanizedDateTime, isPathUnderParent } from './util.js';
import { createFolder, deleteFolder, readFolders, retargetCovers, updateFolder } from './background-folders.js';
import { backgroundOf, changeBackgroundFolders, imageThumbnails, imagesOf, removeImage, renameImage, userImageKey, writeBackground, writeUserImage } from './image-entities.js';
import { settingsDocumentOf } from './settings-documents.js';
import { modelListOf, rememberModelList } from './model-lists.js';
import { default_settings as chatCompletionDefaults } from '../public/scripts/chat-completion-defaults.js';
import { writeNamedSettings, readAllSettings } from './settings-store.js';
import { readCardGreetings } from './endpoints/chats.js';
import { applyGreetingOperation } from './endpoints/characters.js';
import { openTokenizer } from './endpoints/tokenizers-current.js';
import { readTokenizerState } from './connection-state-header.js';
import { TOKEN_KEY_KINDS, readCount, tokenKeyHash } from './token-count-store.js';
import { textMatches } from './text-matches.js';
import { getEngine } from '../engine/load.js';
import { hashGreetingText, opAppend, opDelete, opEdit, opMove, opSetDefault, opUnsetDefaultByHash } from './greeting-ops.js';

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
    defaults: () => ({ oai_settings: chatCompletionDefaults }),
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
    return { store, tree, avatar, actor: { user: context.user.handle, session: context.session } };
}

/**
 * @param {Record<string, any>} entry
 * @returns {import('@st/alternatives/server').Alternative}
 */
const alternativeOf = entry => ({
    nodeId: entry.node_id ?? null,
    text: typeof entry.mes === 'string' ? entry.mes : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    isUser: !!entry.is_user,
    isSystem: !!entry.is_system,
    date: typeof entry.send_date === 'string' || typeof entry.send_date === 'number' ? entry.send_date : null,
});

/**
 * @param {User} user
 * @param {import('@st/alternatives/protocol').TokenizerState} tokenizer
 */
async function tokenizerOf(user, tokenizer) {
    const state = readTokenizerState(tokenizer);
    return state ? openTokenizer(state, directoriesOf(user)) : null;
}

/**
 * @param {import('@st/alternatives/protocol').GreetingOp} op
 * @returns {(model: import('./greeting-list.js').GreetingsModel) => any}
 */
function greetingOperation(op) {
    switch (op.op) {
        case 'add': return model => opAppend(model, op.text);
        case 'edit': return model => opEdit(model, op.position, op.hash, op.text);
        case 'delete': return model => opDelete(model, op.position, op.hash);
        case 'move': return model => opMove(model, op.position, op.hash, op.side, op.target, op.targetHash);
        case 'default': return model => opSetDefault(model, op.position, op.hash);
        case 'undefault': return model => opUnsetDefaultByHash(model, op.hash);
    }
}

/** @type {import('@st/alternatives/server').Ports} */
const alternativesPorts = {
    async list(context, target) {
        if ('message' in target) {
            const store = await userStore(directoriesOf(context.user), context.user.handle);
            const found = await store.chats.alternatives({ node_id: target.message });
            if (!found) return null;
            return { alternatives: found.alternatives.map(alternativeOf), current: found.selected, card: null, openings: null };
        }
        const chat = await chatOfTab(context);
        if ('opening' in target) {
            if (!chat) return null;
            const card = chat.avatar ? await readCardGreetings(chat.store, chat.avatar) : null;
            const openings = await chat.store.chats.openingAlternatives({ tree: chat.tree, actor: chat.actor, range: WHOLE, cardGreetings: card?.greetings ?? [] });
            return {
                alternatives: openings.alternatives.map(alternativeOf),
                current: openings.total > 0 ? openings.default_index : null,
                card: card && chat.avatar ? { avatar: chat.avatar, greetings: card.texts, defaultPosition: card.defaultIndex } : null,
                openings: null,
            };
        }
        const store = chat?.store ?? await userStore(directoriesOf(context.user), context.user.handle);
        const card = await readCardGreetings(store, target.greetings);
        if (!card) return null;
        const inChat = chat && chat.avatar === target.greetings
            ? await chat.store.chats.openingAlternatives({ tree: chat.tree, actor: chat.actor, range: WHOLE, cardGreetings: card.greetings })
            : null;
        return {
            alternatives: card.texts.map(text => ({ nodeId: null, text, name: card.name, isUser: false, isSystem: false, date: null })),
            current: card.defaultIndex,
            card: { avatar: target.greetings, greetings: card.texts, defaultPosition: card.defaultIndex },
            openings: inChat ? inChat.alternatives.map(entry => (typeof entry.mes === 'string' ? entry.mes : '')) : null,
        };
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
    async greeting(user, avatar, op) {
        const result = await applyGreetingOperation(directoriesOf(user), avatar, greetingOperation(op));
        return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'The greetings changed.' };
    },
};

/**
 * @param {unknown} comment
 * @param {unknown} keys
 * @returns {string}
 */
function entryTitle(comment, keys) {
    if (typeof comment === 'string' && comment.trim()) return comment.trim();
    const first = Array.isArray(keys) ? keys.find(k => typeof k === 'string' && k.trim()) : null;
    return first ? first.trim() : 'Untitled entry';
}

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
    async panel(user, message) {
        const store = await userStore(directoriesOf(user), user.handle);
        const [id] = await store.chats.messageIds([message]);
        const stored = id === null ? undefined : (await store.chats.stored([id])).get(id);
        if (!stored) return null;
        const [content] = await store.chats.decoded([stored]);
        const record = content?.extra?.activations;
        if (!record || !Array.isArray(record.entries)) return null;
        const refs = [...record.entries.map(e => e.ref), ...(Array.isArray(record.cut) ? record.cut.map(c => c.ref) : [])];

        const entryIds = [...new Set(refs.filter(r => typeof r?.entry === 'string').map(r => r.entry))];
        const entries = new Map((await store.lib.books.describeEntries(entryIds.map(BigInt))).map((e, i) => [entryIds[i], e]));

        let avatar = typeof content.original_avatar === 'string' ? content.original_avatar : null;
        if (avatar === null) {
            const [key] = await store.lib.store.libraryKeys([stored.owner]);
            avatar = key && key.type !== TYPE.group ? key.key : null;
        }
        const [card] = refs.some(r => typeof r?.card === 'string') && avatar ? await store.lib.cards([avatar]) : [null];
        const cardEntries = Array.isArray(card?.data?.character_book?.entries) ? card.data.character_book.entries : [];
        const cardName = typeof card?.data?.name === 'string' ? card.data.name : (typeof card?.name === 'string' ? card.name : '');

        /** @returns {{ title: string, book: string, start: string, open: import('@st/activations/protocol').Opener }} */
        const described = ref => {
            if (typeof ref?.card === 'string') {
                const found = cardEntries.find((e, index) => String(e.id ?? index) === ref.card);
                return {
                    title: found ? entryTitle(found.comment, found.keys) : 'A removed entry',
                    book: cardName ? `${cardName}'s card` : 'The character card',
                    start: startOf(found?.content),
                    open: avatar ? { card: avatar } : null,
                };
            }
            const entry = entries.get(ref?.entry) ?? null;
            if (!entry) return { title: 'A removed entry', book: 'A lorebook', start: '', open: null };
            const uid = Number(entry.uid);
            return {
                title: entryTitle(entry.comment, entry.key),
                book: entry.bookName,
                start: startOf(entry.content),
                open: Number.isFinite(uid) ? { book: entry.book, uid } : null,
            };
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

export const ui = createUi([backgroundsArea(backgroundPorts), settingsArea(settingsPorts), alternativesArea(alternativesPorts), activationsArea(activationsPorts)], {
    userOf: request => (request.user ? uiUser(request) : null),
    async chatOf(user, owner) {
        const store = await userStore(directoriesOf(user), user.handle);
        const [tree] = await store.people.trees([owner]);
        return tree === null || tree === undefined ? null : { tree: String(tree) };
    },
});

/**
 * @param {import('express').Request} request
 * @returns {User}
 */
export function uiUser(request) {
    return { handle: request.user.profile.handle, directories: /** @type {any} */ (request.user.directories) };
}
