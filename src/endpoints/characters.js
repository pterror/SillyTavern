import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { Buffer } from 'node:buffer';

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
import { deepMerge, humanizedDateTime, tryParse, MemoryLimitedMap, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements, getArrayBufferSlice } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { parse, read, write } from '../character-card-parser.js';
import { getCharaCardV2, convertToV2, readFromV2, charaFormatData, convertWorldInfoToCharacterBook } from '../character-card-normalize.js';
import { calculateChatSize, calculateDataSize, toShallow } from '../character-shallow.js';
import { invalidateThumbnail } from './thumbnails.js';
import { importRisuSprites } from './sprites.js';
import { getUserDirectories } from '../users.js';
import { getChatInfo } from './chats.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { searchCharacters } from './characters-search-index.js';
import { searchGroups } from './groups-search-index.js';
import { getGroupsData } from './groups.js';
import { upsertCharacterFromWrite, deleteCharacterRow, renameCharacterRow, reconcile as reconcileMetadataStore, beginBatchImport, endBatchImport, queryCharacters, checkCharactersExist, getChangesSince } from '../character-metadata-db.js';

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
 * @returns {Promise<void>}
 */
async function fireMetadataUpsertHook(directories, avatar, data) {
    try {
        const stat = await fsPromises.stat(path.join(directories.characters, avatar));
        await upsertCharacterFromWrite(directories, avatar, data, stat.mtimeMs);
    } catch (err) {
        console.error('[character-metadata] Failed to update metadata store after a character write (the reconciler will catch it):', err);
    }
}

/**
 * Writes the character card to the specified image file.
 * @param {string|Buffer} inputFile - Path to the image file or image buffer
 * @param {string} data - Character card data
 * @param {string} outputFile - Target image file name
 * @param {import('express').Request} request - Express request obejct
 * @param {Crop|undefined} crop - Crop parameters
 * @returns {Promise<boolean>} - True if the operation was successful
 */
async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined) {
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

        const inputImage = await getInputImage();

        // Get the chunks
        const outputImage = write(inputImage, data);
        const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);

        writeFileAtomicSync(outputImagePath, outputImage);

        // Phase-1 metadata-store write-path hook (see character-metadata-db.js's header on why this is the one
        // choke point every character create/edit/edit-avatar/edit-attribute/merge-attributes/import route
        // needs, rather than a hook duplicated at each of those call sites): the row this creates/updates for
        // `outputFile` gets a fresh date_added if it's genuinely new. /rename is the one caller that needs
        // something different (the *same* character continuing to exist under a new id/filename, so date_added
        // must carry over rather than reset, and its chat-stats need recomputing once the chats folder has
        // actually been moved) - see that route for how it corrects this generic row afterward.
        await fireMetadataUpsertHook(request.user.directories, `${outputFile}.png`, data);

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

