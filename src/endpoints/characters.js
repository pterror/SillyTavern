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
import { readWorldInfoFile } from './worldinfo.js';
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
 * @param {string} inputFile - Path to the image file
 * @returns {string} - Cache key
 */
function getCacheKey(inputFile) {
    if (fs.existsSync(inputFile)) {
        const stat = fs.statSync(inputFile);
        return `${inputFile}-${stat.mtimeMs}`;
    }

    return inputFile;
}

/**
 * Reads the character card from the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {string} inputFormat - 'png'
 * @returns {Promise<string | undefined>} - Character card data
 */
async function readCharacterData(inputFile, inputFormat = 'png') {
    const cacheKey = getCacheKey(inputFile);
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
 * calculateChatSize - Calculates the total chat size for a given character.
 *
 * @param  {string} charDir The directory where the chats are stored.
 * @return { {chatSize: number, dateLastChat: number} }         The total chat size.
 */
const calculateChatSize = (charDir) => {
    let chatSize = 0;
    let dateLastChat = 0;

    if (fs.existsSync(charDir)) {
        const chats = fs.readdirSync(charDir);
        if (Array.isArray(chats) && chats.length) {
            for (const chat of chats) {
                const chatStat = fs.statSync(path.join(charDir, chat));
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            }
        }
    }

    return { chatSize, dateLastChat };
};

// Calculate the total string length of the data object
const calculateDataSize = (data) => {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
};

/**
 * Only get fields that are used to display the character list.
 * @param {object} character Character object
 * @returns {{shallow: true, [key: string]: any}} Shallow character
 */
const toShallow = (character) => {
    return {
        shallow: true,
        name: character.name,
        avatar: character.avatar,
        chat: character.chat,
        fav: character.fav,
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: character.tags,
        data: {
            name: _.get(character, 'data.name', ''),
            character_version: _.get(character, 'data.character_version', ''),
            creator: _.get(character, 'data.creator', ''),
            tags: _.get(character, 'data.tags', []),
            extensions: {
                fav: _.get(character, 'data.extensions.fav', false),
                world: _.get(character, 'data.extensions.world', ''),
            },
        },
    };
};

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
        const imgData = await readCharacterData(imgFile);
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character.json_data = imgData;
        const charStat = fs.statSync(path.join(directories.characters, item));
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
 * Convert a character object to Spec V2 format.
 * @param {object} jsonObject Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {boolean} hoistDate Will set the chat and create_date fields to the current date if they are missing
 * @returns {object} Character object in Spec V2 format
 */
function getCharaCardV2(jsonObject, directories, hoistDate = true) {
    if (jsonObject.spec === undefined) {
        jsonObject = convertToV2(jsonObject, directories);

        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = new Date().toISOString();
        }
    } else {
        jsonObject = readFromV2(jsonObject);
    }
    return jsonObject;
}

/**
 * Convert a character object to Spec V2 format.
 * @param {object} char Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object} Character object in Spec V2 format
 */
