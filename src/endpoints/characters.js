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
import { Jimp, JimpMime } from '../jimp.js';
import storage from 'node-persist';

import { AVATAR_WIDTH, AVATAR_HEIGHT, DEFAULT_AVATAR_PATH } from '../constants.js';
import { default as validateAvatarUrlMiddleware, getFileNameValidationFunction, forbiddenRegExp } from '../middleware/validateFileName.js';
import { deepMerge, humanizedDateTime, tryParse, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements, getArrayBufferSlice, uuidv7, color } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { parse, read, write, writeCardToFile, computeAvatarIdentityHashFromImageBuffer } from '../character-card-parser.js';
import { getCharaCardV2, convertToV2, readFromV2, charaFormatData, unsetPrivateFields, omitInstallLocalFields, omitFavField, omitChatField, computeContentIdentityHash } from '../character-card-normalize.js';
import { calculateChatSize, calculateDataSize, toShallow } from '../character-shallow.js';
import { touchBrowserPresence, PRESENCE_PING_INTERVAL_MS } from '../browser-presence.js';
import { invalidateThumbnail, getThumbnailVersion } from './thumbnails.js';
import { importRisuSprites, importChubExpressions } from './sprites.js';
import { getChatInfo } from './chats.js';
import { hasSavedChats, listBranches as listTreeBranches } from '../message-tree-db.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { searchCharacters, searchCharacterIds, searchCharacterIdsSorted, rebuildCharacterSearchIndex, TANTIVY_SORT_FIELDS } from './characters-search-index.js';
import { searchGroups, searchGroupIds } from './groups-search-index.js';
import { getGroupsData, getGroupsByIds } from './groups.js';
import { upsertCharacterFromWrite, deleteCharacterRow, reconcile as reconcileMetadataStore, beginBatchImport, endBatchImport, queryCharacters, queryEntities, checkCharactersExist, getChangesSince, getStateDigest, getBucketMembers, treeDescend, resolveFingerprints, findCharacterIdByContentHash, findCharacterIdByContentIdentityHash, setCharacterFav, getCharacterFavsByIds, setCharacterActiveChat, getCharacterActiveChatsByIds, getCharacterTagIdsByIds, getEntityTagIdsForMany, getShallowByIds, setCharacterAllowGlobalStyles, getCharacterAllowGlobalStylesByIds, characterChangeEmitter, getCurrentSeq, seedCardTagsForSingleCharacter, getCharacterCardJson, getStaleCardJsonMap } from '../character-metadata-db.js';
import { DEFAULT_DIGEST_BUCKET_COUNT, characterDigestFieldsHash, characterDigestCardBodyHash, getStringHash } from '../../public/scripts/hash-utils.js';
import { cardToGreetingsModel, applyGreetingsModelToCard } from '../greeting-list.js';
import { hashGreetingText, opAdd, opEdit, opDelete, opMove, opSetDefault, opUnsetDefault } from '../greeting-ops.js';

// Use shallow character data for the character list
const useShallowCharacters = !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
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
 * Resolves the metadata db vs. the (possibly stale) PNG chunk. Only for characters already in the library - use readCharacterData() directly for arbitrary PNGs.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar Avatar filename, e.g. `Alice.png`
 * @param {string} [filePath] The card's path, when the caller already built it.
 * @param {fs.Stats} [precomputedStat] Passed through to readCharacterData() on the file branch only.
 * @returns {Promise<string|undefined>} The card JSON, or `undefined` if unreadable.
 */
export async function readCardContent(directories, avatar, filePath = undefined, precomputedStat = undefined) {
    const parked = await getCharacterCardJson(directories, avatar);
    const raw = parked !== null ? parked : await readCharacterData(filePath ?? path.join(directories.characters, avatar), 'png', precomputedStat);
    return await correctFirstMesDriftOnRead(directories, avatar, filePath, raw);
}

/**
 * Corrects `data.first_mes` vs. the top-level v1 mirror when they disagree, persisting the fix to the metadata store (never the PNG).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {string} [filePath]
 * @param {string|undefined} raw readCardContent()'s own read result
 * @returns {Promise<string|undefined>} `raw`, or the corrected JSON string if a fix was applied
 */
async function correctFirstMesDriftOnRead(directories, avatar, filePath, raw) {
    if (raw === undefined) return raw;

    let card;
    try {
        card = JSON.parse(raw);
    } catch {
        return raw;
    }

    if (card.spec === undefined || _.isUndefined(card.data)) return raw;
    const v2FirstMes = card.data.first_mes;
    if (_.isUndefined(v2FirstMes) || (!_.isUndefined(card.first_mes) && String(card.first_mes) === String(v2FirstMes))) return raw;

    card.first_mes = v2FirstMes;
    const corrected = JSON.stringify(card);

    try {
        const stat = await fsPromises.stat(filePath ?? path.join(directories.characters, avatar));
        await upsertCharacterFromWrite(directories, avatar, corrected, stat.mtimeMs);
    } catch (err) {
        console.debug(`[first-mes-repair] Could not persist the fix for "${avatar}" (will just retry on its next read):`, err.message);
    }

    return corrected;
}

/**
 * Builds a shareable PNG with a CURRENT tEXt chunk, even when the stored file's chunk is stale. In-memory only - never writes the character's own file.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar Avatar filename, e.g. `Alice.png`
 * @param {string} [filePath] The card's path, when the caller already built it.
 * @returns {Promise<{ buffer: Buffer, cardJson: string }|null>} `null` when the card can't be read at all.
 */
export async function materializeCardPng(directories, avatar, filePath = undefined) {
    const imagePath = filePath ?? path.join(directories.characters, avatar);
    const rawBuffer = await fsPromises.readFile(imagePath);
    const parked = await getCharacterCardJson(directories, avatar);
    if (parked === null) {
        const cardJson = read(rawBuffer);
        return cardJson === undefined || cardJson === null ? null : { buffer: rawBuffer, cardJson };
    }
    return { buffer: write(rawBuffer, parked), cardJson: parked };
}

/**
 * Never lets a metadata-store failure fail the character save itself.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar Filename (with .png) that was just written
 * @param {string} data The Spec-V2 JSON string that was just written
 * @param {string|null} [contentHash]
 * @param {string|null} [avatarIdentityHash] `null` means "don't touch whatever is already stored", not "clear it".
 * @returns {Promise<void>}
 */
export async function fireMetadataUpsertHook(directories, avatar, data, contentHash = null, avatarIdentityHash = null) {
    try {
        const stat = await fsPromises.stat(path.join(directories.characters, avatar));
        await upsertCharacterFromWrite(directories, avatar, data, stat.mtimeMs, contentHash, avatarIdentityHash);
    } catch (err) {
        // The reconciler only picks up files with no row yet, so a stale existing row is invisible to it.
        console.error(`[character-metadata] Failed to update the metadata store for "${avatar}" after its character write succeeded. The row is now STALE and nothing will repair it automatically - re-save the character, or run POST /api/characters/metadata/rescan.`, err);
    }
}

/**
 * Finds a DIFFERENT on-disk character with a matching `content_identity_hash`, as a reflink candidate for writeCharacterData(). Only a candidate PATH - byte-level verification still happens in writeCardFromChunks().
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} selfAvatar This write's own avatar filename - excluded from the match.
 * @param {string} data The Spec-V2 JSON string about to be written.
 * @returns {Promise<string | null>} Absolute path to a different character's current file, or `null`.
 */
async function findCrossCharacterReflinkCandidate(directories, selfAvatar, data) {
    let character;
    try {
        character = JSON.parse(data);
    } catch (error) {
        return null;
    }

    const hash = computeContentIdentityHash(character);
    const matchedId = await findCharacterIdByContentIdentityHash(directories, hash);
    if (!matchedId || matchedId === selfAvatar) {
        return null;
    }

    const candidatePath = path.join(directories.characters, matchedId);
    try {
        await fsPromises.access(candidatePath, fs.constants.R_OK);
    } catch (error) {
        return null;
    }
    return candidatePath;
}

/**
 * Writes the character card to the specified image file.
 * @param {string|Buffer} inputFile - Path to the image file or image buffer
 * @param {string} data - Character card data
 * @param {string} outputFile - Target image file name
 * @param {import('express').Request} request - Express request obejct
 * @param {Crop|undefined} crop - Crop parameters
 * @param {string|null} [contentHash] - sha256 hex digest of the raw uploaded source-file bytes, when this write came from `/import`.
 * @param {Set<string>|null} [freshFieldPaths] - V2 dot-paths the caller has already confirmed match current on-disk state.
 * @returns {Promise<true>} Always resolves to `true` on success - a failed write rejects instead.
 */
async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined, contentHash = null, freshFieldPaths = null) {
    try {
        const oldDiskCacheKey = (useDiskCache && !Buffer.isBuffer(inputFile)) ? getCacheKey(inputFile) : null;
        /**
         * Read the image, resize, and save it as a PNG into the buffer.
         * @returns {Promise<Buffer>} Image buffer
         */
        async function getInputImage() {
            try {
                if (Buffer.isBuffer(inputFile)) {
                    return await parseImageBuffer(inputFile, crop);
                }

                return await tryReadImage(inputFile, crop);
            } catch (error) {
                const message = Buffer.isBuffer(inputFile) ? 'Failed to read image buffer.' : `Failed to read image: ${inputFile}.`;
                console.warn(message, 'Using a fallback image.', error);
                return await fs.promises.readFile(DEFAULT_AVATAR_PATH);
            }
        }

        const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);

        // Guards against a stale in-memory empty alternate_greetings clobbering a non-empty one on disk.
        try {
            const incomingCard = JSON.parse(data);
            const incomingGreetings = incomingCard?.data?.alternate_greetings;
            const greetingsVerifiedFresh = freshFieldPaths instanceof Set && freshFieldPaths.has('data.alternate_greetings');
            if (!greetingsVerifiedFresh && Array.isArray(incomingGreetings) && incomingGreetings.length === 0 && fs.existsSync(outputImagePath)) {
                const existingRaw = await readCardContent(request.user.directories, `${outputFile}.png`, outputImagePath);
                const existingCard = JSON.parse(existingRaw);
                const existingGreetings = existingCard?.data?.alternate_greetings;
                if (Array.isArray(existingGreetings) && existingGreetings.length > 0) {
                    console.warn(`[writeCharacterData] Refusing to overwrite non-empty alternate_greetings with an empty array for "${outputFile}.png" - kept ${existingGreetings.length} existing greeting(s) (safety guard against an in-memory-empty read bug; no verified-fresh signal was passed for this write).`);
                    incomingCard.data.alternate_greetings = existingGreetings;
                    data = JSON.stringify(incomingCard);
                }
            }
        } catch (guardError) {
            // Can't compare - don't block the write on the guard itself.
        }

        // Must not touch the PNG's mtime, or the watcher/reconciler treats it as external drift and rolls it back to the stale chunk.
        const isMetadataOnlyWrite = !Buffer.isBuffer(inputFile)
            && crop === undefined
            && path.resolve(inputFile) === path.resolve(outputImagePath)
            && fs.existsSync(outputImagePath);

        if (isMetadataOnlyWrite) {
            const stat = await fsPromises.stat(outputImagePath);
            await upsertCharacterFromWrite(request.user.directories, `${outputFile}.png`, data, stat.mtimeMs, contentHash, null)
                .catch(err => console.error('[character-metadata] Failed to persist a metadata-only character write:', err));
            if (oldDiskCacheKey) await diskCache.invalidateKey(oldDiskCacheKey);
            return true;
        }

        // Fast path: unchanged image bytes reflink straight from inputFile instead of a full rewrite.
        if (!Buffer.isBuffer(inputFile) && crop === undefined) {
            try {
                const crossReflinkCandidatePath = await findCrossCharacterReflinkCandidate(request.user.directories, `${outputFile}.png`, data);
                const { avatarIdentityHash } = await writeCardToFile(inputFile, outputImagePath, data, crossReflinkCandidatePath);
                await fireMetadataUpsertHook(request.user.directories, `${outputFile}.png`, data, contentHash, avatarIdentityHash);
                if (oldDiskCacheKey) await diskCache.invalidateKey(oldDiskCacheKey);
                return true;
            } catch (error) {
                console.warn(`writeCardToFile failed for ${inputFile}, falling back to the full read/re-encode path.`, error);
            }
        }

        const inputImage = await getInputImage();

        // Get the chunks
        const outputImage = write(inputImage, data);
        // Slow path (buffer upload, or a real crop) - no on-disk chunk list to reuse, so hash the built buffer.
        const avatarIdentityHash = computeAvatarIdentityHashFromImageBuffer(outputImage);

        writeFileAtomicSync(outputImagePath, outputImage);

        await fireMetadataUpsertHook(request.user.directories, `${outputFile}.png`, data, contentHash, avatarIdentityHash);
        if (oldDiskCacheKey) await diskCache.invalidateKey(oldDiskCacheKey);

        return true;
    } catch (err) {
        console.error(err);
        throw err;
    }
}

