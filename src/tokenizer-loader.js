import fs from 'node:fs';
import path from 'node:path';

import bytes from 'bytes';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';
import tiktoken from 'tiktoken';

import { findTokenizerSource, getPinnedTokenizerFile } from './tokenizer-sources.js';
import { getConfigValue } from './util.js';

/**
 * Loads tokenizer files with a reader that reads each format exactly, and keeps the loaded ones in
 * an in-memory LRU with a byte budget. A tokenizer's bytes are its file's size on disk. Eviction only
 * drops the LRU's reference; the readers here are reclaimed by the garbage collector once nothing
 * else holds them.
 *
 * The bundled web tokenizers (@agnai/web-tokenizers, src/endpoints/tokenizers.js) are not loaded
 * here: they stay loaded and don't count toward the budget.
 */

/**
 * @typedef {import('./tokenizer-sources.js').TokenizerFileFormat} TokenizerFileFormat
 */

/**
 * The `tiktoken` field of a `tiktoken`-format registry entry: how the repo's own code builds its
 * tiktoken encoding.
 * @typedef {object} TiktokenConfig
 * @property {string} patStr The repo's `pat_str`
 * @property {Record<string, number>} specialTokens Named special tokens, name -> id
 * @property {{ start: number, count: number, name: string }} reservedSpecialTokens The special id
 * range; an id not named in `specialTokens` is named by `name` with `{id}` replaced by the id
 * @property {'all' | 'none'} allowedSpecial `all`: text spelling a special token encodes to its id
 * (tiktoken's `allowed_special="all"`); `none`: it encodes as ordinary text (`disallowed_special=()`)
 * @property {{ maxChars: number, maxRun: number }} split Encode splits the text into chunks of at
 * most `maxChars` characters, and those into pieces with at most `maxRun` consecutive whitespace or
 * non-whitespace characters
 */

/**
 * @typedef {object} TokenizerFileOptions
 * @property {TiktokenConfig} [tiktoken] Required for the `tiktoken` format
 * @property {string} [entryId] The registry entry the file is read for. Its reader is kept under the
 * entry's id: two entries can share one file and read it differently (a tiktoken file's specials).
 * Without it, the reader is kept under the file's format and path.
 */

/**
 * A reader for `tekken` and `tiktoken` files.
 * @typedef {object} TiktokenReader
 * @property {(text: string) => number[]} encode
 * @property {(ids: number[]) => string} decode
 */

/**
 * @typedef {object} TokenizerFunctions
 * @property {(text: string) => Promise<number[]>} encode
 * @property {(ids: number[]) => Promise<string>} decode
 */

const MEMORY_BUDGET = bytes.parse(getConfigValue('tokenizerMemoryCacheCapacity', '256mb'));

/**
 * Loaded readers, least recently used first.
 * @type {Map<string, { reader: any, bytes: number }>}
 */
const loaded = new Map();
let loadedBytes = 0;

/**
 * Loads in flight, by LRU key, so parallel calls for one file share one load.
 * @type {Map<string, Promise<any>>}
 */
const loading = new Map();

/**
 * Python's `str.isspace()` code points.
 */
const PYTHON_WHITESPACE = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/**
 * Decodes UTF-8 like Python's `bytes.decode('utf-8', errors='replace')`, which keeps a leading BOM.
 * @param {Uint8Array} data
 * @returns {string}
 */
function decodeUtf8(data) {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
}

/**
 * @param {string} filePath
 * @returns {Promise<import('tokenizers').Tokenizer>}
 */
async function readHfJson(filePath) {
    const { Tokenizer } = await import('tokenizers');
    return Tokenizer.fromFile(filePath);
}

/**
 * @param {string} filePath
 * @returns {Promise<SentencePieceProcessor>}
 */
async function readSentencepiece(filePath) {
    const instance = new SentencePieceProcessor();
    await instance.load(filePath);
    // load() ignores the load status, and a processor whose model failed to load encodes everything to [].
    if (instance.encodeIds('a').length === 0) {
        throw new Error('The model encodes non-empty text to no tokens');
    }
    return instance;
}