/**
 * Parses an image buffer and applies crop if defined.
 * @param {Buffer} buffer Buffer of the image
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function parseImageBuffer(buffer, crop) {
    const image = await Jimp.fromBuffer(buffer);
    return await applyAvatarCropResize(image, crop);
}

/**
 * Reads an image file and applies crop if defined.
 * @param {string} imgPath Path to the image file
 * @param {Crop|undefined} crop Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function tryReadImage(imgPath, crop) {
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
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromYaml(uploadPath, context, preservedFileName) {
    const fileText = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);
    const yamlData = yaml.parse(fileText);
    console.info('Importing from YAML');
    yamlData.name = sanitize(yamlData.name);
    const fileName = preservedFileName || getPngName(yamlData.name, context.request.user.directories);
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
    const result = await writeCharacterData(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request);
    return result ? fileName : '';
}

/**
 * Imports a character card from CharX (ZIP) file.
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromCharX(uploadPath, { request }, preservedFileName) {
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
    unsetPrivateFields(processedCard);
    processedCard.create_date = new Date().toISOString();

    const fileName = preservedFileName || getPngName(processedCard.name, request.user.directories);
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

    const result = await writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request);
    return result ? fileName : '';
}

async function importFromByaf(uploadPath, { request }, preservedFileName) {
    const data = getArrayBufferSlice(await fsPromises.readFile(uploadPath));
    await fsPromises.unlink(uploadPath);
    console.info('Importing from BYAF');

    const byafData = await new ByafParser(data).parse();
    const card = readFromV2(byafData.card);
    const fileName = preservedFileName || getPngName(sanitize(byafData.character.displayName || card.name, { replacement: sanitizeSafeCharacterReplacements }), request.user.directories);

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

    const result = await writeCharacterData(byafData.images[0].image, JSON.stringify(card), fileName, request);

    return result ? fileName : '';
}

/**
 * Import a character from a JSON file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromJson(uploadPath, { request }, preservedFileName) {
    const data = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);

    let jsonData = JSON.parse(data);

    if (jsonData.spec !== undefined) {
        console.info(`Importing from ${jsonData.spec} json`);
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        if (jsonData.data?.name) {
            jsonData.data.name = sanitize(jsonData.data.name);
        }
        jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, char, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        console.info('Importing from v1 json');
        jsonData.name = sanitize(jsonData.name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
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
        char = convertToV2(char, request.user.directories);
        let charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.char_name !== undefined) {
        //json Pygmalion notepad
        console.info('Importing from gradio json');
        jsonData.char_name = sanitize(jsonData.char_name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.char_name, request.user.directories);
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
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    }

    return '';
}

/**
 * Import a character from a PNG file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromPng(uploadPath, { request }, preservedFileName) {
    const imgData = await readCharacterData(uploadPath);
    if (imgData === undefined) throw new Error('Failed to read character data');

    let jsonData = JSON.parse(imgData);

    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
    const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);

    if (jsonData.spec !== undefined) {
        console.info(`Found a ${jsonData.spec} character file.`);
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(uploadPath, char, pngName, request);
        fs.unlinkSync(uploadPath);
        return result ? pngName : '';
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
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(uploadPath, charJSON, pngName, request);
        fs.unlinkSync(uploadPath);
        return result ? pngName : '';
    }

    return '';
}

export const router = express.Router();

router.post('/create', getFileNameValidationFunction('file_name'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        request.body.ch_name = sanitize(request.body.ch_name);

        const char = JSON.stringify(charaFormatData(request.body, request.user.directories));
        const internalName = request.body.file_name || getPngName(request.body.ch_name, request.user.directories);
        const avatarName = `${internalName}.png`;
        const chatsPath = path.join(request.user.directories.chats, internalName);

        if (!fs.existsSync(chatsPath)) fs.mkdirSync(chatsPath);

        if (!request.file) {
            await writeCharacterData(DEFAULT_AVATAR_PATH, char, internalName, request);
            return response.send(avatarName);
        } else {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            await writeCharacterData(uploadPath, char, internalName, request, crop);
            fs.unlinkSync(uploadPath);
            return response.send(avatarName);
        }
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const oldAvatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);
    const oldInternalName = path.parse(request.body.avatar_url).name;
    const newInternalName = getPngName(newName, request.user.directories);
    const newAvatarName = `${newInternalName}.png`;

    const oldAvatarPath = path.join(request.user.directories.characters, oldAvatarName);

    const oldChatsPath = path.join(request.user.directories.chats, oldInternalName);
    const newChatsPath = path.join(request.user.directories.chats, newInternalName);

    try {
        // Read old file, replace name int it
        const rawOldData = await readCharacterData(oldAvatarPath);
        if (rawOldData === undefined) throw new Error('Failed to read character file');

        const oldData = getCharaCardV2(JSON.parse(rawOldData), request.user.directories);
        _.set(oldData, 'data.name', newName);
        _.set(oldData, 'name', newName);
        const newData = JSON.stringify(oldData);

        // Write data to new location
        await writeCharacterData(oldAvatarPath, newData, newInternalName, request);

        // Rename chats folder
        if (fs.existsSync(oldChatsPath) && !fs.existsSync(newChatsPath)) {
            fs.cpSync(oldChatsPath, newChatsPath, { recursive: true });
            fs.rmSync(oldChatsPath, { recursive: true, force: true });
        }

        // Remove the old character file
        fs.unlinkSync(oldAvatarPath);

        // writeCharacterData() above already fired the generic metadata-store upsert hook for `newAvatarName`,
        // but that ran *before* the chats folder was moved (so its chat_size/date_last_chat were computed
        // against an empty/nonexistent chats dir) and it necessarily saw a brand-new id with no prior row, so it
        // gave it date_added = now. Re-firing now that the chats folder is in place fixes the chat stats; then
        // renameCharacterRow() fixes date_added (by copying it from the old row) and removes the old row -
        // see both functions' own doc comments. Neither failing should fail the rename response to the client;
        // the character file itself is already safely renamed on disk by this point.
        await fireMetadataUpsertHook(request.user.directories, newAvatarName, newData);
        await renameCharacterRow(request.user.directories, oldAvatarName, newAvatarName).catch(err =>
            console.error('[character-metadata] Failed to finalize metadata store rename (the reconciler will catch it):', err));

        // Return new avatar name to ST
        return response.send({ avatar: newAvatarName });
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

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);

    const validator = new TavernCardValidator(character);
    //Accept either V1 or V2.
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const targetImg = avatar.replace('.png', '');
    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request);
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

router.post('/all', async function (request, response) {
    try {
        const { sortField, sortOrder, offset, limit, search, includeGroups, fav } = request.body ?? {};
        const favOnly = fav === true;

        if (sortField === undefined && offset === undefined && limit === undefined && !search && !includeGroups) {
            const files = fs.readdirSync(request.user.directories.characters);
            const pngFiles = files.filter(file => file.endsWith('.png'));
            const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters }));
            const data = (await Promise.all(processingPromises)).filter(c => c.name);
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

// Phase 2's sortable fields (design doc §5's `sort.field` union, minus 'random' and 'search' - see
// character-metadata-db.js's QUERYABLE_SORT_COLUMNS for why those two are deliberately not handled by this
// endpoint yet). Kept here (not imported from character-metadata-db.js) because this is specifically the set of
// values this HTTP layer accepts as *valid input* before ever calling into the metadata module - a distinct
// concern from that module's own "which SQL column does this map to".
const QUERY_SORT_FIELDS = new Set(['name', 'date_added', 'date_last_chat', 'chat_size', 'fav']);

// page/pageSize bounds for "/query" - page/pageSize is the doc's §5 contract shape (not offset/limit, which is
// queryCharacters()'s own internal shape - this route is where the translation happens). The upper bound on
// pageSize is a defensive cap, not something the doc mandates: an unbounded client-supplied page size would let
// a single request force an unbounded LIMIT, defeating the entire point of paginating in the first place.
const DEFAULT_QUERY_PAGE_SIZE = 500;
const MAX_QUERY_PAGE_SIZE = 2000;

/**
 * HTTP POST endpoint for the "/api/characters/query" route (design doc §5): the phase-2 replacement for the
 * fs.readdirSync()+PNG-parse-everything+slice-in-JS shape of a plain (no search term) `/all` browse request -
 * this endpoint never touches the filesystem or parses a PNG; every field it can return already lives in the
 * phase-1 SQLite metadata table (character-metadata-db.js), kept fresh by that module's write hooks/watcher/
 * reconciler independent of this request.
 *
 * NOT YET WIRED TO ANY CLIENT CODE. Per the design doc's own phase table, inverting `getEntitiesList()`/
 * `printCharacters()` (public/script.js) to actually call this instead of the old fully-resident-array path is
 * phase 5's job, not phase 2's - this endpoint exists and is correct, but the browse UI still goes through the
 * pre-existing `/all` handler above until that phase lands. This mirrors how `/metadata/rescan` and the
 * batch-import endpoints above landed in phase 1 unwired, for the same reason.
 *
 * Two things the doc's full `sort`/`filter` union allows that this endpoint deliberately rejects (400, not a
 * silent fallback) rather than half-implementing:
 *   - `sort.field: 'random'` - the seeded-hash comparator and its client-owned-seed wire shape belong to phase
 *     5b (design doc §5.3), which hasn't landed. Falling back to name order the way the pre-phase-2 `/all`
 *     handler's `sortOrder=random` bug silently did is exactly the "silent wrong result" failure the doc calls
 *     out by name - this 400s instead.
 *   - `sort.field: 'search'` / `filter.search` - full-text search stays on the existing tantivy/FTS5 path
 *     (characters-search-index.js) for this dispatch; wiring the two together (doc §5's "push the FTS hit-id set
 *     into SQLite as a temporary table" plan) is real, separate work this pass does not attempt.
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

        if (filter.search) {
            return response.status(400).send({ error: true, reason: 'search-not-supported', message: 'filter.search is not handled by /query yet - use the existing /all endpoint\'s search param.' });
        }
        if (sort.field === 'random') {
            return response.status(400).send({ error: true, reason: 'random-sort-not-supported', message: 'sort.field "random" is phase 5b work (seeded-hash comparator) and is not implemented yet.' });
        }
        if (sort.field === 'search') {
            return response.status(400).send({ error: true, reason: 'search-sort-not-supported', message: 'sort.field "search" requires filter.search, which /query does not handle yet.' });
        }
        if (sort.field !== undefined && !QUERY_SORT_FIELDS.has(sort.field)) {
            return response.status(400).send({ error: true, reason: 'invalid-sort-field' });
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

        const result = await queryCharacters(request.user.directories, {
            tags: filter.tags,
            fav: filter.fav,
            world: filter.world,
            excludeIds: filter.excludeIds,
            ids: filter.ids,
            sortField: sort.field,
            sortOrder: sort.order,
            offset: (page - 1) * pageSize,
            limit: pageSize,
            wantRows: want.includes('rows'),
            wantTotal: want.includes('total'),
        });

        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }

        const payload = { rev: result.rev };
        if (want.includes('rows')) payload.rows = result.rows;
        if (want.includes('total')) payload.total = result.total;
        return response.send(payload);
    } catch (err) {
        console.error('[characters/query] Query failed:', err);
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
 * Lightweight companion to `/all`: returns just `[{ avatar, mtime }, ...]` for every character PNG in the
 * user's library, one entry per file, with no PNG tEXt-chunk read, no JSON parse, and no chat-size calculation
 * (the expensive parts of processCharacter()). This is meant to be fetched on every boot so the client can diff
 * it against what it already has cached (see character-cache.js) and only request full data for characters
 * that are new or whose mtime changed, instead of always re-fetching the entire library via `/all`.
 *
 * mtimeMs (last content modification), not ctimeMs (metadata/inode change time, which is what processCharacter()
 * uses for date_added) - a real edit to the character's data is what should invalidate a client's cached copy.
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
            return { avatar: file, mtime: stat.mtimeMs };
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
 * Gets the name for the uploaded PNG file.
 * @param {string} file File name
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} - The name for the uploaded PNG file
 */