/**
 * @typedef {Object} Crop
 * @property {number} x X-coordinate
 * @property {number} y Y-coordinate
 * @property {number} width Width
 * @property {number} height Height
 * @property {boolean} want_resize Resize the image to the standard avatar size
 */

/**
 * Applies avatar crop and resize operations to an image.
 * I couldn't fix the type issue, so the first argument has {any} type.
 * @param {object} jimp Jimp image instance
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Processed image buffer
 */
export async function applyAvatarCropResize(jimp, crop) {
    if (!(jimp instanceof Jimp)) {
        throw new TypeError('Expected a Jimp instance');
    }

    const image = /** @type {InstanceType<typeof Jimp>} */ (jimp);
    let finalWidth = image.bitmap.width, finalHeight = image.bitmap.height;

    // Apply crop if defined
    if (typeof crop == 'object' && [crop.x, crop.y, crop.width, crop.height].every(x => typeof x === 'number')) {
        image.crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height });
        // Apply standard resize if requested
        if (crop.want_resize) {
            finalWidth = AVATAR_WIDTH;
            finalHeight = AVATAR_HEIGHT;
        } else {
            finalWidth = crop.width;
            finalHeight = crop.height;
        }
    }

    image.cover({ w: finalWidth, h: finalHeight });
    return await image.getBuffer(JimpMime.png);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parses an image buffer and applies crop if defined. Skips the Jimp round trip (and its re-encode churn)
 * when no crop is requested and `buffer` is already a PNG.
 * @param {Buffer} buffer Buffer of the image
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function parseImageBuffer(buffer, crop) {
    if (crop === undefined && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return buffer;
    }
    const image = await Jimp.fromBuffer(buffer);
    return await applyAvatarCropResize(image, crop);
}

/**
 * Reads an image file and applies crop if defined. Same no-op-reencode avoidance as parseImageBuffer().
 * @param {string} imgPath Path to the image file
 * @param {Crop|undefined} crop Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function tryReadImage(imgPath, crop) {
    if (crop === undefined) {
        try {
            const raw = await fs.promises.readFile(imgPath);
            if (raw.subarray(0, 8).equals(PNG_SIGNATURE)) {
                return raw;
            }
        } catch (error) {
            // Fall through to the Jimp path below, which has its own error handling.
        }
    }
    try {
        const rawImg = await Jimp.read(imgPath);
        return await applyAvatarCropResize(rawImg, crop);
    } catch (error) {
        // If it's an unsupported type of image (APNG) - just read the file as buffer
        console.error(`Failed to read image: ${imgPath}`, error);
        return fs.readFileSync(imgPath);
    }
}

/**
 * processCharacter - Process a given character, read its data and calculate its statistics.
 *
 * @param  {string} item The name of the character.
 * @param  {import('../users.js').UserDirectoryList} directories User directories
 * @param  {object} options Options for the character processing
 * @param  {boolean} options.shallow If true, only return the core character's metadata
 * @return {Promise<object>}     A Promise that resolves when the character processing is done.
 */
export const processCharacter = async (item, directories, { shallow, cardJson = undefined }) => {
    try {
        const imgFile = path.join(directories.characters, item);
        // Reused for both the cache key and date_added; left undefined on ENOENT.
        let charStat;
        try {
            charStat = fs.statSync(imgFile);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        // `cardJson`: `undefined` means resolve it here; `null` means the caller already resolved it (file is current); a value is a prefetched hit.
        const imgData = cardJson === undefined
            ? await readCardContent(directories, item, imgFile, charStat)
            : (cardJson ?? await readCharacterData(imgFile, 'png', charStat));
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character.json_data = imgData;
        character.date_added = charStat.ctimeMs;
        character.create_date = jsonObject.create_date || new Date(Math.round(charStat.ctimeMs)).toISOString();
        const charDirName = item.replace('.png', '');
        const chatsDirectory = charDirName ? path.join(directories.chats, charDirName) : null;

        const { chatSize, dateLastChat } = chatsDirectory ? calculateChatSize(chatsDirectory) : { chatSize: 0, dateLastChat: 0 };
        character.chat_size = chatSize;
        character.date_last_chat = dateLastChat;
        character.data_size = calculateDataSize(jsonObject?.data);
        return shallow ? toShallow(character) : character;
    } catch (err) {
        console.error(`Could not process character: ${item}`);

        if (err instanceof SyntaxError) {
            console.error(`${item} does not contain a valid JSON object.`);
        } else {
            console.error('An unexpected error occurred: ', err);
        }

        return {
            date_added: 0,
            date_last_chat: 0,
            chat_size: 0,
        };
    }
};

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
    const fileName = preservedFileName || mintCharacterId(context.request.user.directories);
    let char = convertToV2({
        'name': yamlData.name,
        'description': yamlData.context ?? '',
        'first_mes': yamlData.greeting ?? '',
        'create_date': new Date().toISOString(),
        'chat': `${yamlData.name} - ${humanizedDateTime()}`,
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
    await writeCharacterData(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request, undefined, context.contentHash);
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

    const fileName = preservedFileName || mintCharacterId(request.user.directories);
    // Use the actual character name for asset folders, not the unique filename
    // ST's sprite system looks up by character name, not PNG filename
    const characterFolder = processedCard.name;

    if (auxiliaryAssets.length > 0) {
        try {
            const summary = persistCharXAssets(auxiliaryAssets, extractedBuffers, request.user.directories, characterFolder);
            if (summary.sprites || summary.backgrounds || summary.misc) {
                console.log(`CharX: Imported ${summary.sprites} sprite(s), ${summary.backgrounds} background(s), ${summary.misc} misc asset(s) for ${characterFolder}`);
            }
        } catch (error) {
            console.warn(`CharX: Failed to persist auxiliary assets for ${characterFolder}`, error);
        }
    }

    await writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request, undefined, contentHash);
    return fileName;
}

/**
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|null} [params.contentHash] sha256 hex digest of the uploaded .byaf file's raw bytes (bulk-import dedup)
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromByaf(uploadPath, { request, contentHash }, preservedFileName) {
    const data = getArrayBufferSlice(await fsPromises.readFile(uploadPath));
    await fsPromises.unlink(uploadPath);

    const byafData = await new ByafParser(data).parse();
    const card = readFromV2(byafData.card);
    omitInstallLocalFields(card);
    const fileName = preservedFileName || mintCharacterId(request.user.directories);

    // Don't import chats and images if the character is being replaced or updated, instead of newly imported.
    if (!preservedFileName) {
        /**
         * @param {Partial<ByafScenario>} scenario
        */
        const createChatAsCurrentPersona = (scenario) => {
            const chatName = sanitize(`${scenario.title || card.name} - ${humanizedDateTime()} imported.jsonl`, { replacement: sanitizeSafeCharacterReplacements });
            const filePath = path.join(request.user.directories.chats, path.basename(fileName), chatName);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            writeFileAtomicSync(filePath, ByafParser.getChatFromScenario(scenario, request.body.user_name, card.name, byafData.chatBackgrounds), 'utf8');
            console.log(`Created ${chatName} chat from BYAF import`);
            return chatName;
        };

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
                console.log(`Created ${newFile} background from BYAF import`);
            }
        }

        const chats = [];
        // Create chats for each scenario
        if (Array.isArray(byafData.scenarios)) {
            for (const scenario of byafData.scenarios) {
                chats.push(createChatAsCurrentPersona(scenario));
            }
        }

        // Update the default chat if there are any so we open to an existing chat instead of creating a new one and opening that.
        if (chats.length > 0) {
            card.chat = path.basename(chats[0], path.extname(chats[0]));
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
                console.log(`Created ${file}${extension} alternate icon from BYAF import`);
            }
        }
    }

    await writeCharacterData(byafData.images[0].image, JSON.stringify(card), fileName, request, undefined, contentHash);

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

    const data = buildJsonImportData(rawText, request.user.directories);
    if (data === null) return '';

    const pngName = preservedFileName || mintCharacterId(request.user.directories);
    await writeCharacterData(DEFAULT_AVATAR_PATH, data, pngName, request, undefined, contentHash);
    return pngName;
}

/**
 * Pure (no file I/O, no sqlite) counterpart to importFromJson()'s per-spec logic above.
 * @param {string} rawText Raw JSON text
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string | null} The final Spec V2 JSON string, or `null` if `rawText` matches no recognized shape.
 */