/**
 * Replicates mistral-common 1.12.0's Tekkenizer `encode(s, bos=False, eos=False)` and `decode(ids)`
 * (special token policy IGNORE).
 * @param {string} filePath
 * @returns {Promise<TiktokenReader>}
 */
async function readTekken(filePath) {
    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    const vocabSize = data.config.default_vocab_size;
    const numSpecialTokens = data.config.default_num_special_tokens;
    const innerVocabSize = vocabSize - numSpecialTokens;
    if (!Array.isArray(data.vocab) || data.vocab.length < innerVocabSize) {
        throw new Error(`The vocab has fewer than ${innerVocabSize} tokens`);
    }
    const ranks = data.vocab.slice(0, innerVocabSize).map((token, i) => {
        if (token.rank !== i) {
            throw new Error(`Vocab token ${i} has rank ${token.rank}`);
        }
        return `${token.token_bytes} ${token.rank}`;
    }).join('\n');
    // Special tokens are handled by hand, as Tekkenizer does.
    const encoding = new tiktoken.Tiktoken(ranks, {}, data.config.pattern);

    return {
        encode(text) {
            return Array.from(encoding.encode(text), id => id + numSpecialTokens);
        },
        decode(ids) {
            // Tekkenizer._decode_all: runs of special ids are skipped, and each run of other ids is decoded on its own.
            const parts = [];
            let run = [];
            const flush = () => {
                if (run.length > 0) {
                    parts.push(decodeUtf8(encoding.decode(new Uint32Array(run))));
                    run = [];
                }
            };
            for (const id of ids) {
                if (id < numSpecialTokens) {
                    flush();
                    continue;
                }
                const rank = id - numSpecialTokens;
                if (!Number.isInteger(rank) || rank >= innerVocabSize) {
                    throw new Error(`Unknown token id: ${id}`);
                }
                run.push(rank);
            }
            flush();
            return parts.join('');
        },
    };
}

/**
 * Splits `text` into pieces with at most `maxRun` consecutive whitespace or non-whitespace code
 * points, as tokenization_kimi.py's `_split_whitespaces_or_nonwhitespaces` does.
 * @param {string} text
 * @param {number} maxRun
 * @returns {string[]}
 */
function splitWhitespaceRuns(text, maxRun) {
    const pieces = [];
    let runLength = 0;
    let first = true;
    let runIsSpace = false;
    let start = 0;
    let offset = 0;
    for (const char of text) {
        const isSpace = PYTHON_WHITESPACE.has(/** @type {number} */ (char.codePointAt(0)));
        if (first) {
            runIsSpace = isSpace;
            first = false;
        }
        if (runIsSpace !== isSpace) {
            runLength = 1;
            runIsSpace = isSpace;
        } else {
            runLength += 1;
            if (runLength > maxRun) {
                pieces.push(text.slice(start, offset));
                start = offset;
                runLength = 1;
            }
        }
        offset += char.length;
    }
    pieces.push(text.slice(start));
    return pieces;
}

/**
 * Splits `text` into chunks of at most `maxChars` code points.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitCodePointChunks(text, maxChars) {
    const chunks = [];
    let count = 0;
    let start = 0;
    let offset = 0;
    for (const char of text) {
        if (count === maxChars) {
            chunks.push(text.slice(start, offset));
            start = offset;
            count = 0;
        }
        count += 1;
        offset += char.length;
    }
    if (count > 0) {
        chunks.push(text.slice(start));
    }
    return chunks;
}

/**
 * Replicates the Kimi repo's `TikTokenTokenizer` (tokenization_kimi.py): its `encode(text)` and its
 * `decode(ids)`.
 * @param {string} filePath
 * @param {TiktokenConfig} config
 * @returns {Promise<TiktokenReader>}
 */