function convertToV2(char, directories) {
    // Simulate incoming data from frontend form
    const result = charaFormatData({
        json_data: JSON.stringify(char),
        ch_name: char.name,
        description: char.description,
        personality: char.personality,
        scenario: char.scenario,
        first_mes: char.first_mes,
        mes_example: char.mes_example,
        creator_notes: char.creatorcomment,
        talkativeness: char.talkativeness,
        fav: char.fav,
        creator: char.creator,
        tags: char.tags,
        depth_prompt_prompt: char.depth_prompt_prompt,
        depth_prompt_depth: char.depth_prompt_depth,
        depth_prompt_role: char.depth_prompt_role,
    }, directories);

    result.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`;
    result.create_date = char.create_date;

    return result;
}

/**
 * Removes fields that are not meant to be shared.
 */
function unsetPrivateFields(char) {
    _.set(char, 'fav', false);
    _.set(char, 'data.extensions.fav', false);
    _.unset(char, 'chat');
}

function readFromV2(char) {
    if (_.isUndefined(char.data)) {
        console.warn(`Char ${char.name} has Spec v2 data missing`);
        return char;
    }

    // If 'json_data' was already saved, don't let it propagate
    _.unset(char, 'json_data');

    const fieldMappings = {
        name: 'name',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        first_mes: 'first_mes',
        mes_example: 'mes_example',
        talkativeness: 'extensions.talkativeness',
        fav: 'extensions.fav',
        tags: 'tags',
    };

    _.forEach(fieldMappings, (v2Path, charField) => {
        //console.info(`Migrating field: ${charField} from ${v2Path}`);
        const v2Value = _.get(char.data, v2Path);
        if (_.isUndefined(v2Value)) {
            let defaultValue = undefined;

            // Backfill default values for missing ST extension fields
            if (v2Path === 'extensions.talkativeness') {
                defaultValue = 0.5;
            }

            if (v2Path === 'extensions.fav') {
                defaultValue = false;
            }

            if (!_.isUndefined(defaultValue)) {
                //console.warn(`Spec v2 extension data missing for field: ${charField}, using default value: ${defaultValue}`);
                char[charField] = defaultValue;
            } else {
                console.warn(`Char ${char.name} has Spec v2 data missing for unknown field: ${charField}`);
                return;
            }
        }
        if (!_.isUndefined(char[charField]) && !_.isUndefined(v2Value) && String(char[charField]) !== String(v2Value)) {
            console.warn(`Char ${char.name} has Spec v2 data mismatch with Spec v1 for field: ${charField}`, char[charField], v2Value);
        }
        char[charField] = v2Value;
    });

    char.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`;

    return char;
}

/**
 * Format character data to Spec V2 format.
 * @param {object} data Character data
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns
 */
