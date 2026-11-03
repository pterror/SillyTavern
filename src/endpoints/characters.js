import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import yaml from 'yaml';
import _ from 'lodash';
import mime from 'mime-types';
import extractPngChunks from 'png-chunks-extract';
import { Jimp, JimpMime } from '../jimp.js';
import storage from 'node-persist';

import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { default as validateAvatarUrlMiddleware, getFileNameValidationFunction, forbiddenRegExp } from '../middleware/validateFileName.js';
import { deepMerge, humanizedDateTime, tryParse, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements, getArrayBufferSlice, uuidv7, writeBackpressured } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { importFailure, NO_CARD_DATA } from '../character-import-error.js';
import { computeAnimatedHashFromChunks, computeAvatarIdentityHashFromChunks, parse, write } from '../character-card-parser.js';
import { decodeFrames, encodeApng } from '../image-frames.js';
import { getCharaCardV2, convertToV2, readFromV2, charaFormatData, unsetPrivateFields, omitInstallLocalFields, omitFavField, omitChatField, V1_V2_FIELD_MAPPINGS } from '../character-card-normalize.js';
import { calculateDataSize, toShallow } from '../character-shallow.js';
import { touchBrowserPresence, PRESENCE_PING_INTERVAL_MS } from '../browser-presence.js';
import { claimTabSession } from '../session-presence.js';
import { assignThumbnails, cropOf, normalizeCrop, thumbnailsOf } from '../thumbnail-urls.js';
import { avatarRefString } from '../avatar-refs.js';
import { importRisuSprites, importChubExpressions, importChubRelatedLorebooks } from './sprites.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { savedViewsEvents } from '../saved-views.js';
import { characterDigestFieldsHash, characterDigestCardBodyHash, getStringHash, normalizeFav } from '../../public/scripts/hash-utils.js';
import { cardToGreetingsModel, applyGreetingsModelToCard } from '../greeting-list.js';
import { hashGreetingText, opAdd, opAppend, opEdit, opDelete, opMove, opSetDefault, opUnsetDefault, opUnsetDefaultByHash } from '../greeting-ops.js';
import { withSearchTiming } from '../search-timing.js';
import { requestStore, userStore } from '../user-stores.js';
import { FIELD, HASH, TYPE } from '../library-engine.js';
import { convertedFileKey } from '../library-codes.js';
import { avatarFile, avatarImage, avatarPathOf, inAvatarLane, linkWithAvatar, writeWithAvatar } from '../character-avatars.js';
import { writeUserImage } from '../image-entities.js';
import { chatNamesOf, compatChatIdOf, compatChatIds, droppedOf, moveToChatNamed } from '../chat-request.js';
import { requestSession } from '../request-session.js';
import { ALTERNATIVES_VIEWS, ui, uiUser } from '../ui-wiring.js';

import { groupDigests, groupObjects } from './groups.js';
// Use shallow character data for the character list
const useShallowCharacters = !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
export const FULL_BATCH_MAX = 200;
const useDiskCache = !!getConfigValue('performance.useDiskCache', true, 'boolean');

class DiskCache {
    /**
     * @type {string}
     * @readonly
     */
    static DIRECTORY = 'characters';

    /** @type {import('node-persist').LocalStorage} */
    #instance;

    /**
     * Path to the cache directory.
     * @returns {string}
     */
    get cachePath() {
        return path.join(globalThis.DATA_ROOT, '_cache', DiskCache.DIRECTORY);
    }

    /**
     * Returns the list of hashed keys in the cache.
     * @returns {string[]}
     */
    get hashedKeys() {
        return fs.readdirSync(this.cachePath);
    }

    /**
     * Gets the disk cache instance.
     * @returns {Promise<import('node-persist').LocalStorage>}
     */
    async instance() {
        if (this.#instance) {
            return this.#instance;
        }

        this.#instance = storage.create({
            dir: this.cachePath,
            ttl: false,
            forgiveParseErrors: true,
            expiredInterval: 0,
            // @ts-ignore
            maxFileDescriptors: 100,
        });
        await this.#instance.init();
        return this.#instance;
    }

    /**
     * Removes one entry, by its already-computed cache key (see getCacheKey()).
     * @param {string} cacheKey
     */
    async invalidateKey(cacheKey) {
        if (!useDiskCache) return;
        try {
            const cache = await this.instance();
            await cache.removeItem(cacheKey);
        } catch (error) {
            console.error(`Error invalidating disk cache entry for key ${cacheKey}:`, error);
        }
    }

    /**
     * Full-corpus reconciliation, pruning entries invalidateKey() never caught. Expensive (~24 min on 330k+ files) - manual/rare use only.
     * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
     */
    async verify(directoriesList) {
        try {
            if (!useDiskCache) {
                return;
            }

            const cache = await this.instance();
            const validKeys = new Set();
            for (const dir of directoriesList) {
                if (!fs.existsSync(dir.characters)) continue;
                const files = await fs.promises.readdir(dir.characters, { withFileTypes: true });
                for (const file of files.filter(f => f.isFile() && path.extname(f.name) === '.png')) {
                    const filePath = path.join(dir.characters, file.name);
                    try {
                        const stat = await fs.promises.stat(filePath);
                        const cacheKey = `${filePath}-${stat.mtimeMs}`;
                        validKeys.add(path.parse(cache.getDatumPath(cacheKey)).base);
                    } catch (err) {
                        if (err.code !== 'ENOENT') throw err;
                    }
                }
            }
            const cachedKeys = await fs.promises.readdir(this.cachePath).catch(() => []);
            for (const key of cachedKeys) {
                if (!validKeys.has(key)) {
                    await cache.removeItem(key);
                }
            }
        } catch (error) {
            console.error('Error while verifying disk cache:', error);
        }
    }

    dispose() {
    }
}

export const diskCache = new DiskCache();

/**
 * Gets the cache key for the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {fs.Stats} [precomputedStat] Already-fetched stat for `inputFile`, to avoid statting it twice.
 * @returns {string} - Cache key
 */
function getCacheKey(inputFile, precomputedStat = undefined) {
    try {
        const stat = precomputedStat ?? fs.statSync(inputFile);
        return `${inputFile}-${stat.mtimeMs}`;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return inputFile;
        }
        throw err;
    }
}

/**
 * Reads the character card from the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {string} inputFormat - 'png'
 * @param {fs.Stats} [precomputedStat] See getCacheKey()'s doc comment.
 * @returns {Promise<string | undefined>} - Character card data
 */
export async function readCharacterData(inputFile, inputFormat = 'png', precomputedStat = undefined) {
    const cacheKey = getCacheKey(inputFile, precomputedStat);
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            const cachedData = await cache.getItem(cacheKey);
            if (cachedData) {
                return cachedData;
            }
        } catch (error) {
            console.warn('Error while reading from disk cache:', error);
        }
    }

    const result = await parse(inputFile, inputFormat);
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            await cache.setItem(cacheKey, result);
        } catch (error) {
            console.warn('Error while writing to disk cache:', error);
        }
    }
    return result;
}

/**
 * A character's card as stored, as JSON (use readCharacterData() for a file not yet in the library).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar Avatar filename, e.g. `Alice.png`
 * @returns {Promise<string|undefined>} undefined when there is no such character.
 */