async function readTiktoken(filePath, config) {
    if (!config) {
        throw new Error('A tiktoken file needs its entry\'s tiktoken config');
    }
    const contents = await fs.promises.readFile(filePath, 'utf8');
    const lines = contents.split(/\r\n|\n|\r/).filter(line => line.length > 0);
    const numBaseTokens = lines.length;
    const { start, count, name } = config.reservedSpecialTokens;
    if (start !== numBaseTokens) {
        throw new Error(`The file has ${numBaseTokens} tokens, the special ids start at ${start}`);
    }
    /** @type {Map<number, string>} */
    const namedById = new Map(Object.entries(config.specialTokens).map(([token, id]) => [id, token]));
    /** @type {Record<string, number>} */
    const specialTokens = {};
    for (let id = start; id < start + count; id++) {
        specialTokens[namedById.get(id) ?? name.replace('{id}', String(id))] = id;
    }
    const encoding = new tiktoken.Tiktoken(lines.join('\n'), specialTokens, config.patStr);
    const { maxChars, maxRun } = config.split;
    /** @type {(piece: string) => Uint32Array} */
    let encodePiece;
    if (config.allowedSpecial === 'all') {
        encodePiece = piece => encoding.encode(piece, 'all');
    } else if (config.allowedSpecial === 'none') {
        encodePiece = piece => encoding.encode_ordinary(piece);
    } else {
        throw new Error(`Unknown allowedSpecial: ${config.allowedSpecial}`);
    }

    return {
        encode(text) {
            const ids = [];
            for (const chunk of splitCodePointChunks(text, maxChars)) {
                for (const piece of splitWhitespaceRuns(chunk, maxRun)) {
                    for (const id of encodePiece(piece)) {
                        ids.push(id);
                    }
                }
            }
            return ids;
        },
        decode(ids) {
            for (const id of ids) {
                if (!Number.isInteger(id) || id < 0 || id >= start + count) {
                    throw new Error(`Unknown token id: ${id}`);
                }
            }
            return decodeUtf8(encoding.decode(new Uint32Array(ids)));
        },
    };
}

/**
 * @param {string} filePath
 * @param {TokenizerFileFormat} format
 * @param {TokenizerFileOptions} options
 * @returns {Promise<any>}
 */
function readTokenizerFile(filePath, format, options) {
    switch (format) {
        case 'hf-json':
            return readHfJson(filePath);
        case 'sentencepiece':
            return readSentencepiece(filePath);
        case 'tekken':
            return readTekken(filePath);
        case 'tiktoken':
            return readTiktoken(filePath, /** @type {TiktokenConfig} */ (options.tiktoken));
        default:
            return Promise.reject(new Error(`Unknown tokenizer file format: ${format}`));
    }
}

/**
 * Adds a loaded reader, then unloads the least recently used others until the total fits the
 * budget. A reader bigger than the whole budget stays, alone.
 * @param {string} key
 * @param {any} reader
 * @param {number} size
 */
function remember(key, reader, size) {
    loaded.set(key, { reader, bytes: size });
    loadedBytes += size;
    for (const [oldKey, entry] of loaded) {
        if (loadedBytes <= MEMORY_BUDGET || oldKey === key) {
            break;
        }
        loaded.delete(oldKey);
        loadedBytes -= entry.bytes;
        console.info('Unloaded the tokenizer', oldKey);
    }
}

/**
 * The loaded reader for a tokenizer file, from memory or loaded now:
 * - `hf-json`: an npm `tokenizers` Tokenizer
 * - `sentencepiece`: an `@agnai/sentencepiece-js` SentencePieceProcessor
 * - `tekken`, `tiktoken`: `{ encode(text) → ids, decode(ids) → text }`
 *
 * Throws when the file can't be loaded.
 * @param {string} filePath
 * @param {TokenizerFileFormat} format
 * @param {TokenizerFileOptions} [options]
 * @returns {Promise<any>}
 */