function getPngName(file, directories) {
    file = sanitize(file);
    return getUniqueName(file, (name) => fs.existsSync(path.join(directories.characters, `${name}.png`)),
        { nameBuilder: (base, i) => i === 0 ? base : `${base}${i}`, startIndex: 0, maxTries: 10000 }) ?? file;
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

router.post('/import', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = request.body.file_type;
    const preservedFileName = getPreservedName(request);

    const formatImportFunctions = {
        'yaml': importFromYaml,
        'yml': importFromYaml,
        'json': importFromJson,
        'png': importFromPng,
        'charx': importFromCharX,
        'byaf': importFromByaf,
    };

    try {
        const importFunction = formatImportFunctions[format];

        if (!importFunction) {
            throw new Error(`Unsupported format: ${format}`);
        }

        const fileName = await importFunction(uploadPath, { request, response }, preservedFileName);

        if (!fileName) {
            console.warn('Failed to import character');
            return response.sendStatus(400);
        }

        if (preservedFileName) {
            invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);
        }

        response.send({ file_name: fileName });
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
        const nameParts = path.basename(filename, path.extname(filename)).split('_');
        const lastPart = nameParts[nameParts.length - 1];
        const isStrictInteger = /^\d+$/.test(lastPart);

        let suffix = 1;
        let baseName;

        if (isStrictInteger && nameParts.length > 1) {
            suffix = parseInt(lastPart, 10) + 1;
            baseName = nameParts.slice(0, -1).join('_'); // construct baseName without suffix
        } else {
            baseName = nameParts.join('_'); // original filename is completely the baseName
        }

        let newFilename = path.join(request.user.directories.characters, `${baseName}_${suffix}${path.extname(filename)}`);

        // suffix is always a real, strictly increasing integer here, so this loop is guaranteed to terminate:
        // there are only finitely many existing files it could collide with before it finds a free name.
        while (fs.existsSync(newFilename)) {
            suffix++;
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