export async function readCardContent(directories, avatar) {
    const [card] = await (await userStore(directories)).lib.cards([avatar]);
    return card === null || card === undefined ? undefined : JSON.stringify(withV2FieldsOnTop(card));
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
export async function readExtraBooks(directories, avatar) {
    return (await userStore(directories)).lib.extraBookNames(avatar);
}

/**
 * @param {any} card
 * @returns {any}
 */
function withV2FieldsOnTop(card) {
    if (card.spec === undefined || _.isUndefined(card.data)) return card;
    _.forEach(V1_V2_FIELD_MAPPINGS, (v2Path, charField) => {
        const v2Value = _.get(card.data, v2Path);
        if (!_.isUndefined(v2Value)) card[charField] = v2Value;
    });
    return card;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<{ buffer: Buffer, cardJson: string }|null>}
 */
export async function materializeCardPng(directories, avatar) {
    const { lib } = await userStore(directories);
    const file = await avatarPathOf(lib, directories, avatar);
    const cardJson = await readCardContent(directories, avatar);
    if (file === null || cardJson === undefined) return null;
    return { buffer: write(await fsPromises.readFile(file), cardJson), cardJson };
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {string} data
 * @param {Set<string>|null} freshFieldPaths
 * @returns {Promise<string>}
 */
async function keepStoredGreetings(directories, avatar, data, freshFieldPaths) {
    try {
        const incomingCard = JSON.parse(data);
        const incomingGreetings = incomingCard?.data?.alternate_greetings;
        const greetingsVerifiedFresh = freshFieldPaths instanceof Set && freshFieldPaths.has('data.alternate_greetings');
        if (!greetingsVerifiedFresh && Array.isArray(incomingGreetings) && incomingGreetings.length === 0) {
            const existingRaw = await readCardContent(directories, avatar);
            const existingGreetings = existingRaw === undefined ? undefined : JSON.parse(existingRaw)?.data?.alternate_greetings;
            if (Array.isArray(existingGreetings) && existingGreetings.length > 0) {
                console.warn(`[writeCharacter] Refusing to overwrite non-empty alternate_greetings with an empty array for "${avatar}" - kept ${existingGreetings.length} existing greeting(s) (no verified-fresh signal was passed for this write).`);
                incomingCard.data.alternate_greetings = existingGreetings;
                return JSON.stringify(incomingCard);
            }
        }
    } catch {
        // Can't compare - don't block the write on the guard itself.
    }
    return data;
}

/**
 * @param {import('express').Request} request
 * @param {string} avatar
 * @param {string} data
 * @param {object} [o]
 * @param {string|Buffer} [o.image]
 * @param {Crop} [o.crop]
 * @param {string|null} [o.contentHash]
 * @param {Set<string>|null} [o.freshFieldPaths]
 * @param {boolean} [o.fav]
 * @param {number} [o.dateAdded]
 * @param {{ from: string, pastChats: boolean }} [o.renamed]
 * @returns {Promise<void>}
 * @throws {ImageReadError}
 */
async function writeCharacter(request, avatar, data, { image, crop, contentHash = null, freshFieldPaths = null, fav, dateAdded, renamed } = {}) {
    const directories = request.user.directories;
    const { lib } = await userStore(directories);
    const card = await keepStoredGreetings(directories, avatar, data, freshFieldPaths);
    const options = { contentHash, ...(fav === undefined ? {} : { fav }), ...(dateAdded === undefined ? {} : { dateAdded }), ...(renamed === undefined ? {} : { renamed }) };
    if (image === undefined) {
        await lib.writeCard(directories, avatar, cardWithCrop(card, cropOf(await lib.entity(TYPE.character, avatar))), options);
        return;
    }
    const withCrop = cardWithCrop(card, crop);
    let bytes;
    /** @type {Array<{ name: string, data: Uint8Array }>} */
    let chunks;
    try {
        bytes = await cardImage(Buffer.isBuffer(image) ? image : await fs.promises.readFile(image));
        chunks = extractPngChunks(new Uint8Array(bytes));
    } catch (error) {
        throw new ImageReadError(imageDisplayName(image, request), error);
    }
    if (typeof image === 'string' && await isPngFile(image)) {
        const hashes = { avatarIdentityHash: computeAvatarIdentityHashFromChunks(chunks), animatedHash: computeAnimatedHashFromChunks(chunks) };
        await linkWithAvatar(lib, directories, avatar, image, () => lib.writeCard(directories, avatar, withCrop, { ...options, ...hashes }));
        return;
    }
    const stored = avatarImage(bytes);
    await writeWithAvatar(lib, directories, avatar, stored, () => lib.writeCard(directories, avatar, withCrop, {
        ...options, avatarIdentityHash: stored.avatarIdentityHash, animatedHash: stored.animatedHash,
    }));
}

/**
 * @typedef {Object} Crop
 * @property {number} x X-coordinate
 * @property {number} y Y-coordinate
 * @property {number} width Width
 * @property {number} height Height
 */

/**
 * @param {string} card
 * @param {unknown} crop
 * @returns {string}
 */
function cardWithCrop(card, crop) {
    const parsed = JSON.parse(card);
    parsed.data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    parsed.data.extensions = parsed.data.extensions && typeof parsed.data.extensions === 'object' ? parsed.data.extensions : {};
    const rect = normalizeCrop(crop);
    if (rect) parsed.data.extensions.avatar_crop = rect;
    else delete parsed.data.extensions.avatar_crop;
    return JSON.stringify(parsed);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
async function cardImage(buffer) {
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;
    const frames = await decodeFrames(buffer);
    if (frames) return encodeApng(frames);
    const image = await Jimp.fromBuffer(buffer);
    return Buffer.from(await image.getBuffer(JimpMime.png));
}

/**
 * @param {string} file
 * @returns {Promise<boolean>} Whether the file itself is a PNG (not an image read into one).
 */
async function isPngFile(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const head = Buffer.alloc(PNG_SIGNATURE.length);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        return bytesRead === head.length && head.equals(PNG_SIGNATURE);
    } finally {
        await handle.close();
    }
}

/**
 * An uploaded or given image that can't be read. Nothing is written when it's thrown; routes answer 400 with its
 * message, which names the file.
 */
class ImageReadError extends Error {
    /**
     * @param {string} name
     * @param {unknown} cause
     */
    constructor(name, cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        super(`couldn't read ${name} as an image: ${reason}`);
        this.name = 'ImageReadError';
        this.cause = cause;
    }
}

/**
 * The name a user would recognise for an image passed to writeCharacterData(): the upload's original file name when
 * it's the request's upload, else the file's own name.
 * @param {string|Buffer} inputFile
 * @param {import('express').Request} request
 * @returns {string}
 */
function imageDisplayName(inputFile, request) {
    if (Buffer.isBuffer(inputFile)) {
        return 'the card\'s image';
    }
    const file = request?.file;
    if (file && path.resolve(path.join(file.destination, file.filename)) === path.resolve(inputFile)) {
        return file.originalname || path.basename(inputFile);
    }
    return path.basename(inputFile);
}

/**
 * Answers a failed character write: 400 with the reason for an image that couldn't be read, else 500.
 * @param {import('express').Response} response
 * @param {unknown} err
 */
function sendWriteFailure(response, err) {
    if (err instanceof ImageReadError) {
        return response.status(400).send(err.message);
    }
    return response.sendStatus(500);
}


/**
 * @param {import('express').Request} request
 * @param {string[]} avatars
 * @param {{ shallow: boolean }} o
 * @returns {Promise<(Record<string, any> | null)[]>}
 */
export async function characterObjects(request, avatars, { shallow }) {
    const store = await requestStore(request);
    const { lib } = store;
    const entities = await lib.entities(await lib.ids(TYPE.character, avatars));
    const present = /** @type {import('../library-engine.js').StoredEntity[]} */ (entities.filter(e => e !== null));
    const tagKeys = new Map((await lib.tagKeys(present)).map((k, i) => [present[i].id, k]));
    const stats = await lib.chatStats(present.map(e => e.id));
    const chats = await compatChatIds(store, request, present.map(e => e.id));
    return Promise.all(entities.map(async e => {
        if (!e) return null;
        const card = await lib.assembled(e);
        const json = JSON.stringify(card);
        const character = getCharaCardV2(JSON.parse(json), request.user.directories, false);
        character.avatar = e.key;
        assignThumbnails(character, thumbnailsOf(e, 'avatar'));
        character.avatar_ref = avatarRefString(TYPE.character, e.key);
        character.json_data = json;
        character.date_added = e.added;
        character.create_date = character.create_date || new Date(e.added).toISOString();
        character.chat_size = stats.get(e.id)?.chat_size ?? 0;
        character.date_last_chat = stats.get(e.id)?.date_last_chat ?? 0;
        character.data_size = e.dataSize ?? calculateDataSize(character.data);
        character.fav = e.fav;
        _.set(character, 'data.extensions.fav', e.fav);
        character.chat = chats.get(e.id);
        character.tag_ids = tagKeys.get(e.id) ?? [];
        const allow = e.values.find(v => v.field === FIELD.allow_global_styles);
        if (allow?.json !== undefined) character.allow_global_styles = !!JSON.parse(allow.json);
        return shallow ? toShallow(character) : character;
    }));
}

/**
 * Import a character from a YAML file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response, contentHash?: string|null }} context Express request/response objects plus the uploaded file's content hash (bulk-import dedup)
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromYaml(uploadPath, context, preservedFileName) {
    const fileText = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);
    const yamlData = yaml.parse(fileText);
    yamlData.name = sanitize(yamlData.name);
    const fileName = preservedFileName || await mintCharacterId(context.request.user.directories);
    let char = convertToV2({
        'name': yamlData.name,
        'description': yamlData.context ?? '',
        'first_mes': yamlData.greeting ?? '',
        'create_date': new Date().toISOString(),
        'personality': '',
        'creatorcomment': '',
        'avatar': 'none',
        'mes_example': '',
        'scenario': '',
        'talkativeness': 0.5,
        'creator': '',
        'tags': '',
    }, context.request.user.directories);
    omitInstallLocalFields(char);
    await writeCharacter(context.request, `${fileName}.png`, JSON.stringify(char), { image: DEFAULT_AVATAR_PATH, contentHash: context.contentHash ?? null });
    return fileName;
}

/**
 * Imports a character card from CharX (ZIP) file.
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|null} [params.contentHash] sha256 hex digest of the uploaded .charx file's raw bytes (bulk-import dedup)
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromCharX(uploadPath, { request, contentHash }, preservedFileName) {
    const fileBuffer = fs.readFileSync(uploadPath);
    // Create a properly-sized ArrayBuffer (Node's buffer pool can cause oversized .buffer)
    const data = getArrayBufferSlice(fileBuffer);
    fs.unlinkSync(uploadPath);

    const parser = new CharXParser(data);
    const { card, avatar, auxiliaryAssets, extractedBuffers } = await parser.parse();

    // Apply standard character transformations
    if (card.data?.name) {
        card.data.name = sanitize(card.data.name);
    }
    card.name = sanitize(card.data?.name || card.name);
    let processedCard = readFromV2(card);
    omitInstallLocalFields(processedCard);
    processedCard.create_date = new Date().toISOString();

    const fileName = preservedFileName || await mintCharacterId(request.user.directories);
    // Use the actual character name for asset folders, not the unique filename
    // ST's sprite system looks up by character name, not PNG filename
    const characterFolder = processedCard.name;

    if (auxiliaryAssets.length > 0) {
        try {
            const { userImages } = persistCharXAssets(auxiliaryAssets, extractedBuffers, request.user.directories, characterFolder);
            const { lib } = await userStore(request.user.directories);
            for (const file of userImages) {
                await writeUserImage(lib, clientRelativePath(request.user.directories.root, file), await fs.promises.readFile(file));
            }
        } catch (error) {
            console.warn(`CharX: Failed to persist auxiliary assets for ${characterFolder}`, error);
        }
    }

    await writeCharacter(request, `${fileName}.png`, JSON.stringify(processedCard), { image: avatar, contentHash: contentHash ?? null });
    return fileName;
}

/**
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|null} [params.contentHash]
 * @param {string|undefined} preservedFileName
 * @returns {Promise<string>}
 */
async function importFromByaf(uploadPath, { request, contentHash }, preservedFileName) {
    const data = getArrayBufferSlice(await fsPromises.readFile(uploadPath));
    await fsPromises.unlink(uploadPath);

    const byafData = await new ByafParser(data).parse();
    const card = readFromV2(byafData.card);
    omitInstallLocalFields(card);
    const fileName = preservedFileName || await mintCharacterId(request.user.directories);

    await writeCharacter(request, `${fileName}.png`, JSON.stringify(card), { image: byafData.images[0].image, contentHash: contentHash ?? null });

    if (!preservedFileName) {
        // Upload backgrounds
        for (const bg of byafData.chatBackgrounds) {
            const extension = path.extname(bg.paths?.[0]) || '.png';
            const baseName = `${path.basename(fileName)}_bg`;
            const filePath = path.join(request.user.directories.userImages, fileName);
            if (!fs.existsSync(filePath)) fs.mkdirSync(filePath, { recursive: true });
            const file = getUniqueName(baseName, (name) => fs.existsSync(path.join(filePath, `${name}${extension}`)));
            if (Buffer.isBuffer(bg.data)) {
                const newFile = `${file}${extension}`;
                writeFileAtomicSync(path.join(filePath, newFile), bg.data);
                bg.name = clientRelativePath(request.user.directories.root, path.join(filePath, newFile)); // Update background name to the new file
            }
        }

        if (Array.isArray(byafData.scenarios) && byafData.scenarios.length > 0) {
            const store = await requestStore(request);
            const avatar = `${fileName}.png`;
            const [tree] = await store.people.trees([{ avatar }]);
            const treeSpeaker = (await store.people.byAvatar([avatar])).get(avatar) ?? null;
            const actor = (await requestSession(store.chats, request, /** @type {bigint} */ (tree))).actor();
            /** @type {string | null | undefined} */
            let firstChatEnd;
            for (const scenario of byafData.scenarios) {
                const chatName = sanitize(`${scenario.title || card.name} - ${humanizedDateTime()} imported`, { replacement: sanitizeSafeCharacterReplacements });
                const chatText = ByafParser.getChatFromScenario(scenario, request.body.user_name, card.name, byafData.chatBackgrounds);
                const [header, ...messages] = chatText.split('\n').map(line => tryParse(line)).filter(x => x);
                const saved = await store.chats.importChat({
                    tree: /** @type {bigint} */ (tree), treeSpeaker, name: chatName, messages, metadata: header?.chat_metadata, actor,
                });
                if (!saved.ok) throw new Error(`The chat "${chatName}" in the BYAF file could not be stored.`);
                if (firstChatEnd === undefined) firstChatEnd = saved.node_ids.length ? saved.node_ids[saved.node_ids.length - 1] : null;
            }
            if (firstChatEnd !== undefined) {
                await store.chats.rememberUserPosition({ tree: /** @type {bigint} */ (tree), at: firstChatEnd, user: actor.user });
            }
        }

        // Save alternate icons for the character.
        for (const icon of byafData.images.slice(1)) {
            // BYAF does not support character expressions, so using the same structure will not result in conflicts,
            // even if the expression system did not tolerate additional icons that are not mapped to expressions.
            // This will not yet allow changing icons within the UI but at least the icons will be available for manual selection, rather than being lost.
            const altImagesFolder = path.join(request.user.directories.characters, sanitize(card.name));
            if (!fs.existsSync(altImagesFolder)) fs.mkdirSync(altImagesFolder, { recursive: true });
            const extension = path.extname(icon.filename) || '.png';
            const file = getUniqueName(`${sanitize(icon.label, { replacement: sanitizeSafeCharacterReplacements }) || 'alt'}`, (name) => fs.existsSync(path.join(altImagesFolder, `${name}${extension}`)));
            if (Buffer.isBuffer(icon.image)) {
                writeFileAtomicSync(path.join(altImagesFolder, `${file}${extension}`), icon.image);
            }
        }
    }

    return fileName;
}

/**
 * Import a character from a JSON file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response, contentHash?: string|null }} context Express request/response objects plus the uploaded file's content hash (bulk-import dedup)
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromJson(uploadPath, { request, contentHash }, preservedFileName) {
    const rawText = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);

    const pngName = preservedFileName || await mintCharacterId(request.user.directories);
    const data = buildJsonImportData(rawText, request.user.directories, pngName);
    if (data === null) return '';

    await writeCharacter(request, `${pngName}.png`, data, { image: DEFAULT_AVATAR_PATH, contentHash: contentHash ?? null });
    return pngName;
}

/**
 * @param {string} rawText
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string | null} [avatarFileName]
 * @returns {string | null}
 */
export function buildJsonImportData(rawText, directories, avatarFileName = null) {
    let jsonData = JSON.parse(rawText);

    if (jsonData.spec !== undefined) {
        importRisuSprites(directories, jsonData, avatarFileName);
        importChubExpressions(directories, jsonData, avatarFileName);
        importChubRelatedLorebooks(directories, jsonData);
        const rawName = jsonData.data?.name || jsonData.name;
        if (jsonData.data?.name) {
            jsonData.data.name = sanitize(jsonData.data.name);
        }
        jsonData.name = sanitize(String(rawName || ''));
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        omitInstallLocalFields(jsonData);
        return JSON.stringify(jsonData);
    } else if (jsonData.name !== undefined) {
        jsonData.name = sanitize(jsonData.name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, directories);
        omitInstallLocalFields(char);
        return JSON.stringify(char);
    } else if (jsonData.char_name !== undefined) {
        //json Pygmalion notepad
        jsonData.char_name = sanitize(jsonData.char_name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        let char = {
            'name': jsonData.char_name,
            'description': jsonData.char_persona ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': '',
            'first_mes': jsonData.char_greeting ?? '',
            'avatar': 'none',
            'mes_example': jsonData.example_dialogue ?? '',
            'scenario': jsonData.world_scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, directories);
        omitInstallLocalFields(char);
        return JSON.stringify(char);
    }

    return null;
}

/**
 * Import a character from a PNG file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response, contentHash?: string|null }} context Express request/response objects plus the uploaded file's content hash (bulk-import dedup)
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromPng(uploadPath, { request, contentHash }, preservedFileName) {
    const imgData = await readCharacterData(uploadPath);
    if (imgData === undefined) throw new Error('Failed to read character data');

    const pngName = preservedFileName || await mintCharacterId(request.user.directories);
    const data = buildPngImportData(imgData, request.user.directories, pngName);
    if (data === null) return '';

    try {
        await writeCharacter(request, `${pngName}.png`, data, { image: uploadPath, contentHash: contentHash ?? null });
    } finally {
        fs.unlinkSync(uploadPath);
    }
    return pngName;
}

/**
 * @param {string} rawText
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string | null} [avatarFileName]
 * @returns {string | null}
 */
export function buildPngImportData(rawText, directories, avatarFileName = null) {
    let jsonData = JSON.parse(rawText);

    const rawName = jsonData.data?.name || jsonData.name;
    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(String(rawName || ''));

    if (jsonData.spec !== undefined) {
        importRisuSprites(directories, jsonData, avatarFileName);
        importChubExpressions(directories, jsonData, avatarFileName);
        importChubRelatedLorebooks(directories, jsonData);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        omitInstallLocalFields(jsonData);
        return JSON.stringify(jsonData);
    } else if (jsonData.name !== undefined) {
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }

        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, directories);
        omitInstallLocalFields(char);
        return JSON.stringify(char);
    }

    return null;
}

export const router = express.Router();

router.post('/create', getFileNameValidationFunction('file_name'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        request.body.ch_name = sanitize(request.body.ch_name);

        const initialFav = normalizeFav(request.body.fav);
        const charaData = charaFormatData(request.body, request.user.directories);
        const embeddedBook = _.get(tryParse(request.body.json_data), 'data.character_book');
        if (embeddedBook !== undefined) {
            _.set(charaData, 'data.character_book', embeddedBook);
        }
        charaData.create_date = new Date().toISOString();
        omitFavField(charaData);
        const char = JSON.stringify(charaData);
        const internalName = request.body.file_name || await mintCharacterId(request.user.directories);
        const avatarName = `${internalName}.png`;

        if (!request.file) {
            await writeCharacter(request, avatarName, char, { image: DEFAULT_AVATAR_PATH, fav: initialFav });
        } else {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            try {
                await writeCharacter(request, avatarName, char, { image: uploadPath, crop, fav: initialFav });
            } finally {
                fs.unlinkSync(uploadPath);
            }
        }
        const tagIds = [request.body.tag_ids ?? []].flat().filter(id => typeof id === 'string' && id !== '');
        if (tagIds.length > 0) {
            const { lib } = await requestStore(request);
            const unassigned = [];
            for (const tagId of tagIds) {
                const result = await lib.tags.assign(avatarName, tagId).catch((error) => {
                    console.error(`[characters/create] Assigning tag ${tagId} to ${avatarName} failed:`, error);
                    return null;
                });
                if (result?.result !== 'ok') unassigned.push(tagId);
            }
            if (unassigned.length > 0) response.setHeader('X-Unassigned-Tag-Ids', JSON.stringify(unassigned));
        }
        return response.send(avatarName);
    } catch (err) {
        console.error(err);
        sendWriteFailure(response, err);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const avatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);

    try {
        const rawData = await readCardContent(request.user.directories, avatarName);
        if (rawData === undefined) throw new Error('Failed to read character file');

        const data = getCharaCardV2(JSON.parse(rawData), request.user.directories);
        const oldName = data.data?.name ?? data.name;
        _.set(data, 'data.name', newName);
        _.set(data, 'name', newName);
        const renamed = typeof oldName === 'string' && oldName !== newName
            ? { from: oldName, pastChats: request.body.rename_past_chats === true }
            : undefined;
        await writeCharacter(request, avatarName, JSON.stringify(data), { renamed });

        if (request.body.rename_past_chats === true) {
            return response.send({ avatar: avatarName, past_chats_renamed: 0 });
        }
        return response.send({ avatar: avatarName });
    } catch (err) {
        console.error(err);
        return response.sendStatus(500);
    }
});

