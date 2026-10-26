import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { createUi } from '@st/server-ui';
import { backgroundsArea } from '@st/server-ui/backgrounds';
import { settingsArea } from '@st/server-ui/settings';

import { userStore } from './user-stores.js';
import { TYPE } from './library-engine.js';
import { getImages, clientRelativePath, humanizedDateTime, isPathUnderParent } from './util.js';
import { getThumbnailVersion, invalidateThumbnail } from './endpoints/thumbnails.js';
import {
    readMetadataIndex, getOrGenerateMetadataBatch, renameMetadata, removeMetadata, createFolder, updateFolder,
    deleteFolder, assignImagesToFolder, unassignImagesFromFolder, setImageFolderMembership,
} from './endpoints/image-metadata.js';
import { settingsDocumentOf } from './settings-documents.js';
import { writeNamedSettings, readAllSettings } from './settings-store.js';

/**
 * The new code's server side (packages/server-ui) over the old server: each port an area declares is implemented
 * here with old code, so the packages never import it.
 */

/** @typedef {import('@st/server-ui').User} User */
/** @typedef {import('@st/server-ui').ViewContext} ViewContext */

/** What a chat's background may be stored as (not svg: it can carry script, and user images are served as they are). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'bmp', 'avif']);

const LIST_KEY = 'chat_backgrounds';
const LOCK_KEY = 'custom_background';

/**
 * @param {User} user
 * @returns {import('./users.js').UserDirectoryList}
 */
const directoriesOf = user => /** @type {any} */ (user.directories);

/** @param {string} file */
const backgroundPath = file => path.posix.join('backgrounds', file);

/**
 * The open chat of a tab: its tree, and where its session is in it.
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
 * A new background's metadata (its color, shape, whether it's animated), made now so the list has it. The file is
 * stored whether or not this works (as upstream's upload route); a background without it lists without it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} file
 */
async function describe(directories, file) {
    await getOrGenerateMetadataBatch(directories.root, [backgroundPath(file)], 'bg').catch(error => {
        console.warn(`[backgrounds] No metadata for ${file}:`, error.message);
    });
}