export async function loadTokenizerFile(filePath, format, options = {}) {
    const key = options.entryId !== undefined ? `entry:${options.entryId}` : `${format}:${path.resolve(filePath)}`;
    const cached = loaded.get(key);
    if (cached) {
        loaded.delete(key);
        loaded.set(key, cached);
        return cached.reader;
    }

    const pending = loading.get(key);
    if (pending) {
        return pending;
    }

    const load = (async () => {
        const { size } = await fs.promises.stat(filePath);
        const reader = await readTokenizerFile(filePath, format, options);
        remember(key, reader, size);
        console.info('Instantiated the tokenizer for', path.parse(filePath).name);
        return reader;
    })();
    loading.set(key, load);
    try {
        return await load;
    } finally {
        loading.delete(key);
    }
}

/**
 * Async encode and decode for a tokenizer file. Encoding adds no special tokens; decoding keeps them.
 * @param {string} filePath
 * @param {TokenizerFileFormat} format
 * @param {TokenizerFileOptions} [options]
 * @returns {Promise<TokenizerFunctions>}
 */
export async function loadTokenizerFunctions(filePath, format, options = {}) {
    const reader = await loadTokenizerFile(filePath, format, options);
    switch (format) {
        case 'hf-json':
            return {
                encode: async text => (await reader.encode(text, null, { addSpecialTokens: false })).getIds(),
                decode: async ids => reader.decode(Array.from(ids), false),
            };
        case 'sentencepiece':
            return {
                encode: async text => reader.encodeIds(text),
                decode: async ids => reader.decodeIds(Array.from(ids)),
            };
        default:
            return {
                encode: async text => reader.encode(text),
                decode: async ids => reader.decode(Array.from(ids)),
            };
    }
}

/**
 * Loads a registry entry's tokenizer, downloading its file first when it isn't cached.
 * @param {import('./tokenizer-sources.js').TokenizerSourceEntry} entry
 * @param {import('./users.js').UserDirectoryList} [directories] The requesting user's directories, for their saved Hugging Face token
 * @returns {Promise<TokenizerFunctions & { downloaded: boolean, license: string }>} `downloaded` is true only for
 * the call that fetched the file, and `license` is then that of the source it came from
 */
export async function loadPinnedTokenizer(entry, directories) {
    const file = await getPinnedTokenizerFile(entry, directories);
    const functions = await loadTokenizerFunctions(file.path, entry.format, { tiktoken: entry.tiktoken, entryId: entry.id });
    return { ...functions, downloaded: file.downloaded, license: file.license };
}

/**
 * @typedef {object} RegistryTokenizerOptions
 * @property {import('./users.js').UserDirectoryList} [directories] For the user's saved Hugging Face token
 * @property {{ downloads?: Array<{ family: string, license: string }> }} [outcome] The request's
 * outcome (src/tokenizer-resolve.js), whose `downloads` gets the entry when this call downloaded its file
 * @property {readonly import('./tokenizer-sources.js').TokenizerSourceEntry[]} [registry] Replaces TOKENIZER_SOURCES, for tests
 * @property {typeof loadPinnedTokenizer} [loadPinned] Replaces loadPinnedTokenizer, for tests
 */

/**
 * Loads the tokenizer of the registry entry with this id. Throws when there is no such entry or it
 * can't be had.
 * @param {string} id
 * @param {RegistryTokenizerOptions} [options]
 * @returns {Promise<TokenizerFunctions>}
 */
export async function loadRegistryTokenizer(id, { directories, outcome, registry, loadPinned = loadPinnedTokenizer } = {}) {
    const entry = findTokenizerSource(id, registry);
    if (!entry) {
        throw new Error(`No tokenizer registry entry ${id}`);
    }
    const { encode, decode, downloaded, license } = await loadPinned(entry, directories);
    if (downloaded && outcome) {
        (outcome.downloads ??= []).push({ family: entry.family, license });
    }
    return { encode, decode };
}