router.post('/edit', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) {
        console.warn('Error: no response body detected');
        response.status(400).send('Error: no response body detected');
        return;
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        response.status(400).send('Error: invalid name.');
        return;
    }

    const contentHashesHeader = request.headers['x-content-hashes'];
    let freshFieldPaths = null;
    if (contentHashesHeader) {
        try {
            const clientHashes = JSON.parse(contentHashesHeader);
            const currentCardJson = await readCardContent(request.user.directories, request.body.avatar_url);
            if (currentCardJson) {
                const currentCard = getCharaCardV2(JSON.parse(currentCardJson), request.user.directories, false);
                const conflicts = [];
                if (clientHashes.fields !== undefined &&
                    clientHashes.fields !== characterDigestFieldsHash(currentCard)) {
                    conflicts.push('fields');
                }
                if (clientHashes.body !== undefined &&
                    clientHashes.body !== characterDigestCardBodyHash(currentCard)) {
                    conflicts.push('body');
                }
                if (conflicts.length > 0) {
                    return response.status(409).json({ error: 'conflict', conflicts });
                }
                if (clientHashes.body !== undefined) {
                    freshFieldPaths = new Set(['data.alternate_greetings']);
                }
            }
        } catch (err) {
            console.warn('[characters/edit] Failed to parse content hashes header, skipping conflict check:', err);
        }
    }

    let char = charaFormatData(request.body, request.user.directories);
    const requestedChat = request.body.chat;
    char.create_date = request.body.create_date;
    omitFavField(char);
    omitChatField(char);
    char = JSON.stringify(char);
    const avatar = request.body.avatar_url;

    try {
        if (!request.file) {
            await writeCharacter(request, avatar, char, { freshFieldPaths });
        } else {
            const crop = tryParse(request.query.crop);
            const newAvatarPath = path.join(request.file.destination, request.file.filename);
            try {
                await writeCharacter(request, avatar, char, { image: newAvatarPath, crop, freshFieldPaths });
            } finally {
                fs.unlinkSync(newAvatarPath);
            }

            // Bust cache to reload the new avatar
            cacheBuster.bust(request, response);
        }

        if (typeof requestedChat === 'string' && requestedChat !== '') {
            await moveToChatNamed(request, response, { avatar }, requestedChat);
        }

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return sendWriteFailure(response, err);
    }
});

router.post('/edit-avatar', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.file) {
            return response.status(400).send('Error: no file uploaded');
        }

        if (!request.body || !request.body.avatar_url) {
            return response.status(400).send('Error: no avatar_url in request body');
        }

        const uploadPath = path.join(request.file.destination, request.file.filename);
        if (!fs.existsSync(uploadPath)) {
            return response.status(400).send('Error: uploaded file does not exist');
        }
        const data = await readCardContent(request.user.directories, request.body.avatar_url);
        if (data === undefined) {
            fs.unlinkSync(uploadPath);
            return response.status(400).send('Error: character does not exist');
        }

        const crop = tryParse(request.query.crop);
        try {
            await writeCharacter(request, request.body.avatar_url, data, { image: uploadPath, crop });
        } finally {
            fs.unlinkSync(uploadPath);
        }

        // Reset images caches
        cacheBuster.bust(request, response);

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred while editing avatar', err);
        return sendWriteFailure(response, err);
    }
});

/**
 * Handle a POST request to edit a character attribute.
 *
 * This function reads the character data from a file, updates the specified attribute,
 * and writes the updated data back to the file.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 * @returns {void}
 */
router.post('/edit-attribute', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) {
        console.warn('Error: no response body detected');
        return response.status(400).send('Error: no response body detected');
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        return response.status(400).send('Error: invalid name.');
    }

    if (request.body.field === 'json_data') {
        console.warn('Error: cannot edit json_data field.');
        return response.status(400).send('Error: cannot edit json_data field.');
    }

    try {
        const charJSON = await readCardContent(request.user.directories, request.body.avatar_url);
        if (typeof charJSON !== 'string') throw new Error('Failed to read character file');

        const char = JSON.parse(charJSON);
        //check if the field exists
        if (char[request.body.field] === undefined && char.data[request.body.field] === undefined) {
            console.warn('Error: invalid field.');
            response.status(400).send('Error: invalid field.');
            return;
        }
        char[request.body.field] = request.body.value;
        char.data[request.body.field] = request.body.value;
        await writeCharacter(request, request.body.avatar_url, JSON.stringify(char));
        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return sendWriteFailure(response, err);
    }
});

const UNSET_SENTINEL = '__@@UNSET@@__';

/** Maximum number of characters processed in parallel during bulk merge */
const BULK_MERGE_CONCURRENCY = 10;

/**
 * Removes any key from `target` whose value in `source` is {@link UNSET_SENTINEL}. Called after {@link deepMerge}.
 * @param {object} target The merged character object to clean up
 * @param {object} source The original update payload (pre-merge clone)
 */
function processUnsetSentinels(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] === UNSET_SENTINEL) {
            _.unset(target, key);
        } else if (_.isPlainObject(source[key]) && _.isPlainObject(target[key])) {
            processUnsetSentinels(target[key], source[key]);
        }
    }
}

/**
 * @param {string} avatar     Avatar filename (e.g. "char.png")
 * @param {object} updateData The merge payload to apply
 * @param {import("express").Request} request Express request object
 * @param {((data: any) => boolean) | null} [shouldSkip] Used for bulk merge filtering.
 * @param {{ destination: string, filename: string } | null} [avatarUpload] A new image, uploaded.
 * @param {import("express").Response | null} [response] Told of the tab's session when `chat` moves it.
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean, hashes?: Object<string, number>}>}
 */
async function mergeCharacterUpdate(avatar, updateData, request, shouldSkip = null, avatarUpload = null, response = null) {
    const pngStringData = await readCardContent(request.user.directories, avatar);
    if (!pngStringData) {
        return { ok: false, error: 'Invalid character file' };
    }

    let character = JSON.parse(pngStringData);

    if (typeof shouldSkip === 'function' && shouldSkip(character)) {
        return { ok: false, skipped: true };
    }

    const update = _.cloneDeep(updateData);
    _.unset(update, 'json_data');
    _.unset(character, 'json_data');

    const forbiddenGreetingPaths = ['data.alternate_greetings', 'data.first_mes', 'alternate_greetings', 'first_mes'];
    const touchedGreetingPaths = forbiddenGreetingPaths.filter(p => _.has(update, p));
    if (touchedGreetingPaths.length > 0) {
        return { ok: false, error: 'greeting-fields-forbidden', touchedGreetingPaths };
    }

    const loadedFieldHashes = update._loadedFieldHashes;
    delete update._loadedFieldHashes;
    let freshFieldPaths = null;
    if (loadedFieldHashes && typeof loadedFieldHashes === 'object') {
        const conflictingFields = [];
        for (const [v2Path, loadedHash] of Object.entries(loadedFieldHashes)) {
            const currentValue = _.get(character, v2Path);
            const currentHash = getStringHash(JSON.stringify(currentValue !== undefined ? currentValue : null));
            if (currentHash !== loadedHash) {
                conflictingFields.push(v2Path);
            }
        }
        if (conflictingFields.length > 0) {
            return { ok: false, error: 'conflict', conflictingFields };
        }
        if (Object.prototype.hasOwnProperty.call(loadedFieldHashes, 'data.alternate_greetings')) {
            freshFieldPaths = new Set(['data.alternate_greetings']);
        }
    }

    const favRequested = _.has(update, 'fav') || _.has(update, 'data.extensions.fav');
    const chatRequested = _.has(update, 'chat');

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);
    const requestedFav = normalizeFav(character.fav ?? _.get(character, 'data.extensions.fav'));
    const requestedChat = character.chat;
    omitFavField(character);
    omitChatField(character);

    const validator = new TavernCardValidator(character);
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const image = avatarUpload ? path.join(avatarUpload.destination, avatarUpload.filename) : undefined;
    const crop = avatarUpload ? tryParse(request.query.crop) : undefined;
    await writeCharacter(request, avatar, JSON.stringify(character), { image, crop, freshFieldPaths });
    if (favRequested) {
        await (await requestStore(request)).lib.setFav(TYPE.character, avatar, requestedFav);
    }
    if (chatRequested && response && typeof requestedChat === 'string' && requestedChat !== '') {
        await moveToChatNamed(request, response, { avatar }, requestedChat);
    }

    let hashes;
    if (loadedFieldHashes && typeof loadedFieldHashes === 'object') {
        hashes = {};
        for (const v2Path of Object.keys(loadedFieldHashes)) {
            const currentValue = _.get(character, v2Path);
            hashes[v2Path] = getStringHash(JSON.stringify(currentValue !== undefined ? currentValue : null));
        }
    }

    return { ok: true, hashes };
}

/**
 * Single mode (`avatar` string) merges one character; bulk mode (`avatars` array) merges many in parallel, optionally filtered.
 * @param {import("express").Request} request - The HTTP request object
 * @param {import("express").Response} response - The HTTP response object
 * @returns {void}
 */
router.post('/merge-attributes', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        if (request.file && typeof request.body.payload === 'string') {
            let parsedBody;
            try {
                parsedBody = JSON.parse(request.body.payload);
            } catch {
                return response.status(400).send({ message: 'Invalid payload JSON' });
            }
            if (typeof parsedBody.avatar !== 'string' || forbiddenRegExp.test(parsedBody.avatar)) {
                return response.status(400).send({ message: 'Invalid avatar filename' });
            }
            request.body = parsedBody;
        }

        // ── Bulk mode: avatars array is present ──────────────────
        if (Array.isArray(request.body.avatars)) {
            const { avatars, data, filter } = request.body;

            if (!_.isPlainObject(data)) {
                return response.status(400).send({ message: 'No valid update data provided.' });
            }

            let targetAvatars;
            if (avatars.length > 0) {
                for (const avatar of avatars) {
                    if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar) || path.extname(avatar).toLowerCase() !== '.png') {
                        return response.status(400).send({ message: `Invalid avatar filename: ${avatar}` });
                    }
                }
                targetAvatars = avatars;
            } else {
                targetAvatars = everyCharacter(request);
            }

            const updated = [];
            const skipped = [];
            const failed = [];

            const processOne = async (avatar) => {
                try {
                    /** @type {(character: object) => boolean} */
                    let shouldSkip = () => false;

                    if (filter && typeof filter.path === 'string' && 'equals' in filter) {
                        shouldSkip = (character) => _.get(character, filter.path) !== filter.equals;
                    } else if (filter && typeof filter.path === 'string') {
                        shouldSkip = (character) => {
                            const value = _.get(character, filter.path);
                            return value === undefined;
                        };
                    }

                    const result = await mergeCharacterUpdate(avatar, data, request, shouldSkip);
                    if (result.ok) {
                        updated.push(avatar);
                    } else if (result.skipped) {
                        skipped.push(avatar);
                    } else {
                        console.warn(`Bulk merge failed for ${avatar}:`, result.error);
                        failed.push(avatar);
                    }
                } catch (error) {
                    console.error(`Bulk merge failed for ${avatar}:`, error);
                    failed.push(avatar);
                }
            };

            let batch = [];
            for await (const avatar of targetAvatars) {
                batch.push(avatar);
                if (batch.length < BULK_MERGE_CONCURRENCY) continue;
                await Promise.allSettled(batch.map(processOne));
                batch = [];
            }
            await Promise.allSettled(batch.map(processOne));

            return response.send({ updated, skipped, failed });
        }

        // ── Single mode (default behavior) ───────────────────────
        const update = request.body;

        let result;
        if (request.file) {
            const uploadPath = path.join(request.file.destination, request.file.filename);
            try {
                result = await mergeCharacterUpdate(update.avatar, update, request, null, request.file, response);
                if (result.ok) cacheBuster.bust(request, response);
            } finally {
                if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
            }
        } else {
            result = await mergeCharacterUpdate(update.avatar, update, request, null, null, response);
        }

        if (result.ok) {
            if (result.hashes) {
                response.status(200).json({ hashes: result.hashes });
            } else {
                response.sendStatus(200);
            }
        } else if (result.error === 'conflict' && result.conflictingFields) {
            response.status(409).json({ error: 'conflict', conflictingFields: result.conflictingFields });
        } else if (result.error === 'greeting-fields-forbidden') {
            response.status(400).json({
                error: 'greeting-fields-forbidden',
                touchedGreetingPaths: result.touchedGreetingPaths,
                message: 'first_mes and alternate_greetings can no longer be written through /merge-attributes - use the /greetings/* operations instead.',
            });
        } else {
            console.warn(result.error);
            response.status(400).send({ message: `Validation failed for ${update.avatar}`, error: result.error });
        }
    } catch (exception) {
        response.status(500).send({ message: 'Unexpected error while saving character.', error: exception.toString() });
    }
});


/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {(model: import('../greeting-list.js').GreetingsModel) => {ok: boolean, reason?: string, model?: import('../greeting-list.js').GreetingsModel, position?: number, sourcePosition?: number, targetPosition?: number}} op
 * @returns {Promise<{ok: boolean, reason?: string, status?: number, greetings?: string[], hashes?: number[], defaultPosition?: number|null, position?: number, sourcePosition?: number, targetPosition?: number}>}
 */
export function applyGreetingOperation(directories, avatar, op) {
    const key = `${directories.root}\u0000${avatar}`;
    const run = (greetingOperationQueues.get(key) ?? Promise.resolve()).then(() => runGreetingOperation(directories, avatar, op));
    const tail = run.then(() => {}, () => {});
    greetingOperationQueues.set(key, tail);
    void tail.then(() => {
        if (greetingOperationQueues.get(key) === tail) greetingOperationQueues.delete(key);
    });
    return run;
}

/** @type {Map<string, Promise<void>>} */
const greetingOperationQueues = new Map();

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {Parameters<typeof applyGreetingOperation>[2]} op
 * @returns {ReturnType<typeof applyGreetingOperation>}
 */
async function runGreetingOperation(directories, avatar, op) {
    const pngStringData = await readCardContent(directories, avatar);
    if (!pngStringData) {
        return { ok: false, reason: 'character not found', status: 404 };
    }

    const character = JSON.parse(pngStringData);
    const model = cardToGreetingsModel(character);
    const result = op(model);
    if (!result.ok) {
        return { ok: false, reason: result.reason, status: 409 };
    }

    const unchanged = result.model.defaultIndex === model.defaultIndex
        && result.model.greetings.length === model.greetings.length
        && result.model.greetings.every((text, i) => text === model.greetings[i]);
    if (unchanged) {
        return {
            ok: true,
            greetings: model.greetings,
            hashes: model.greetings.map(hashGreetingText),
            defaultPosition: model.defaultIndex,
            position: result.position,
            sourcePosition: result.sourcePosition,
            targetPosition: result.targetPosition,
        };
    }

    applyGreetingsModelToCard(character, result.model);

    const validator = new TavernCardValidator(character);
    if (!validator.validate()) {
        return { ok: false, reason: validator.lastValidationError ?? 'validation failed', status: 500 };
    }

    await writeCharacter(/** @type {any} */ ({ user: { directories } }), avatar, JSON.stringify(character), { freshFieldPaths: new Set(['data.alternate_greetings']) });

    return {
        ok: true,
        greetings: result.model.greetings,
        hashes: result.model.greetings.map(hashGreetingText),
        defaultPosition: result.model.defaultIndex,
        position: result.position,
        sourcePosition: result.sourcePosition,
        targetPosition: result.targetPosition,
    };
}

