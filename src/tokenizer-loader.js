import fs from 'node:fs';
import path from 'node:path';

import bytes from 'bytes';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';
import tiktoken from 'tiktoken';

import { findTokenizerSource, getPinnedTokenizerFile } from './tokenizer-sources.js';
import { getConfigValue } from './util.js';

/** @typedef {import('./tokenizer-sources.js').TokenizerFileFormat} TokenizerFileFormat */

/**
 * @typedef {object} TiktokenConfig
 * @property {string} patStr
 * @property {Record<string, number>} specialTokens
 * @property {{ start: number, count: number, name?: string }} reservedSpecialTokens
 * @property {'all' | 'none'} allowedSpecial
 * @property {{ maxChars: number, maxRun: number } | null} split
 */

/**
 * @typedef {object} TokenizerFileOptions
 * @property {TiktokenConfig} [tiktoken]
 * @property {string} [entryId]
 */

/**
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

/** @type {Map<string, { reader: any, bytes: number }>} */
const loaded = new Map();
let loadedBytes = 0;

/** @type {Map<string, Promise<any>>} */
const loading = new Map();

const PYTHON_WHITESPACE = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/**
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
    if (instance.encodeIds('a').length === 0) {
        throw new Error('The model encodes non-empty text to no tokens');
    }
    return instance;
}

/**
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
    const encoding = new tiktoken.Tiktoken(ranks, {}, data.config.pattern);

    return {
        encode(text) {
            return Array.from(encoding.encode(text), id => id + numSpecialTokens);
        },
        decode(ids) {
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
        const tokenName = namedById.get(id) ?? name?.replace('{id}', String(id));
        if (tokenName === undefined) {
            throw new Error(`Special id ${id} has no name`);
        }
        specialTokens[tokenName] = id;
    }
    const encoding = new tiktoken.Tiktoken(lines.join('\n'), specialTokens, config.patStr);
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
            if (config.split === null) {
                return Array.from(encodePiece(text));
            }
            const { maxChars, maxRun } = config.split;
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
 * @param {import('./tokenizer-sources.js').TokenizerSourceEntry} entry
 * @param {import('./users.js').UserDirectoryList} [directories]
 * @returns {Promise<TokenizerFunctions & { downloaded: boolean, license: string }>}
 */
export async function loadPinnedTokenizer(entry, directories) {
    const file = await getPinnedTokenizerFile(entry, directories);
    const functions = await loadTokenizerFunctions(file.path, entry.format, { tiktoken: entry.tiktoken, entryId: entry.id });
    return { ...functions, downloaded: file.downloaded, license: file.license };
}

/**
 * @typedef {object} RegistryTokenizerOptions
 * @property {import('./users.js').UserDirectoryList} [directories]
 * @property {{ downloads?: Array<{ family: string, license: string }> }} [outcome]
 * @property {readonly import('./tokenizer-sources.js').TokenizerSourceEntry[]} [registry]
 * @property {typeof loadPinnedTokenizer} [loadPinned]
 */

/**
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
