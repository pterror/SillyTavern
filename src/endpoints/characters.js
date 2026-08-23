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
import { deepMerge, humanizedDateTime, tryParse, MemoryLimitedMap, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements, getArrayBufferSlice, uuidv7 } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { parse, read, write, writeCardToFile, computeAvatarIdentityHashFromImageBuffer } from '../character-card-parser.js';
import { getCharaCardV2, convertToV2, readFromV2, charaFormatData, convertWorldInfoToCharacterBook, unsetPrivateFields, omitInstallLocalFields, omitFavField, computeContentIdentityHash } from '../character-card-normalize.js';
import { calculateChatSize, calculateDataSize, toShallow } from '../character-shallow.js';
import { invalidateThumbnail, getThumbnailVersion } from './thumbnails.js';
import { importRisuSprites } from './sprites.js';
import { getUserDirectories } from '../users.js';
import { getChatInfo } from './chats.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { searchCharacters, searchCharacterIds, rebuildCharacterSearchIndex, SEARCH_ID_CAP } from './characters-search-index.js';
import { searchGroups } from './groups-search-index.js';
import { getGroupsData, getGroupsByIds } from './groups.js';
import { upsertCharacterFromWrite, deleteCharacterRow, reconcile as reconcileMetadataStore, beginBatchImport, endBatchImport, queryCharacters, queryEntities, checkCharactersExist, getChangesSince, findCharacterIdByContentHash, findCharacterIdByContentIdentityHash, setCharacterFav, getCharacterFavsByIds } from '../character-metadata-db.js';

// With 100 MB limit it would take roughly 3000 characters to reach this limit
const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity', '100mb');
const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);
// Some Android devices require tighter memory management
const isAndroid = process.platform === 'android';
// Use shallow character data for the character list
const useShallowCharacters = !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
const useDiskCache = !!getConfigValue('performance.useDiskCache', true, 'boolean');

class DiskCache {
    /**
     * @type {string}
     * @readonly
     */
    static DIRECTORY = 'characters';

    /**
     * @type {number}
     * @readonly
     */
    static SYNC_INTERVAL = 5 * 60 * 1000;

    /** @type {import('node-persist').LocalStorage} */
    #instance;

    /** @type {NodeJS.Timeout} */
    #syncInterval;

    /**
     * Queue of user handles to sync.
     * @type {Set<string>}
     * @readonly
     */
    syncQueue = new Set();

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
     * Processes the synchronization queue.
     * @returns {Promise<void>}
     */
    async #syncCacheEntries() {
        try {
            if (!useDiskCache || this.syncQueue.size === 0) {
                return;
            }

            const directories = [...this.syncQueue].map(entry => getUserDirectories(entry));
            this.syncQueue.clear();

            await this.verify(directories);
        } catch (error) {
            console.error('Error while synchronizing cache entries:', error);
        }
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
        this.#syncInterval = setInterval(this.#syncCacheEntries.bind(this), DiskCache.SYNC_INTERVAL);
        return this.#instance;
    }

    /**
     * Verifies disk cache size and prunes it if necessary.
     * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
     * @returns {Promise<void>}
     */
    async verify(directoriesList) {
        try {
            if (!useDiskCache) {
                return;
            }

            const cache = await this.instance();
            const validKeys = new Set();
            for (const dir of directoriesList) {
                const files = fs.readdirSync(dir.characters, { withFileTypes: true });
                for (const file of files.filter(f => f.isFile() && path.extname(f.name) === '.png')) {
                    const filePath = path.join(dir.characters, file.name);
                    const cacheKey = getCacheKey(filePath);
                    validKeys.add(path.parse(cache.getDatumPath(cacheKey)).base);
                }
            }
            for (const key of this.hashedKeys) {
                if (!validKeys.has(key)) {
                    await cache.removeItem(key);
                }
            }
        } catch (error) {
            console.error('Error while verifying disk cache:', error);
        }
    }

    dispose() {
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
        }
    }
}

export const diskCache = new DiskCache();

/**
 * Gets the cache key for the specified image file.
 *
 * One `stat` call, not `existsSync` followed by a separate `statSync` - a non-existent file is just the ENOENT
 * branch of the same syscall, not two syscalls (design doc §3.3 item 6: "getCacheKey()'s existsSync + statSync
 * pair collapses into one stat whose ENOENT is the existence answer"). Same return values as before for both
 * outcomes, so every caller (readCharacterData(), the writeCharacterData() cache-reset loop) sees byte-identical
 * behavior - this only removes the redundant syscall, it doesn't change what gets returned.
 * @param {string} inputFile - Path to the image file
 * @param {fs.Stats} [precomputedStat] Already-fetched stat for `inputFile`, if the caller happens to have one on
 * hand (processCharacter() does, for date_added) - skips this function's own stat call entirely rather than
 * statting the same file twice in one logical operation (design doc §3.3 item 6's "another statSync for
 * date_added" finding: today's code stats every character file once here and again for date_added).
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
async function readCharacterData(inputFile, inputFormat = 'png', precomputedStat = undefined) {
    const cacheKey = getCacheKey(inputFile, precomputedStat);
    if (memoryCache.has(cacheKey)) {
        return memoryCache.get(cacheKey);
    }
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
    !isAndroid && memoryCache.set(cacheKey, result);
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
 * Fires the phase-1 metadata-store write-path hook (character-metadata-db.js's upsertCharacterFromWrite())
 * right after a character PNG write has already landed on disk. Stats the file itself rather than threading a
 * pre-fetched mtime through every writeCharacterData() caller - one extra stat on a write path (an infrequent,
 * user-initiated action) is a non-issue; it's per-request reads that this design's server-IO work is about, not
 * this. Never lets a metadata-store failure fail the character save itself - see this function's callers.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar Filename (with .png) that was just written
 * @param {string} data The Spec-V2 JSON string that was just written
 * @param {string|null} [contentHash] sha256 hex digest of the raw uploaded source-file bytes, when this write
 * came from `/import` - see writeCharacterData()'s own param and upsertCharacterFromWrite()'s doc comment.
 * @param {string|null} [avatarIdentityHash] computeAvatarIdentityHashFromChunks() of the image bytes actually
 * written - callers that just performed a real image write (writeCardToFile()/writeCardFromChunks()'s own
 * return value, or computeAvatarIdentityHashFromImageBuffer() for the crop/buffer-upload path) pass it
 * through here; a caller with no new image bytes to report (e.g. /rename, which never touches pixels) omits
 * it - see upsertCharacterFromWrite()'s own doc comment for why `null` there means "don't touch whatever is
 * already stored", not "clear it".
 * @returns {Promise<void>}
 */
export async function fireMetadataUpsertHook(directories, avatar, data, contentHash = null, avatarIdentityHash = null) {
    try {
        const stat = await fsPromises.stat(path.join(directories.characters, avatar));
        await upsertCharacterFromWrite(directories, avatar, data, stat.mtimeMs, contentHash, avatarIdentityHash);
    } catch (err) {
        console.error('[character-metadata] Failed to update metadata store after a character write (the reconciler will catch it):', err);
    }
}