/**
 * On success, echoes back the post-op greeting list, its hash-per-position list and the default position, so a caller can
 * show the list as stored (other sessions' changes included) and chain further operations without re-fetching the card,
 * and the positions the op acted on: `position` for edit, delete, set-default and an appending add, `source_position` and
 * `target_position` for move.
 * @param {import('express').Response} response
 * @param {Awaited<ReturnType<typeof applyGreetingOperation>>} result
 */
function sendGreetingOpResult(response, result) {
    if (!result.ok) {
        return response.status(result.status ?? 409).send({ ok: false, reason: result.reason });
    }
    const body = { ok: true, greetings: result.greetings, hashes: result.hashes, default_position: result.defaultPosition };
    if (result.position !== undefined) body.position = result.position;
    if (result.sourcePosition !== undefined) body.source_position = result.sourcePosition;
    if (result.targetPosition !== undefined) body.target_position = result.targetPosition;
    return response.status(200).send(body);
}

router.post('/greetings/add', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const text = request.body.text;
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (typeof text !== 'string') return response.status(400).send({ ok: false, reason: 'text is required' });
        if (text === '') return response.status(400).send({ ok: false, reason: 'refused to add empty greeting text' });
        if (request.body.append === true) {
            if (request.body.position !== undefined || request.body.expected_length !== undefined) {
                return response.status(400).send({ ok: false, reason: 'append takes no position or expected_length' });
            }
            const appended = await applyGreetingOperation(request.user.directories, avatar, model => opAppend(model, text));
            return sendGreetingOpResult(response, appended);
        }
        const position = Number(request.body.position);
        const expectedLength = Number(request.body.expected_length);
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isInteger(expectedLength)) return response.status(400).send({ ok: false, reason: 'expected_length is required' });

        const result = await applyGreetingOperation(request.user.directories, avatar, model => opAdd(model, position, expectedLength, text));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error adding greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