export function buildJsonImportData(rawText, directories) {
    let jsonData = JSON.parse(rawText);

    if (jsonData.spec !== undefined) {
        importRisuSprites(directories, jsonData);
        importChubExpressions(directories, jsonData);
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
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
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
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
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

    const data = buildPngImportData(imgData, request.user.directories);
    if (data === null) return '';

    const pngName = preservedFileName || mintCharacterId(request.user.directories);
    // Temp upload gets cleaned up whether the write succeeds or throws.
    try {
        await writeCharacterData(uploadPath, data, pngName, request, undefined, contentHash);
    } finally {
        fs.unlinkSync(uploadPath);
    }
    return pngName;
}

/**
 * Pure (no file I/O, no sqlite) counterpart to importFromPng()'s per-spec logic above.
 * @param {string} rawText Raw embedded card JSON text
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string | null} The final Spec V2 JSON string, or `null` if `rawText` has neither `spec` nor `name`.
 */
export function buildPngImportData(rawText, directories) {
    let jsonData = JSON.parse(rawText);

    // Read the pre-sanitize name once: sanitize() can turn an all-illegal name into '', and re-reading it
    // after that mutation would wrongly fall through to jsonData.name (usually undefined on v2/v3 cards).
    const rawName = jsonData.data?.name || jsonData.name;
    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(String(rawName || ''));

    if (jsonData.spec !== undefined) {
        importRisuSprites(directories, jsonData);
        importChubExpressions(directories, jsonData);
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
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
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

        // Favorite status is db-authoritative once a row exists; the card written below never carries `fav`.
        const initialFav = request.body.fav === 'true' || request.body.fav === true;
        const charaData = charaFormatData(request.body, request.user.directories);
        omitFavField(charaData);
        const char = JSON.stringify(charaData);
        const internalName = request.body.file_name || mintCharacterId(request.user.directories);
        const avatarName = `${internalName}.png`;
        const chatsPath = path.join(request.user.directories.chats, internalName);

        if (!fs.existsSync(chatsPath)) fs.mkdirSync(chatsPath);

        if (!request.file) {
            await writeCharacterData(DEFAULT_AVATAR_PATH, char, internalName, request);
        } else {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            // Temp upload gets cleaned up whether the write succeeds or throws.
            try {
                await writeCharacterData(uploadPath, char, internalName, request, crop);
            } finally {
                fs.unlinkSync(uploadPath);
            }
        }

        if (initialFav) {
            await setCharacterFav(request.user.directories, avatarName, true);
        }
        return response.send(avatarName);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

/**
 * "Rename" a character. The avatar filename is the immutable id, so this is a pure card-data edit - no file move, no chats-directory copy.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {Promise<void>}
 */
router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const avatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);
    const avatarPath = path.join(request.user.directories.characters, avatarName);

    try {
        const rawData = await readCardContent(request.user.directories, avatarName, avatarPath);
        if (rawData === undefined) throw new Error('Failed to read character file');

        const data = getCharaCardV2(JSON.parse(rawData), request.user.directories);
        _.set(data, 'data.name', newName);
        _.set(data, 'name', newName);
        const newData = JSON.stringify(data);

        // Leaves date_added frozen.
        await writeCharacterData(avatarPath, newData, path.parse(avatarName).name, request);

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

    // Per-field content-hash conflict detection: rejects with 409 if a field group the client loaded has since changed.
    const contentHashesHeader = request.headers['x-content-hashes'];
    let freshFieldPaths = null;
    if (contentHashesHeader) {
        try {
            const clientHashes = JSON.parse(contentHashesHeader);
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            const currentCardJson = await readCardContent(request.user.directories, request.body.avatar_url, avatarPath);
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
                // The body hash covers alternate_greetings, so a match confirms this request's view is current.
                if (clientHashes.body !== undefined) {
                    freshFieldPaths = new Set(['data.alternate_greetings']);
                }
            }
        } catch (err) {
            console.warn('[characters/edit] Failed to parse content hashes header, skipping conflict check:', err);
        }
    }

    let char = charaFormatData(request.body, request.user.directories);
    // fav/chat are db-authoritative once a row exists; kept out of the card.
    const requestedChat = request.body.chat;
    char.create_date = request.body.create_date;
    omitFavField(char);
    omitChatField(char);
    char = JSON.stringify(char);
    let targetFile = (request.body.avatar_url).replace('.png', '');

    try {
        if (!request.file) {
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            await writeCharacterData(avatarPath, char, targetFile, request, undefined, null, freshFieldPaths);
        } else {
            const crop = tryParse(request.query.crop);
            const newAvatarPath = path.join(request.file.destination, request.file.filename);
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
            // Temp upload gets cleaned up whether the write succeeds or throws.
            try {
                await writeCharacterData(newAvatarPath, char, targetFile, request, crop, null, freshFieldPaths);
            } finally {
                fs.unlinkSync(newAvatarPath);
            }

            // Bust cache to reload the new avatar
            cacheBuster.bust(request, response);
        }

        if (typeof requestedChat === 'string' && requestedChat !== '') {
            await setCharacterActiveChat(request.user.directories, request.body.avatar_url, requestedChat);
        }

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
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
        const characterPath = path.join(request.user.directories.characters, request.body.avatar_url);
        if (!fs.existsSync(characterPath)) {
            return response.status(400).send('Error: character file does not exist');
        }
        const data = await readCardContent(request.user.directories, request.body.avatar_url, characterPath);
        if (!data) {
            return response.status(400).send('Error: failed to read character data');
        }

        const crop = tryParse(request.query.crop);
        const fileName = request.body.avatar_url.replace('.png', '');
        // Temp upload gets cleaned up whether the write succeeds or throws.
        try {
            await writeCharacterData(uploadPath, data, fileName, request, crop);
        } finally {
            fs.unlinkSync(uploadPath);
        }

        // Reset images caches
        cacheBuster.bust(request, response);
        invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred while editing avatar', err);
        return response.sendStatus(500);
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
        const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
        const charJSON = await readCardContent(request.user.directories, request.body.avatar_url, avatarPath);
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
        let newCharJSON = JSON.stringify(char);
        const targetFile = (request.body.avatar_url).replace('.png', '');
        await writeCharacterData(avatarPath, newCharJSON, targetFile, request);
        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    }
});

/** Signals a field should be deleted rather than set, without overloading `null`. Shared with the frontend. */
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
 * @param {string} avatarPath Full path to the character PNG
 * @param {string} avatar     Avatar filename (e.g. "char.png")
 * @param {object} updateData The merge payload to apply
 * @param {import("express").Request} request Express request object
 * @param {((data: any) => boolean) | null} [shouldSkip] Used for bulk merge filtering.
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean, hashes?: Object<string, number>}>}
 */
async function mergeCharacterUpdate(avatarPath, avatar, updateData, request, shouldSkip = null) {
    const pngStringData = await readCardContent(request.user.directories, avatar, avatarPath);
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

    // Greetings must go through the named /greetings/* operations instead, which enforce no empty entries,
    // stable order, and a tracked default. /edit is exempt - it takes a whole card, not a merge.
    const forbiddenGreetingPaths = ['data.alternate_greetings', 'data.first_mes', 'alternate_greetings', 'first_mes'];
    const touchedGreetingPaths = forbiddenGreetingPaths.filter(p => _.has(update, p));
    if (touchedGreetingPaths.length > 0) {
        return { ok: false, error: 'greeting-fields-forbidden', touchedGreetingPaths };
    }

    // Per-field conflict detection: compare cyrb53 hashes the client loaded against the current card, and
    // report a conflict only for fields the client is actually writing.
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

    // fav/chat are db-authoritative once a row exists; kept out of the card file and applied after the write below.
    const favRequested = _.has(update, 'fav') || _.has(update, 'data.extensions.fav');
    const chatRequested = _.has(update, 'chat');

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);
    const requestedFav = !!(character.fav ?? _.get(character, 'data.extensions.fav'));
    const requestedChat = character.chat;
    omitFavField(character);
    omitChatField(character);

    const validator = new TavernCardValidator(character);
    //Accept either V1 or V2.
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const targetImg = avatar.replace('.png', '');
    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request, undefined, null, freshFieldPaths);
    if (favRequested) {
        await setCharacterFav(request.user.directories, avatar, requestedFav);
    }
    if (chatRequested && typeof requestedChat === 'string' && requestedChat !== '') {
        await setCharacterActiveChat(request.user.directories, avatar, requestedChat);
    }

    // Server is the sole source of the conflict-detection hash: for every field the caller echoed a loaded hash
    // for, hand back a fresh one computed off the just-written value, so the caller's next edit round has an
    // up-to-date baseline it never had to compute itself. Additive - omitted entirely when the caller didn't
    // opt in by sending _loadedFieldHashes, so callers that don't care about hashes see no response-shape change.
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
                const files = fs.readdirSync(request.user.directories.characters);
                targetAvatars = files.filter(file => path.extname(file).toLowerCase() === '.png');
            }

            const updated = [];
            const skipped = [];
            const failed = [];

            const processOne = async (avatar) => {
                const avatarPath = path.join(request.user.directories.characters, avatar);

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

                    const result = await mergeCharacterUpdate(avatarPath, avatar, data, request, shouldSkip);
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

            for (let i = 0; i < targetAvatars.length; i += BULK_MERGE_CONCURRENCY) {
                const batch = targetAvatars.slice(i, i + BULK_MERGE_CONCURRENCY);
                await Promise.allSettled(batch.map(processOne));
            }

            return response.send({ updated, skipped, failed });
        }

        // ── Single mode (default behavior) ───────────────────────
        const update = request.body;
        const avatarPath = path.join(request.user.directories.characters, update.avatar);

        const result = await mergeCharacterUpdate(avatarPath, update.avatar, update, request);
        if (result.ok) {
            // Additive: only present when the request opted in via _loadedFieldHashes, so a caller that never
            // sends that (and therefore never reads this) sees the exact same `200, no body` shape as before.
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

// Named, position-addressed operations on a character's greeting list; ops targeting an existing greeting carry a precondition hash and refuse rather than guess on mismatch.

/**
 * Reads a character card fresh from disk, applies a single greeting-list operation, and writes it back.
 * @param {import('express').Request} request
 * @param {string} avatar avatar filename (e.g. "char.png")
 * @param {(model: import('../greeting-list.js').GreetingsModel) => {ok: boolean, reason?: string, model?: import('../greeting-list.js').GreetingsModel}} op
 * @returns {Promise<{ok: boolean, reason?: string, status?: number, hashes?: number[], defaultPosition?: number|null}>}
 */
async function applyGreetingOperation(request, avatar, op) {
    const avatarPath = path.join(request.user.directories.characters, avatar);
    const pngStringData = await readCardContent(request.user.directories, avatar, avatarPath);
    if (!pngStringData) {
        return { ok: false, reason: 'character not found', status: 404 };
    }

    const character = JSON.parse(pngStringData);
    const model = cardToGreetingsModel(character);
    const result = op(model);
    if (!result.ok) {
        return { ok: false, reason: result.reason, status: 409 };
    }

    applyGreetingsModelToCard(character, result.model);

    const validator = new TavernCardValidator(character);
    if (!validator.validate()) {
        return { ok: false, reason: validator.lastValidationError ?? 'validation failed', status: 500 };
    }

    const targetImg = avatar.replace('.png', '');
    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request, undefined, null, new Set(['data.alternate_greetings']));

    return {
        ok: true,
        hashes: result.model.greetings.map(hashGreetingText),
        defaultPosition: result.model.defaultIndex,
    };
}

/**
 * On success, echoes back the post-op hash-per-position list and default position so a caller can chain further operations without re-fetching the card.
 * @param {import('express').Response} response
 * @param {Awaited<ReturnType<typeof applyGreetingOperation>>} result
 */
function sendGreetingOpResult(response, result) {
    if (!result.ok) {
        return response.status(result.status ?? 409).send({ ok: false, reason: result.reason });
    }
    return response.status(200).send({ ok: true, hashes: result.hashes, default_position: result.defaultPosition });
}

/**
 * Inserts a new greeting at `position` (length appends at the end). No precondition hash and no content dedup - two identical greetings are legitimate on a card.
 */