function charaFormatData(data, directories) {
    // This is supposed to save all the foreign keys that ST doesn't care about
    const char = tryParse(data.json_data) || {};

    // Prevent erroneous 'json_data' recursive saving
    _.unset(char, 'json_data');

    // Checks if data.alternate_greetings is an array, a string, or neither, and acts accordingly. (expected to be an array of strings)
    const getAlternateGreetings = data => {
        if (Array.isArray(data.alternate_greetings)) return data.alternate_greetings;
        if (typeof data.alternate_greetings === 'string') return [data.alternate_greetings];
        return [];
    };

    // Spec V1 fields
    _.set(char, 'name', data.ch_name);
    _.set(char, 'description', data.description || '');
    _.set(char, 'personality', data.personality || '');
    _.set(char, 'scenario', data.scenario || '');
    _.set(char, 'first_mes', data.first_mes || '');
    _.set(char, 'mes_example', data.mes_example || '');

    // Old ST extension fields (for backward compatibility, will be deprecated)
    _.set(char, 'creatorcomment', data.creator_notes || '');
    _.set(char, 'avatar', 'none');
    _.set(char, 'chat', data.ch_name + ' - ' + humanizedDateTime());
    _.set(char, 'talkativeness', data.talkativeness || 0.5);
    _.set(char, 'fav', data.fav == 'true');
    _.set(char, 'tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);

    // Spec V2 fields
    _.set(char, 'spec', 'chara_card_v2');
    _.set(char, 'spec_version', '2.0');
    _.set(char, 'data.name', data.ch_name);
    _.set(char, 'data.description', data.description || '');
    _.set(char, 'data.personality', data.personality || '');
    _.set(char, 'data.scenario', data.scenario || '');
    _.set(char, 'data.first_mes', data.first_mes || '');
    _.set(char, 'data.mes_example', data.mes_example || '');

    // New V2 fields
    _.set(char, 'data.creator_notes', data.creator_notes || '');
    _.set(char, 'data.system_prompt', data.system_prompt || '');
    _.set(char, 'data.post_history_instructions', data.post_history_instructions || '');
    _.set(char, 'data.tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);
    _.set(char, 'data.creator', data.creator || '');
    _.set(char, 'data.character_version', data.character_version || '');
    _.set(char, 'data.alternate_greetings', getAlternateGreetings(data));

    // ST extension fields to V2 object
    _.set(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
    _.set(char, 'data.extensions.fav', data.fav == 'true');
    _.set(char, 'data.extensions.world', data.world || '');

    // Spec extension: depth prompt
    const depth_default = 4;
    const role_default = 'system';
    const depth_value = !isNaN(Number(data.depth_prompt_depth)) ? Number(data.depth_prompt_depth) : depth_default;
    const role_value = data.depth_prompt_role ?? role_default;
    _.set(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
    _.set(char, 'data.extensions.depth_prompt.depth', depth_value);
    _.set(char, 'data.extensions.depth_prompt.role', role_value);

    if (data.world) {
        try {
            const file = readWorldInfoFile(directories, data.world, false);

            // File was imported - save it to the character book
            if (file && file.originalData) {
                _.set(char, 'data.character_book', file.originalData);
            }

            // File was not imported - convert the world info to the character book
            if (file && file.entries) {
                _.set(char, 'data.character_book', convertWorldInfoToCharacterBook(data.world, file.entries));
            }
        } catch {
            console.warn(`Failed to read world info file: ${data.world}. Character book will not be available.`);
        }
    }

    if (data.extensions) {
        try {
            const extensions = JSON.parse(data.extensions);
            // Deep merge the extensions object
            _.set(char, 'data.extensions', deepMerge(char.data.extensions, extensions));
        } catch {
            console.warn(`Failed to parse extensions JSON: ${data.extensions}`);
        }
    }

    return char;
}

/**
 * @param {string} name Name of World Info file
 * @param {object} entries Entries object
 */
function convertWorldInfoToCharacterBook(name, entries) {
    /** @type {{ entries: object[]; name: string }} */
    const result = { entries: [], name };

    for (const index in entries) {
        const entry = entries[index];

        const originalEntry = {
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        };

        result.entries.push(originalEntry);
    }

    return result;
}

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
 * Accepts optional `sortField`/`sortOrder`/`offset`/`limit`/`search`/`includeGroups` in the request body to get
 * a sorted (or fuzzy-searched) page back instead of the full array - see paginateCharacters()/paginateEntities()/
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
        const { sortField, sortOrder, offset, limit, search, includeGroups } = request.body ?? {};

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
            const emptySearch = { results: [], total: 0, backend: 'native' };
            // Each source only needs to fetch its own top (offset + limit) rows to guarantee a correct merged
            // page - paginateSearchResults() below still does the real character/group interleave-by-score and
            // final slice, this just stops each individual FTS5 query (and the JSON.parse() of every one of its
            // rows - see querySqliteIndex()) from doing that work across the *entire* matching set first.
            const searchFetchLimit = numericOffset + numericLimit;
            const [characterSearch, groupSearch] = await Promise.all([
                searchCharacters(handle, request.user.directories, search, searchFetchLimit),
                includeGroups ? searchGroups(handle, request.user.directories, search, searchFetchLimit) : emptySearch,
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
            // indicator when search is running on anything other than the fast native engine (see
            // sqlite-engine.js) instead of that only ever showing up as a server console warning. Character and
            // group search resolve the engine independently but always agree in practice (both go through the
            // same process-wide getSqliteEngine() cache) - this just reports whichever is worse, in case they
            // ever don't.
            const BACKEND_SEVERITY = { native: 0, wasm: 1, unavailable: 2 };
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
        let suffix = 1;
        let newFilename = filename;

        // If filename ends with a _number, increment the number
        const nameParts = path.basename(filename, path.extname(filename)).split('_');
        const lastPart = nameParts[nameParts.length - 1];

        let baseName;

        if (!isNaN(Number(lastPart)) && nameParts.length > 1) {
            suffix = parseInt(lastPart) + 1;
            baseName = nameParts.slice(0, -1).join('_'); // construct baseName without suffix
        } else {
            baseName = nameParts.join('_'); // original filename is completely the baseName
        }

        newFilename = path.join(request.user.directories.characters, `${baseName}_${suffix}${path.extname(filename)}`);

        while (fs.existsSync(newFilename)) {
            let suffixStr = '_' + suffix;
            newFilename = path.join(request.user.directories.characters, `${baseName}${suffixStr}${path.extname(filename)}`);
            suffix++;
        }

        fs.copyFileSync(filename, newFilename);
        console.info(`${filename} was copied to ${newFilename}`);
        response.send({ path: path.parse(newFilename).base });
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