router.post('/greetings/edit', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const expectedHash = Number(request.body.expected_hash);
        const text = request.body.text;
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (typeof text !== 'string') return response.status(400).send({ ok: false, reason: 'text is required' });
        if (text === '') return response.status(400).send({ ok: false, reason: 'refused to blank stored greeting text' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request.user.directories, avatar, model => opEdit(model, position, expectedHash, text));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error editing greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

router.post('/greetings/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const expectedHash = Number(request.body.expected_hash);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request.user.directories, avatar, model => opDelete(model, position, expectedHash));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error deleting greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

router.post('/greetings/move', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const sourcePosition = Number(request.body.source_position);
        const expectedHash = Number(request.body.expected_hash);
        const side = request.body.side;
        const targetPosition = Number(request.body.target_position);
        const targetExpectedHash = Number(request.body.target_expected_hash);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (!Number.isInteger(sourcePosition)) return response.status(400).send({ ok: false, reason: 'source_position must be an integer' });
        if (!Number.isInteger(targetPosition)) return response.status(400).send({ ok: false, reason: 'target_position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });
        if (!Number.isFinite(targetExpectedHash)) return response.status(400).send({ ok: false, reason: 'target_expected_hash is required' });
        if (side !== 'before' && side !== 'after') return response.status(400).send({ ok: false, reason: 'side must be "before" or "after"' });
        if (targetPosition === sourcePosition) return response.status(400).send({ ok: false, reason: 'target_position must differ from source_position' });

        const result = await applyGreetingOperation(request.user.directories, avatar, model => opMove(model, sourcePosition, expectedHash, side, targetPosition, targetExpectedHash));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error moving greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

router.post('/greetings/default/set', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const expectedHash = Number(request.body.expected_hash);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request.user.directories, avatar, model => opSetDefault(model, position, expectedHash));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error setting default greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

router.post('/greetings/default/unset', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (request.body.expected_default_hash !== undefined) {
            if (request.body.expected_default_position !== undefined) {
                return response.status(400).send({ ok: false, reason: 'expected_default_hash and expected_default_position can\'t both be given' });
            }
            const expectedDefaultHash = Number(request.body.expected_default_hash);
            if (!Number.isFinite(expectedDefaultHash)) {
                return response.status(400).send({ ok: false, reason: 'expected_default_hash must be a number' });
            }
            const byHash = await applyGreetingOperation(request.user.directories, avatar, model => opUnsetDefaultByHash(model, expectedDefaultHash));
            return sendGreetingOpResult(response, byHash);
        }
        const rawExpectedDefault = request.body.expected_default_position;
        const expectedDefaultPosition = rawExpectedDefault === null ? null : Number(rawExpectedDefault);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (expectedDefaultPosition !== null && !Number.isInteger(expectedDefaultPosition)) {
            return response.status(400).send({ ok: false, reason: 'expected_default_position is required (an integer, or null)' });
        }

        const result = await applyGreetingOperation(request.user.directories, avatar, model => opUnsetDefault(model, expectedDefaultPosition));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error unsetting default greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/**
 * Every character's avatar, in name order, read a page at a time.
 * @param {import('express').Request} request
 * @returns {AsyncGenerator<string, void, undefined>}
 */
async function* everyCharacter(request) {
    const { lib } = await requestStore(request);
    /** @type {string | undefined} */
    let cursor;
    for (;;) {
        const page = await lib.query({ sortField: 'name', limit: EVERY_PAGE, cursor, wantRows: false, wantTotal: false, wantHashes: true, includeGroups: false });
        const rows = /** @type {{ id: string }[]} */ (page.hashRows);
        for (const row of rows) yield row.id;
        if (typeof page.cursor !== 'string' || rows.length === 0) return;
        cursor = page.cursor;
    }
}

const EVERY_PAGE = 500;

router.post('/fav', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        const { avatar, fav, bulk, toggle } = request.body ?? {};
        const { lib } = await requestStore(request);
        const flip = async (/** @type {string} */ key) => {
            const e = await lib.entity(TYPE.character, key);
            if (!e) return null;
            await lib.setFav(TYPE.character, key, !e.fav);
            return !e.fav;
        };

        if (Array.isArray(bulk)) {
            const results = [];
            for (const entry of bulk) {
                if (typeof entry?.avatar !== 'string' || !entry.avatar) {
                    results.push({ avatar: entry?.avatar, ok: false });
                    continue;
                }
                if (entry.toggle === true) {
                    const next = await flip(entry.avatar);
                    results.push(next === null ? { avatar: entry.avatar, ok: false } : { avatar: entry.avatar, ok: true, fav: next });
                    continue;
                }
                const updated = await lib.setFav(TYPE.character, entry.avatar, normalizeFav(entry.fav));
                results.push({ avatar: entry.avatar, ok: updated !== null });
            }
            return response.send({ results });
        }

        if (typeof avatar !== 'string' || !avatar) {
            return response.status(400).send({ error: true, reason: 'avatar-required' });
        }
        if (toggle === true) {
            const next = await flip(avatar);
            if (next === null) {
                return response.status(404).send({ error: true, reason: 'not-tracked' });
            }
            return response.send({ fav: next });
        }
        const updated = await lib.setFav(TYPE.character, avatar, normalizeFav(fav));
        if (updated === null) {
            return response.status(404).send({ error: true, reason: 'not-tracked' });
        }
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/fav] Failed to update favorite status:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/chat', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        const { avatar, chat } = request.body ?? {};
        if (typeof avatar !== 'string' || !avatar) {
            return response.status(400).send({ error: true, reason: 'avatar-required' });
        }
        if (chat !== null && typeof chat !== 'string') {
            return response.status(400).send({ error: true, reason: 'chat-required' });
        }
        const opened = await moveToChatNamed(request, response, { avatar }, chat);
        if (!opened) return response.status(404).send({ error: true, reason: 'not-tracked' });
        return response.send({ chat: await compatChatIdOf(opened) });
    } catch (err) {
        console.error('[characters/chat] Failed to move to the chat:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/allow-global-styles', async function (request, response) {
    try {
        const { avatar, allowed, bulk } = request.body ?? {};
        const { lib } = await requestStore(request);

        if (Array.isArray(bulk)) {
            for (const entry of bulk) {
                if (typeof entry.avatar === 'string' && entry.avatar) {
                    await lib.setAllowGlobalStyles(entry.avatar, entry.allowed === true || entry.allowed === 'true');
                }
            }
            return response.sendStatus(204);
        }

        if (typeof avatar !== 'string' || !avatar) {
            return response.status(400).send({ error: true, reason: 'avatar-required' });
        }
        const updated = await lib.setAllowGlobalStyles(avatar, allowed === true || allowed === 'true');
        if (!updated) {
            return response.status(404).send({ error: true, reason: 'not-tracked' });
        }
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/allow-global-styles] Failed to update:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * @param {import('express').Request} request
 * @param {string} avatarUrl
 * @param {boolean} deleteChats
 * @returns {Promise<{ok: true, chats: string[]}|{ok: false, status: number}>}
 */
async function deleteOneCharacter(request, avatarUrl, deleteChats) {
    if (avatarUrl !== sanitize(avatarUrl)) {
        console.error('Malicious filename prevented');
        return { ok: false, status: 403 };
    }
    const store = await requestStore(request);
    const e = await store.lib.entity(TYPE.character, avatarUrl);
    if (!e) return { ok: false, status: 400 };

    const chats = deleteChats ? await chatNamesOf(store, e.id) : [];
    /** @type {any} */
    let dropped = null;
    try {
        if (deleteChats) {
            const session = await requestSession(store.chats, request, e.id);
            const deleted = await store.chats.deleteTree({ tree: e.id, actor: session.actor() });
            dropped = droppedOf(deleted);
            if (dropped) console.warn(`[characters/delete] Deleting ${avatarUrl} with its chats dropped:`, JSON.stringify(dropped));
        }
        await store.lib.deleteEntity(TYPE.character, avatarUrl, { keepChats: !deleteChats });
    } catch (err) {
        console.error('[characters/delete] Failed to delete the character:', err);
        return { ok: false, status: 500 };
    }
    await inAvatarLane(store.lib, avatarUrl, async () => fs.rmSync(avatarFile(request.user.directories, avatarUrl), { force: true }));
    return { ok: true, chats, dropped };
}

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (Array.isArray(request.body.avatar_urls)) {
        const avatarUrls = request.body.avatar_urls;
        const deleteChats = request.body.delete_chats == true;
        const results = [];
        for (const avatarUrl of avatarUrls) {
            if (typeof avatarUrl !== 'string' || !avatarUrl || forbiddenRegExp.test(avatarUrl)) {
                results.push({ avatar_url: avatarUrl, ok: false });
                continue;
            }
            const result = await deleteOneCharacter(request, avatarUrl, deleteChats);
            results.push(result.ok ? { avatar_url: avatarUrl, ok: true, chats: result.chats, ...(result.dropped ? { dropped: result.dropped } : {}) } : { avatar_url: avatarUrl, ok: false });
        }
        return response.send({ results });
    }

    if (!request.body.avatar_url) {
        return response.sendStatus(400);
    }

    const result = await deleteOneCharacter(request, request.body.avatar_url, request.body.delete_chats == true);
    if (!result.ok) {
        return response.sendStatus(result.status);
    }

    return result.dropped ? response.send({ dropped: result.dropped }) : response.sendStatus(200);
});

const DEFAULT_PAGE_LIMIT = 500;

router.post('/all', async function (request, response) {
    try {
        const { offset, limit, search, includeGroups, fav } = request.body ?? {};

        if (typeof search !== 'string' || search.trim() === '') {
            return response.status(400).send({ error: true, reason: 'search-required', message: 'The character list is read a page at a time through /api/characters/query; /all only searches.' });
        }

        const numericOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
        const numericLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Math.trunc(Number(limit)), MAX_QUERY_PAGE_SIZE) : DEFAULT_PAGE_LIMIT;
        const store = await requestStore(request);
        const page = await store.lib.query({
            search: String(search), sortField: 'search', offset: numericOffset, limit: numericLimit,
            includeGroups: includeGroups === true, ...(fav === true ? { fav: true } : {}),
            wantRows: false, wantHashes: true, wantTotal: true,
        });
        const rows = /** @type {{ id: string, isGroup: boolean }[]} */ (page.hashRows);
        const characters = await characterObjects(request, rows.filter(r => !r.isGroup).map(r => r.id), { shallow: useShallowCharacters });
        const byAvatar = new Map(characters.filter(Boolean).map(c => [(c).avatar, c]));
        const groups = new Map((await groupObjects(request, rows.filter(r => r.isGroup).map(r => r.id))).filter(Boolean).map(g => [(g).id, g]));
        const items = rows.map(r => (r.isGroup ? { type: 'group', item: groups.get(r.id) } : { type: 'character', item: byAvatar.get(r.id) })).filter(x => x.item);
        const total = Number(page.total ?? items.length);
        const payload = includeGroups ? { items, total } : { items: items.map(x => x.item), total };
        return response.send(payload);
    } catch (err) {
        console.error(err);
        const isRangeError = err instanceof RangeError;
        response.status(500).send({ overflow: isRangeError, error: true });
    }
});

const RESCAN_BATCH = 100;

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} avatars
 * @returns {Promise<{ imported: number, skipped: number, failed: string[] }>}
 */
async function importDropped(directories, avatars) {
    const { lib } = await userStore(directories);
    const request = /** @type {import('express').Request} */ (/** @type {unknown} */ ({ user: { directories } }));
    let imported = 0;
    let skipped = 0;
    /** @type {string[]} */
    const failed = [];
    const known = await lib.ids(TYPE.character, avatars);
    const fresh = avatars.filter((_, i) => known[i] === null);
    const converted = fresh.length ? await lib.store.meta(fresh.map(convertedFileKey)) : [];
    for (const [i, avatar] of fresh.entries()) {
        const file = path.join(directories.characters, avatar);
        try {
            if (converted[i] !== null) {
                const st = await fsPromises.stat(file);
                if (converted[i] === JSON.stringify([st.size, st.mtimeMs])) {
                    skipped++;
                    continue;
                }
            }
            const raw = await readCharacterData(file);
            const data = raw === undefined ? null : buildPngImportData(raw, directories, path.parse(avatar).name);
            if (data === null) {
                failed.push(avatar);
                continue;
            }
            const contentHash = await hashFileContents(file);
            await writeCharacter(request, avatar, data, { image: file, contentHash });
            imported++;
        } catch (err) {
            console.warn(`[characters/rescan] ${avatar} could not be imported:`, err);
            failed.push(avatar);
        }
    }
    return { imported, skipped, failed };
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 */
async function rescanCharacters(directories) {
    const dir = await fsPromises.opendir(directories.characters);
    const total = { imported: 0, skipped: 0, /** @type {string[]} */ failed: [] };
    let batch = [];
    const importBatch = async () => {
        const done = await importDropped(directories, batch);
        total.imported += done.imported;
        total.skipped += done.skipped;
        total.failed.push(...done.failed);
        batch = [];
        await new Promise(resolve => setTimeout(resolve, 10));
    };
    for await (const entry of dir) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png') continue;
        batch.push(entry.name);
        if (batch.length >= RESCAN_BATCH) await importBatch();
    }
    await importBatch();
    const { imported, skipped, failed } = total;
    console.info(`[characters/rescan] ${imported} imported, ${skipped} converted file(s) left as converted, ${failed.length} not importable${failed.length ? `: ${failed.join(', ')}` : ''}`);
    return total;
}

const DROP_QUIET_MS = 500;

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {number} [quietMs]
 * @returns {{ first: Promise<void>, idle: () => Promise<void>, close: () => Promise<void> }}
 */
export function watchDroppedCharacters(directories, quietMs = DROP_QUIET_MS) {
    let tail = Promise.resolve();
    /** @param {() => Promise<unknown>} work */
    const queue = work => {
        tail = tail.then(work).then(() => {}, err => console.error('[characters/watch] Importing dropped files failed:', err));
        return tail;
    };
    const first = queue(() => rescanCharacters(directories));
    /** @type {Set<string>} */
    const pending = new Set();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let closed = false;
    const flush = () => queue(async () => {
        const names = [...pending].filter(name => fs.existsSync(path.join(directories.characters, name)));
        pending.clear();
        for (let i = 0; i < names.length; i += RESCAN_BATCH) {
            const { failed } = await importDropped(directories, names.slice(i, i + RESCAN_BATCH));
            if (failed.length) console.warn(`[characters/watch] ${failed.length} dropped file(s) not importable: ${failed.join(', ')}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    });
    /** @type {fs.FSWatcher | undefined} */
    let watcher;
    try {
        watcher = fs.watch(directories.characters, (_event, name) => {
            if (closed || !name || path.extname(name).toLowerCase() !== '.png') return;
            pending.add(name);
            clearTimeout(timer);
            timer = setTimeout(flush, quietMs);
        });
        watcher.on('error', err => console.error('[characters/watch] The watch on characters/ failed:', err));
    } catch (err) {
        console.error(`[characters/watch] Can't watch ${directories.characters}; files dropped there are found at the next start or by a rescan:`, err);
    }
    return {
        first,
        idle: async () => {
            clearTimeout(timer);
            if (pending.size) await flush();
            await tail;
        },
        close: () => {
            closed = true;
            clearTimeout(timer);
            watcher?.close();
            return tail;
        },
    };
}

/** @type {Map<string, ReturnType<typeof watchDroppedCharacters>>} */
const droppedWatches = new Map();

/**
 * @param {import('../users.js').UserDirectoryList} directories
 */
export function startDroppedWatch(directories) {
    const root = path.resolve(directories.root);
    const had = droppedWatches.get(root);
    if (had) return had;
    const watch = watchDroppedCharacters(directories);
    droppedWatches.set(root, watch);
    return watch;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 */
export async function stopDroppedWatch(directories) {
    const root = path.resolve(directories.root);
    const watch = droppedWatches.get(root);
    droppedWatches.delete(root);
    await watch?.close();
}

export async function stopDroppedWatches() {
    const all = [...droppedWatches.values()];
    droppedWatches.clear();
    await Promise.all(all.map(watch => watch.close()));
}

router.post('/metadata/rescan', async function (request, response) {
    try {
        return response.send(await rescanCharacters(request.user.directories));
    } catch (err) {
        console.error('[characters/metadata/rescan] Rescan failed:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/metadata/batch-import/begin', async function (request, response) {
    try {
        (await requestStore(request)).lib.beginBatch();
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/metadata/batch-import] Failed to begin:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/metadata/batch-import/end', async function (request, response) {
    try {
        (await requestStore(request)).lib.endBatch();
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/metadata/batch-import] Failed to end:', err);
        return response.status(500).send({ error: true });
    }
});

const QUERY_RANGE_FIELDS = new Set(['create_date', 'date_last_chat', 'chat_size', 'data_size', 'closed_folders']);
const QUERY_RANGE_TAG_PREFIX = 'tag:';

/**
 * @param {string} field
 */
function isQueryRangeField(field) {
    return QUERY_RANGE_FIELDS.has(field) || (field.startsWith(QUERY_RANGE_TAG_PREFIX) && field.length > QUERY_RANGE_TAG_PREFIX.length);
}

/** @typedef {Record<string, { min?: number, max?: number }>} QueryRanges */

/**
 * @param {unknown} raw
 * @returns {QueryRanges | undefined | null}
 */
export function parseQueryRanges(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    /** @type {QueryRanges} */
    const ranges = {};
    for (const [field, bound] of Object.entries(raw)) {
        if (!isQueryRangeField(field)) return null;
        if (!bound || typeof bound !== 'object' || Array.isArray(bound)) return null;
        /** @type {{ min?: number, max?: number }} */
        const checked = {};
        for (const end of /** @type {const} */ (['min', 'max'])) {
            const value = /** @type {any} */ (bound)[end];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'number' || !Number.isFinite(value)) return null;
            checked[end] = value;
        }
        if (Object.keys(checked).length > 0) ranges[field] = checked;
    }
    return Object.keys(ranges).length > 0 ? ranges : undefined;
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {{ folder?: string, tags?: { include?: string[], exclude?: string[], mode?: string }, ranges?: QueryRanges }} filter
 */
async function applyFolderCase(lib, filter) {
    const folder = /** @type {string} */ (filter.folder);
    delete filter.folder;
    if (folder === 'none') {
        const closed = await lib.store.tagPage({ sort: 0, folders: true, folderType: 'CLOSED', limit: 1 });
        if (closed.ids.length === 0) return;
        filter.ranges = { ...filter.ranges, closed_folders: { max: 0 } };
        return;
    }
    const include = Array.isArray(filter.tags?.include) ? filter.tags.include : [];
    if (filter.tags?.mode === 'or' && include.length > 0) {
        filter.ranges = { ...filter.ranges, [`tag:${folder}`]: { min: 1 } };
        return;
    }
    filter.tags = { ...filter.tags, include: [...new Set([...include, folder])], mode: 'and' };
}

const QUERY_SORT_FIELDS = new Set(['name', 'date_added', 'date_last_chat', 'chat_size', 'fav', 'create_date', 'data_size', 'random', 'search']);

const DEFAULT_QUERY_PAGE_SIZE = 500;
const MAX_QUERY_PAGE_SIZE = 2000;

/** @typedef {{ status: number, body: object } | { hashes: Parameters<typeof serializeQueryHashesBinary>[0] }} QueryReply */

/**
 * @param {number} status
 * @param {object} body
 * @returns {QueryReply}
 */
function queryReply(status, body) {
    return { status, body };
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 */
async function queryVersion(lib) {
    const token = `l${lib.store.durableEnd()}`;
    const seq = await lib.changesEnd();
    return { seq, token };
}

/**
 * @param {import('express').Request} request
 * @param {object} body
 * @param {{ compat?: boolean }} [o]
 * @returns {Promise<QueryReply>}
 */
async function runQuery(request, body, { compat = true } = {}) {
    const filter = { ...(body.filter ?? {}) };
    const sort = body.sort ?? {};
    const want = Array.isArray(body.want) ? body.want : ['rows', 'total'];
    const includeGroups = filter.includeGroups === true;
    const group = typeof filter.group === 'boolean' ? filter.group : undefined;
    if (group === true && !includeGroups) {
        return queryReply(400, { error: true, reason: 'group-requires-include-groups', message: 'filter.group true requires filter.includeGroups.' });
    }
    const searchTerm = typeof filter.search === 'string' ? filter.search.trim() : '';
    if (sort.field === 'search' && !searchTerm) {
        return queryReply(400, { error: true, reason: 'search-sort-requires-search', message: 'sort.field "search" requires a non-empty filter.search.' });
    }
    if (sort.field !== undefined && !QUERY_SORT_FIELDS.has(sort.field)) {
        return queryReply(400, { error: true, reason: 'invalid-sort-field' });
    }
    if (filter.ranges !== undefined) {
        const ranges = parseQueryRanges(filter.ranges);
        if (ranges === null) {
            return queryReply(400, { error: true, reason: 'invalid-ranges', message: `filter.ranges takes { field: { min?, max? } } with numbers, for: ${[...QUERY_RANGE_FIELDS].join(', ')}.` });
        }
        filter.ranges = ranges;
    }
    const seed = Number(sort.seed);
    if (sort.field === 'random' && !Number.isFinite(seed)) {
        return queryReply(400, { error: true, reason: 'random-seed-required', message: 'sort.field "random" requires a finite sort.seed - design doc §5.3 decision 10, the client mints and persists this (public/scripts/random-sort.js).' });
    }
    const tie = sort.field === 'search' && sort.tie && typeof sort.tie === 'object' ? sort.tie : undefined;
    if (tie !== undefined && (!QUERY_SORT_FIELDS.has(tie.field) || tie.field === 'search')) {
        return queryReply(400, { error: true, reason: 'invalid-sort-field', message: 'sort.tie.field takes a list sort field.' });
    }
    const tieSeed = Number(tie?.seed);
    if (tie?.field === 'random' && !Number.isFinite(tieSeed)) {
        return queryReply(400, { error: true, reason: 'random-seed-required', message: 'sort.tie.field "random" requires a finite sort.tie.seed.' });
    }
    for (const w of want) {
        if (w !== 'rows' && w !== 'total' && w !== 'hashes' && w !== 'hidden') {
            return queryReply(400, { error: true, reason: 'want-not-supported', message: `want: "${w}" is not implemented yet.` });
        }
    }
    const wantHidden = want.includes('hidden');
    const wantRows = want.includes('rows');
    const wantTotal = want.includes('total') || wantHidden;
    const wantHashes = want.includes('hashes');
    if (wantHashes && wantRows) {
        return queryReply(400, { error: true, reason: 'hashes-and-rows-exclusive', message: 'want cannot include both "rows" and "hashes" in the same request.' });
    }

    const store = await requestStore(request);
    const { lib } = store;
    if (filter.folder !== undefined) {
        if (typeof filter.folder !== 'string' || filter.folder === '') {
            return queryReply(400, { error: true, reason: 'invalid-folder', message: 'filter.folder takes "none" or a closed folder\'s tag id.' });
        }
        await applyFolderCase(lib, filter);
    }

    const page = Number.isFinite(Number(body.page)) && Number(body.page) >= 1 ? Math.trunc(Number(body.page)) : 1;
    const pageSize = Number.isFinite(Number(body.pageSize)) && Number(body.pageSize) > 0
        ? Math.min(Math.trunc(Number(body.pageSize)), MAX_QUERY_PAGE_SIZE)
        : DEFAULT_QUERY_PAGE_SIZE;

    const { seq, token } = await queryVersion(lib);
    if (typeof body.ifToken === 'string' && body.ifToken.length > 0 && body.ifToken === token) {
        return queryReply(200, { seq, token, unchanged: true });
    }

    const result = await lib.query({
        tags: filter.tags,
        fav: typeof filter.fav === 'boolean' ? filter.fav : undefined,
        world: filter.world,
        ranges: filter.ranges,
        excludeIds: filter.excludeIds,
        ids: filter.ids,
        sortField: sort.field,
        sortOrder: sort.order,
        seed,
        ...(tie ? { tieSortField: tie.field, tieSortOrder: tie.order, tieSeed } : {}),
        offset: typeof body.cursor === 'string' ? 0 : (page - 1) * pageSize,
        limit: pageSize,
        cursor: body.cursor,
        wantRows,
        wantTotal,
        wantHashes,
        wantHidden,
        groupsOnly: includeGroups && group === true,
        includeGroups: includeGroups && group !== false,
        hiddenKinds: { characters: true, groups: includeGroups },
        ...(searchTerm ? { search: searchTerm } : {}),
    });
    if (result === 'invalid-cursor') {
        return queryReply(400, { error: true, reason: 'invalid-cursor', message: 'The cursor was made for another sort: ask again without it.' });
    }

    const listed = /** @type {{ id: string, isGroup?: boolean, type?: string }[]} */ (wantHashes ? result.hashRows : (result.rows ?? []));
    const keys = listed.map(r => ({ key: r.id, group: wantHashes ? !!r.isGroup : r.type === 'group' }));
    const ids = compat ? await Promise.all(keys.map(async k => (await lib.ids(k.group ? TYPE.group : TYPE.character, [k.key]))[0])) : keys.map(() => null);
    const chats = await compatChatIds(store, request, /** @type {bigint[]} */ (ids.filter(id => id !== null)));
    const chatOf = (/** @type {number} */ i) => (ids[i] === null ? null : chats.get(/** @type {bigint} */ (ids[i])) ?? null);
    const extra = {
        ...(result.more ? { more: true } : {}),
        ...(typeof result.cursor === 'string' ? { cursor: result.cursor } : {}),
    };

    const groupKeys = keys.filter(k => k.group).map(k => k.key);
    const groups = new Map((compat && groupKeys.length ? await groupObjects(request, groupKeys) : []).filter(g => g !== null).map(g => [(g).id, g]));

    if (wantHashes) {
        const hashRows = /** @type {any[]} */ (result.hashRows).map((r, i) => {
            const group = r.isGroup ? groups.get(r.id) : undefined;
            return { ...r, chat: chatOf(i), ...(group ? groupDigests(group) : {}) };
        });
        return {
            hashes: {
                seq, token, total: wantTotal ? Number(result.total) : undefined, approxTotal: !!result.approxTotal, hashRows,
                ...extra,
                ...(wantHidden ? { hidden: Number(result.hidden), approxHidden: !!result.approxHidden } : {}),
            },
        };
    }
    /** @type {Record<string, unknown>} */
    const payload = { seq, token, ...extra };
    if (wantRows) {
        const rows = /** @type {any[]} */ (result.rows).map((r, i) => {
            const group = r.type === 'group' ? groups.get(r.id) : undefined;
            const item = r.type === 'group' ? { ...r.item, chat_id: group?.chat_id ?? chatOf(i), chats: group?.chats ?? [] } : { ...r.item, chat: chatOf(i) };
            return { type: r.type, item };
        });
        payload.rows = includeGroups ? rows : rows.map(r => r.item);
    }
    if (wantTotal && want.includes('total')) payload.total = result.approxTotal ? `~${result.total}` : result.total;
    if (wantHidden) payload.hidden = result.approxHidden ? `~${result.hidden}` : result.hidden;
    return queryReply(200, payload);
}

async function handleQuery(request, response) {
    try {
        const reply = await runQuery(request, request.body ?? {});
        if ('hashes' in reply) return sendHashQueryResponse(response, reply.hashes);
        return response.status(reply.status).send(reply.body);
    } catch (err) {
        console.error('[characters/query] Query failed:', err);
        return response.status(500).send({ error: true });
    }
}

router.post('/query', (request, response) => withSearchTiming(response, () => handleQuery(request, response)));

router.post('/search-index/rebuild', function (_request, response) {
    return response.send({ ok: true });
});

router.post('/exists', async function (request, response) {
    try {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : null;
        if (!ids || ids.some(id => typeof id !== 'string')) {
            return response.sendStatus(400);
        }
        const { lib } = await requestStore(request);
        const found = await lib.ids(TYPE.character, ids);
        /** @type {Record<string, boolean>} */
        const result = {};
        ids.forEach((id, i) => { result[id] = found[i] !== null; });
        return response.send(result);
    } catch (err) {
        console.error('[characters/exists] Existence check failed:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/find', async function (request, response) {
    try {
        const body = request.body ?? {};
        const name = body.name ?? null;
        if (name !== null && typeof name !== 'string') return response.sendStatus(400);
        const { lib } = await requestStore(request);
        if (body.type === 'group') {
            if (!name) return response.sendStatus(400);
            return response.send({ ids: await lib.findGroups(name) });
        }
        if (body.type !== undefined && body.type !== 'character') return response.sendStatus(400);
        const tags = body.tags ?? null;
        if (tags !== null && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) return response.sendStatus(400);
        return response.send(await lib.findCharacters({
            name,
            allowAvatar: body.allowAvatar !== false,
            insensitive: body.insensitive !== false,
            tags,
        }));
    } catch (err) {
        console.error('[characters/find] Lookup failed:', err);
        return response.status(500).send({ error: true });
    }
});

const CHANGES_PAGE_SIZE = 500;

router.post('/changes', async function (request, response) {
    try {
        const sinceSeq = Number(request.body?.sinceSeq);
        if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
            return response.sendStatus(400);
        }
        const { lib } = await requestStore(request);
        return response.send(await lib.changes(sinceSeq, CHANGES_PAGE_SIZE));
    } catch (err) {
        console.error('[characters/changes] Change-feed query failed:', err);
        return response.status(500).send({ error: true });
    }
});

const HASH_QUERY_SEARCH_BACKEND_CODES = { tantivy: 1, native: 2, wasm: 3, unavailable: 4 };

/**
 * @param {{seq:number, token:string|null, total:number|undefined, approxTotal:boolean, hashRows:object[], searchBackend?:string, hidden?:number, approxHidden?:boolean, more?:boolean, cursor?:string}} params
 * @returns {Buffer}
 */
export function serializeQueryHashesBinary({ seq, token, total, approxTotal, hashRows, searchBackend, hidden, approxHidden = false, more = false, cursor }) {
    const hasTotal = typeof total === 'number';
    const hasCursor = typeof cursor === 'string' && cursor.length > 0;
    const cursorBytes = hasCursor ? Buffer.byteLength(cursor, 'utf8') : 0;
    const hasHidden = typeof hidden === 'number';
    const searchBackendCode = HASH_QUERY_SEARCH_BACKEND_CODES[searchBackend] ?? 0;

    const tokenBytes = token ? Buffer.byteLength(token, 'utf8') : 0;
    let totalSize = 1 + 1 + 8 + 8 + 2;
    for (const row of hashRows) {
        const idBytes = Buffer.byteLength(row.id, 'utf8');
        const chatBytes = row.chat ? Buffer.byteLength(row.chat, 'utf8') : 0;
        totalSize += 1 + 2 + idBytes + (row.isGroup ? 4 + 4 + 4 : 8 + 4) + 8 + 8 + 8 + 8 + 8 + 2 + chatBytes;
    }
    totalSize += 2 + tokenBytes;
    if (hasCursor) totalSize += 2 + cursorBytes;
    if (hasHidden) totalSize += 1 + 8;

    const buf = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    const headerFlags = (hasTotal ? 0b01 : 0) | (hasTotal && approxTotal ? 0b10 : 0) | (more ? 0b100 : 0) | (hasCursor ? 0b1000 : 0);
    buf.writeUInt8(headerFlags, offset); offset += 1;
    buf.writeUInt8(searchBackendCode, offset); offset += 1;
    buf.writeDoubleLE(seq ?? 0, offset); offset += 8;
    buf.writeDoubleLE(hasTotal ? total : 0, offset); offset += 8;
    buf.writeUInt16LE(hashRows.length, offset); offset += 2;

    for (const row of hashRows) {
        const hasCreateDate = row.create_date !== null && row.create_date !== undefined;
        const flags = (row.isGroup ? 0b01 : 0) | (hasCreateDate ? 0b10 : 0);
        buf.writeUInt8(flags, offset); offset += 1;

        const idBytes = Buffer.byteLength(row.id, 'utf8');
        buf.writeUInt16LE(idBytes, offset); offset += 2;
        buf.write(row.id, offset, idBytes, 'utf8'); offset += idBytes;

        if (row.isGroup) {
            buf.writeUInt32LE(row.favHash >>> 0, offset); offset += 4;
            buf.writeUInt32LE(row.tagIdsHash >>> 0, offset); offset += 4;
            buf.writeUInt32LE(row.contentHash >>> 0, offset); offset += 4;
        } else {
            buf.writeDoubleLE(row.version, offset); offset += 8;
            buf.writeUInt32LE(row.tagIdsHash >>> 0, offset); offset += 4;
        }

        buf.writeDoubleLE(row.date_added ?? 0, offset); offset += 8;
        buf.writeDoubleLE(hasCreateDate ? row.create_date : 0, offset); offset += 8;
        buf.writeDoubleLE(row.date_last_chat ?? 0, offset); offset += 8;
        buf.writeDoubleLE(row.chat_size ?? 0, offset); offset += 8;
        buf.writeDoubleLE(row.data_size ?? 0, offset); offset += 8;

        const chatBytes = row.chat ? Buffer.byteLength(row.chat, 'utf8') : 0;
        buf.writeUInt16LE(chatBytes, offset); offset += 2;
        if (chatBytes > 0) {
            buf.write(row.chat, offset, chatBytes, 'utf8'); offset += chatBytes;
        }
    }

    buf.writeUInt16LE(tokenBytes, offset); offset += 2;
    if (tokenBytes > 0) {
        buf.write(token, offset, tokenBytes, 'utf8'); offset += tokenBytes;
    }
    if (hasCursor) {
        buf.writeUInt16LE(cursorBytes, offset); offset += 2;
        buf.write(cursor, offset, cursorBytes, 'utf8'); offset += cursorBytes;
    }
    if (hasHidden) {
        buf.writeUInt8(approxHidden ? 0b1 : 0, offset); offset += 1;
        buf.writeDoubleLE(hidden, offset); offset += 8;
    }

    return buf;
}

/**
 * @param {import("express").Response} response
 * @param {{seq:number, token:string|null, total:number|undefined, approxTotal:boolean, hashRows:object[], searchBackend?:string}} params
 */
function sendHashQueryResponse(response, params) {
    response.set('Content-Type', 'application/octet-stream');
    return response.send(serializeQueryHashesBinary(params));
}

const VIEW_TYPES = new Set([TYPE.viewList, TYPE.view, TYPE.condition, TYPE.range]);

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {number} from
 * @param {number} to
 */
async function changedOtherThanViews(lib, from, to) {
    let after = BigInt(from);
    for (;;) {
        const page = await lib.store.chatRead('entityChanges', { after, limit: 256 });
        const entries = page.entries.filter((/** @type {any} */ e) => Number(e.pos) <= to);
        if (entries.some((/** @type {any} */ e) => e.gone !== null && !VIEW_TYPES.has(e.gone.kind))) return true;
        const live = entries.filter((/** @type {any} */ e) => e.gone === null);
        const keys = live.length ? await lib.store.libraryKeys(live.map((/** @type {any} */ e) => e.id)) : [];
        if (keys.some((/** @type {any} */ k) => k !== null && !VIEW_TYPES.has(k.type))) return true;
        if (!page.more || entries.length < page.entries.length || entries.length === 0) return false;
        after = entries[entries.length - 1].pos;
    }
}

router.get('/changes/stream', async function (request, response) {
    let store;
    try {
        store = await requestStore(request);
    } catch (err) {
        console.error('[characters/changes/stream] The store could not be opened:', err);
        return response.sendStatus(500);
    }
    const { lib, chats } = store;
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    response.write(':ok\n\n');
    touchBrowserPresence();

    const send = (/** @type {object} */ frame) => response.write(`data: ${JSON.stringify(frame)}\n\n`);
    const tab = await tabStreamSession(request, store, send);
    const detachUi = tab ? ui.attach(uiUser(request), tab.session, send) : null;

    const presenceInterval = setInterval(() => {
        response.write(':ping\n\n');
        touchBrowserPresence();
    }, PRESENCE_PING_INTERVAL_MS);

    const writeChanged = _.debounce(() => response.write('data: {}\n\n'), 500, { maxWait: 2000 });
    const writeGroupsChanged = _.debounce(() => send({ type: 'groups-changed' }), 500, { maxWait: 2000 });
    const writeTagsChanged = _.debounce(() => send({ type: 'tags-changed' }), 500, { maxWait: 2000 });
    const writeViewsChanged = _.debounce(() => send({ type: 'views-changed' }), 200, { maxWait: 1000 });

    let entityEnd = await lib.changesEnd();
    let assignmentEnd = (await lib.tags.entityChangesEnd()).seq;
    let tagEnd = await lib.tags.changesSeq();
    const onCommit = async (/** @type {object[]} */ records) => {
        try {
            const nextEntity = await lib.changesEnd();
            const nextAssignment = (await lib.tags.entityChangesEnd()).seq;
            const nextTag = await lib.tags.changesSeq();
            if (nextEntity !== entityEnd && await changedOtherThanViews(lib, entityEnd, nextEntity)) writeChanged();
            if (nextAssignment !== assignmentEnd || records.some(r => /** @type {any} */ (r).kind === 'entityCreate' && /** @type {any} */ (r).type === TYPE.group)) writeGroupsChanged();
            if (nextTag !== tagEnd) writeTagsChanged();
            entityEnd = nextEntity;
            assignmentEnd = nextAssignment;
            tagEnd = nextTag;
            await tab?.told(records);
            const told = new Set();
            for (const r of /** @type {any[]} */ (records)) {
                if (r.kind !== 'stateChange' && r.kind !== 'stateRevert') continue;
                const where = await chats.stateChangePlace(r);
                if (where === null) continue;
                const [key] = where.tree === null ? [null] : await lib.store.libraryKeys([where.tree]);
                const frame = { type: 'state-changed', tree: key?.key ?? null, at: where.at };
                const id = JSON.stringify(frame);
                if (told.has(id)) continue;
                told.add(id);
                send(frame);
            }
            if (tab && records.some(r => CHAT_MOVES.has(/** @type {any} */ (r).kind))) {
                ui.chatMoved(uiUser(request), tab.session).catch(error => console.error('[ui] chat views not pushed:', error));
            }
            if (tab && records.some(r => ALTERNATIVE_CHANGES.has(/** @type {any} */ (r).kind))) {
                ui.changedFor(uiUser(request), tab.session, ALTERNATIVES_VIEWS).catch(error => console.error('[ui] alternatives not pushed:', error));
            }
        } catch (err) {
            console.error('[characters/changes/stream] A change could not be told:', err);
        }
    };
    const onTagChanges = () => writeTagsChanged();
    const onTagOrderSettled = () => send({ type: 'tag-order-settled' });
    const onTagMoveFailed = (/** @type {object} */ payload, /** @type {{ delivered?: boolean }} */ ack) => {
        send({ type: 'tag-move-failed', ...payload });
        if (ack) ack.delivered = true;
    };
    const root = request.user.directories.root;
    const onViewsChanged = (/** @type {string} */ changedRoot) => {
        if (changedRoot === root) writeViewsChanged();
    };

    store.events.on('commit', onCommit);
    lib.tags.on('tag-changes', onTagChanges);
    lib.tags.on('tag-order-settled', onTagOrderSettled);
    lib.tags.on('tag-move-failed', onTagMoveFailed);
    savedViewsEvents.on('changed', onViewsChanged);

    request.on('close', () => {
        store.events.off('commit', onCommit);
        lib.tags.off('tag-changes', onTagChanges);
        lib.tags.off('tag-order-settled', onTagOrderSettled);
        lib.tags.off('tag-move-failed', onTagMoveFailed);
        savedViewsEvents.off('changed', onViewsChanged);
        for (const f of [writeChanged, writeGroupsChanged, writeTagsChanged, writeViewsChanged]) f.cancel();
        clearInterval(presenceInterval);
        detachUi?.();
        tab?.release();
    });
});

const SESSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAB_TOKEN = /^[0-9A-Za-z_-]{8,64}$/;
const ALTERNATIVE_CHANGES = new Set(['messageAppend', 'messageParent', 'subtreeDelete', 'textEdit', 'textValue', 'jsonValue', 'valueDelete', 'openingChoice', 'pointerMove', 'pointerRoot', 'historyStep', 'currentChat']);
const CHAT_MOVES = new Set(['stateChange', 'stateRevert', 'pointerMove', 'pointerRoot', 'historyStep', 'currentChat']);
const SESSION_KINDS = new Set(['pointerMove', 'pointerRoot', 'historyStep', 'sessionFork', 'messageAppend', 'currentChat']);

/**
 * @param {import('express').Request} request
 * @param {import('../user-stores.js').UserStore} store
 * @param {(frame: object) => void} send
 * @returns {Promise<{ session: string, told(records: object[]): Promise<void>, release(): void } | null>}
 */
async function tabStreamSession(request, store, send) {
    const token = typeof request.query.token === 'string' && TAB_TOKEN.test(request.query.token) ? request.query.token : null;
    if (token === null) return null;
    const asked = typeof request.query.session === 'string' && SESSION_KEY.test(request.query.session) ? request.query.session : null;
    if (asked === null && request.query.claim !== '1') return null;
    const { chats } = store;
    let closed = false;
    request.once('close', () => closed = true);
    const claim = await claimTabSession({ root: request.user.directories.root, user: request.user.profile.handle, chats, asked, token });
    if (closed) {
        claim.release();
        return null;
    }
    const { session } = claim;
    const ownerOf = async (/** @type {bigint} */ tree) => {
        const [key] = await store.lib.store.libraryKeys([tree]);
        if (!key) return null;
        return key.type === TYPE.group ? { group: key.key } : { avatar: key.key };
    };
    send({ type: 'session', session, held: claim.held, place: claim.held ? null : await chats.sessionPlace(session) });
    if (claim.held) return null;
    if (claim.reused) {
        for await (const page of chats.currentChats(session)) {
            const rows = [];
            for (const c of page) {
                const tree = await ownerOf(c.tree);
                if (tree) rows.push({ tree, bookmark: c.bookmark });
            }
            if (rows.length) send({ type: 'session-chats', chats: rows });
        }
    }
    /** @type {bigint | null} */
    let sid = await chats.sessionId(session);
    return {
        session,
        async told(records) {
            const ours = /** @type {any[]} */ (records).filter(r => SESSION_KINDS.has(r.kind) && r.session !== undefined);
            if (!ours.length) return;
            sid ??= await chats.sessionId(session);
            if (sid === null) return;
            let moved = false;
            for (const r of ours) {
                if (r.session !== sid) continue;
                if (r.kind !== 'currentChat') {
                    moved = true;
                    continue;
                }
                const tree = await ownerOf(r.tree);
                if (tree) send({ type: 'current-chat', tree, bookmark: r.bookmark === undefined ? null : String(r.bookmark) });
            }
            if (moved) send({ type: 'session-place', place: await chats.sessionPlace(session) });
        },
        release: claim.release,
    };
}

router.post('/batch', async function (request, response) {
    try {
        const avatars = Array.isArray(request.body?.avatars) ? request.body.avatars : [];
        const fields = Array.isArray(request.body?.fields) ? request.body.fields : null;

        for (const avatar of avatars) {
            if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar)) {
                return response.sendStatus(400);
            }
        }

        if (fields) {
            const rows = (await characterObjects(request, avatars, { shallow: true })).filter(Boolean);
            return response.send(rows.map(row => {
                /** @type {Record<string, any>} */
                const filtered = { avatar: /** @type {any} */ (row).avatar };
                for (const field of fields) {
                    if (field in /** @type {any} */ (row)) filtered[field] = /** @type {any} */ (row)[field];
                }
                return filtered;
            }));
        }

        const full = request.body?.full === true;
        if (full && avatars.length > FULL_BATCH_MAX) {
            return response.status(400).send({ error: `at most ${FULL_BATCH_MAX} avatars with full` });
        }
        const data = /** @type {Record<string, any>[]} */ ((await characterObjects(request, avatars, { shallow: full ? false : useShallowCharacters })).filter(Boolean));
        if (full) {
            for (const character of data) {
                character._fieldsHash = characterDigestFieldsHash(character);
                character._bodyHash = characterDigestCardBodyHash(character);
            }
        }
        return response.send(data);
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: true });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        const [data] = await characterObjects(request, [request.body.avatar_url], { shallow: false });
        if (!data) return response.sendStatus(404);

        data._fieldsHash = characterDigestFieldsHash(data);
        data._bodyHash = characterDigestCardBodyHash(data);

        return response.send(data);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

const CHATS_PAGE = 500;

router.post('/chats', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        const store = await requestStore(request);
        const [tree] = await store.people.trees([{ avatar: request.body.avatar_url }]);
        if (tree === null || tree === undefined) return response.send([]);
        const session = await requestSession(store.chats, request, tree);
        const rows = [];
        /** @type {string | undefined} */
        let after;
        for (;;) {
            const page = await store.chats.chatList({ tree, session: session.reader().session ?? undefined, after, limit: CHATS_PAGE, withMetadata: request.body.metadata === true });
            rows.push(...page.rows);
            if (!page.more || page.rows.length === 0) break;
            after = page.rows[page.rows.length - 1].position;
        }
        const ids = await store.chats.chatIdsOf(tree, rows);
        const named = rows.map((r, i) => ({ ...r, file_id: ids[i] }));
        if (request.body.simple) {
            return response.send(named.map(r => ({ file_name: `${r.file_id}.jsonl`, file_id: r.file_id, label: r.name ?? null })));
        }
        return response.send(named.map(r => ({
            node_id: r.at,
            file_name: `${r.file_id}.jsonl`,
            label: r.name ?? null,
            file_size: 0,
            chat_items: r.message_count,
            mes: r.last_mes || '[No messages]',
            last_mes: r.last_activity,
            chat_metadata: request.body.metadata ? r.chat_metadata : undefined,
        })));
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<string>}
 */
export async function mintCharacterId(directories) {
    const { lib } = await userStore(directories);
    for (let i = 0; i < 5; i++) {
        const id = uuidv7();
        if ((await lib.ids(TYPE.character, [`${id}.png`]))[0] === null) return id;
    }
    throw new Error('Failed to mint a unique character id after 5 attempts');
}

/**
 * @param {import("express").Request} request
 * @returns {string | undefined}
 */
function getPreservedName(request) {
    return typeof request.body.preserved_name === 'string' && request.body.preserved_name.length > 0
        ? path.parse(request.body.preserved_name).name
        : undefined;
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function hashFileContents(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

const formatImportFunctions = {
    'yaml': importFromYaml,
    'yml': importFromYaml,
    'json': importFromJson,
    'png': importFromPng,
    'charx': importFromCharX,
    'byaf': importFromByaf,
};

/**
 * @param {string} filePath
 * @param {string} format
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ userHandle: string, contentHash: string }} options
 * @returns {Promise<{ fileName: string } | { duplicateOf: string } | null>}
 */
export async function importCharacterFileHeadless(filePath, format, directories, { userHandle, contentHash }) {
    const importFunction = formatImportFunctions[format];
    if (!importFunction) return null;

    const duplicateOf = await (await userStore(directories)).lib.findByHash(HASH.content, contentHash);
    if (duplicateOf) return { duplicateOf };

    /** @type {import('express').Request} */
    const fakeRequest = /** @type {any} */ ({
        user: { directories, profile: { handle: userHandle } },
        body: {},
    });

    const fileName = await importFunction(filePath, { request: fakeRequest, contentHash }, undefined);
    return fileName ? { fileName } : null;
}

router.post('/import', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = request.body.file_type;
    const preservedFileName = getPreservedName(request);
    const sourceUrl = typeof request.body.source_url === 'string' && request.body.source_url ? request.body.source_url : null;
    const importName = sourceUrl ? `${sourceUrl} (${request.file.originalname})` : request.file.originalname;

    try {
        const importFunction = formatImportFunctions[format];

        if (!importFunction) {
            throw new Error(`Unsupported format: ${format}`);
        }

        const contentHash = await hashFileContents(uploadPath);
        const { lib } = await requestStore(request);
        const imported = await lib.importLane(contentHash, async () => {
            if (!preservedFileName) {
                const duplicateOf = await lib.findByHash(HASH.content, contentHash);
                if (duplicateOf) {
                    await fsPromises.unlink(uploadPath).catch(() => {});
                    return { duplicateOf };
                }
            }
            return { fileName: await importFunction(uploadPath, { request, response, contentHash }, preservedFileName) };
        });
        if ('duplicateOf' in imported) return response.send({ duplicate: true, duplicate_of: imported.duplicateOf });
        const fileName = imported.fileName;

        if (!fileName) {
            const error = importFailure(importName, 'not a recognized character card format');
            console.warn(error.message);
            return response.status(400).send({ error: error.message });
        }

        const tagImportMode = request.body.tagImportMode;
        /** @type {object[]} */
        let tagDefinitions = [];
        if (tagImportMode === 'all' || tagImportMode === 'existing') {
            try {
                ({ tagDefinitions } = await (await requestStore(request)).lib.tags.seedCardTags(`${fileName}.png`, { onlyExisting: tagImportMode === 'existing' }));
            } catch (err) {
                console.error(`Failed to seed card tags for ${fileName}.png:`, err);
            }
        }

        const [character] = await characterObjects(request, [`${fileName}.png`], { shallow: false });

        response.send({ file_name: fileName, character, tagDefinitions });
    } catch (err) {
        const error = importFailure(importName, err);
        console.error(error);
        response.status(error.code === NO_CARD_DATA || err instanceof ImageReadError ? 400 : 500).send({ error: error.message });
    }
});

/**
 * @param {import('express').Request} request
 * @param {string} avatarUrl
 * @returns {Promise<{ok: true, newAvatar: string}|{ok: false, status: number, error: string}>}
 */
async function duplicateOneCharacter(request, avatarUrl) {
    const avatar = sanitize(avatarUrl);
    const { lib } = await requestStore(request);
    const source = await lib.entity(TYPE.character, avatar);
    if (!source) {
        console.error('character for dupe not found', avatar);
        return { ok: false, status: 404, error: 'not found' };
    }

    const nameParts = path.basename(avatar, path.extname(avatar)).split('_');
    const lastPart = nameParts[nameParts.length - 1];
    const isStrictInteger = /^\d{1,15}$/.test(lastPart);
    let suffix = isStrictInteger && nameParts.length > 1 ? parseInt(lastPart, 10) + 1 : 1;
    const baseName = isStrictInteger && nameParts.length > 1 ? nameParts.slice(0, -1).join('_') : nameParts.join('_');

    const MAX_DUPLICATE_ATTEMPTS = 10000;
    let newAvatar = `${baseName}_${suffix}${path.extname(avatar)}`;
    for (let attempts = 0; (await lib.ids(TYPE.character, [newAvatar]))[0] !== null; attempts++) {
        if (attempts >= MAX_DUPLICATE_ATTEMPTS) {
            console.error(`Too many duplicate suffixes for ${baseName}, giving up after ${MAX_DUPLICATE_ATTEMPTS} attempts`);
            return { ok: false, status: 500, error: 'Too many duplicates with this name' };
        }
        suffix++;
        newAvatar = `${baseName}_${suffix}${path.extname(avatar)}`;
    }

    const [card] = await lib.cards([avatar]);
    if (!card) return { ok: false, status: 404, error: 'not found' };
    const [tags] = await lib.store.libraryTagIds([source.id]);
    const hashOf = (/** @type {number} */ which) => source.hashes.find(h => h.which === which)?.hash.toString('hex') ?? null;
    try {
        await inAvatarLane(lib, newAvatar, async () => {
            const from = avatarFile(request.user.directories, avatar);
            const to = avatarFile(request.user.directories, newAvatar);
            const copied = fs.existsSync(from);
            if (copied) fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
            try {
                await lib.writeCard(request.user.directories, newAvatar, JSON.stringify(card), { avatarIdentityHash: hashOf(HASH.avatarIdentity), animatedHash: hashOf(HASH.animated), fav: source.fav, tags });
            } catch (err) {
                if (copied) fs.rmSync(to, { force: true });
                throw err;
            }
        });
    } catch (err) {
        console.error(`The duplicate of "${avatar}" could not be saved`, err);
        return { ok: false, status: 500, error: `The duplicate of "${avatar}" could not be saved` };
    }
    return { ok: true, newAvatar };
}

router.post('/duplicate', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (Array.isArray(request.body.avatar_urls)) {
            const avatarUrls = request.body.avatar_urls;
            const results = [];
            for (const avatarUrl of avatarUrls) {
                if (typeof avatarUrl !== 'string' || !avatarUrl || forbiddenRegExp.test(avatarUrl)) {
                    results.push({ avatar_url: avatarUrl, ok: false, error: 'invalid avatar_url' });
                    continue;
                }
                const result = await duplicateOneCharacter(request, avatarUrl);
                if (result.ok) {
                    results.push({ avatar_url: avatarUrl, ok: true, path: result.newAvatar });
                } else {
                    results.push({ avatar_url: avatarUrl, ok: false, error: result.error });
                }
            }
            return response.send({ results });
        }

        if (!request.body.avatar_url) {
            console.warn('avatar URL not found in request body');
            console.debug(request.body);
            return response.sendStatus(400);
        }

        const result = await duplicateOneCharacter(request, request.body.avatar_url);
        if (!result.ok) {
            return response.status(result.status).send({ error: true, message: result.error });
        }

        response.send({ path: result.newAvatar });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

const BULK_QUERY_PAGE_SIZE = 1000;
const BULK_MAX_NAMED = 10000;
const BULK_MAX_RANGES = 1000;
const BULK_SAMPLE_SIZE = 30;
const BULK_IDS_PAGE = 500;
const RUN_LIST_CHUNK = 1000;
const BULK_ACTIONS = new Set(['delete', 'fav', 'duplicate', 'tag-add', 'tag-remove', 'tag-reset', 'tag-import']);

const bulkPause = () => new Promise(resolve => setImmediate(resolve));

/**
 * @typedef {object} BulkSelection
 * @property {{ filter: object, sort?: object } | null} query
 * @property {boolean} all
 * @property {[number, number][]} ranges
 * @property {[number, number][]} excludeRanges
 * @property {string[]} include
 * @property {Set<string>} exclude
 */

/**
 * @param {unknown} value
 * @returns {[number, number][] | null}
 */
function parseBulkRanges(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > BULK_MAX_RANGES) return null;
    /** @type {[number, number][]} */
    const ranges = [];
    for (const range of value) {
        if (!Array.isArray(range) || range.length !== 2) return null;
        const [a, b] = range.map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return null;
        ranges.push([Math.min(a, b), Math.max(a, b)]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    /** @type {[number, number][]} */
    const merged = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
    }
    return merged;
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function parseBulkAvatars(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > BULK_MAX_NAMED) return null;
    if (!value.every(avatar => typeof avatar === 'string' && avatar && !forbiddenRegExp.test(avatar))) return null;
    return /** @type {string[]} */ (value);
}

/**
 * @param {unknown} raw
 * @returns {BulkSelection | string}
 */
function parseBulkSelection(raw) {
    if (!raw || typeof raw !== 'object') return 'selection-required';
    const r = /** @type {Record<string, any>} */ (raw);
    const query = r.query && typeof r.query === 'object' ? { filter: r.query.filter ?? {}, sort: r.query.sort } : null;
    const ranges = parseBulkRanges(r.ranges);
    const excludeRanges = parseBulkRanges(r.excludeRanges);
    const include = parseBulkAvatars(r.include);
    const exclude = parseBulkAvatars(r.exclude);
    if (ranges === null || excludeRanges === null || include === null || exclude === null) return 'invalid-selection';
    const all = r.all === true;
    if ((all || ranges.length > 0 || excludeRanges.length > 0) && !query) return 'query-required';
    return { query, all, ranges, excludeRanges, include, exclude: new Set(exclude) };
}

/**
 * @param {import('express').Request} request
 * @param {{ filter: object, sort?: object }} query
 * @param {number} start
 * @returns {AsyncGenerator<{ position: number, avatar: string | null }, void, undefined>}
 */
async function* listRows(request, query, start) {
    const filter = /** @type {Record<string, any>} */ (query.filter ?? {});
    if (filter.group === true) return;
    let page = Math.floor(start / BULK_QUERY_PAGE_SIZE) + 1;
    let position = (page - 1) * BULK_QUERY_PAGE_SIZE;
    /** @type {string | undefined} */
    let cursor;
    for (;;) {
        const reply = await runQuery(request, { filter, sort: query.sort, page, pageSize: BULK_QUERY_PAGE_SIZE, want: ['hashes'], cursor }, { compat: false });
        if (!('hashes' in reply)) throw new Error(`The list could not be read: ${reply.status}`);
        const rows = reply.hashes.hashRows;
        for (const row of rows) {
            if (position >= start) yield { position, avatar: row.isGroup ? null : row.id };
            position++;
        }
        if (typeof reply.hashes.cursor !== 'string' || rows.length === 0) return;
        cursor = reply.hashes.cursor;
        page++;
        await bulkPause();
    }
}

/**
 * @param {import('express').Request} request
 * @param {BulkSelection} selection
 * @param {string} [from]
 * @param {{ missing?: boolean }} [o]
 * @returns {AsyncGenerator<{ avatar: string, next: string, missing?: true }, void, undefined>}
 */
async function* selectedAvatars(request, selection, from, { missing = false } = {}) {
    const at = typeof from === 'string' ? /^([pi])(\d+)$/.exec(from) : null;
    if (at === null || at[1] === 'p') {
        const start = at === null ? 0 : Number(at[2]);
        const spans = selection.all ? [[0, Infinity]] : selection.ranges;
        const excluded = (/** @type {number} */ p) => selection.excludeRanges.some(([a, b]) => p >= a && p <= b);
        for (const [a, b] of spans) {
            if (b < start || !selection.query) continue;
            for await (const row of listRows(request, selection.query, Math.max(a, start))) {
                if (row.position > b) break;
                if (row.avatar === null || excluded(row.position) || selection.exclude.has(row.avatar)) continue;
                yield { avatar: row.avatar, next: `p${row.position + 1}` };
            }
        }
    }
    const first = at?.[1] === 'i' ? Number(at[2]) : 0;
    const { lib } = await requestStore(request);
    for (let i = first; i < selection.include.length; i += BULK_IDS_PAGE) {
        const slice = selection.include.slice(i, i + BULK_IDS_PAGE);
        const found = await lib.ids(TYPE.character, slice);
        for (const [j, avatar] of slice.entries()) {
            if (selection.exclude.has(avatar)) continue;
            if (found[j] !== null) yield { avatar, next: `i${i + j + 1}` };
            else if (missing) yield { avatar, next: `i${i + j + 1}`, missing: true };
        }
    }
}

router.post('/bulk/prepare', async function (request, response) {
    const body = request.body ?? {};
    const selection = parseBulkSelection(body.selection);
    if (typeof selection === 'string') return response.status(400).send({ error: true, reason: selection });
    try {
        const current = typeof body.current === 'string' ? body.current : undefined;
        let count = 0;
        let containsCurrent = false;
        const sample = [];
        for await (const { avatar } of selectedAvatars(request, selection)) {
            count++;
            if (avatar === current) containsCurrent = true;
            if (sample.length < BULK_SAMPLE_SIZE) sample.push(avatar);
        }
        const { lib } = await requestStore(request);
        const found = selection.include.length > 0 ? await lib.ids(TYPE.character, selection.include) : [];
        const missing = selection.include.filter((_, i) => found[i] === null);
        return response.send({ count, containsCurrent, sample, missing });
    } catch (err) {
        console.error('[characters/bulk/prepare] The selection could not be read:', err);
        return response.status(500).send({ error: true, reason: 'selection-failed' });
    }
});

router.post('/bulk/ids', async function (request, response) {
    const body = request.body ?? {};
    const selection = parseBulkSelection(body.selection);
    if (typeof selection === 'string') return response.status(400).send({ error: true, reason: selection });
    try {
        const avatars = [];
        let after;
        let more = false;
        for await (const { avatar, next } of selectedAvatars(request, selection, typeof body.after === 'string' ? body.after : undefined)) {
            if (avatars.length === BULK_IDS_PAGE) {
                more = true;
                break;
            }
            avatars.push(avatar);
            after = next;
        }
        return response.send({ avatars, more, ...(more ? { after } : {}) });
    } catch (err) {
        console.error('[characters/bulk/ids] The selection could not be read:', err);
        return response.status(500).send({ error: true, reason: 'selection-failed' });
    }
});

const RUNS_KEY = 'bulk.runs';
const runKey = (/** @type {string} */ run) => `bulk.run.${run}`;
const chunkKey = (/** @type {string} */ run, /** @type {number} */ n) => `bulk.run.${run}.${n}`;

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {(runs: string[]) => string[]} change
 * @param {object[]} [records]
 */
function changeRuns(lib, change, records = []) {
    return lib.serialized(RUNS_LANE, RUNS_KEY, async () => {
        const [runs] = await lib.store.meta([RUNS_KEY]);
        const next = change(runs ? JSON.parse(runs) : []);
        await lib.store.commit([...records, next.length ? { kind: 'metaValue', key: RUNS_KEY, json: JSON.stringify(next) } : { kind: 'metaValue', key: RUNS_KEY }]);
    });
}

const RUNS_LANE = -2;

/**
 * @param {import('express').Request} request
 * @param {BulkSelection} selection
 * @param {string} action
 * @returns {Promise<{ run: string, chunks: number, total: number }>}
 */
async function writeRunList(request, selection, action) {
    const { lib } = await requestStore(request);
    const run = crypto.randomUUID();
    await changeRuns(lib, runs => [...runs, run]);
    let chunks = 0;
    let total = 0;
    /** @type {string[]} */
    let chunk = [];
    const flush = async () => {
        if (chunk.length === 0) return;
        const ids = await lib.ids(TYPE.character, chunk);
        const entries = chunk.map((avatar, i) => [ids[i] === null ? null : String(ids[i]), avatar]);
        await lib.store.commit([{ kind: 'metaValue', key: chunkKey(run, chunks++), json: JSON.stringify(entries) }]);
        chunk = [];
    };
    for await (const { avatar } of selectedAvatars(request, selection, undefined, { missing: true })) {
        chunk.push(avatar);
        total++;
        if (chunk.length >= RUN_LIST_CHUNK) await flush();
    }
    await flush();
    await lib.store.commit([{ kind: 'metaValue', key: runKey(run), json: JSON.stringify({ action, total, done: 0, chunks }) }]);
    return { run, chunks, total };
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} run
 * @param {number} n
 * @returns {Promise<{ avatar: string, gone: boolean }[]>}
 */
async function runListChunk(lib, run, n) {
    const [json] = await lib.store.meta([chunkKey(run, n)]);
    /** @type {[string | null, string][]} */
    const entries = json ? JSON.parse(json) : [];
    const ids = entries.flatMap(([id]) => (id === null ? [] : [BigInt(id)]));
    const keys = ids.length > 0 ? await lib.store.libraryKeys(ids) : [];
    let k = 0;
    return entries.map(([id, avatar]) => {
        const key = id === null ? null : keys[k++];
        return key && key.type === TYPE.character ? { avatar: key.key, gone: false } : { avatar, gone: true };
    });
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} run
 * @param {number} chunks
 */
async function endRunList(lib, run, chunks) {
    const records = [];
    for (let n = 0; n < chunks; n++) records.push({ kind: 'metaValue', key: chunkKey(run, n) });
    records.push({ kind: 'metaValue', key: runKey(run) });
    await changeRuns(lib, runs => runs.filter(r => r !== run), records);
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 */
export async function dropStoppedRuns(lib) {
    const [runs] = await lib.store.meta([RUNS_KEY]);
    for (const run of runs ? JSON.parse(runs) : []) {
        const [state] = await lib.store.meta([runKey(run)]);
        const s = state ? JSON.parse(state) : null;
        console.warn(s
            ? `[characters/bulk] A bulk "${s.action}" was stopped by the server stopping, after ${s.done} of ${s.total} characters; the rest weren't changed.`
            : '[characters/bulk] A bulk action was stopped by the server stopping before it began; nothing was changed.');
        let chunks = s?.chunks ?? 0;
        while ((await lib.store.meta([chunkKey(run, chunks)]))[0] !== null) chunks++;
        await endRunList(lib, run, chunks);
    }
}

router.post('/bulk/mutual-tags', async function (request, response) {
    const selection = parseBulkSelection(request.body?.selection);
    if (typeof selection === 'string') return response.status(400).send({ error: true, reason: selection });
    const { lib } = await requestStore(request);
    let list;
    try {
        list = await writeRunList(request, selection, 'mutual-tags');
        /** @type {Set<string> | null} */
        let mutual = null;
        for (let n = 0; n < list.chunks && (mutual === null || mutual.size > 0); n++) {
            const avatars = (await runListChunk(lib, list.run, n)).filter(e => !e.gone).map(e => e.avatar);
            const carried = await lib.tags.tagIdsFor(avatars);
            for (const avatar of avatars) {
                const tags = new Set(carried[avatar] ?? []);
                mutual = mutual === null ? tags : new Set([...mutual].filter(t => tags.has(t)));
            }
        }
        return response.send({ tagIds: [...(mutual ?? [])] });
    } catch (err) {
        console.error('[characters/bulk/mutual-tags] The selection could not be read:', err);
        return response.status(500).send({ error: true, reason: 'selection-failed' });
    } finally {
        if (list) await endRunList(lib, list.run, list.chunks);
    }
});

/**
 * @param {import('express').Request} request
 * @param {string} action
 * @param {string} avatar
 * @param {Record<string, any>} options
 * @returns {Promise<{ ok: boolean, error?: string, extra?: object }>}
 */
async function applyBulkAction(request, action, avatar, options) {
    const { lib } = await requestStore(request);
    const tagIds = Array.isArray(options.tagIds) ? options.tagIds.filter(id => typeof id === 'string' && id) : [];
    switch (action) {
        case 'delete': {
            const result = await deleteOneCharacter(request, avatar, options.deleteChats === true);
            return result.ok ? { ok: true } : { ok: false, error: `status ${result.status}` };
        }
        case 'fav': {
            const e = await lib.entity(TYPE.character, avatar);
            if (!e) return { ok: false, error: 'not found' };
            await lib.setFav(TYPE.character, avatar, !e.fav);
            return { ok: true, extra: { fav: !e.fav } };
        }
        case 'duplicate': {
            const result = await duplicateOneCharacter(request, avatar);
            return result.ok ? { ok: true, extra: { path: result.newAvatar } } : { ok: false, error: result.error };
        }
        case 'tag-add': {
            for (const tagId of tagIds) {
                const result = await lib.tags.assign(avatar, tagId);
                if (result.result !== 'ok') return { ok: false, error: 'not found' };
            }
            return { ok: true };
        }
        case 'tag-remove': {
            for (const tagId of tagIds) await lib.tags.unassign(avatar, tagId);
            return { ok: true };
        }
        case 'tag-reset': {
            const carried = await lib.tags.tagIdsFor([avatar]);
            for (const tagId of carried[avatar] ?? []) await lib.tags.unassign(avatar, tagId);
            return { ok: true };
        }
        case 'tag-import': {
            await lib.tags.seedCardTags(avatar, { onlyExisting: options.onlyExisting === true });
            return { ok: true };
        }
    }
    return { ok: false, error: 'unknown action' };
}

router.post('/bulk/run', async function (request, response) {
    const { action, options, watch } = request.body ?? {};
    if (typeof action !== 'string' || !BULK_ACTIONS.has(action)) {
        return response.status(400).send({ error: true, reason: 'invalid-action' });
    }
    const selection = parseBulkSelection(request.body?.selection);
    if (typeof selection === 'string') return response.status(400).send({ error: true, reason: selection });
    const watched = new Set(Array.isArray(watch) ? watch.filter(avatar => typeof avatar === 'string').slice(0, BULK_MAX_NAMED) : []);
    const actionOptions = options && typeof options === 'object' ? options : {};
    const { lib } = await requestStore(request);

    response.status(200);
    response.set('Content-Type', 'application/x-ndjson');
    response.set('Cache-Control', 'no-cache');
    const send = async (/** @type {object} */ line) => {
        await writeBackpressured(response, JSON.stringify(line) + '\n');
        /** @type {any} */ (response).flush?.();
    };

    let done = 0;
    let failed = 0;
    let list;
    try {
        list = await writeRunList(request, selection, action);
        for (let n = 0; n < list.chunks; n++) {
            for (const { avatar, gone } of await runListChunk(lib, list.run, n)) {
                /** @type {{ ok: boolean, error?: string, extra?: object }} */
                let outcome;
                try {
                    outcome = gone ? { ok: false, error: 'not found' } : await applyBulkAction(request, action, avatar, actionOptions);
                } catch (err) {
                    console.error(`[characters/bulk/run] ${action} failed for ${avatar}:`, err);
                    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
                if (outcome.ok) {
                    done++;
                    if (watched.has(avatar)) await send({ type: 'item', avatar, ...(outcome.extra ?? {}) });
                } else {
                    failed++;
                    await send({ type: 'failed', avatar, error: outcome.error ?? 'failed' });
                }
            }
            await lib.store.commit([{ kind: 'metaValue', key: runKey(list.run), json: JSON.stringify({ action, total: list.total, done: done + failed, chunks: list.chunks }) }]);
            await send({ type: 'progress', done, failed });
            await bulkPause();
        }
        await send({ type: 'done', done, failed });
    } catch (err) {
        console.error(`[characters/bulk/run] ${action} stopped:`, err);
        try {
            await send({ type: 'error', done, failed });
        } catch {
            // The connection is gone; nothing left to tell.
        }
    } finally {
        if (list) await endRunList(lib, list.run, list.chunks).catch(err => console.error('[characters/bulk/run] Its run list could not be removed:', err));
        response.end();
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.format || !request.body.avatar_url) {
            return response.sendStatus(400);
        }
        const avatar = sanitize(request.body.avatar_url);

        switch (request.body.format) {
            case 'png': {
                const materialized = await materializeCardPng(request.user.directories, avatar);
                if (!materialized) return response.sendStatus(404);
                const mutatedData = mutateJsonString(materialized.cardJson, unsetPrivateFields);
                const mutatedBuffer = write(materialized.buffer, mutatedData);
                response.setHeader('Content-Type', mime.lookup(avatar) || 'image/png');
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(avatar)}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                const json = await readCardContent(request.user.directories, avatar);
                if (json === undefined) return response.sendStatus(404);
                try {
                    const jsonObject = getCharaCardV2(JSON.parse(json), request.user.directories);
                    unsetPrivateFields(jsonObject);
                    return response.type('json').send(JSON.stringify(jsonObject, null, 4));
                } catch {
                    return response.sendStatus(400);
                }
            }
        }

        return response.sendStatus(400);
    } catch (err) {
        console.error('Character export failed', err);
        response.sendStatus(500);
    }
});