router.post('/greetings/add', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const text = request.body.text;
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (typeof text !== 'string') return response.status(400).send({ ok: false, reason: 'text is required' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });

        const result = await applyGreetingOperation(request, avatar, model => opAdd(model, position, text));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error adding greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/** Replaces the text of the greeting at `position`. Refuses empty text and a stale `expected_hash`. */
router.post('/greetings/edit', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const expectedHash = Number(request.body.expected_hash);
        const text = request.body.text;
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (typeof text !== 'string') return response.status(400).send({ ok: false, reason: 'text is required' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request, avatar, model => opEdit(model, position, expectedHash, text));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error editing greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/**
 * Removes the greeting at `position`. Removing the current default clears default-ness rather than
 * picking a successor.
 */
router.post('/greetings/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const expectedHash = Number(request.body.expected_hash);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request, avatar, model => opDelete(model, position, expectedHash));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error deleting greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/**
 * Moves the greeting at `source_position` to `target_position` (both read against the list's current, pre-removal state; `length` means "move to the end").
 */
router.post('/greetings/move', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const sourcePosition = Number(request.body.source_position);
        const expectedHash = Number(request.body.expected_hash);
        const targetPosition = Number(request.body.target_position);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (!Number.isInteger(sourcePosition)) return response.status(400).send({ ok: false, reason: 'source_position must be an integer' });
        if (!Number.isInteger(targetPosition)) return response.status(400).send({ ok: false, reason: 'target_position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request, avatar, model => opMove(model, sourcePosition, expectedHash, targetPosition));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error moving greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/** Makes the greeting at `position` the default. Never reorders anything. */
router.post('/greetings/default/set', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        const position = Number(request.body.position);
        const expectedHash = Number(request.body.expected_hash);
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });
        if (!Number.isInteger(position)) return response.status(400).send({ ok: false, reason: 'position must be an integer' });
        if (!Number.isFinite(expectedHash)) return response.status(400).send({ ok: false, reason: 'expected_hash is required' });

        const result = await applyGreetingOperation(request, avatar, model => opSetDefault(model, position, expectedHash));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error setting default greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/**
 * Clears the default entirely - no default greeting at all. The list keeps its order and membership.
 * Doesn't address a position, so it carries no precondition hash.
 */
router.post('/greetings/default/unset', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        if (!avatar) return response.status(400).send({ ok: false, reason: 'avatar_url is required' });

        const result = await applyGreetingOperation(request, avatar, model => opUnsetDefault(model));
        return sendGreetingOpResult(response, result);
    } catch (error) {
        console.error('Error unsetting default greeting:', error);
        return response.status(500).send({ ok: false, reason: 'internal error' });
    }
});

/**
 * Touches only the `fav` column, no card read/write. 404s (not 400) when the avatar isn't tracked yet.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/fav', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        const { avatar, fav } = request.body ?? {};
        if (typeof avatar !== 'string' || !avatar) {
            return response.status(400).send({ error: true, reason: 'avatar-required' });
        }
        const updated = await setCharacterFav(request.user.directories, avatar, fav === true || fav === 'true');
        if (!updated) {
            return response.status(404).send({ error: true, reason: 'not-tracked' });
        }
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/fav] Failed to update favorite status:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Dedicated chat-pointer write path, mirroring POST /fav: touches only the `active_chat` column.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/chat', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        const { avatar, chat } = request.body ?? {};
        if (typeof avatar !== 'string' || !avatar) {
            return response.status(400).send({ error: true, reason: 'avatar-required' });
        }
        // An empty string (or explicit null) is a real, valid pointer value now: "this character has
        // no active chat right now" - not an error. A character's conversation needs no name/id
        // until the user labels a point in it (Workstream 6), so callers must be able to persist
        // "no active chat" the same way they persist a real one. Only a missing/wrong-typed `chat`
        // (the field absent from the body entirely, or not a string) is a malformed request.
        if (chat !== null && typeof chat !== 'string') {
            return response.status(400).send({ error: true, reason: 'chat-required' });
        }
        const updated = await setCharacterActiveChat(request.user.directories, avatar, chat || null);
        if (!updated) {
            return response.status(404).send({ error: true, reason: 'not-tracked' });
        }
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/chat] Failed to update active chat pointer:', err);
        return response.status(500).send({ error: true });
    }
});

/** Sets `allow_global_styles`. Accepts `{ avatar, allowed }` for one character or `{ bulk: [{ avatar, allowed }, ...] }` for a batch. */
router.post('/allow-global-styles', async function (request, response) {
    try {
        const { avatar, allowed, bulk } = request.body ?? {};

        if (Array.isArray(bulk)) {
            for (const entry of bulk) {
                if (typeof entry.avatar === 'string' && entry.avatar) {
                    await setCharacterAllowGlobalStyles(request.user.directories, entry.avatar, entry.allowed === true || entry.allowed === 'true');
                }
            }
            return response.sendStatus(204);
        }

        if (typeof avatar !== 'string' || !avatar) {
            return response.status(400).send({ error: true, reason: 'avatar-required' });
        }
        const updated = await setCharacterAllowGlobalStyles(request.user.directories, avatar, allowed === true || allowed === 'true');
        if (!updated) {
            return response.status(404).send({ error: true, reason: 'not-tracked' });
        }
        return response.sendStatus(204);
    } catch (err) {
        console.error('[characters/allow-global-styles] Failed to update:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body || !request.body.avatar_url) {
        return response.sendStatus(400);
    }

    if (request.body.avatar_url !== sanitize(request.body.avatar_url)) {
        console.error('Malicious filename prevented');
        return response.sendStatus(403);
    }

    const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
    if (!fs.existsSync(avatarPath)) {
        return response.sendStatus(400);
    }

    const dir_name = request.body.avatar_url.replace('.png', '');

    fs.unlinkSync(avatarPath);
    invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
    await deleteCharacterRow(request.user.directories, request.body.avatar_url).catch(err =>
        console.error('[character-metadata] Failed to update metadata store after a character delete (the reconciler will catch it):', err));

    if (request.body.delete_chats == true && dir_name) {
        try {
            await fs.promises.rm(path.join(request.user.directories.chats, sanitize(dir_name)), { recursive: true, force: true });
        } catch (err) {
            console.error(err);
            return response.sendStatus(500);
        }
    }

    return response.sendStatus(200);
});

/**
 * Fields a shallow (and full) character carries that are cheap/stable enough to sort the list by
 * without having to hydrate anything extra. Keys are the accepted `sortField` values.
 * @type {{[sortField: string]: (character: object) => (string|number)}}
 */
const SORT_FIELD_GETTERS = {
    name: (c) => (c.data?.name ?? c.name ?? '').toLowerCase(),
    date_added: (c) => c.date_added ?? 0,
    date_last_chat: (c) => c.date_last_chat ?? 0,
    chat_size: (c) => c.chat_size ?? 0,
};

/**
 * Applies optional sort/offset/limit to an already-fully-read character array. `{}` is a no-op.
 * @param {object[]} data Full array of processed characters (already filtered to `c.name` truthy)
 * @param {object} params
 * @param {string} [params.sortField] One of SORT_FIELD_GETTERS' keys. Unknown/omitted -> no sort applied.
 * @param {string} [params.sortOrder] 'asc' (default) or 'desc'.
 * @param {number} [params.offset] Slice start. Omitted/NaN -> 0.
 * @param {number} [params.limit] Slice length. Omitted/NaN -> no limit (rest of the array).
 * @returns {{ items: object[], total: number }} `total` is the count before offset/limit.
 */
function paginateCharacters(data, { sortField, sortOrder, offset, limit } = {}) {
    const total = data.length;
    const getter = SORT_FIELD_GETTERS[sortField];
    if (getter) {
        const direction = sortOrder === 'desc' ? -1 : 1;
        // Stable sort so same-key entries keep their on-disk relative order across identical requests.
        data = [...data].sort((a, b) => {
            const av = getter(a), bv = getter(b);
            if (av < bv) return -1 * direction;
            if (av > bv) return 1 * direction;
            return 0;
        });
    }

    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const end = Number.isFinite(limit) && limit >= 0 ? start + limit : undefined;
    const items = (start > 0 || end !== undefined) ? data.slice(start, end) : data;
    return { items, total };
}

/**
 * Like paginateCharacters(), but merges in a groups array before sorting/slicing, producing one sorted list
 * of characters and groups together. SORT_FIELD_GETTERS' getters work unmodified on group objects.
 * @param {object[]} characters
 * @param {object[]} groups
 * @param {object} params Same shape as paginateCharacters()'s params
 * @param {string} [params.sortField]
 * @param {string} [params.sortOrder]
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @returns {{ items: {type: 'character'|'group', item: object}[], total: number }}
 */
function paginateEntities(characters, groups, { sortField, sortOrder, offset, limit } = {}) {
    let combined = [
        ...characters.map(item => ({ type: 'character', item })),
        ...groups.map(item => ({ type: 'group', item })),
    ];

    const getter = SORT_FIELD_GETTERS[sortField];
    if (getter) {
        const direction = sortOrder === 'desc' ? -1 : 1;
        combined = combined.sort((a, b) => {
            const av = getter(a.item), bv = getter(b.item);
            if (av < bv) return -1 * direction;
            if (av > bv) return 1 * direction;
            return 0;
        });
    }

    const total = combined.length;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const end = Number.isFinite(limit) && limit >= 0 ? start + limit : undefined;
    const items = (start > 0 || end !== undefined) ? combined.slice(start, end) : combined;
    return { items, total };
}

/**
 * Merges pre-scored character/group Fuse search results (best-first, ascending score) into one paginated,
 * still best-first result.
 * @param {import('fuse.js').FuseResult<object>[]} characterResults
 * @param {import('fuse.js').FuseResult<object>[]} groupResults
 * @param {object} params
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @param {number} [params.trueTotal] Real total match count - `combined.length` underreports since the inputs are already capped to the sliced page. Falls back to `combined.length` if omitted.
 * @returns {{ items: {type: 'character'|'group', item: object}[], total: number }}
 */
function paginateSearchResults(characterResults, groupResults, { offset, limit, trueTotal } = {}) {
    const combined = [
        ...characterResults.map(r => ({ type: 'character', item: r.item, score: r.score })),
        ...groupResults.map(r => ({ type: 'group', item: r.item, score: r.score })),
    ].sort((a, b) => a.score - b.score);

    const total = Number.isFinite(trueTotal) ? trueTotal : combined.length;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const end = Number.isFinite(limit) && limit >= 0 ? start + limit : undefined;
    const sliced = (start > 0 || end !== undefined) ? combined.slice(start, end) : combined;
    return { items: sliced.map(({ type, item }) => ({ type, item })), total };
}

/**
 * Accepts optional `sortField`/`sortOrder`/`offset`/`limit`/`search`/`includeGroups`/`fav` in the body for a paginated/searched page; no body returns every character in on-disk order (sort/offset/limit still reads every file, it only slices the response). `fav` with `search` is applied inside the search query itself, not as a post-fetch filter, so it can't miss a favorite ranked outside the fetched page.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
// Requests that omit `limit` still need a bound - unbounded search/includeGroups on a large library can OOM.
const DEFAULT_PAGE_LIMIT = 500;

/**
 * Overwrites each character's `.fav` with the metadata store's own value, in place. A character not yet tracked is left untouched.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object[]} characters Already-processed character objects (each with `.avatar` set) - mutated in place.
 * @returns {Promise<void>}
 */
async function stampDbFav(directories, characters) {
    const ids = characters.map(c => c.avatar).filter(Boolean);
    if (ids.length === 0) return;
    const favById = await getCharacterFavsByIds(directories, ids);
    for (const character of characters) {
        if (Object.prototype.hasOwnProperty.call(favById, character.avatar)) {
            character.fav = favById[character.avatar];
        }
    }
}

/**
 * Overwrites each character's `.chat` with the metadata store's own value, in place. Untracked or NULL `active_chat` is left untouched.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object[]} characters Already-processed character objects (each with `.avatar` set) - mutated in place.
 * @returns {Promise<void>}
 */
async function stampDbActiveChat(directories, characters) {
    const ids = characters.map(c => c.avatar).filter(Boolean);
    if (ids.length === 0) return;
    const chatById = await getCharacterActiveChatsByIds(directories, ids);
    for (const character of characters) {
        if (Object.prototype.hasOwnProperty.call(chatById, character.avatar)) {
            character.chat = chatById[character.avatar];
        }
    }
}

/**
 * Overwrites each character's `.tag_ids` with the metadata store's own value, in place - the PNG carries no tag assignments.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object[]} characters Already-processed character objects (each with `.avatar` set) - mutated in place.
 * @returns {Promise<void>}
 */
async function stampDbTagIds(directories, characters) {
    const ids = characters.map(c => c.avatar).filter(Boolean);
    if (ids.length === 0) return;
    const tagIdsById = await getCharacterTagIdsByIds(directories, ids);
    for (const character of characters) {
        if (Object.prototype.hasOwnProperty.call(tagIdsById, character.avatar)) {
            character.tag_ids = tagIdsById[character.avatar];
        }
    }
}

/**
 * Stamps each character's `allow_global_styles` from the DB, same pattern as stampDbFav().
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object[]} characters Already-processed character objects - mutated in place.
 * @returns {Promise<void>}
 */
async function stampDbAllowGlobalStyles(directories, characters) {
    const ids = characters.map(c => c.avatar).filter(Boolean);
    if (ids.length === 0) return;
    const allowedById = await getCharacterAllowGlobalStylesByIds(directories, ids);
    for (const character of characters) {
        if (Object.prototype.hasOwnProperty.call(allowedById, character.avatar)) {
            character.allow_global_styles = allowedById[character.avatar];
        }
    }
}

router.post('/all', async function (request, response) {
    try {
        const { sortField, sortOrder, offset, limit, search, includeGroups, fav } = request.body ?? {};
        const favOnly = fav === true;

        if (sortField === undefined && offset === undefined && limit === undefined && !search && !includeGroups) {
            const files = fs.readdirSync(request.user.directories.characters);
            const pngFiles = files.filter(file => file.endsWith('.png'));
            const staleCards = await getStaleCardJsonMap(request.user.directories);
            const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters, cardJson: staleCards.get(file) ?? null }));
            const data = (await Promise.all(processingPromises)).filter(c => 'name' in c);
            await stampDbFav(request.user.directories, data);
            await stampDbActiveChat(request.user.directories, data);
            await stampDbTagIds(request.user.directories, data);
            await stampDbAllowGlobalStyles(request.user.directories, data);
            // No pagination params at all: preserve the exact pre-existing response shape (a bare array).
            return response.send(data);
        }

        const numericOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
        const numericLimit = Number.isFinite(Number(limit)) ? Number(limit) : DEFAULT_PAGE_LIMIT;

        if (search) {
            const handle = request.user.profile.handle;
            // 'tantivy', not 'native': placeholder for "not searched" that never wins BACKEND_SEVERITY's worse-of comparison.
            const emptySearch = { results: [], total: 0, backend: 'tantivy' };
            // Each source fetches only its own top (offset + limit) rows; paginateSearchResults() below does the real merge.
            const searchFetchLimit = numericOffset + numericLimit;
            // favOnly is applied inside the query itself so it can't drop a match ranked outside searchFetchLimit.
            const [characterSearch, groupSearch] = await Promise.all([
                searchCharacters(handle, request.user.directories, search, searchFetchLimit, favOnly),
                includeGroups ? searchGroups(handle, request.user.directories, search, searchFetchLimit, favOnly) : emptySearch,
            ]);
            // The search index is built from full character data - trim to shallow fields to match this server's normal response shape.
            const finalCharacterResults = useShallowCharacters
                ? characterSearch.results.map(r => ({ ...r, item: toShallow(r.item) }))
                : characterSearch.results;
            // The search index's own `fav` copy can lag a db-only fav toggle (which never touches the card file).
            await stampDbFav(request.user.directories, finalCharacterResults.map(r => r.item));
            await stampDbActiveChat(request.user.directories, finalCharacterResults.map(r => r.item));
            await stampDbTagIds(request.user.directories, finalCharacterResults.map(r => r.item));
            await stampDbAllowGlobalStyles(request.user.directories, finalCharacterResults.map(r => r.item));

            const { items, total } = paginateSearchResults(finalCharacterResults, groupSearch.results, {
                offset: numericOffset, limit: numericLimit,
                trueTotal: characterSearch.total + groupSearch.total,
            });
            // Lets the client show an indicator when search runs on anything other than the fastest engine tier.
            const BACKEND_SEVERITY = { tantivy: 0, unavailable: 1 };
            const searchBackend = BACKEND_SEVERITY[groupSearch.backend] > BACKEND_SEVERITY[characterSearch.backend]
                ? groupSearch.backend
                : characterSearch.backend;
            const payload = includeGroups ? { items, total } : { items: items.map(x => x.item), total };
            payload.searchBackend = searchBackend;
            return response.send(payload);
        }

        const files = fs.readdirSync(request.user.directories.characters);
        const pngFiles = files.filter(file => file.endsWith('.png'));
        const staleCards = await getStaleCardJsonMap(request.user.directories);
        const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters, cardJson: staleCards.get(file) ?? null }));
        const data = (await Promise.all(processingPromises)).filter(c => c.name);
        await stampDbFav(request.user.directories, data);
        await stampDbActiveChat(request.user.directories, data);
        await stampDbTagIds(request.user.directories, data);
        await stampDbAllowGlobalStyles(request.user.directories, data);

        if (includeGroups) {
            const groupsData = getGroupsData(request.user.directories);
            const { items, total } = paginateEntities(data, groupsData, {
                sortField, sortOrder, offset: numericOffset, limit: numericLimit,
            });
            return response.send({ items, total });
        }

        const { items, total } = paginateCharacters(data, {
            sortField,
            sortOrder,
            offset: numericOffset,
            limit: numericLimit,
        });
        return response.send({ items, total });
    } catch (err) {
        console.error(err);
        const isRangeError = err instanceof RangeError;
        response.status(500).send({ overflow: isRangeError, error: true });
    }
});