/** @type {import('@st/server-ui/backgrounds').Ports} */
const backgroundPorts = {
    files: {
        async list(user) {
            const directories = directoriesOf(user);
            const files = getImages(directories.backgrounds);
            const { results } = await getOrGenerateMetadataBatch(directories.root, files.map(backgroundPath), 'bg');
            return files.map(file => {
                const meta = results[backgroundPath(file)];
                const version = getThumbnailVersion(directories, 'bg', file);
                return {
                    file,
                    animated: meta?.isAnimated ?? false,
                    color: meta?.dominantColor ?? null,
                    aspect: typeof meta?.aspectRatio === 'number' ? meta.aspectRatio : null,
                    added: typeof meta?.addedTimestamp === 'number' ? meta.addedTimestamp : null,
                    folders: Array.isArray(meta?.folderIds) ? meta.folderIds : [],
                    thumbnailVersion: version === null || version === undefined ? null : String(version),
                };
            });
        },
        async folders(user) {
            const index = await readMetadataIndex(user.directories.root);
            return (index.folders ?? []).map(f => ({ id: f.id, name: f.name, cover: f.thumbnailFile || null }));
        },
        async save(user, upload) {
            const directories = directoriesOf(user);
            const file = sanitize(upload.name);
            await fs.promises.copyFile(upload.path, path.join(directories.backgrounds, file));
            invalidateThumbnail(directories, 'bg', file);
            await describe(directories, file);
            return file;
        },
        async copyIn(user, from, name) {
            const directories = directoriesOf(user);
            const source = path.join(directories.root, from);
            if (!isPathUnderParent(directories.userImages, source)) throw new Error(`Not a user image: ${from}`);
            const file = sanitize(name);
            await fs.promises.copyFile(source, path.join(directories.backgrounds, file));
            invalidateThumbnail(directories, 'bg', file);
            await describe(directories, file);
            return file;
        },
        async rename(user, file, to) {
            const directories = directoriesOf(user);
            const from = path.join(directories.backgrounds, sanitize(file));
            const target = path.join(directories.backgrounds, sanitize(to));
            if (sanitize(file) !== file || sanitize(to) !== to || !fs.existsSync(from) || fs.existsSync(target)) return false;
            await fs.promises.rename(from, target);
            invalidateThumbnail(directories, 'bg', file);
            await renameMetadata(directories.root, backgroundPath(file), backgroundPath(to));
            return true;
        },
        async remove(user, file) {
            const directories = directoriesOf(user);
            if (sanitize(file) !== file) throw new Error(`Not a background's name: ${file}`);
            await fs.promises.rm(path.join(directories.backgrounds, file), { force: true });
            invalidateThumbnail(directories, 'bg', file);
            await removeMetadata(directories.root, backgroundPath(file));
        },
        async createFolder(user, name) {
            await createFolder(user.directories.root, name);
        },
        async renameFolder(user, id, name) {
            await updateFolder(user.directories.root, id, { name });
        },
        async deleteFolder(user, id) {
            await deleteFolder(user.directories.root, id);
        },
        async setCover(user, id, file) {
            await updateFolder(user.directories.root, id, { thumbnailFile: file });
        },
        async addToFolder(user, id, files) {
            await assignImagesToFolder(user.directories.root, id, files.map(backgroundPath));
        },
        async removeFromFolder(user, id, files) {
            await unassignImagesFromFolder(user.directories.root, id, files.map(backgroundPath));
        },
        async setFolders(user, file, ids) {
            await setImageFolderMembership(user.directories.root, backgroundPath(file), ids);
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
            // Upstream's folder: the character's name, or the group's id.
            const folder = sanitize(speaker?.name || key?.key || 'chat');
            const extension = path.extname(upload.name).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(extension.slice(1))) throw new Error(`Not an image to keep: ${upload.name}`);
            const target = path.join(directories.userImages, folder, sanitize(`${folder}_${humanizedDateTime()}${extension}`));
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.copyFile(upload.path, target);
            return clientRelativePath(directories.root, target);
        },
        async deleteImage(context, relative) {
            const directories = directoriesOf(context.user);
            const target = path.join(directories.root, relative);
            if (!isPathUnderParent(directories.userImages, target)) throw new Error(`Not a user image: ${relative}`);
            await fs.promises.rm(target, { force: true });
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

/** The backgrounds' views (packages/protocol/src/backgrounds.ts). */
export const BACKGROUND_VIEWS = ['backgrounds', 'backgrounds.chat'];

/** The settings' view (packages/protocol/src/settings.ts). */
export const SETTINGS_VIEWS = ['settings'];

/**
 * The settings document's context for a chat's owner.
 * @param {import('@st/protocol').ChatOwner | null} owner
 */
const contextOf = owner => ({ avatar: owner && 'avatar' in owner ? owner.avatar : null, groupId: owner && 'group' in owner ? owner.group : null });

/**
 * Each user's chat completion model lists, by source, as the status route last answered them: the limits a model
 * has (packages/server-ui/src/model-limits.ts) come from them. Memory only; after a restart they're the name tables'
 * until the page connects again.
 * @type {Map<string, Map<string, readonly Record<string, unknown>[]>>}
 */
const modelLists = new Map();

/**
 * Remembers the model list a chat completion status answer carries, and pushes the settings view (its limits).
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
            const lists = modelLists.get(user.handle) ?? new Map();
            lists.set(source, body.data);
            modelLists.set(user.handle, lists);
            response.on('finish', () => ui.changed(user, SETTINGS_VIEWS).catch(error => console.error('[ui] not pushed:', error)));
        }
        return json(body);
    };
    next();
}

/** @type {import('@st/server-ui/settings').Ports} */
const settingsPorts = {
    async view(user, owner, range) {
        const document = settingsDocumentOf(user.directories);
        if (!document) return { settings: readAllSettings(directoriesOf(user)), sources: {} };
        return document.view(contextOf(owner), range);
    },
    async writeAt(user, owner, range, path, value) {
        const document = settingsDocumentOf(user.directories);
        if (!document) throw new Error(`The settings of ${user.handle} aren't open`);
        await document.writeAt(contextOf(owner), range, path, value);
    },
    async ownerOf(user, chat) {
        const store = await userStore(directoriesOf(user), user.handle);
        const [key] = await store.lib.store.libraryKeys([BigInt(chat.tree)]);
        if (!key) return null;
        return key.type === TYPE.group ? { group: key.key } : { avatar: key.key };
    },
    models: (user, source) => modelLists.get(user.handle)?.get(source) ?? [],
};

export const ui = createUi([backgroundsArea(backgroundPorts), settingsArea(settingsPorts)], {
    userOf: request => (request.user ? uiUser(request) : null),
    async chatOf(user, owner) {
        const store = await userStore(directoriesOf(user), user.handle);
        const [tree] = await store.people.trees([owner]);
        return tree === null || tree === undefined ? null : { tree: String(tree) };
    },
});

/**
 * The user a request is (what auth put on it), as the new code takes it.
 * @param {import('express').Request} request
 * @returns {User}
 */
export function uiUser(request) {
    return { handle: request.user.profile.handle, directories: /** @type {any} */ (request.user.directories) };
}