/**
 * Live-write-path counterpart to scripts/reclaim-character-reflinks.mjs's one-time historical reclaim -
 * finds a DIFFERENT already-on-disk character whose `content_identity_hash` matches the card about to be
 * written, so writeCharacterData()'s fast path can attempt to reflink against that live file's extents
 * instead of (or in addition to, see writeCardFromChunks()'s own doc comment on ordering) `inputFile`'s own
 * history. Owner decision: since every write here already goes through the write-then-atomic-rename pattern
 * (see writeSharedPrefixThenAppend()), a target that's some OTHER live, still-mutable character carries no
 * more risk than reflinking against this same character's own prior version already does - no partial state
 * is ever exposed either way.
 *
 * Only ever proposes a candidate PATH - `findCharacterIdByContentIdentityHash()`'s O(1) indexed lookup on
 * `content_identity_hash` covers just the JSON half of the card (see computeContentIdentityHash()'s own doc
 * comment: fav/chat/create_date stripped, image bytes never enter that hash at all), so a hash match here is
 * never proof the two characters' actual portraits match. writeCardFromChunks() is what does the real,
 * byte-level verification against the candidate's own current file before ever trusting it - this function
 * fails open (`null`) on anything short of "a different row's hash matches and its file is currently
 * readable," same posture as every other content_identity_hash consumer in this codebase.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} selfAvatar This write's own avatar filename (e.g. `Alice.png`) - excluded from the match so
 * a character can never "match" its own row.
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
 * @param {string|null} [contentHash] - sha256 hex digest of the raw uploaded source-file bytes this write came
 * from (bulk-import dedup) - only `/import`'s format importers have one of these to pass; every other caller
 * omits it and the write proceeds exactly as before (see fireMetadataUpsertHook()'s doc comment).
 * @returns {Promise<boolean>} - True if the operation was successful
 */