/**
 * Forces an out-of-cycle pass of the metadata store's background reconciler for the calling user.
 * Not called by any client UI yet.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/metadata/rescan', async function (request, response) {
    try {
        await reconcileMetadataStore(request.user.directories);
        return response.sendStatus(204);
    } catch (err) {
        console.error('[character-metadata] Explicit rescan failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Wrap a scripted bulk import in `begin`/`end` to avoid one SQLite transaction and one directory-watcher event per file.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/metadata/batch-import/begin', async function (request, response) {
    try {
        await beginBatchImport(request.user.directories);
        return response.sendStatus(204);
    } catch (err) {
        console.error('[character-metadata] Failed to begin batch-import mode:', err);
        return response.status(500).send({ error: true });
    }
});

router.post('/metadata/batch-import/end', async function (request, response) {
    try {
        await endBatchImport(request.user.directories);
        return response.sendStatus(204);
    } catch (err) {
        console.error('[character-metadata] Failed to end batch-import mode:', err);
        return response.status(500).send({ error: true });
    }
});

// Sortable fields this HTTP layer accepts. 'random' and 'search' don't map to a plain SQL column sort.
const QUERY_SORT_FIELDS = new Set(['name', 'date_added', 'date_last_chat', 'chat_size', 'fav', 'create_date', 'data_size', 'random', 'search']);

const DEFAULT_QUERY_PAGE_SIZE = 500;
const MAX_QUERY_PAGE_SIZE = 2000;

/**
 * SQLite-backed replacement for `/all`; never touches the filesystem or parses a PNG. `sort.field: 'random'` requires a client-minted `sort.seed` (400s otherwise, since the seed must stay client-owned for stable pagination). `filter.includeGroups: true` merges groups into the same sorted, paginated result.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
/**
 * Turns queryEntities()'s raw UNION ALL rows into the `/query` route's wire shape - a group row only carries its SQL-side columns and needs its JSON hydrated separately.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{type: 'character'|'group', id: string, fav: boolean, date_added: number, date_last_chat: number, chat_size: number, item: object|null}[]} rows
 * @returns {Promise<{type: 'character'|'group', item: object}[]>}
 */
async function hydrateEntityRows(directories, rows) {
    const groupIds = rows.filter(r => r.type === 'group').map(r => r.id);
    const [groupsById, groupTagIdsById] = await Promise.all([
        groupIds.length > 0 ? getGroupsByIds(directories, groupIds) : {},
        groupIds.length > 0 ? getEntityTagIdsForMany(directories, groupIds) : {},
    ]);
    return rows.map(r => {
        if (r.type === 'character') {
            return { type: 'character', item: r.item };
        }
        const group = groupsById[r.id];
        if (!group) {
            // Metadata row exists but the group's JSON file doesn't.
            return null;
        }
        return { type: 'group', item: { ...group, fav: r.fav, date_added: r.date_added, date_last_chat: r.date_last_chat, chat_size: r.chat_size, tag_ids: groupTagIdsById?.[r.id] ?? [] } };
    }).filter(Boolean);
}

/** Search-backend enum codes for the binary hash-mode `/query` response. 0 means "absent". */
const HASH_QUERY_SEARCH_BACKEND_CODES = { tantivy: 1, native: 2, wasm: 3, unavailable: 4 };

/**
 * Serializes `/query`'s hash-only mode (`want: ['hashes']`) into a compact binary response. See
 * `deserializeQueryHashesBinary()` client-side (character-repository.js) for the matching decoder.
 *
 * Header (20 bytes): headerFlags(1) [bit0=hasTotal, bit1=totalApprox] + searchBackendCode(1) + seq(8, float64) +
 * total(8, float64, meaningful only if hasTotal) + rowCount(2, uint16).
 *
 * Per row: flags(1) [bit0=isGroup, bit1=hasCreateDate] + idLen(2) + id(idLen, utf8) + favHash(4) +
 * tagIdsHash(4) + contentHash(4) + date_added(8, float64) + create_date(8, float64, 0 if !hasCreateDate) +
 * date_last_chat(8, float64) + chat_size(8, float64) + data_size(8, float64) + chatLen(2) +
 * chat(chatLen, utf8, omitted if chatLen is 0).
 * @param {{seq:number, total:number|undefined, approxTotal:boolean, hashRows:object[], searchBackend?:string}} params
 * @returns {Buffer}
 */
function serializeQueryHashesBinary({ seq, total, approxTotal, hashRows, searchBackend }) {
    const hasTotal = typeof total === 'number';
    const searchBackendCode = HASH_QUERY_SEARCH_BACKEND_CODES[searchBackend] ?? 0;

    let totalSize = 1 + 1 + 8 + 8 + 2; // header
    for (const row of hashRows) {
        const idBytes = Buffer.byteLength(row.id, 'utf8');
        const chatBytes = row.chat ? Buffer.byteLength(row.chat, 'utf8') : 0;
        totalSize += 1 + 2 + idBytes + 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 2 + chatBytes;
    }

    const buf = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    const headerFlags = (hasTotal ? 0b01 : 0) | (hasTotal && approxTotal ? 0b10 : 0);
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

        buf.writeUInt32LE(row.favHash >>> 0, offset); offset += 4;
        buf.writeUInt32LE(row.tagIdsHash >>> 0, offset); offset += 4;
        buf.writeUInt32LE(row.contentHash >>> 0, offset); offset += 4;

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

    return buf;
}

/**
 * Sends a hash-mode `/query` response as `application/octet-stream`.
 * @param {import("express").Response} response
 * @param {{seq:number, total:number|undefined, approxTotal:boolean, hashRows:object[], searchBackend?:string}} params
 */
function sendHashQueryResponse(response, params) {
    response.set('Content-Type', 'application/octet-stream');
    return response.send(serializeQueryHashesBinary(params));
}

router.post('/query', async function (request, response) {
    try {
        const body = request.body ?? {};
        const filter = body.filter ?? {};
        const sort = body.sort ?? {};
        const want = Array.isArray(body.want) ? body.want : ['rows', 'total'];
        const includeGroups = filter.includeGroups === true;

        const searchTerm = typeof filter.search === 'string' ? filter.search.trim() : '';
        const hasSearch = searchTerm.length > 0;

        if (sort.field === 'search' && !hasSearch) {
            return response.status(400).send({ error: true, reason: 'search-sort-requires-search', message: 'sort.field "search" requires a non-empty filter.search.' });
        }
        if (sort.field !== undefined && !QUERY_SORT_FIELDS.has(sort.field)) {
            return response.status(400).send({ error: true, reason: 'invalid-sort-field' });
        }
        const seed = Number(sort.seed);
        if (sort.field === 'random' && !Number.isFinite(seed)) {
            return response.status(400).send({ error: true, reason: 'random-seed-required', message: 'sort.field "random" requires a finite sort.seed - design doc §5.3 decision 10, the client mints and persists this (public/scripts/random-sort.js).' });
        }
        for (const w of want) {
            if (w !== 'rows' && w !== 'total' && w !== 'hashes') {
                return response.status(400).send({ error: true, reason: 'want-not-supported', message: `want: "${w}" is not implemented yet.` });
            }
        }

        const page = Number.isFinite(Number(body.page)) && Number(body.page) >= 1 ? Math.trunc(Number(body.page)) : 1;
        const pageSize = Number.isFinite(Number(body.pageSize)) && Number(body.pageSize) > 0
            ? Math.min(Math.trunc(Number(body.pageSize)), MAX_QUERY_PAGE_SIZE)
            : DEFAULT_QUERY_PAGE_SIZE;
        const offset = (page - 1) * pageSize;
        const wantRows = want.includes('rows');
        const wantTotal = want.includes('total');
        // Hash-only mode is mutually exclusive with `rows` - one shape or the other per request.
        const wantHashes = want.includes('hashes');
        if (wantHashes && wantRows) {
            return response.status(400).send({ error: true, reason: 'hashes-and-rows-exclusive', message: 'want cannot include both "rows" and "hashes" in the same request.' });
        }

        // Cheap re-fetch guard: skip row hydration/search if `ifSeq` matches the current seq. Coarser than
        // per-bucket digests - invalidates on any character/group write, not just ones affecting this page.
        if (Number.isFinite(Number(body.ifSeq))) {
            const currentSeq = await getCurrentSeq(request.user.directories);
            if (currentSeq !== null && currentSeq === Math.trunc(Number(body.ifSeq))) {
                return response.send({ seq: currentSeq, unchanged: true });
            }
        }

        let searchBackend;
        let queryParams = {
            tags: filter.tags,
            fav: filter.fav,
            world: filter.world,
            excludeIds: filter.excludeIds,
            ids: filter.ids,
            sortField: sort.field,
            sortOrder: sort.order,
            seed,
            offset,
            limit: pageSize,
            wantRows,
            wantTotal,
            wantHashes,
        };
        // Whether a total computed against a search-narrowed candidate set is exact or approximate
        // (wire convention: a `~` prefix, never a silently-truncated number).
        let approxTotal = false;

        // Populated only in the hasSearch+includeGroups branch below, for JS-sorting merged relevance order
        // when sort.field === 'search' (no SQL column exists for text relevance).
        let combinedScoresById = null;

        if (hasSearch) {
            const handle = request.user.profile.handle;

            // Fast path: tantivy sorts/paginates natively when the sort field has a fast field, returning
            // just the page window - no match-set materialization, no SQL sort. Falls back to SQL otherwise.
            if (sort.field && TANTIVY_SORT_FIELDS.has(sort.field) && !includeGroups) {
                const favOnly = filter.fav === true;
                const sortedResult = await searchCharacterIdsSorted(
                    handle, request.user.directories, searchTerm,
                    sort.field, sort.order === 'asc' ? 'asc' : 'desc',
                    offset, pageSize, favOnly,
                    { tags: filter.tags, excludeIds: filter.excludeIds },
                );
                if (sortedResult !== null) {
                    searchBackend = sortedResult.backend;
                    if (sortedResult.ids.length === 0) {
                        const seq = (await queryCharacters(request.user.directories, { ids: [], wantRows: false, wantTotal: false }))?.seq ?? 0;
                        if (wantHashes) {
                            return sendHashQueryResponse(response, { seq, total: wantTotal ? 0 : undefined, approxTotal: false, hashRows: [], searchBackend });
                        }
                        const payload = { seq, searchBackend };
                        if (wantRows) payload.rows = [];
                        if (wantTotal) payload.total = 0;
                        return response.send(payload);
                    }
                    // Hydrate just the page-sized id set - no sorting, no counting in SQL.
                    const result = await queryCharacters(request.user.directories, {
                        ids: sortedResult.ids,
                        wantRows, wantHashes, wantTotal: false,
                    });
                    if (result === null) {
                        return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
                    }
                    if (wantHashes) {
                        // queryCharacters returns hashRows in id order; re-order to match tantivy's sort.
                        const idToHashRow = new Map(result.hashRows.map(r => [r.id, r]));
                        const orderedHashRows = sortedResult.ids.map(id => idToHashRow.get(id)).filter(Boolean);
                        return sendHashQueryResponse(response, { seq: result.seq, total: wantTotal ? sortedResult.total : undefined, approxTotal: false, hashRows: orderedHashRows, searchBackend });
                    }
                    const payload = { seq: result.seq };
                    if (wantTotal) payload.total = sortedResult.total;
                    if (wantRows) {
                        // Rows here are always plain toShallow() projections, so the id lives at `.avatar`.
                        const idToRow = new Map(result.rows.map(r => [r.avatar, r]));
                        payload.rows = sortedResult.ids.map(id => idToRow.get(id)).filter(Boolean);
                    }
                    if (searchBackend !== undefined) payload.searchBackend = searchBackend;
                    return response.send(payload);
                }
                // sortedResult === null: fast field not available on this index, fall through to SQL path.
            }

            // 'search' sort only needs a relevance-ordered page-sized window; any other sort needs the full
            // matched set since ordering comes from SQL. Undefined tells the search engine to return all matches.
            const idFetchCap = sort.field === 'search' ? offset + pageSize : undefined;
            const favOnly = filter.fav === true;
            const searchResult = await searchCharacterIds(handle, request.user.directories, searchTerm, idFetchCap, favOnly);

            // filter.ids and filter.search both restrict the candidate set - when both are present they
            // intersect, not override each other, for both types when includeGroups is active.
            const explicitIds = Array.isArray(filter.ids) ? new Set(filter.ids) : null;
            const effectiveIds = explicitIds ? searchResult.ids.filter(id => explicitIds.has(id)) : searchResult.ids;

            let groupSearchResult = { ids: [], scoresById: new Map(), total: 0, backend: 'tantivy' };
            let effectiveGroupIds = [];
            if (includeGroups) {
                groupSearchResult = await searchGroupIds(handle, request.user.directories, searchTerm, idFetchCap, favOnly);
                effectiveGroupIds = explicitIds ? groupSearchResult.ids.filter(id => explicitIds.has(id)) : groupSearchResult.ids;
            }

            // Character and group search resolve their engine tier independently but always agree in practice
            // (both go through the same process-wide resolveSearchEngine() cache) - report whichever is worse,
            // matching the `/all` route's identical BACKEND_SEVERITY comparison, in case they ever don't.
            const BACKEND_SEVERITY = { tantivy: 0, unavailable: 1 };
            searchBackend = includeGroups && BACKEND_SEVERITY[groupSearchResult.backend] > BACKEND_SEVERITY[searchResult.backend]
                ? groupSearchResult.backend
                : searchResult.backend;

            approxTotal = Number.isFinite(idFetchCap) && (searchResult.total > idFetchCap || (includeGroups && groupSearchResult.total > idFetchCap));

            if (effectiveIds.length === 0 && effectiveGroupIds.length === 0) {
                const seq = (await queryCharacters(request.user.directories, { ids: [], wantRows: false, wantTotal: false }))?.seq ?? 0;
                if (wantHashes) {
                    return sendHashQueryResponse(response, { seq, total: wantTotal ? 0 : undefined, approxTotal: false, hashRows: [], searchBackend });
                }
                const payload = { seq, searchBackend };
                if (wantRows) payload.rows = [];
                if (wantTotal) payload.total = 0;
                return response.send(payload);
            }

            if (includeGroups) {
                // Groups have their own full-text index - resolve both id sets, then answer from
                // queryEntities()'s UNION ALL restricted to their union.
                combinedScoresById = new Map([...searchResult.scoresById, ...groupSearchResult.scoresById]);
                const combinedIds = [...effectiveIds, ...effectiveGroupIds];
                const entityParams = {
                    tags: filter.tags, fav: filter.fav, excludeIds: filter.excludeIds,
                    ids: combinedIds, wantRows, wantTotal, wantHashes,
                };
                if (sort.field === 'search') {
                    // No SQL column for relevance - fetch every matched row so the JS reorder+slice below sees the true top-K.
                    entityParams.offset = 0;
                    entityParams.limit = combinedIds.length;
                } else {
                    // A non-relevance sort composes with search narrowing - SQL does ORDER BY/LIMIT/OFFSET directly.
                    entityParams.sortField = sort.field;
                    entityParams.sortOrder = sort.order;
                    entityParams.seed = seed;
                    entityParams.offset = offset;
                    entityParams.limit = pageSize;
                }
                const result = await queryEntities(request.user.directories, entityParams);
                if (result === null) {
                    return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
                }

                let rows = result.rows;
                let hashRows = result.hashRows;
                if (sort.field === 'search' && (wantRows || wantHashes)) {
                    // No SQL column for relevance - queryEntities() returned every matched row in id order; reorder by score here.
                    if (wantRows) rows = rows.slice().sort((a, b) => combinedScoresById.get(a.id) - combinedScoresById.get(b.id)).slice(offset, offset + pageSize);
                    if (wantHashes) hashRows = hashRows.slice().sort((a, b) => combinedScoresById.get(a.id) - combinedScoresById.get(b.id)).slice(offset, offset + pageSize);
                }

                if (wantHashes) {
                    return sendHashQueryResponse(response, {
                        seq: result.seq,
                        total: wantTotal ? result.total : undefined,
                        approxTotal,
                        hashRows,
                        searchBackend,
                    });
                }
                const payload = { seq: result.seq };
                if (wantTotal) payload.total = approxTotal ? `~${result.total}` : result.total;
                if (wantRows) payload.rows = await hydrateEntityRows(request.user.directories, rows);
                if (searchBackend !== undefined) payload.searchBackend = searchBackend;
                return response.send(payload);
            }

            queryParams = { ...queryParams, ids: effectiveIds, idOrder: searchResult.ids };
        }

        // A non-search request with includeGroups reaches queryEntities()'s UNION ALL path directly.
        if (!hasSearch && includeGroups) {
            const result = await queryEntities(request.user.directories, queryParams);
            if (result === null) {
                return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
            }

            if (wantHashes) {
                return sendHashQueryResponse(response, {
                    seq: result.seq,
                    total: wantTotal ? result.total : undefined,
                    approxTotal: false,
                    hashRows: result.hashRows,
                    searchBackend: undefined,
                });
            }
            const payload = { seq: result.seq };
            if (wantTotal) payload.total = result.total;
            if (wantRows) payload.rows = await hydrateEntityRows(request.user.directories, result.rows);
            return response.send(payload);
        }

        const result = await queryCharacters(request.user.directories, queryParams);

        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }

        // includeGroups is always false here - both includeGroups branches already returned above.
        if (wantHashes) {
            return sendHashQueryResponse(response, {
                seq: result.seq,
                total: wantTotal ? result.total : undefined,
                approxTotal,
                hashRows: result.hashRows,
                searchBackend,
            });
        }
        const payload = { seq: result.seq };
        if (wantRows) payload.rows = result.rows;
        if (wantTotal) payload.total = approxTotal ? `~${result.total}` : result.total;
        if (searchBackend !== undefined) payload.searchBackend = searchBackend;
        return response.send(payload);
    } catch (err) {
        console.error('[characters/query] Query failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Explicit repair path for a user's character search index. Forces an immediate full rebuild regardless of the current freshness signature.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/search-index/rebuild', async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const result = await rebuildCharacterSearchIndex(handle, request.user.directories);
        if (!result.ok) {
            return response.status(503).send({ error: true, reason: 'search-unavailable', backend: result.backend });
        }
        return response.send({ ok: true, backend: result.backend });
    } catch (err) {
        console.error('[characters/search-index/rebuild] Rebuild failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Chunked existence-by-id, answered from the metadata table's primary key rather than the filesystem.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/exists', async function (request, response) {
    try {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : null;
        if (!ids || ids.some(id => typeof id !== 'string')) {
            return response.sendStatus(400);
        }

        const result = await checkCharactersExist(request.user.directories, ids);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        return response.send(result);
    } catch (err) {
        console.error('[characters/exists] Existence check failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Change feed over the metadata store's change log, replacing `/api/characters/manifest`'s readdir+stat-everything boot scan.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/changes', async function (request, response) {
    try {
        const sinceSeq = Number(request.body?.sinceSeq);
        if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
            return response.sendStatus(400);
        }

        const result = await getChangesSince(request.user.directories, sinceSeq);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        return response.send(result);
    } catch (err) {
        console.error('[characters/changes] Change-feed query failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * SSE endpoint that pushes an empty "something changed, go ask" notification whenever the metadata store's
 * `changes` table gets a new row, so a client can call `/changes` instead of polling. Also carries the former
 * `/api/browser-heartbeat` job (touches browser-presence on connect/ping) - merged in because the browser's
 * per-origin connection pool is shared across tabs, and two permanent per-tab SSE connections each was enough
 * to exhaust it at only ~3 tabs open and stall every other request.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.get('/changes/stream', function (request, response) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    response.write(':ok\n\n');
    touchBrowserPresence();

    const presenceInterval = setInterval(() => {
        response.write(':ping\n\n');
        touchBrowserPresence();
    }, PRESENCE_PING_INTERVAL_MS);

    // Debounced: a bulk write can emit 'change' hundreds of times in one synchronous burst, and an
    // un-debounced response.write() per emission per SSE client would stall the event loop.
    let notifyTimer = null;
    const onChange = () => {
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(() => {
            response.write('data: {}\n\n');
        }, 500);
    };

    characterChangeEmitter.on('change', onChange);

    request.on('close', () => {
        characterChangeEmitter.off('change', onChange);
        clearTimeout(notifyTimer);
        clearInterval(presenceInterval);
    });
});

/**
 * SUPERSEDED by `/tree-descend` below. Kept for now, not yet removed from routing.
 *
 * Anti-entropy check on the character cache: proves a client's cache matches the server by re-deriving a fixed-size bucket-digest table from actual record content, cheap regardless of library size.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/state-digest', async function (request, response) {
    try {
        const bucketCount = Number.isFinite(Number(request.body?.bucketCount)) && Number(request.body?.bucketCount) > 0
            ? Math.trunc(Number(request.body.bucketCount))
            : DEFAULT_DIGEST_BUCKET_COUNT;

        const result = await getStateDigest(request.user.directories, bucketCount);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        return response.send(result);
    } catch (err) {
        console.error('[characters/state-digest] State-digest query failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * SUPERSEDED by `/tree-descend` below - kept for now, not yet removed from routing.
 *
 * Repair half of `/state-digest`: returns one bucket's `{id, favHash, fieldsHash, fav}` members so the client can repair only the ids that actually changed.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/bucket-members', async function (request, response) {
    try {
        const bucketCount = Number.isFinite(Number(request.body?.bucketCount)) && Number(request.body?.bucketCount) > 0
            ? Math.trunc(Number(request.body.bucketCount))
            : DEFAULT_DIGEST_BUCKET_COUNT;
        const bucket = Number(request.body?.bucket);
        if (!Number.isFinite(bucket) || bucket < 0 || bucket >= bucketCount) {
            return response.sendStatus(400);
        }

        const result = await getBucketMembers(request.user.directories, bucket, bucketCount);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        return response.send(result);
    } catch (err) {
        console.error('[characters/bucket-members] Bucket-members query failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Serializes tree-descend results into a compact binary format. Fixed-width integers where JSON
 * would use key names and string representations, positional where JSON would be self-describing.
 * See deserializeTreeDescendBinary() client-side for the matching decoder.
 * @param {{ path: number[], type: string, children?: {digest: {a:number,b:number,c:number,d:number}}[], members?: {id:string,favHash:number,tagIdsHash:number,contentHash:number,fav:boolean}[] }[]} results
 * @returns {Buffer}
 */
function serializeTreeDescendBinary(results) {
    // Pre-compute total size
    let totalSize = 2; // resultCount
    for (const result of results) {
        totalSize += 1 + result.path.length + 1; // pathLen + path + type
        if (result.type === 'children') {
            totalSize += 2 + result.children.length * 16;
        } else {
            totalSize += 2; // memberCount
            for (const member of (result.members ?? [])) {
                totalSize += 2 + Buffer.byteLength(member.id, 'utf8') + 13;
            }
        }
    }

    const buf = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    buf.writeUInt16LE(results.length, offset); offset += 2;

    for (const result of results) {
        buf.writeUInt8(result.path.length, offset); offset += 1;
        for (const p of result.path) {
            buf.writeUInt8(p, offset); offset += 1;
        }
        buf.writeUInt8(result.type === 'children' ? 0 : 1, offset); offset += 1;

        if (result.type === 'children') {
            buf.writeUInt16LE(result.children.length, offset); offset += 2;
            for (const child of result.children) {
                const d = child.digest ?? { a: 0, b: 0, c: 0, d: 0 };
                buf.writeUInt32LE(d.a >>> 0, offset); offset += 4;
                buf.writeUInt32LE(d.b >>> 0, offset); offset += 4;
                buf.writeUInt32LE(d.c >>> 0, offset); offset += 4;
                buf.writeUInt32LE(d.d >>> 0, offset); offset += 4;
            }
        } else {
            const members = result.members ?? [];
            buf.writeUInt16LE(members.length, offset); offset += 2;
            for (const member of members) {
                const idBytes = Buffer.byteLength(member.id, 'utf8');
                buf.writeUInt16LE(idBytes, offset); offset += 2;
                buf.write(member.id, offset, idBytes, 'utf8'); offset += idBytes;
                buf.writeUInt32LE(member.favHash >>> 0, offset); offset += 4;
                buf.writeUInt32LE(member.tagIdsHash >>> 0, offset); offset += 4;
                buf.writeUInt32LE(member.contentHash >>> 0, offset); offset += 4;
                buf.writeUInt8(member.fav ? 1 : 0, offset); offset += 1;
            }
        }
    }

    return buf;
}

/**
 * Recursive hash-tree anti-entropy descent. The client calls this repeatedly, once per descent level, until
 * all mismatched subtrees are resolved. Stateless - each call does its own table scan.
 */
router.post('/tree-descend', async function (request, response) {
    try {
        const branching = Number.isFinite(Number(request.body?.branching)) && Number(request.body?.branching) > 0
            ? Math.trunc(Number(request.body.branching))
            : DEFAULT_DIGEST_BUCKET_COUNT;
        const leafThreshold = Number.isFinite(Number(request.body?.leafThreshold)) && Number(request.body?.leafThreshold) > 0
            ? Math.trunc(Number(request.body.leafThreshold))
            : DEFAULT_DIGEST_BUCKET_COUNT;
        const nodes = Array.isArray(request.body?.nodes)
            ? request.body.nodes.filter(n => Array.isArray(n.path) && n.path.every(x => Number.isFinite(x) && x >= 0 && x < branching))
            : [{ path: [] }];

        const result = await treeDescend(request.user.directories, nodes, branching, leafThreshold);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        if (request.body.binary) {
            response.set('Content-Type', 'application/octet-stream');
            return response.send(serializeTreeDescendBinary(result.results));
        }
        return response.send(result);
    } catch (err) {
        console.error('[characters/tree-descend] Tree-descend failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * POST /api/characters/fingerprint-values: targeted fetch of fingerprint field values for specific record IDs.
 * Called after tree-descend has identified the exact drifted records via per-record hash comparison.
 * Reads from shallow_json in the DB - no processCharacter()/PNG disk reads.
 */
router.post('/fingerprint-values', async function (request, response) {
    try {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
        for (const id of ids) {
            if (typeof id !== 'string' || forbiddenRegExp.test(id)) {
                return response.sendStatus(400);
            }
        }
        const result = await resolveFingerprints(request.user.directories, ids);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        return response.send(result);
    } catch (err) {
        console.error('[characters/fingerprint-values] Fingerprint-values query failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * Lightweight companion to `/all`: returns just `[{ avatar, mtime, thumbnailVersion }, ...]` with no PNG chunk
 * read, JSON parse, or chat-size calc, so the client can diff against its cache and fetch only what changed.
 * `mtime` is mtimeMs (content change), not ctimeMs. `thumbnailVersion` is the cached thumbnail's own mtime
 * (null if none cached yet), not the source PNG's - the thumbnail is only regenerated lazily on first request.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/manifest', function (request, response) {
    try {
        const files = fs.readdirSync(request.user.directories.characters);
        const pngFiles = files.filter(file => file.endsWith('.png'));
        const manifest = pngFiles.map(file => {
            const stat = fs.statSync(path.join(request.user.directories.characters, file));
            const thumbnailVersion = getThumbnailVersion(request.user.directories, 'avatar', file);
            return { avatar: file, mtime: stat.mtimeMs, thumbnailVersion };
        });
        return response.send(manifest);
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: true });
    }
});

/**
 * Other half of the `/manifest` delta-caching flow: fetches full (or shallow) character data for a specific
 * list of avatars, so the client only re-fetches what `/manifest` showed as new or changed. An optional
 * `fields` array switches to a field-filtered mode reading only those fields (plus `avatar`) from `shallow_json`.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/batch', async function (request, response) {
    try {
        const avatars = Array.isArray(request.body?.avatars) ? request.body.avatars : [];
        const fields = Array.isArray(request.body?.fields) ? request.body.fields : null;

        for (const avatar of avatars) {
            if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar)) {
                return response.sendStatus(400);
            }
        }

        // Field-filtered mode: shallow_json already carries db-authoritative fav/active_chat/tag_ids, so no
        // extra stamping step is needed here, unlike the full-record path below.
        if (fields) {
            const shallowById = await getShallowByIds(request.user.directories, avatars);
            const data = avatars
                .filter(avatar => shallowById[avatar])
                .map(avatar => {
                    const shallow = shallowById[avatar];
                    /** @type {Record<string, any>} */
                    const filtered = { avatar };
                    for (const field of fields) {
                        if (field in shallow) {
                            filtered[field] = shallow[field];
                        }
                    }
                    return filtered;
                });
            return response.send(data);
        }

        // Full mode: one batched stale-card_json query for the whole request instead of a point lookup per character.
        const staleCards = await getStaleCardJsonMap(request.user.directories);
        const processingPromises = avatars.map(avatar => processCharacter(avatar, request.user.directories, { shallow: useShallowCharacters, cardJson: staleCards.get(avatar) ?? null }));
        const data = (await Promise.all(processingPromises)).filter(c => 'name' in c);
        // fav/active_chat are db-authoritative once a row exists; without this stamp, a toggle made purely
        // through /fav or /chat would come back here still carrying the stale PNG-embedded value.
        await stampDbFav(request.user.directories, data);
        await stampDbActiveChat(request.user.directories, data);
        await stampDbTagIds(request.user.directories, data);
        await stampDbAllowGlobalStyles(request.user.directories, data);
        return response.send(data);
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: true });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        const item = request.body.avatar_url;
        const filePath = path.join(request.user.directories.characters, item);

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        const data = await processCharacter(item, request.user.directories, { shallow: false });
        await stampDbFav(request.user.directories, [data]);
        await stampDbActiveChat(request.user.directories, [data]);
        await stampDbTagIds(request.user.directories, [data]);
        await stampDbAllowGlobalStyles(request.user.directories, [data]);

        // Per-field content hashes for edit conflict detection: sent back on save so the server can detect
        // if another session changed the card in between. Fields hash covers metadata, body hash the editable body.
        data._fieldsHash = characterDigestFieldsHash(data);
        data._bodyHash = characterDigestCardBodyHash(data);

        return response.send(data);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/chats', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const characterDirectory = (request.body.avatar_url).replace('.png', '');
        if (!characterDirectory) {
            return response.send([]);
        }

        // Tree DB path: if the character is migrated, list branches from the tree DB
        if (await hasSavedChats(request.user.directories, characterDirectory)) {
            const branches = await listTreeBranches(request.user.directories, characterDirectory);

            if (request.body.simple) {
                return response.send(branches.map(b => ({ file_name: b.name + '.jsonl', file_id: b.name })));
            }

            const chatData = branches.map(b => {
                const meta = b.metadata ? JSON.parse(b.metadata) : {};
                return {
                    node_id: b.id,
                    file_name: b.name + '.jsonl',
                    file_size: 0,
                    chat_items: b.message_count,
                    mes: b.last_mes || '[No messages]',
                    // The branch's leaf, not its label's birthday - see branchViewSync().
                    last_mes: b.last_activity ?? b.created_at,
                    chat_metadata: request.body.metadata ? meta : undefined,
                };
            });

            return response.send(chatData);
        }

        // JSONL fallback path
        const chatsDirectory = path.join(request.user.directories.chats, characterDirectory);

        // No chats directory yet is the ordinary state for a freshly created character, not an error.
        if (!fs.existsSync(chatsDirectory)) {
            return response.send([]);
        }

        const files = fs.readdirSync(chatsDirectory, { withFileTypes: true });
        const jsonFiles = files.filter(file => file.isFile() && path.extname(file.name) === '.jsonl').map(file => file.name);

        if (jsonFiles.length === 0) {
            return response.send([]);
        }

        if (request.body.simple) {
            return response.send(jsonFiles.map(file => ({ file_name: file, file_id: path.parse(file).name })));
        }

        const jsonFilesPromise = jsonFiles.map((file) => {
            const withMetadata = !!request.body.metadata;
            const pathToFile = path.join(request.user.directories.chats, characterDirectory, file);
            return getChatInfo(pathToFile, {}, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        // Deliberately `{ error: true }`, not `[]` - callers must not treat this as "zero chats".
        return response.send({ error: true });
    }
});

/**
 * Mints the immutable id a new character is created/imported under: a UUIDv7, unrelated to the display name. Naming the PNG after this id (rather than a sanitized display name) is what makes `/rename` a pure card-data edit. Throws rather than silently overwriting if collisions persist.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} A UUIDv7 string with no existing `<id>.png` in `directories.characters`
 */
export function mintCharacterId(directories) {
    for (let i = 0; i < 5; i++) {
        const id = uuidv7();
        if (!fs.existsSync(path.join(directories.characters, `${id}.png`))) {
            return id;
        }
    }
    throw new Error('Failed to mint a unique character id after 5 attempts');
}

/**
 * Gets the preserved name for the uploaded file if the request is valid.
 * @param {import("express").Request} request - Express request object
 * @returns {string | undefined} - The preserved name if the request is valid, otherwise undefined
 */
function getPreservedName(request) {
    return typeof request.body.preserved_name === 'string' && request.body.preserved_name.length > 0
        ? path.parse(request.body.preserved_name).name
        : undefined;
}

/**
 * sha256 hex digest of a file's raw bytes, streamed rather than read fully into memory first.
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex digest
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

/** Format -> importer dispatch table for `/import` below, shared with importCharacterFileHeadless(). */
const formatImportFunctions = {
    'yaml': importFromYaml,
    'yml': importFromYaml,
    'json': importFromJson,
    'png': importFromPng,
    'charx': importFromCharX,
    'byaf': importFromByaf,
};

/**
 * Headless counterpart to `POST /import` for scan-discovered files, driven through the same dispatch table, dedup, and write path as a browser upload, via a minimal fake Express `request`.
 * `filePath` is consumed (deleted) by the import - callers must pass a staged copy, never the original source file.
 * @param {string} filePath Absolute path to a staged copy of the discovered file - consumed (deleted) by the import.
 * @param {string} format One of formatImportFunctions' keys (yaml/yml/json/png/charx/byaf)
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ userHandle: string, contentHash: string }} options
 * @returns {Promise<{ fileName: string } | { duplicateOf: string } | null>} `null` for an unsupported format or a
 * failed import (the importer returned no file name).
 */
export async function importCharacterFileHeadless(filePath, format, directories, { userHandle, contentHash }) {
    const importFunction = formatImportFunctions[format];
    if (!importFunction) return null;

    const duplicateOf = await findCharacterIdByContentHash(directories, contentHash);
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

    try {
        const importFunction = formatImportFunctions[format];

        if (!importFunction) {
            throw new Error(`Unsupported format: ${format}`);
        }

        // Exact-byte-identical dedup, skipped only when `preservedFileName` is set (an explicit "replace THIS
        // character" action must not silently no-op just because its bytes match some other character). The
        // hash itself is always computed and recorded regardless, so content_hash doesn't go stale on a replace.
        const contentHash = await hashFileContents(uploadPath);
        if (!preservedFileName) {
            const duplicateOf = await findCharacterIdByContentHash(request.user.directories, contentHash);
            if (duplicateOf) {
                await fsPromises.unlink(uploadPath).catch(() => {});
                return response.send({ duplicate: true, duplicate_of: duplicateOf });
            }
        }

        const fileName = await importFunction(uploadPath, { request, response, contentHash }, preservedFileName);

        if (!fileName) {
            console.warn('Failed to import character');
            return response.sendStatus(400);
        }

        if (preservedFileName) {
            invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);
        }

        // ALL/ONLY_EXISTING tag-import modes done atomically here, in the same request; ASK still needs the
        // client's interactive review popup, so tag import there stays entirely client-driven.
        const tagImportMode = request.body.tagImportMode;
        /** @type {object[]} Tag definitions resolved by the ALL/ONLY_EXISTING seed below, shipped back so the client can merge them without a second /api/tags/get round trip. Empty for ASK/NONE. */
        let tagDefinitions = [];
        if (tagImportMode === 'all' || tagImportMode === 'existing') {
            try {
                ({ tagDefinitions } = await seedCardTagsForSingleCharacter(request.user.directories, `${fileName}.png`, { onlyExisting: tagImportMode === 'existing' }));
            } catch (err) {
                // Card-tag seeding failing must not fail the import itself - the character row already exists.
                console.error(`Failed to seed card tags for ${fileName}.png:`, err);
            }
        }

        // Hands the client the freshly-imported character's data in the same response, so it can insert it
        // directly instead of a second full-library fetch just to learn what it itself just uploaded.
        const character = await processCharacter(`${fileName}.png`, request.user.directories, { shallow: useShallowCharacters });
        await stampDbTagIds(request.user.directories, [character]);

        response.send({ file_name: fileName, character, tagDefinitions });
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: true });
    }
});

router.post('/duplicate', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.avatar_url) {
            console.warn('avatar URL not found in request body');
            console.debug(request.body);
            return response.sendStatus(400);
        }
        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));
        if (!fs.existsSync(filename)) {
            console.error('file for dupe not found', filename);
            return response.sendStatus(404);
        }

        // If filename ends with a _number, increment the number. The suffix regex is capped to safe-integer
        // length so `suffix++` always advances (an uncapped/loose parse could produce a non-advancing suffix,
        // e.g. NaN or a float-precision-stuck value, and wedge the loop below in a synchronous existsSync spin).
        const nameParts = path.basename(filename, path.extname(filename)).split('_');
        const lastPart = nameParts[nameParts.length - 1];
        // 15 digits is comfortably inside Number.MAX_SAFE_INTEGER (16 digits) even after +1.
        const isStrictInteger = /^\d{1,15}$/.test(lastPart);

        let suffix = 1;
        let baseName;

        if (isStrictInteger && nameParts.length > 1) {
            suffix = parseInt(lastPart, 10) + 1;
            baseName = nameParts.slice(0, -1).join('_'); // construct baseName without suffix
        } else {
            baseName = nameParts.join('_'); // original filename is completely the baseName
        }

        let newFilename = path.join(request.user.directories.characters, `${baseName}_${suffix}${path.extname(filename)}`);

        // No legitimate library needs more than this many same-named duplicates in one chain; this also
        // bounds the loop by iteration count rather than by the value of `suffix`, so it can't spin forever
        // even if `suffix` were somehow to stop advancing.
        const MAX_DUPLICATE_ATTEMPTS = 10000;
        let attempts = 0;
        while (fs.existsSync(newFilename)) {
            suffix++;
            attempts++;
            if (attempts > MAX_DUPLICATE_ATTEMPTS) {
                console.error(`Too many duplicate suffixes for ${baseName}, giving up after ${MAX_DUPLICATE_ATTEMPTS} attempts`);
                return response.status(500).send({ error: true, message: 'Too many duplicates with this name' });
            }
            newFilename = path.join(request.user.directories.characters, `${baseName}_${suffix}${path.extname(filename)}`);
        }

        fs.copyFileSync(filename, newFilename);
        console.info(`${filename} was copied to ${newFilename}`);

        // A raw byte copy also copies the source's tEXt chunk, which may be stale - re-stamp the copy with
        // the source's authoritative content when that's the case, so the duplicate isn't silently a copy of
        // a pre-edit card. writeCardToFile() only rewrites when there's genuinely something to correct.
        const sourceParked = await getCharacterCardJson(request.user.directories, path.basename(filename));
        if (sourceParked !== null) {
            await writeCardToFile(filename, newFilename, sourceParked, null);
        }

        // /duplicate is a raw file copy, not a re-encode, so it doesn't go through writeCharacterData() and
        // needs its own metadata-store upsert here.
        const newAvatar = path.parse(newFilename).base;
        const rawData = await readCharacterData(newFilename);
        if (rawData !== undefined) {
            await fireMetadataUpsertHook(request.user.directories, newAvatar, rawData);
        }

        response.send({ path: newAvatar });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.format || !request.body.avatar_url) {
            return response.sendStatus(400);
        }

        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));

        if (!fs.existsSync(filename)) {
            return response.sendStatus(404);
        }

        switch (request.body.format) {
            case 'png': {
                // Materialized, not streamed: the stored PNG's chunk may be stale, and an exported file must
                // carry a current one since other tools read it by that chunk alone.
                const materialized = await materializeCardPng(request.user.directories, path.basename(filename), filename);
                if (!materialized) return response.sendStatus(400);
                const rawBuffer = materialized.buffer;
                const mutatedData = mutateJsonString(materialized.cardJson, unsetPrivateFields);
                const mutatedBuffer = write(rawBuffer, mutatedData);
                const contentType = mime.lookup(filename) || 'image/png';
                response.setHeader('Content-Type', contentType);
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(path.basename(filename))}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                try {
                    const json = await readCardContent(request.user.directories, path.basename(filename), filename);
                    if (json === undefined) return response.sendStatus(400);
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