async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined, contentHash = null) {
    try {
        // Reset the cache
        for (const key of memoryCache.keys()) {
            if (Buffer.isBuffer(inputFile)) {
                break;
            }
            if (key.startsWith(inputFile)) {
                memoryCache.delete(key);
                break;
            }
        }
        if (useDiskCache && !Buffer.isBuffer(inputFile)) {
            diskCache.syncQueue.add(request.user.profile.handle);
        }
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

        // Fast path: when the source is already a file on disk and no crop is requested, its image data
        // is going into the output completely unchanged (crop is the only thing that would actually
        // touch pixels) - writeCardToFile() reflinks that unchanged portion straight from `inputFile`
        // instead of paying a full-file rewrite for a change that, in the common case, only ever touches
        // a few KB of trailing metadata. Verifies its own fast-path assumption byte-for-byte before ever
        // touching disk, and falls back to an ordinary full write on its own if that verification (or the
        // reflink itself) doesn't pan out - so correctness here never depends on the optimization
        // succeeding. Buffer input (in-memory upload) and crop both skip straight to the slow path below,
        // since there's no on-disk source file to reflink from / the image data itself is changing.
        if (!Buffer.isBuffer(inputFile) && crop === undefined) {
            try {
                const crossReflinkCandidatePath = await findCrossCharacterReflinkCandidate(request.user.directories, `${outputFile}.png`, data);
                const { avatarIdentityHash } = await writeCardToFile(inputFile, outputImagePath, data, crossReflinkCandidatePath);
                await fireMetadataUpsertHook(request.user.directories, `${outputFile}.png`, data, contentHash, avatarIdentityHash);
                return true;
            } catch (error) {
                console.warn(`writeCardToFile failed for ${inputFile}, falling back to the full read/re-encode path.`, error);
            }
        }

        const inputImage = await getInputImage();

        // Get the chunks
        const outputImage = write(inputImage, data);
        // Slow path (buffer upload, or a crop that legitimately changes pixels) - no on-disk chunk list to
        // reuse the way the fast path's writeCardToFile() does, so this pays its own extract() over the
        // already-built `outputImage` - see computeAvatarIdentityHashFromImageBuffer()'s own doc comment.
        const avatarIdentityHash = computeAvatarIdentityHashFromImageBuffer(outputImage);

        writeFileAtomicSync(outputImagePath, outputImage);

        // Phase-1 metadata-store write-path hook (see character-metadata-db.js's header on why this is the one
        // choke point every character create/edit/edit-avatar/edit-attribute/merge-attributes/import route
        // needs, rather than a hook duplicated at each of those call sites): the row this creates/updates for
        // `outputFile` gets a fresh date_added if it's genuinely new. /rename is the one caller that needs
        // something different (the *same* character continuing to exist under a new id/filename, so date_added
        // must carry over rather than reset, and its chat-stats need recomputing once the chats folder has
        // actually been moved) - see that route for how it corrects this generic row afterward.
        await fireMetadataUpsertHook(request.user.directories, `${outputFile}.png`, data, contentHash, avatarIdentityHash);

        return true;
    } catch (err) {
        console.error(err);
        return false;
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

// First 8 bytes every PNG file starts with - used below to recognize "this is already a PNG" without paying
// for a full Jimp decode just to answer that question.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parses an image buffer and applies crop if defined.
 *
 * When no crop is requested and `buffer` is already a PNG, the Jimp decode/cover/re-encode round trip is
 * skipped entirely and the original bytes are returned untouched - `cover()`'ing an image to its own existing
 * dimensions is a no-op transform that still produces different output bytes than the source encoder did
 * (different compressor, stripped ancillary chunks that aren't `chara`/`ccv3`), which is pure churn when
 * nothing was actually asked to change. A crop, or a non-PNG source that genuinely needs format conversion,
 * still goes through Jimp as before - this only removes the reencode when there's nothing for it to do.
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
 * Reads an image file and applies crop if defined.
 *
 * Same no-op-reencode avoidance as parseImageBuffer() above, for the file-path input case (the common one for
 * `/import`'s PNG importer and for the YAML/JSON importers' shared DEFAULT_AVATAR_PATH) - see that function's
 * doc comment for why skipping the Jimp round trip when there is genuinely nothing to change is safe. The
 * `catch` below already proved raw-bytes-passthrough is safe for a PNG Jimp can't decode (e.g. an APNG); this
 * generalizes the same passthrough to the far more common case of a plain PNG Jimp *could* decode but doesn't
 * need to, because no crop was requested.
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
export const processCharacter = async (item, directories, { shallow }) => {
    try {
        const imgFile = path.join(directories.characters, item);
        // One stat, reused for both the cache key (readCharacterData -> getCacheKey) and date_added below -
        // see getCacheKey()'s doc comment. Left undefined on ENOENT; readCharacterData() will hit the same
        // ENOENT via its own fallback stat and throw out of parse(), landing in this function's catch block
        // below without ever reaching the `charStat.ctimeMs` read.
        let charStat;
        try {
            charStat = fs.statSync(imgFile);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        const imgData = await readCharacterData(imgFile, 'png', charStat);
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character.json_data = imgData;
        character.date_added = charStat.ctimeMs;
        character.create_date = jsonObject.create_date || new Date(Math.round(charStat.ctimeMs)).toISOString();
        const chatsDirectory = path.join(directories.chats, item.replace('.png', ''));

        const { chatSize, dateLastChat } = calculateChatSize(chatsDirectory);
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
    console.info('Importing from YAML');
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
    const result = await writeCharacterData(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request, undefined, context.contentHash);
    return result ? fileName : '';
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

    const result = await writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request, undefined, contentHash);
    return result ? fileName : '';
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
    console.info('Importing from BYAF');

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

    const result = await writeCharacterData(byafData.images[0].image, JSON.stringify(card), fileName, request, undefined, contentHash);

    return result ? fileName : '';
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
    const result = await writeCharacterData(DEFAULT_AVATAR_PATH, data, pngName, request, undefined, contentHash);
    return result ? pngName : '';
}

/**
 * Pure (no file I/O, no sqlite) counterpart to importFromJson()'s per-spec business logic above - factored out
 * so local-import-scan.js's headless pipeline (2026-08 worker-owned-write extension) can drive the identical
 * spec dispatch/sanitize/normalize logic from a raw JSON text it already has in hand (its worker read the
 * source file's bytes once and handed the text straight back - see local-import-worker.js's own header) instead
 * of importFromJson()'s own uploadPath-based flow, which assumes a file on disk to read and delete.
 * @param {string} rawText Raw JSON text (same contract as fs.readFileSync(uploadPath, 'utf8') above).
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string | null} The final Spec V2 JSON string ready to embed via write()/writeCardToFile(), or
 * `null` if `rawText` matches none of the recognized shapes (mirrors importFromJson()'s own '' fallthrough).
 */
export function buildJsonImportData(rawText, directories) {
    let jsonData = JSON.parse(rawText);

    if (jsonData.spec !== undefined) {
        console.info(`Importing from ${jsonData.spec} json`);
        importRisuSprites(directories, jsonData);
        // Same pre-mutation snapshot as buildPngImportData() below, and for the same reason - see its comment.
        const rawName = jsonData.data?.name || jsonData.name;
        if (jsonData.data?.name) {
            jsonData.data.name = sanitize(jsonData.data.name);
        }
        jsonData.name = sanitize(String(rawName || ''));
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        // Last mutation before stringify - see omitInstallLocalFields()'s own doc comment on why import no
        // longer writes fav/chat into the card at all (the metadata store is authoritative for that state now).
        omitInstallLocalFields(jsonData);
        return JSON.stringify(jsonData);
    } else if (jsonData.name !== undefined) {
        console.info('Importing from v1 json');
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
        console.info('Importing from gradio json');
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
    const result = await writeCharacterData(uploadPath, data, pngName, request, undefined, contentHash);
    fs.unlinkSync(uploadPath);
    return result ? pngName : '';
}

/**
 * Pure (no file I/O, no sqlite) counterpart to importFromPng()'s per-spec business logic above - factored out
 * so local-import-scan.js's headless pipeline (2026-08 worker-owned-write extension) can drive the identical
 * spec dispatch/sanitize/normalize logic from a raw card text its worker already extracted (see
 * local-import-worker.js's own header: the worker reads a discovered PNG's bytes exactly once, extracts its
 * chunks once, and hands the decoded 'chara'/'ccv3' text straight back - the same ccv3-preferring read()
 * readCharacterData() above uses) instead of importFromPng()'s own uploadPath-based flow, which assumes a
 * staged file on disk to read.
 * @param {string} rawText Raw embedded card JSON text (same contract as readCharacterData()'s own return value).
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string | null} The final Spec V2 JSON string ready to embed via writeCardToFile(), or `null` if
 * `rawText` has neither `spec` nor `name` (mirrors importFromPng()'s own '' fallthrough).
 */
export function buildPngImportData(rawText, directories) {
    let jsonData = JSON.parse(rawText);

    // Read the pre-sanitize name once and reuse it for the fallback below - sanitize() below can turn a
    // non-empty-but-all-illegal name (e.g. ".") into an empty string, and re-reading jsonData.data.name AFTER
    // that mutation would then see that empty string as falsy and fall through to jsonData.name, which is
    // `undefined` on essentially every v2/v3 card (they only ever carry data.name). sanitize(undefined) throws
    // "Input must be string" - that's the exact crash this guarded against. Coercing through String(... || '')
    // also makes this tolerant of a card with no name field anywhere, which previously crashed the same way.
    const rawName = jsonData.data?.name || jsonData.name;
    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(String(rawName || ''));

    if (jsonData.spec !== undefined) {
        console.info(`Found a ${jsonData.spec} character file.`);
        importRisuSprites(directories, jsonData);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        omitInstallLocalFields(jsonData);
        return JSON.stringify(jsonData);
    } else if (jsonData.name !== undefined) {
        console.info('Found a v1 character file.');

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

        // Favorite status is db-authoritative from the moment a row exists (see character-metadata-db.js's
        // setCharacterFav() doc comment) - the card written below never carries `fav` at all, so read the
        // requested initial state here and seed the row with it (setCharacterFav(), further down) right after
        // writeCharacterData()'s own metadata-upsert hook has genuinely INSERTed it.
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
            await writeCharacterData(uploadPath, char, internalName, request, crop);
            fs.unlinkSync(uploadPath);
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
 * "Rename" a character - under Option A (design doc §2.2, §9 phase 4d) the avatar filename IS the immutable id,
 * so a display-name change is a pure card-data edit: no file move, no chats-directory copy, no
 * tag/charLore/note/active_character fan-out, no "please rename your sprites folder" toast. The route path and
 * request/response shape are unchanged (still `{ avatar_url, new_name }` in, `{ avatar }` out) so existing
 * callers - client and extensions alike - don't need to know identity stopped moving; `avatar` in the response
 * is now always identical to the `avatar_url` that was sent in.
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
        const rawData = await readCharacterData(avatarPath);
        if (rawData === undefined) throw new Error('Failed to read character file');

        const data = getCharaCardV2(JSON.parse(rawData), request.user.directories);
        _.set(data, 'data.name', newName);
        _.set(data, 'name', newName);
        const newData = JSON.stringify(data);

        // Rewrites the PNG in place at the SAME path/id. writeCharacterData()'s own write-path hook
        // (upsertCharacterFromWrite) upserts the existing row by id, so `name`/`name_fold`/`shallow_json`
        // refresh but `date_added` stays frozen (its ON CONFLICT clause never touches that column) - no separate
        // renameCharacterRow() call is needed anymore, because the id never changes.
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

    let char = charaFormatData(request.body, request.user.directories);
    char.chat = request.body.chat;
    char.create_date = request.body.create_date;
    // Favorite status is db-authoritative once a row exists (character-metadata-db.js's setCharacterFav() doc
    // comment) - an ordinary card edit must not carry `fav` back into the file at all, regardless of whatever
    // the request body's own `fav` field says (the client no longer sends a meaningful one - see script.js's
    // favorite-button click handler, which now calls the dedicated /fav route directly instead of folding a
    // toggle into this save).
    omitFavField(char);
    char = JSON.stringify(char);
    let targetFile = (request.body.avatar_url).replace('.png', '');

    try {
        if (!request.file) {
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            await writeCharacterData(avatarPath, char, targetFile, request);
        } else {
            const crop = tryParse(request.query.crop);
            const newAvatarPath = path.join(request.file.destination, request.file.filename);
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
            await writeCharacterData(newAvatarPath, char, targetFile, request, crop);
            fs.unlinkSync(newAvatarPath);

            // Bust cache to reload the new avatar
            cacheBuster.bust(request, response);
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
        const data = await readCharacterData(characterPath);
        if (!data) {
            return response.status(400).send('Error: failed to read character data');
        }

        const crop = tryParse(request.query.crop);
        const fileName = request.body.avatar_url.replace('.png', '');
        await writeCharacterData(uploadPath, data, fileName, request, crop);

        // Remove uploaded temp file
        fs.unlinkSync(uploadPath);

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
    console.debug(request.body);
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
        const charJSON = await readCharacterData(avatarPath);
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

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Use this in
 * the merge payload wherever a key should be deleted.
 *
 * Both the server and the frontend share this constant so that callers can
 * explicitly opt into deletion without overloading `null`.
 * @type {string}
 */
const UNSET_SENTINEL = '__@@UNSET@@__';

/** Maximum number of characters processed in parallel during bulk merge */
const BULK_MERGE_CONCURRENCY = 10;

/**
 * Recursively walks `source` and removes any key from `target` whose
 * corresponding value in `source` equals the {@link UNSET_SENTINEL}.
 * Called after {@link deepMerge} so that the sentinel gets replaced by
 * an actual key deletion.
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
 * Reads a character card, applies a merge update (with sentinel-based
 * unsetting), validates the result, and writes it back.
 * @param {string} avatarPath Full path to the character PNG
 * @param {string} avatar     Avatar filename (e.g. "char.png")
 * @param {object} updateData The merge payload to apply
 * @param {import("express").Request} request Express request object
 * @param {((data: any) => boolean) | null} [shouldSkip] Optional function to determine if a character should be skipped based on its original data (used for bulk merge filtering)
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean}>} Result of the merge operation, including any validation error
 */
async function mergeCharacterUpdate(avatarPath, avatar, updateData, request, shouldSkip = null) {
    const pngStringData = await readCharacterData(avatarPath);
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

    // Favorite status is db-authoritative once a row exists (character-metadata-db.js's setCharacterFav() doc
    // comment) - a merge payload's `fav`/`data.extensions.fav` (the shape slash-commands.js's /char-attribute
    // still advertises and sends) must never land in the card file, but it still has to take effect: pull the
    // intended value out here (merged the normal way first, so `deepMerge`'s existing precedence/nesting rules
    // decide the winning value exactly like every other field) and apply it through setCharacterFav() after the
    // write below, instead of writing it at all.
    const favRequested = _.has(update, 'fav') || _.has(update, 'data.extensions.fav');

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);
    const requestedFav = !!(character.fav ?? _.get(character, 'data.extensions.fav'));
    omitFavField(character);

    const validator = new TavernCardValidator(character);
    //Accept either V1 or V2.
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const targetImg = avatar.replace('.png', '');
    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request);
    if (favRequested) {
        await setCharacterFav(request.user.directories, avatar, requestedFav);
    }
    return { ok: true };
}

/**
 * Handle a POST request to edit character properties.
 *
 * Operates in two modes depending on the request body:
 *
 * **Single mode** (default behavior) — when `avatar` (string) is present:
 *   Merges the request body with the selected character and validates the
 *   result against TavernCard V2 specification.
 *
 * **Bulk mode** — when `avatars` (array) is present:
 *   Applies the same merge to multiple characters in parallel. Supports:
 *   - An explicit list of avatars, or all characters when the array is empty
 *   - An optional server-side `filter` so only characters where a given
 *     JSON path exists and is non-null are updated
 *
 * In both modes, any value equal to the sentinel `__@@UNSET@@__` will cause
 * that key to be **deleted** from the character card instead of being set.
 *
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

            // Determine which avatar files to process
            let targetAvatars;
            if (avatars.length > 0) {
                for (const avatar of avatars) {
                    if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar) || path.extname(avatar).toLowerCase() !== '.png') {
                        return response.status(400).send({ message: `Invalid avatar filename: ${avatar}` });
                    }
                }
                targetAvatars = avatars;
            } else {
                // Empty array → scan all characters in the directory
                const files = fs.readdirSync(request.user.directories.characters);
                targetAvatars = files.filter(file => path.extname(file).toLowerCase() === '.png');
            }

            const updated = [];
            const skipped = [];
            const failed = [];

            /**
             * Process a single character in bulk: read, filter, merge, validate, write.
             * @param {string} avatar Avatar filename
             */
            const processOne = async (avatar) => {
                const avatarPath = path.join(request.user.directories.characters, avatar);

                try {
                    /** @type {(character: object) => boolean} */
                    let shouldSkip = () => false;

                    // Apply optional server-side filter before updating the card
                    if (filter && typeof filter.path === 'string') {
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

            // Process in parallel with a concurrency limit
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
            response.sendStatus(200);
        } else {
            console.warn(result.error);
            response.status(400).send({ message: `Validation failed for ${update.avatar}`, error: result.error });
        }
    } catch (exception) {
        response.status(500).send({ message: 'Unexpected error while saving character.', error: exception.toString() });
    }
});

/**
 * HTTP POST endpoint for the "/api/characters/fav" route - the dedicated fav-toggle write path (owner decision:
 * favorite status is now a pure metadata-store mutation, not a card-file edit - see character-metadata-db.js's
 * setCharacterFav() doc comment). Deliberately does NOT go through writeCharacterData()/mergeCharacterUpdate():
 * no card read, no card write, no thumbnail/cache invalidation, no metadata-upsert-hook re-derivation - the one
 * thing this route touches is the `fav` column (plus its `shallow_json` mirror) of an already-tracked row.
 *
 * 404s (not 400) when the avatar isn't tracked yet, rather than silently doing nothing - a caller has no other
 * way to tell "no-op because unfavorited already" apart from "no-op because this row doesn't exist", and the
 * client only ever calls this for a character it already has in hand (so this should be unreachable in normal
 * use; a stale client cache is the only realistic trigger).
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

    fs.unlinkSync(avatarPath);
    invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
    await deleteCharacterRow(request.user.directories, request.body.avatar_url).catch(err =>
        console.error('[character-metadata] Failed to update metadata store after a character delete (the reconciler will catch it):', err));
    let dir_name = (request.body.avatar_url.replace('.png', ''));

    if (!dir_name.length) {
        console.error('Malicious dirname prevented');
        return response.sendStatus(403);
    }

    if (request.body.delete_chats == true) {
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
 * Applies optional sort/offset/limit to an already-fully-read character array. Every param is optional and
 * defaults to "return everything, in on-disk order" - i.e. calling this with `{}` is a no-op, so existing callers
 * that don't pass any of these params see byte-for-byte the same response shape/order as before this function
 * existed.
 * @param {object[]} data Full array of processed characters (already filtered to `c.name` truthy)
 * @param {object} params
 * @param {string} [params.sortField] One of SORT_FIELD_GETTERS' keys. Unknown/omitted -> no sort applied.
 * @param {string} [params.sortOrder] 'asc' (default) or 'desc'.
 * @param {number} [params.offset] Slice start. Omitted/NaN -> 0.
 * @param {number} [params.limit] Slice length. Omitted/NaN -> no limit (rest of the array).
 * @returns {{ items: object[], total: number }} `total` is the count *before* offset/limit is applied, so a
 * paginating caller knows how many pages exist.
 */
function paginateCharacters(data, { sortField, sortOrder, offset, limit } = {}) {
    const total = data.length;
    const getter = SORT_FIELD_GETTERS[sortField];
    if (getter) {
        const direction = sortOrder === 'desc' ? -1 : 1;
        // Stable sort (Array#sort is spec-guaranteed stable since ES2019) so same-key entries keep their
        // on-disk relative order instead of shuffling between identical requests.
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
 * Like paginateCharacters(), but merges in a groups array before sorting/slicing, so the list-view "one sorted
 * list of characters and groups together" ordering (see sortEntitiesList() in public/scripts/power-user.js) can
 * be produced server-side instead of requiring every character to be resident client-side first.
 *
 * SORT_FIELD_GETTERS' getters work unmodified on group objects: the `name` getter falls through to a group's
 * plain `.name` field (groups have no `.data`), and date_added/date_last_chat/chat_size are the exact field
 * names getGroupsData() (groups.js) already computes for groups, the same way processCharacter() computes them
 * for characters.
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
 * Merges pre-scored character/group Fuse search results (best-first, ascending score - the Fuse.js convention)
 * into one paginated, still best-first result. Comparing scores from the two independent Fuse indexes directly
 * isn't a new assumption - the client's own sortEntitiesList() "search" sort mode already does the same thing,
 * merging fuzzySearchCharacters()/fuzzySearchGroups()/fuzzySearchTags() (three separate Fuse instances) purely
 * by comparing their scores.
 * @param {import('fuse.js').FuseResult<object>[]} characterResults
 * @param {import('fuse.js').FuseResult<object>[]} groupResults
 * @param {object} params
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @param {number} [params.trueTotal] The real total match count (characters-search-index.js/
 * groups-search-index.js's own `total`, summed by the caller) - NOT the same as `combined.length` below.
 * `characterResults`/`groupResults` are each already capped at `offset + limit` rows before this function ever
 * sees them (see the `/all` handler's `searchFetchLimit`, sized only to cover the page being sliced out) - so
 * `combined.length` silently equals `min(realMatchCount, offset + limit)` and previously got reported to the
 * client as `total` outright. That's correct only by coincidence when the true match count is small; on a
 * broad query it just reports back the fetch cap it was given (confirmed against this install's real
 * 24,171-character library: a single-word query legitimately matched more than the default page limit, and the
 * old `total` silently read exactly as that limit, not the real match count) - which is exactly the number a
 * "showing X of Y" UI needs to be honest about. Falls back to `combined.length` if the caller doesn't have a
 * real total handy (keeps this function usable standalone).
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
 * HTTP POST endpoint for the "/api/characters/all" route.
 *
 * This endpoint is responsible for reading character files from the `charactersPath` directory,
 * parsing character data, calculating stats for each character and responding with the data.
 * Stats are calculated only on the first run, on subsequent runs the stats are fetched from
 * the `charStats` variable.
 * The stats are calculated by the `calculateStats` function.
 * The characters are processed by the `processCharacter` function.
 *
 * Accepts optional `sortField`/`sortOrder`/`offset`/`limit`/`search`/`includeGroups`/`fav` in the request body to
 * get a sorted (or fuzzy-searched) page back instead of the full array - see paginateCharacters()/paginateEntities()/
 * paginateSearchResults() above. None of these are required: a request with no body (or an empty one) behaves
 * exactly as before, returning every character in on-disk order. Passing sort/offset/limit alone is deliberately
 * just a slice of the already-fully-processed array, not a way to skip processing files outside the requested
 * page - every character on disk still gets read once per request, same as before this endpoint accepted these
 * params - so it does not reduce server-side I/O by itself, only response size/order and the amount of
 * client-side work (Fuse search, tag filtering, sort, DOM render) done over the result. Full-index consumers
 * (findChar() and friends, which need every character resolvable client-side, not just one page) should keep
 * calling this with no pagination params, exactly as `getCharacters()` does today.
 *
 * `search` runs the query against a persistent server-side Fuse index (see characters-search-index.js) built
 * from full (non-shallow) character data and the user's tags.json, using the exact same keys/weights/options as
 * the client's own fuzzySearchCharacters() - so results rank identically to what the same term would produce
 * client-side, just without needing every character resident first. When `search` is present, `sortField`/
 * `sortOrder` are ignored (mirrors sortEntitiesList()'s isSearch branch, which always sorts by score).
 *
 * `includeGroups: true` merges the user's groups into the same sorted-or-searched, paginated result (see
 * paginateEntities()/paginateSearchResults()). This changes `items` to an array of `{ type, item }` instead of
 * bare character objects, since an item may now be a character *or* a group.
 *
 * `fav: true` (only meaningful together with `search`) restricts matches to favorited characters/groups, applied
 * inside the search index query itself rather than after the `offset+limit`-sized page is fetched - see
 * searchCharacters()'s `favOnly` doc comment (characters-search-index.js) for why a post-fetch filter here would
 * be wrong: a favorited item's text relevance to the search term is unrelated to its favorite status, so it can
 * rank arbitrarily far outside whatever page a plain relevance search returns, silently making a favorites-only
 * search on a large library look like it returns nothing.
 *
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
// Real-world crash (see git history): fetchServerCharacterSearchResults() (script.js) calls this endpoint with
// `{ search, includeGroups: true }` on every keystroke and never sends `limit` - it only needs enough top
// matches to usefully re-rank the already-resident character list, not literally every match. Below, once any
// pagination-shaped param puts a request into one of the paginate*() branches, an omitted `limit` used to mean
// "unbounded" (Number.isFinite(Number(undefined)) is false, so paginateSearchResults()/paginateEntities()/
// paginateCharacters() would slice(start, undefined) - i.e. not slice at all). FTS5 prefix-matches each
// whitespace token against 11 text columns per character, so a short/common search-as-you-type term (or an
// in-progress `label:query` pill) routinely matches most of a large library - confirmed against this install's
// real 24,171-character library, a one-letter query matched effectively the entire set. That produced one
// `response.send()` (JSON.stringify) call over tens of thousands of full result objects at once, which is what
// took the process's heap to ~4GB and crashed it with a JS heap OOM. A "page" endpoint silently returning the
// whole unbounded set just because `limit` was omitted - while `search`/`includeGroups` themselves were
// present, i.e. very much a paginated request - was the actual bug; this default closes it for all three
// paginate*() branches below, not just the search one that happened to crash first.
const DEFAULT_PAGE_LIMIT = 500;

/**
 * Overwrites each character's `.fav` with the metadata store's own value, in place - the live `/all` route's
 * counterpart to the `/query` route's group-hydration stamp (`{ ...group, fav: r.fav, ... }` above): `fav` is
 * db-authoritative once a row is tracked (see character-metadata-db.js's writeRowSync()/setCharacterFav() doc
 * comments), so whatever processCharacter() read straight off the card file is a stale/irrelevant value for any
 * already-tracked character, not a fallback to merge with. One batched query for the whole page rather than one
 * per character.
 *
 * A character NOT YET tracked (getCharacterFavsByIds() simply omits it - the bootstrap/watcher/reconciler
 * haven't caught up to a brand-new file yet) is left untouched, keeping whatever processCharacter() read from
 * the card - the file is still the only source for a character the metadata store hasn't seen yet.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object[]} characters Already-processed character objects (each with `.avatar` set - see
 * processCharacter()) - mutated in place.
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

router.post('/all', async function (request, response) {
    try {
        const { sortField, sortOrder, offset, limit, search, includeGroups, fav } = request.body ?? {};
        const favOnly = fav === true;

        if (sortField === undefined && offset === undefined && limit === undefined && !search && !includeGroups) {
            const files = fs.readdirSync(request.user.directories.characters);
            const pngFiles = files.filter(file => file.endsWith('.png'));
            const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters }));
            const data = (await Promise.all(processingPromises)).filter(c => c.name);
            await stampDbFav(request.user.directories, data);
            // No pagination params at all: preserve the exact pre-existing response shape (a bare array).
            return response.send(data);
        }

        const numericOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
        const numericLimit = Number.isFinite(Number(limit)) ? Number(limit) : DEFAULT_PAGE_LIMIT;

        if (search) {
            const handle = request.user.profile.handle;
            // 'tantivy' (not 'native') on purpose: this is a placeholder for "groups weren't searched at all"
            // (includeGroups: false), and BACKEND_SEVERITY below reports whichever of the two is *worse* - it has
            // to be the best possible tier so it never wins that comparison and misreports a real tantivy-backed
            // characterSearch result as running on a lesser tier it never touched.
            const emptySearch = { results: [], total: 0, backend: 'tantivy' };
            // Each source only needs to fetch its own top (offset + limit) rows to guarantee a correct merged
            // page - paginateSearchResults() below still does the real character/group interleave-by-score and
            // final slice, this just stops each individual FTS5 query (and the JSON.parse() of every one of its
            // rows - see querySqliteIndex()) from doing that work across the *entire* matching set first.
            const searchFetchLimit = numericOffset + numericLimit;
            // favOnly restricts both searches to favorited items *inside* the query itself (see
            // searchCharacters()'s `favOnly` doc comment, characters-search-index.js) - not a post-fetch filter
            // over `searchFetchLimit` relevance-ranked rows, which would silently drop any favorited match that
            // doesn't happen to rank in the top `searchFetchLimit` results for the term (real bug: a favorites-only
            // + search combination on a large library could return zero results for a term that has thousands of
            // real matches, because none of the relevance-top-N happened to be favorited).
            const [characterSearch, groupSearch] = await Promise.all([
                searchCharacters(handle, request.user.directories, search, searchFetchLimit, favOnly),
                includeGroups ? searchGroups(handle, request.user.directories, search, searchFetchLimit, favOnly) : emptySearch,
            ]);
            // The search index is always built from *full* character data (see characters-search-index.js) -
            // trim results down to shallow fields here to match this server's normal list-response shape
            // (`performance.lazyLoadCharacters`), same as the non-search path does via processCharacter()'s own
            // `shallow` option.
            const finalCharacterResults = useShallowCharacters
                ? characterSearch.results.map(r => ({ ...r, item: toShallow(r.item) }))
                : characterSearch.results;
            // Same db-authoritative stamp stampDbFav() applies to the non-search path above - the search index's
            // own `fav` copy (characters-search-index.js) can lag behind a db-only fav toggle (setCharacterFav()
            // never touches the card file, so it can't trigger a reindex the way an ordinary write does), so a
            // displayed result's `.fav` still needs correcting here even though `favOnly` itself was already
            // decided against whatever the index had at query time - see this function's own doc comment.
            await stampDbFav(request.user.directories, finalCharacterResults.map(r => r.item));

            const { items, total } = paginateSearchResults(finalCharacterResults, groupSearch.results, {
                offset: numericOffset, limit: numericLimit,
                trueTotal: characterSearch.total + groupSearch.total,
            });
            // searchBackend lets the client (fetchServerCharacterSearchResults(), script.js) show a visible
            // indicator when search is running on anything other than the fastest engine tier (see
            // search-engine.js) instead of that only ever showing up as a server console warning. Character and
            // group search resolve the engine independently but always agree in practice (both go through the
            // same process-wide resolveSearchEngine() cache) - this just reports whichever is worse, in case they
            // ever don't.
            const BACKEND_SEVERITY = { tantivy: 0, native: 1, wasm: 2, unavailable: 3 };
            const searchBackend = BACKEND_SEVERITY[groupSearch.backend] > BACKEND_SEVERITY[characterSearch.backend]
                ? groupSearch.backend
                : characterSearch.backend;
            const payload = includeGroups ? { items, total } : { items: items.map(x => x.item), total };
            payload.searchBackend = searchBackend;
            return response.send(payload);
        }

        const files = fs.readdirSync(request.user.directories.characters);
        const pngFiles = files.filter(file => file.endsWith('.png'));
        const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters }));
        const data = (await Promise.all(processingPromises)).filter(c => c.name);
        await stampDbFav(request.user.directories, data);

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
 * HTTP POST endpoint for the "/api/characters/metadata/rescan" route.
 *
 * Forces an out-of-cycle pass of the phase-1 metadata store's background reconciler (see
 * character-metadata-db.js's header on why the reconciler is a mandatory backstop, not optional) for the
 * calling user, rather than waiting for the next periodic interval. Not called by any client UI yet - this is
 * the "explicit rescan endpoint" the design doc's §3.2 calls for, for an owner (or a future admin UI) to use
 * directly after a change they know the watcher/reconciler haven't caught up to yet.
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
 * HTTP POST endpoints for "/api/characters/metadata/batch-import/{begin,end}".
 *
 * Explicit batch-import mode for the phase-1 metadata store (design doc §3.3 item 7) - not wired to any client
 * UI yet, since a large corpus import is presently a scripted/manual owner workflow (there is no "import 300k
 * characters at once" endpoint; each /import call is its own request). Wrap such a scripted import in a call to
 * `begin` before and `end` after to avoid one SQLite transaction and one directory-watcher event per file - see
 * beginBatchImport()'s own doc comment for exactly what this suspends/buffers.
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

// Phase 2's sortable fields (design doc §5's `sort.field` union) - kept here (not imported from
// character-metadata-db.js) because this is specifically the set of values this HTTP layer accepts as *valid
// input* before ever calling into the metadata module - a distinct concern from that module's own "which SQL
// column does this map to". 'random' and 'search' are real, handled values (see the route below), not rejected -
// they just don't map to a QUERYABLE_SORT_COLUMNS entry, since neither is a plain column sort.
const QUERY_SORT_FIELDS = new Set(['name', 'date_added', 'date_last_chat', 'chat_size', 'fav', 'random', 'search']);

// page/pageSize bounds for "/query" - page/pageSize is the doc's §5 contract shape (not offset/limit, which is
// queryCharacters()'s own internal shape - this route is where the translation happens). The upper bound on
// pageSize is a defensive cap, not something the doc mandates: an unbounded client-supplied page size would let
// a single request force an unbounded LIMIT, defeating the entire point of paginating in the first place.
const DEFAULT_QUERY_PAGE_SIZE = 500;
const MAX_QUERY_PAGE_SIZE = 2000;

/**
 * HTTP POST endpoint for the "/api/characters/query" route (design doc §5): the phase-2 replacement for the
 * fs.readdirSync()+PNG-parse-everything+slice-in-JS shape of a plain (no search term) `/all` browse request -
 * this endpoint never touches the filesystem or parses a PNG for a plain (no `filter.search`) request; every
 * field it can return already lives in the phase-1 SQLite metadata table (character-metadata-db.js), kept fresh
 * by that module's write hooks/watcher/reconciler independent of this request. A `filter.search` request routes
 * through characters-search-index.js's tantivy/FTS5 tier to resolve the matched id set, then intersects that
 * with this table via `queryCharacters()`'s `ids` filter (doc §5's "push the FTS hit-id set into SQLite as a
 * temporary table and let SQLite do the filtering and ordering" composition plan) - still zero PNG parses,
 * regardless of search.
 *
 * NOT YET WIRED TO ANY CLIENT CODE. Per the design doc's own phase table, inverting `getEntitiesList()`/
 * `printCharacters()` (public/script.js) to actually call this instead of the old fully-resident-array path is
 * phase 5's job, not phase 2's - this endpoint exists and is correct, but the browse UI still goes through the
 * pre-existing `/all` handler above until that phase lands. This mirrors how `/metadata/rescan` and the
 * batch-import endpoints above landed in phase 1 unwired, for the same reason.
 *
 * `sort.field: 'random'` (design doc §5.3, decisions 8/10/13) requires `sort.seed` - a finite number the client
 * generated and persisted (public/scripts/random-sort.js's mintRandomSortSeed()/getRandomSortSeed(), phase 5b,
 * already shipped client-side). Omitting it 400s rather than silently defaulting to *some* seed: decision 10 is
 * explicit that the seed is client-owned so two tabs/devices can disagree without coordination, and a
 * server-minted fallback would defeat that plus break pagination the moment the client reloads and gets a
 * different seed than whatever the server silently used for page 1.
 *
 * `sort.field: 'search'` requires `filter.search` (same rule as the pre-existing client-side
 * `verifyCharactersSearchSortRule()`), but a `filter.search` term composes with *any* sort field, not just
 * 'search' - decision 23: "random and search compose unconditionally... sort stops being forced by the presence
 * of a query." Search narrows the candidate id set; whatever sort field is chosen orders it (relevance for
 * 'search', the seeded hash for 'random', a plain column otherwise).
 *
 * `filter.includeGroups: true` (owner decision extending the character-data-residency-redesign to groups, not
 * part of the original design doc's §5 contract) merges the user's groups into the same sorted, paginated
 * result, the SQL-backed analogue of what `/all`'s own `includeGroups` already does over a full in-memory scan
 * (see paginateEntities() above). Response shape changes accordingly: `rows` becomes
 * `Array<{ type: 'character', item: Character } | { type: 'group', item: Group }>` instead of a bare
 * `Character[]`, and `total` counts both. **Omitted or `false` is byte-for-byte today's existing behavior** -
 * every existing caller (favsToHotswap, CharacterRepository.queryAll, characters-query.test.js) keeps seeing
 * exactly what it always has; this is the compatibility bar the implementation is built to hold, not a
 * best-effort goal.
 *
 * `filter.search` + `filter.includeGroups: true`: groups have no full-text index and this extension does not add
 * one (owner decision - see character-metadata-db.js's queryEntities() header). A non-empty `filter.search`
 * therefore always routes through the pre-existing, characters-only queryCharacters() call below regardless of
 * `includeGroups` - the result is simply wrapped into `{type: 'character', item}` shape when `includeGroups` was
 * requested, so the response envelope stays consistent, but no group can ever appear in a search result. Not an
 * error - matching the existing `sort.field: 'search'` rule's own "requires, doesn't merely permit" documentation
 * style, this is a hard scope boundary, not a fallback.
 *
 * `filter.tags.include` composes with `includeGroups` for free (no separate mechanism): character_tags and
 * group_tags are both indexed by tag_id, so a `{filter: {tags: {include: [folderId]}}, includeGroups: true}`
 * request is exactly "open a folder" - it returns every character and group carrying that tag as one merged,
 * paginated page, since a folder can contain both.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
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
            if (w !== 'rows' && w !== 'total') {
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
        };
        // Whether a total computed against a search-narrowed candidate set is exact or has to be flagged
        // approximate (design doc §5 decision 6: "approximate is fine, capped is not" - the wire convention is a
        // `~` prefix, never a bare-but-silently-truncated number).
        let approxTotal = false;

        if (hasSearch) {
            const handle = request.user.profile.handle;
            // 'search' sort only needs a relevance-ordered page-sized window (runIdSearch()'s own doc comment on
            // why tantivy's payload shrink makes this cheap either way); any other sort needs the *whole*
            // matched candidate set (bounded by SEARCH_ID_CAP) since ordering doesn't come from relevance rank -
            // see SEARCH_ID_CAP's doc comment (characters-search-index.js) for why sort:'random' + search is
            // exactly the case this matters for (decision 23).
            const idFetchCap = sort.field === 'search' ? offset + pageSize : SEARCH_ID_CAP;
            const favOnly = filter.fav === true;
            const searchResult = await searchCharacterIds(handle, request.user.directories, searchTerm, idFetchCap, favOnly);
            searchBackend = searchResult.backend;

            // filter.ids (an explicit "resolve exactly these ids" request) and filter.search both restrict the
            // candidate set - when both are present they intersect, not override each other. Order is preserved
            // from the search engine's relevance ranking either way (queryCharacters()'s 'search' branch uses
            // this same array as idOrder; other sort fields ignore order here and let SQL ORDER BY decide it).
            const explicitIds = Array.isArray(filter.ids) ? new Set(filter.ids) : null;
            const effectiveIds = explicitIds ? searchResult.ids.filter(id => explicitIds.has(id)) : searchResult.ids;

            approxTotal = searchResult.total > idFetchCap;
            queryParams = { ...queryParams, ids: effectiveIds, idOrder: searchResult.ids };

            if (effectiveIds.length === 0) {
                const rev = (await queryCharacters(request.user.directories, { ids: [], wantRows: false, wantTotal: false }))?.rev ?? 0;
                const payload = { rev, searchBackend };
                if (wantRows) payload.rows = [];
                if (wantTotal) payload.total = 0;
                return response.send(payload);
            }
        }

        // filter.includeGroups (owner decision extending the design doc's §5 contract to groups - see this
        // route's own doc comment above): a search request always answers from queryCharacters() (characters-only
        // - groups have no full-text index, see queryEntities()'s header), so only a non-search request with
        // includeGroups actually reaches queryEntities()'s UNION ALL path.
        if (!hasSearch && includeGroups) {
            const result = await queryEntities(request.user.directories, queryParams);
            if (result === null) {
                return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
            }

            const payload = { rev: result.rev };
            if (wantTotal) payload.total = result.total;
            if (wantRows) {
                // Hydrate just this page's group ids (getGroupsByIds() - bounded by pageSize, never a
                // whole-directory read) and stamp queryEntities()'s own fav/date_added/date_last_chat/chat_size
                // onto each one, so what's displayed always agrees with what the page was actually sorted by
                // (see queryEntities()'s header on why hydration doesn't re-derive these from a live stat).
                const groupIds = result.rows.filter(r => r.type === 'group').map(r => r.id);
                const groupsById = groupIds.length > 0 ? getGroupsByIds(request.user.directories, groupIds) : {};
                payload.rows = result.rows.map(r => {
                    if (r.type === 'character') {
                        return { type: 'character', item: r.item };
                    }
                    const group = groupsById[r.id];
                    if (!group) {
                        // The metadata row exists but the group's JSON file doesn't (deleted out from under a
                        // stale row, or unreadable) - drop it rather than shipping a null item the client isn't
                        // expecting. Rare and self-correcting: the next /delete or /edit reconciles the metadata
                        // row against reality.
                        return null;
                    }
                    return { type: 'group', item: { ...group, fav: r.fav, date_added: r.date_added, date_last_chat: r.date_last_chat, chat_size: r.chat_size } };
                }).filter(Boolean);
            }
            return response.send(payload);
        }

        const result = await queryCharacters(request.user.directories, queryParams);

        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }

        const payload = { rev: result.rev };
        if (wantRows) payload.rows = includeGroups ? result.rows.map(item => ({ type: 'character', item })) : result.rows;
        if (wantTotal) payload.total = approxTotal ? `~${result.total}` : result.total;
        if (searchBackend !== undefined) payload.searchBackend = searchBackend;
        return response.send(payload);
    } catch (err) {
        console.error('[characters/query] Query failed:', err);
        return response.status(500).send({ error: true });
    }
});

/**
 * HTTP POST endpoint for the "/api/characters/search-index/rebuild" route (design doc §3.2): the explicit repair
 * path for a user's character search index (tantivy or, on installs without it, the SQLite FTS5 fallback tier -
 * see characters-search-index.js). Forces an immediate full rebuild regardless of the current freshness
 * signature - "the existing full-rebuild path stays, demoted to a repair tool behind an explicit endpoint rather
 * than something a directory mtime change can trigger implicitly." Not wired to any client UI yet, same
 * unwired-but-real status as `/metadata/rescan` and the batch-import endpoints above.
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
 * HTTP POST endpoint for the "/api/characters/exists" route (design doc §4.2): chunked existence-by-id, answered
 * from the phase-1 metadata table's primary key rather than the filesystem. Not yet wired to any client
 * call site - the destructive-existence sites this backs (group-chats.js's validateGroup, world-info.js's binding
 * cleanup, tags.js's backup-restore/prune) are phase 5 client work; this lands the server capability first, same
 * reasoning as `/query` above.
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
 * HTTP POST endpoint for the "/api/characters/changes" route (design doc §5.2): a change feed over the phase-1
 * metadata store's change log, meant to eventually replace `/api/characters/manifest`'s readdir+stat-everything
 * boot scan. NOT wired to replace `/manifest` yet - the doc scopes that client-side cutover ("once browse is
 * server-paginated") to phase 5/6, alongside character-cache.js's own IndexedDB rework; `/manifest` keeps serving
 * the existing boot-diff flow unchanged. This only adds the endpoint.
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/changes', async function (request, response) {
    try {
        const sinceRev = Number(request.body?.sinceRev);
        if (!Number.isFinite(sinceRev) || sinceRev < 0) {
            return response.sendStatus(400);
        }

        const result = await getChangesSince(request.user.directories, sinceRev);
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
 * HTTP POST endpoint for the "/api/characters/manifest" route.
 *
 * Lightweight companion to `/all`: returns just `[{ avatar, mtime, thumbnailVersion }, ...]` for every
 * character PNG in the user's library, one entry per file, with no PNG tEXt-chunk read, no JSON parse, and no
 * chat-size calculation (the expensive parts of processCharacter()). This is meant to be fetched on every boot
 * so the client can diff it against what it already has cached (see character-cache.js) and only request full
 * data for characters that are new or whose mtime changed, instead of always re-fetching the entire library
 * via `/all`.
 *
 * mtimeMs (last content modification), not ctimeMs (metadata/inode change time, which is what processCharacter()
 * uses for date_added) - a real edit to the character's data is what should invalidate a client's cached copy.
 *
 * `thumbnailVersion` is a *different* value from `mtime` above - it's the cached avatar thumbnail's own mtime
 * (via getThumbnailVersion(), see src/endpoints/thumbnails.js), not the source PNG's. The two diverge: a
 * thumbnail is only (re)generated lazily on first request to GET /thumbnail, so its mtime reflects whenever
 * that happened, not when the source character file last changed. Handing the client this value lets
 * getThumbnailUrl() emit the thumbnail route's `?v=` up front and skip its no-cache redirect hop; null when no
 * cached thumbnail exists yet (client just omits `v`, same as before this field existed).
 *
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
 * HTTP POST endpoint for the "/api/characters/batch" route.
 *
 * Fetches full (or shallow, per `performance.lazyLoadCharacters`) character data for a specific list of
 * avatars, via the same processCharacter() every other character-reading endpoint uses. This is the other half
 * of the `/manifest` delta-caching flow: after diffing `/manifest` against its cache, the client calls this
 * with only the avatars that are new or changed, instead of re-fetching every character via `/all`.
 *
 * Each requested avatar is validated with the same forbidden-character check `validateAvatarUrlMiddleware`
 * applies to a single `avatar_url` field - done manually here rather than via that middleware since this
 * endpoint takes an array, not a single field.
 *
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/batch', async function (request, response) {
    try {
        const avatars = Array.isArray(request.body?.avatars) ? request.body.avatars : [];

        for (const avatar of avatars) {
            if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar)) {
                return response.sendStatus(400);
            }
        }

        const processingPromises = avatars.map(avatar => processCharacter(avatar, request.user.directories, { shallow: useShallowCharacters }));
        const data = (await Promise.all(processingPromises)).filter(c => c.name);
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
        const chatsDirectory = path.join(request.user.directories.chats, characterDirectory);

        if (!fs.existsSync(chatsDirectory)) {
            return response.send({ error: true });
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
        return response.send({ error: true });
    }
});

/**
 * Mints the immutable id a new character is created/imported under (design doc §2.2, SETTLED Option A): a
 * UUIDv7, unrelated to the display name. Naming the PNG after this id rather than a sanitized display name is
 * what makes `/rename` a pure card-data edit (§9 phase 4d) and retires the old `getPngName()`'s 10k-probe
 * uniqueness dance and its overwrite-on-exhaustion fallback - a freshly minted UUIDv7 essentially cannot
 * collide with an existing id, but per the doc's "correctness over cost" input (§0 decision 1) this still
 * checks rather than assumes, and throws (never silently overwrites) if collisions persist past a handful of
 * tries.
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
 * sha256 hex digest of a file's raw bytes, streamed rather than read fully into memory first - the natural hash
 * point for bulk-import dedup (see `/import` below): this runs on the multer-saved upload BEFORE any
 * format-specific parsing touches it, so it's always hashing the exact bytes the user dropped, regardless of
 * format. Exported for local-import-scan.js, which needs the identical hash-then-dedup ordering against a
 * locally-discovered file instead of a multer upload.
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

/**
 * Format -> importer dispatch table for `/import` below, hoisted to module scope so importCharacterFileHeadless()
 * (local-import-scan.js's entry point) can reuse the exact same table rather than a second copy that could drift.
 */
const formatImportFunctions = {
    'yaml': importFromYaml,
    'yml': importFromYaml,
    'json': importFromJson,
    'png': importFromPng,
    'charx': importFromCharX,
    'byaf': importFromByaf,
};

/**
 * Headless counterpart to `POST /import` for the local-directory-scan feature (local-import-scan.js) - there is
 * no real HTTP request for a scan-discovered file, so this builds the minimal fake Express `request` object that
 * writeCharacterData()/the importFromX() functions actually read fields off of (`user.directories`,
 * `user.profile.handle` for the disk-cache sync queue, and `body` for BYAF's optional persona name), and drives
 * them through the exact same `formatImportFunctions` dispatch table, hash-based exact-duplicate dedup
 * (findCharacterIdByContentHash()), and writeCharacterData()/metadata-upsert path `/import` uses - so a
 * scan-discovered file is imported through the identical machinery a browser-uploaded one would be, not a
 * parallel reimplementation of it.
 *
 * `filePath` must already be a file this function is allowed to consume: every formatImportFunctions() entry
 * reads it and then deletes/unlinks it as part of normal processing (matching what they already do to a
 * multer-saved upload) - callers must pass a copy staged for this purpose (see local-import-scan.js, which gets
 * it there via copyCharacterFile()), never the original source file outside the managed tree.
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

        // Exact-byte-identical dedup (owner-scoped: no near-duplicate/fuzzy matching - see
        // findCharacterIdByContentHash()'s own doc comment for the in-batch case). Deliberately skipped when
        // `preservedFileName` is set: that request is an explicit "replace THIS specific character" action from
        // the caller, and silently no-op'ing it because its bytes happen to match some OTHER character would
        // ignore that explicit target rather than honor it - a worse outcome than just letting the replace
        // proceed. Dedup only ever BLOCKS a genuine new-character import, which is also the only case where
        // "this exact content is already in the library" is an unambiguous reason to skip.
        //
        // The hash itself is still always computed and recorded (including for a preserved-name replace) -
        // skipping that too would leave content_hash stale after a replace (still pointing at whatever bytes
        // this id was FIRST imported with), which would then make a later genuine duplicate of the *new* content
        // undetectable. Only the "skip the import" branch below is preservedFileName-gated, not the hash.
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

        // Hands the client the freshly-imported character's data in the same response, shaped by the identical
        // processCharacter() /batch and /get already use - this is what lets the client (processDroppedFiles(),
        // public/script.js) insert the new character straight into charactersStore and run its tag-import logic
        // immediately, per-card, instead of a second full-library fetch afterward just to learn what it itself
        // already just uploaded. One extra parse of the single file just written - not a library-wide cost.
        const character = await processCharacter(`${fileName}.png`, request.user.directories, { shallow: useShallowCharacters });

        response.send({ file_name: fileName, character });
    } catch (err) {
        console.error(err);
        response.send({ error: true });
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

        // If filename ends with a _number, increment the number. Parsed with a single strict-integer regex
        // rather than a `Number()` guard paired with a `parseInt()` use - those two disagree on inputs like
        // an empty or "Infinity" trailing segment (e.g. `foo_.png`), which used to let a NaN suffix through:
        // the first dupe silently produced `foo_NaN.png`, and the second dupe span forever in the loop below,
        // since `foo_NaN.png` always exists and `NaN++` stays `NaN` - a synchronous existsSync spin that
        // wedged the whole server on one request (docs/design/character-data-residency-redesign.md §1.3).
        //
        // That parse fix alone wasn't enough: `/^\d+$/` still accepts arbitrarily long digit strings, and
        // once the parsed suffix exceeds Number.MAX_SAFE_INTEGER (16 digits), `suffix++` stops advancing in
        // float precision (e.g. stuck at 1e22) - same synchronous existsSync wedge, just a longer digit-string
        // trigger instead of the original one-character one. Two independent guards close this for good:
        // capping the regex to safe-integer-length digit strings keeps `suffix` itself always a real,
        // strictly-increasing integer, and the attempt counter below bounds the loop by iteration count
        // (never by the numeric value of `suffix`), so it terminates even if some future change reintroduces
        // a non-advancing suffix.
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

        // /duplicate doesn't go through writeCharacterData() (it's a raw file copy, not a re-encode), so it
        // needs its own metadata-store hook rather than getting one for free - see writeCharacterData()'s own
        // hook for why every other write route doesn't need this. The duplicate is a genuinely new character
        // (a new id under this pre-Option-A identity scheme - design doc §2.2), so this is a plain generic
        // upsert, not a rename-shaped one: date_added = now is correct here.
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
                const rawBuffer = await fsPromises.readFile(filename);
                const rawData = read(rawBuffer);
                const mutatedData = mutateJsonString(rawData, unsetPrivateFields);
                const mutatedBuffer = write(rawBuffer, mutatedData);
                const contentType = mime.lookup(filename) || 'image/png';
                response.setHeader('Content-Type', contentType);
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(path.basename(filename))}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                try {
                    const json = await readCharacterData(filename);
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
