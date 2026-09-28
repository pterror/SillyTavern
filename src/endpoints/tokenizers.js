import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { Tokenizer } from '@agnai/web-tokenizers';
import tiktoken from 'tiktoken';

import { TEXTGEN_TYPES } from '../constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from '../tokenizer-ids.js';
import { resolveChatCompletionTokenizer, describeMapEntry, localResolution } from '../tokenizer-map-resolution.js';
import { readConnectionStateHeader } from '../connection-state-header.js';
import { setAdditionalHeaders } from '../additional-headers.js';
import { DOWNLOAD_RETRY_MS, isDownloadBackedOff, recordDownloadFailure, clearDownloadFailure } from '../tokenizer-sources.js';
import { loadRegistryTokenizer, loadTokenizerFile, loadTokenizerFunctions } from '../tokenizer-loader.js';
import { getConfigValue, isValidUrl, trimV1 } from '../util.js';

/**
 * @typedef { (req: import('express').Request, res: import('express').Response) => Promise<any> } TokenizationHandler
 */

/**
 * @type {{[key: string]: import('tiktoken').Tiktoken}} Tokenizers cache
 */
const tokenizersCache = {};

/**
 * @type {string[]}
 */
export const TEXT_COMPLETION_MODELS = [
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-instruct-0914',
    'text-davinci-003',
    'text-davinci-002',
    'text-davinci-001',
    'text-curie-001',
    'text-babbage-001',
    'text-ada-001',
    'code-davinci-002',
    'code-davinci-001',
    'code-cushman-002',
    'code-cushman-001',
    'text-davinci-edit-001',
    'code-davinci-edit-001',
    'text-embedding-ada-002',
    'text-similarity-davinci-001',
    'text-similarity-curie-001',
    'text-similarity-babbage-001',
    'text-similarity-ada-001',
    'text-search-davinci-doc-001',
    'text-search-curie-doc-001',
    'text-search-babbage-doc-001',
    'text-search-ada-doc-001',
    'code-search-babbage-code-001',
    'code-search-ada-code-001',
];

const BYTES_PER_TOKEN = 3.35;
const IS_DOWNLOAD_ALLOWED = getConfigValue('enableDownloadableTokenizers', true, 'boolean');
const gunzip = promisify(zlib.gunzip);

/**
 * Guesstimates the token count for a string.
 * @param {string} str String to tokenize.
 * @returns {number} Token count.
 */
export function guesstimate(str) {
    const byteLength = Buffer.byteLength(str, 'utf8');
    return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

/**
 * Gets a path to the tokenizer model. Downloads the model if it's a URL.
 * @param {string} model Model URL or path
 * @returns {Promise<string>} Path to the tokenizer model. Throws when the model can't be had.
 */
export async function getPathToTokenizer(model) {
    if (!isValidUrl(model)) {
        return model;
    }

    try {
        const url = new URL(model);

        if (!['https:', 'http:'].includes(url.protocol)) {
            throw new Error('Invalid URL protocol');
        }

        const fileName = url.pathname.split('/').pop();

        if (!fileName) {
            throw new Error('Failed to extract the file name from the URL');
        }

        const CACHE_PATH = path.join(globalThis.DATA_ROOT, '_cache');
        if (!fs.existsSync(CACHE_PATH)) {
            fs.mkdirSync(CACHE_PATH, { recursive: true });
        }

        // If an uncompressed version exists, return it
        const isCompressed = path.extname(fileName) === '.gz';
        const uncompressedName = path.basename(fileName, '.gz');
        const uncompressedPath = path.join(CACHE_PATH, uncompressedName);
        if (isCompressed && fs.existsSync(uncompressedPath)) {
            return uncompressedPath;
        }

        const cachedFile = path.join(CACHE_PATH, fileName);
        if (fs.existsSync(cachedFile)) {
            // If the file was downloaded manually
            if (isCompressed) {
                const compressedBuffer = await fs.promises.readFile(cachedFile);
                const decompressedBuffer = await gunzip(compressedBuffer);
                writeFileAtomicSync(uncompressedPath, decompressedBuffer);
                await fs.promises.unlink(cachedFile);
                return uncompressedPath;
            }
            return cachedFile;
        }

        if (!IS_DOWNLOAD_ALLOWED) {
            throw new Error('Downloading tokenizers is disabled, the model is not cached');
        }

        if (isDownloadBackedOff(model)) {
            throw new Error(`The last download failed less than ${DOWNLOAD_RETRY_MS / 1000} s ago`);
        }

        try {
            console.info('Downloading tokenizer model:', model);
            const response = await fetch(model);
            if (!response.ok) {
                throw new Error(`Failed to fetch the model: ${response.status} ${response.statusText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            if (isCompressed) {
                const decompressedBuffer = await gunzip(arrayBuffer);
                writeFileAtomicSync(uncompressedPath, decompressedBuffer);
                clearDownloadFailure(model);
                return uncompressedPath;
            }

            writeFileAtomicSync(cachedFile, Buffer.from(arrayBuffer));
            clearDownloadFailure(model);
            return cachedFile;
        } catch (error) {
            recordDownloadFailure(model);
            throw error;
        }
    } catch (error) {
        throw new Error(`Could not get a tokenizer from ${model.split('/').pop()}. Reason: ${error.message}`);
    }
}

/**
 * Sentencepiece tokenizer for tokenizing text.
 */
class SentencePieceTokenizer {
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;

    /**
     * Creates a new Sentencepiece tokenizer.
     * @param {string} model Path to the tokenizer model
     */
    constructor(model) {
        this.#model = model;
    }

    /**
     * Gets the Sentencepiece tokenizer instance.
     * @returns {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>} Sentencepiece tokenizer instance
     */
    async get() {
        try {
            const pathToModel = await getPathToTokenizer(this.#model);
            return await loadTokenizerFile(pathToModel, 'sentencepiece');
        } catch (error) {
            console.error('Sentencepiece tokenizer failed to load: ' + this.#model, error);
            return null;
        }
    }
}

/**
 * Web tokenizer for tokenizing text.
 */
class WebTokenizer {
    /**
     * @type {Tokenizer} Web tokenizer instance
     */
    #instance;
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;
    /**
     * @type {Promise<Tokenizer|null>|null}
     */
    #loadPromise;

    /**
     * Creates a new Web tokenizer.
     * @param {string} model Path to the tokenizer model
     */
    constructor(model) {
        this.#model = model;
    }

    /**
     * Gets the Web tokenizer instance.
     * @returns {Promise<Tokenizer|null>} Web tokenizer instance
     */
    async get() {
        if (this.#instance) {
            return this.#instance;
        }

        if (!this.#loadPromise) {
            this.#loadPromise = this.#load();
        }

        return this.#loadPromise;
    }

    /**
     * Loads the Web tokenizer instance.
     * @returns {Promise<Tokenizer|null>} Web tokenizer instance
     */
    async #load() {
        try {
            const pathToModel = await getPathToTokenizer(this.#model);
            const fileBuffer = await fs.promises.readFile(pathToModel);
            this.#instance = await Tokenizer.fromJSON(fileBuffer);
            console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
            return this.#instance;
        } catch (error) {
            console.error('Web tokenizer failed to load: ' + this.#model, error);
            return null;
        } finally {
            this.#loadPromise = null;
        }
    }
}

/**
 * A tokenizer.json read by npm `tokenizers`, with the same `get()` as WebTokenizer. Its instance's
 * encode and decode return promises.
 */
class ExactJsonTokenizer {
    /**
     * @type {string} Path to the tokenizer file
     */
    #model;

    /**
     * @param {string} model Path to the tokenizer file
     */
    constructor(model) {
        this.#model = model;
    }

    /**
     * @returns {Promise<import('../tokenizer-loader.js').TokenizerFunctions|null>}
     */
    async get() {
        try {
            return await loadTokenizerFunctions(this.#model, 'hf-json');
        } catch (error) {
            console.error('Tokenizer failed to load: ' + this.#model, error);
            return null;
        }
    }
}

/**
 * A registry entry's tokenizer (src/tokenizer-sources.js), with the same `get()` as WebTokenizer.
 * Its instance's encode and decode return promises.
 */
class RegistryTokenizer {
    /** @type {string} */
    #source;
    /** @type {LocalTokenizerOptions} */
    #options;

    /**
     * @param {string} source Registry entry id
     * @param {LocalTokenizerOptions} options
     */
    constructor(source, options) {
        this.#source = source;
        this.#options = options;
    }

    /**
     * @returns {Promise<import('../tokenizer-loader.js').TokenizerFunctions|null>}
     */
    async get() {
        try {
            return await loadRegistryTokenizer(this.#source, this.#options);
        } catch (error) {
            console.error('Tokenizer failed to load: ' + this.#source, error);
            return null;
        }
    }
}

/**
 * What loading a registry entry's tokenizer needs from the request.
 * @typedef {object} LocalTokenizerOptions
 * @property {import('../users.js').UserDirectoryList} [directories] For the user's saved Hugging Face token
 * @property {import('../tokenizer-resolve.js').TokenizerOutcome} [outcome] Records a download of the entry's file
 */

const spp_llama = new SentencePieceTokenizer('src/tokenizers/llama.model');
const spp_nerd = new SentencePieceTokenizer('src/tokenizers/nerdstash.model');
const spp_nerd_v2 = new SentencePieceTokenizer('src/tokenizers/nerdstash_v2.model');
const spp_mistral = new SentencePieceTokenizer('src/tokenizers/mistral.model');
const spp_yi = new SentencePieceTokenizer('src/tokenizers/yi.model');
const spp_gemma = new SentencePieceTokenizer('src/tokenizers/gemma.model');
const spp_jamba = new SentencePieceTokenizer('src/tokenizers/jamba.model');
const claude_tokenizer = new WebTokenizer('src/tokenizers/claude.json');
const llama3_tokenizer = new WebTokenizer('src/tokenizers/llama3.json');
// @agnai/web-tokenizers ignores llama3.json's `ignore_merges`. llama3_tokenizer stays for the upstream
// exports that hand out its instance or encode with it synchronously (getWebTokenizer, countWebTokenizerTokens).
const llama3ExactTokenizer = new ExactJsonTokenizer('src/tokenizers/llama3.json');
const commandRTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-r.json.gz');
const commandATokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-a.json.gz');
const qwen2Tokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz');
const nemoTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/nemo.json.gz');
const deepseekTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/deepseek.json.gz');

export const sentencepieceTokenizers = [
    'llama',
    'nerdstash',
    'nerdstash_v2',
    'mistral',
    'yi',
    'gemma',
    'jamba',
];

export const webTokenizers = [
    'claude',
    'llama3',
    'command-r',
    'command-a',
    'qwen2',
    'nemo',
    'deepseek',
];

/**
 * Gets the Sentencepiece tokenizer by the model name.
 * @param {string} model Sentencepiece model name
 * @returns {SentencePieceTokenizer|null} Sentencepiece tokenizer
 */
export function getSentencepiceTokenizer(model) {
    if (model.includes('llama')) {
        return spp_llama;
    }

    if (model.includes('nerdstash')) {
        return spp_nerd;
    }

    if (model.includes('mistral')) {
        return spp_mistral;
    }

    if (model.includes('nerdstash_v2')) {
        return spp_nerd_v2;
    }

    if (model.includes('yi')) {
        return spp_yi;
    }

    if (model.includes('gemma')) {
        return spp_gemma;
    }

    if (model.includes('jamba')) {
        return spp_jamba;
    }

    return null;
}

/**
 * Gets the Web tokenizer by the model name.
 * @param {string} model Web tokenizer model name
 * @returns {WebTokenizer|null} Web tokenizer
 */
export function getWebTokenizer(model) {
    if (model.includes('llama3')) {
        return llama3_tokenizer;
    }

    if (model.includes('claude')) {
        return claude_tokenizer;
    }

    if (model.includes('command-r')) {
        return commandRTokenizer;
    }

    if (model.includes('command-a')) {
        return commandATokenizer;
    }

    if (model.includes('qwen2')) {
        return qwen2Tokenizer;
    }

    if (model.includes('nemo')) {
        return nemoTokenizer;
    }

    if (model.includes('deepseek')) {
        return deepseekTokenizer;
    }

    return null;
}

/**
 * Counts the token ids for the given text using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @param {string} text Text to tokenize
 * @returns { Promise<{ids: number[], count: number}> } Tokenization result. Throws when the tokenizer fails to load.
 */
async function countSentencepieceTokens(tokenizer, text) {
    const instance = await tokenizer?.get();
    if (!instance) {
        throw new Error('Failed to load the Sentencepiece tokenizer');
    }

    let cleaned = text; // cleanText(text); <-- cleaning text can result in an incorrect tokenization

    let ids = instance.encodeIds(cleaned);
    return {
        ids,
        count: ids.length,
    };
}

/**
 * Counts the tokens in the given array of objects using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer
 * @param {object[]} array Array of objects to tokenize
 * @returns {Promise<number>} Number of tokens
 */
async function countSentencepieceArrayTokens(tokenizer, array) {
    const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
    const result = await countSentencepieceTokens(tokenizer, jsonBody);
    const num_tokens = result.count;
    return num_tokens;
}

async function getTiktokenChunks(tokenizer, ids) {
    const decoder = new TextDecoder();
    const chunks = [];

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const chunkTextBytes = await tokenizer.decode(new Uint32Array([id]));
        const chunkText = decoder.decode(chunkTextBytes);
        chunks.push(chunkText);
    }

    return chunks;
}

/**
 * Gets the token chunks for the given token IDs using the Web tokenizer.
 * @param {Tokenizer|import('../tokenizer-loader.js').TokenizerFunctions} tokenizer Web tokenizer instance
 * @param {number[]} ids Token IDs
 * @returns {Promise<string[]>} Token chunks
 */
async function getWebTokenizersChunks(tokenizer, ids) {
    const chunks = [];

    for (let i = 0, lastProcessed = 0; i < ids.length; i++) {
        const chunkIds = ids.slice(lastProcessed, i + 1);
        const chunkText = await tokenizer.decode(new Int32Array(chunkIds));
        if (chunkText === '�') {
            continue;
        }
        chunks.push(chunkText);
        lastProcessed = i + 1;
    }

    return chunks;
}

/**
 * The token chunks for llama.cpp's `/tokenize` pieces (a string, or the piece's bytes when they aren't
 * valid UTF-8), merged as getWebTokenizersChunks() merges ids: until they decode to more than `�`.
 * @param {Array<string|number[]>} pieces
 * @returns {string[]}
 */
export function getBytePieceChunks(pieces) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const chunks = [];
    /** @type {number[]} */
    let pending = [];

    for (const piece of pieces) {
        pending = pending.concat(Array.from(typeof piece === 'string' ? encoder.encode(piece) : piece));
        const chunkText = decoder.decode(new Uint8Array(pending));
        if (chunkText === '�') {
            continue;
        }
        chunks.push(chunkText);
        pending = [];
    }

    return chunks;
}

/**
 * Gets the tokenizer model by the model name.
 * @param {string} requestModel Models to use for tokenization
 * @returns {string} Tokenizer model to use
 */
export function getTokenizerModel(requestModel) {
    if (requestModel === 'o1' || requestModel.includes('o1-preview') || requestModel.includes('o1-mini') || requestModel.includes('o3-mini')) {
        return 'o1';
    }

    if (requestModel.includes('gpt-5') || requestModel.includes('o3') || requestModel.includes('o4-mini')) {
        return 'o1';
    }

    if (requestModel.includes('gpt-4o') || requestModel.includes('chatgpt-4o-latest')) {
        return 'gpt-4o';
    }

    if (requestModel.includes('gpt-4.1') || requestModel.includes('gpt-4.5')) {
        return 'gpt-4o';
    }

    if (requestModel.includes('gpt-4-32k')) {
        return 'gpt-4-32k';
    }

    if (requestModel.includes('gpt-4')) {
        return 'gpt-4';
    }

    if (requestModel.includes('gpt-3.5-turbo-0301')) {
        return 'gpt-3.5-turbo-0301';
    }

    if (requestModel.includes('gpt-3.5-turbo')) {
        return 'gpt-3.5-turbo';
    }

    if (TEXT_COMPLETION_MODELS.includes(requestModel)) {
        return requestModel;
    }

    if (requestModel.includes('claude')) {
        return 'claude';
    }

    if (requestModel.includes('llama3') || requestModel.includes('llama-3')) {
        return 'llama3';
    }

    if (requestModel.includes('llama')) {
        return 'llama';
    }

    if (requestModel.includes('mistral')) {
        return 'mistral';
    }

    if (requestModel.includes('yi')) {
        return 'yi';
    }

    if (requestModel.includes('deepseek')) {
        return 'deepseek';
    }

    if (requestModel.includes('gemma') || requestModel.includes('gemini') || requestModel.includes('learnlm')) {
        return 'gemma';
    }

    if (requestModel.includes('jamba')) {
        return 'jamba';
    }

    if (requestModel.includes('qwen2')) {
        return 'qwen2';
    }

    if (requestModel.includes('command-r')) {
        return 'command-r';
    }

    if (requestModel.includes('command-a')) {
        return 'command-a';
    }

    if (requestModel.includes('nemo')) {
        return 'nemo';
    }

    // default
    return 'gpt-3.5-turbo';
}

export function getTiktokenTokenizer(model) {
    if (tokenizersCache[model]) {
        return tokenizersCache[model];
    }

    const tokenizer = tiktoken.encoding_for_model(model);
    console.info('Instantiated the tokenizer for', model);
    tokenizersCache[model] = tokenizer;
    return tokenizer;
}

/**
 * Gets tokenids for a given logit bias preset entry. Mirrors the getEntryTokens() helper that used
 * to live inline in the /api/backends/chat-completions/bias route handler.
 * @param {string} text Entry text
 * @param {((text: string) => Uint32Array|Promise<Uint32Array>)|null} encode Function to encode text to
 * token ids; null when there is no tokenizer.
 * @returns {Promise<Uint32Array|null>} Array of token ids; null when the entry needs a tokenizer and there is none.
 */
async function getEntryTokens(text, encode) {
    // Get raw token ids from JSON array
    if (text.trim().startsWith('[') && text.trim().endsWith(']')) {
        try {
            const json = JSON.parse(text);
            if (Array.isArray(json) && json.every(x => typeof x === 'number')) {
                return new Uint32Array(json);
            }
        } catch {
            // ignore
        }
    }

    // Otherwise, get token ids from tokenizer
    return encode ? await encode(text) : null;
}

/**
 * An encoder for a local resolveTokenizer() answer, or null when its tokenizer fails to load.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @returns {Promise<((text: string) => Uint32Array|Promise<Uint32Array>)|null>}
 */
async function getLocalEncoder(resolved) {
    if (resolved.id === tokenizers.OPENAI) {
        const tokenizer = getTiktokenTokenizer(resolved.model);
        return tokenizer.encode.bind(tokenizer);
    }
    const key = TOKENIZER_TYPE_KEYS[resolved.id];
    const instance = await getLocalTokenizer(resolved)?.get();
    if (!instance) {
        return null;
    }
    if (!resolved.source && sentencepieceTokenizers.includes(key)) {
        return (text) => new Uint32Array(instance.encodeIds(text));
    }
    return async (text) => new Uint32Array(await instance.encode(text));
}

/**
 * Computes a token-id-keyed logit bias map from bias-preset entries for a server-built
 * chat-completion send, with the model's chat-completion tokenizer resolution (the model map).
 * Claude models get {} (no bias support). With no tokenizer for the model, or one that fails to load
 * (tried again on every call), raw-id entries are kept and every other entry is left out and listed
 * in `dropped`.
 * Entries without `text` are skipped, and an encode failure is warned about, not thrown.
 *
 * @param {{text?: string, value?: number}[]} biasPresetEntries Raw bias-preset entries, e.g.
 * oai_settings.bias_presets[oai_settings.bias_preset_selected] client-side - {id, text, value}[]
 * shaped, though only `text`/`value` are used here.
 * @param {string} requestModel The chat-completion model name.
 * @param {string[]} [dropped] Receives the text of each entry left out because there are no token ids for it.
 * @param {string} [source] The chat-completion source, which decides the file for a model with several official files.
 * @param {import('../tokenizer-map-resolution.js').ChatCompletionConnection} [connection] The custom source's
 * URL and what its requests carry, for a custom URL that is llama.cpp.
 * @returns {Promise<{[tokenId: number]: number}>} Token-id-keyed bias map
 */
export async function computeLogitBias(biasPresetEntries, requestModel, dropped = undefined, source = undefined, connection = {}) {
    const result = {};

    if (!Array.isArray(biasPresetEntries)) {
        return result;
    }

    const modelName = String(requestModel || '');

    // no bias for claude
    if (modelName.toLowerCase().includes('claude')) {
        return result;
    }

    const resolved = await resolveChatCompletionTokenizer(modelName, source, connection);
    let encodeFunction = null;
    if (resolved.llamaCpp) {
        const { llamaCpp, localCopy } = resolved;
        encodeFunction = async (text) => {
            const result = await encodeViaCustomLlamaCpp(llamaCpp, text);
            if (result) return new Uint32Array(result.ids);
            const localEncoder = localCopy ? await getLocalEncoder(localResolution(localCopy, null)) : null;
            return localEncoder ? await localEncoder(text) : null;
        };
    } else if (resolved.kind !== 'estimate') {
        encodeFunction = await getLocalEncoder(resolved);
        if (!encodeFunction) {
            console.error('Tokenizer not initialized:', resolved.name);
        }
    }

    for (const entry of biasPresetEntries) {
        if (!entry || !entry.text) {
            continue;
        }

        try {
            const tokens = await getEntryTokens(entry.text, encodeFunction);

            if (tokens === null) {
                dropped?.push(entry.text);
                continue;
            }

            for (const token of tokens) {
                result[token] = entry.value;
            }
        } catch {
            console.warn('Tokenizer failed to encode:', entry.text);
        }
    }

    // not needed for cached tokenizers
    //tokenizer.free();
    return result;
}

/**
 * The `/api/backends/chat-completions/bias` route's encoding for a request without an
 * `X-ST-Connection-State` header, as upstream calls it: the tokenizer upstream picks from the model
 * name with getTokenizerModel(), and the same result for the same input.
 * @param {{text?: string, value?: number}[]} biasPresetEntries
 * @param {string} requestModel The route's `?model=`.
 * @returns {Promise<{[tokenId: number]: number}>} Token-id-keyed bias map
 */
export async function computeUpstreamLogitBias(biasPresetEntries, requestModel) {
    const result = {};

    if (!Array.isArray(biasPresetEntries)) {
        return result;
    }

    const model = getTokenizerModel(String(requestModel || ''));

    // no bias for claude
    if (model == 'claude') {
        return result;
    }

    let encodeFunction;

    if (sentencepieceTokenizers.includes(model)) {
        const tokenizer = getSentencepiceTokenizer(model);
        const instance = await tokenizer?.get();
        if (!instance) {
            console.error('Tokenizer not initialized:', model);
            return {};
        }
        encodeFunction = (text) => new Uint32Array(instance.encodeIds(text));
    } else if (webTokenizers.includes(model)) {
        const tokenizer = model === 'llama3' ? llama3ExactTokenizer : getWebTokenizer(model);
        const instance = await tokenizer?.get();
        if (!instance) {
            console.warn('Tokenizer not initialized:', model);
            return {};
        }
        encodeFunction = async (text) => new Uint32Array(await instance.encode(text));
    } else {
        const tokenizer = getTiktokenTokenizer(model);
        encodeFunction = (tokenizer.encode.bind(tokenizer));
    }

    for (const entry of biasPresetEntries) {
        if (!entry || !entry.text) {
            continue;
        }

        try {
            const tokens = await getEntryTokens(entry.text, encodeFunction);

            for (const token of tokens) {
                result[token] = entry.value;
            }
        } catch {
            console.warn('Tokenizer failed to encode:', entry.text);
        }
    }

    // not needed for cached tokenizers
    //tokenizer.free();
    return result;
}

/**
 * Encodes one string against a Kobold-compatible backend's own tokenize endpoint. Extracted from
 * the `/api/tokenizers/remote/kobold/count` route handler below (same rationale as
 * `encodeViaTextgenAPI` and this session's `computeLogitBias` extraction) so in-process callers can
 * reuse the real remote-tokenization logic without an HTTP round trip to this server.
 * @param {string} baseUrl KoboldAI-compatible backend base URL
 * @param {string} text Text to encode
 * @returns {Promise<{count: number, ids: number[]}|{error: true}>}
 */
export async function encodeViaKoboldAPI(baseUrl, text) {
    try {
        const args = {
            method: 'POST',
            body: JSON.stringify({ 'prompt': text }),
            headers: { 'Content-Type': 'application/json' },
        };

        let url = String(baseUrl).replace(/\/$/, '');
        url += '/extra/tokencount';

        const result = await fetch(url, args);

        if (!result.ok) {
            console.warn(`API returned error: ${result.status} ${result.statusText}`);
            return { error: true };
        }

        /** @type {any} */
        const data = await result.json();
        const count = data.value;
        const ids = data.ids ?? [];
        return { count, ids };
    } catch (error) {
        console.error(error);
        return { error: true };
    }
}

/**
 * Server-side port of public/scripts/textgen-settings.js's `calculateLogitBias()` - computes a
 * token-id-keyed logit bias map from a textgen `logit_bias` preset array, encoding each entry with
 * `tokenizerOptions.encode`: the send's resolveTokenizer() answer bound to its backend
 * (encodeWithTokenizer() in src/tokenizer-resolve.js), which gives null when it has no ids for the
 * text (an estimate resolution, or a failed tokenizer with no local copy).
 *
 * @param {{id?: string, text?: string, value?: number}[]} logitBiasPreset Raw
 * `textgenerationwebui_settings.logit_bias`-shaped array.
 * @param {{encode?: (text: string) => Promise<number[]|null>}} [tokenizerOptions] `encode` is
 * required for a non-empty preset; without one this throws, since any default would silently pick
 * a tokenizer.
 * @param {string[]} [dropped] Receives the text of each entry left out because `encode` gave null.
 * @returns {Promise<{[tokenId: string]: number}>} Token-id-keyed bias map. `{}` for an
 * absent/empty preset, matching `calculateLogitBias()`'s own early return.
 */
export async function computeTextgenLogitBias(logitBiasPreset, tokenizerOptions = {}, dropped = undefined) {
    const result = {};

    if (!Array.isArray(logitBiasPreset) || logitBiasPreset.length === 0) {
        return result;
    }

    const { encode } = tokenizerOptions;
    if (!encode) {
        throw new Error('computeTextgenLogitBias: tokenizerOptions.encode is required');
    }

    for (const entry of logitBiasPreset) {
        if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) {
            continue;
        }

        const text = entry.text.trim();
        if (text.length === 0) {
            continue;
        }

        let tokens;
        if (text.startsWith('{') && text.endsWith('}')) {
            // Verbatim text
            tokens = await encode(text.slice(1, -1));
        } else if (text.startsWith('[') && text.endsWith(']')) {
            // Raw token ids, JSON serialized
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed) && parsed.every(t => Number.isInteger(t))) {
                    tokens = parsed;
                } else {
                    console.log(`Failed to parse logit bias token list: ${text}`, new Error('Not an array of integers'));
                    continue;
                }
            } catch (err) {
                console.log(`Failed to parse logit bias token list: ${text}`, err);
                continue;
            }
        } else {
            // Text with a leading space
            tokens = await encode(` ${text}`);
        }

        if (tokens === null) {
            dropped?.push(text);
            continue;
        }

        if (!Array.isArray(tokens) || tokens.length === 0) {
            continue;
        }

        for (const token of tokens) {
            result[String(token)] = entry.value;
        }
    }

    return result;
}

/**
 * Counts the tokens for the given messages using the WebTokenizer and Claude prompt conversion.
 * @param {Tokenizer} tokenizer Web tokenizer
 * @param {object[]} messages Array of messages
 * @returns {number} Number of tokens
 */
export function countWebTokenizerTokens(tokenizer, messages) {
    const jsonBody = messages.flatMap(x => Object.values(x)).join('\n\n');

    // Fallback to strlen estimation
    if (!tokenizer) {
        return guesstimate(jsonBody);
    }

    const count = tokenizer.encode(jsonBody).length;
    return count;
}

/**
 * Creates an API handler for encoding Sentencepiece tokens.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @returns {TokenizationHandler} Handler function
 */
function createSentencepieceEncodingHandler(tokenizer) {
    /**
     * Request handler for encoding Sentencepiece tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const instance = await tokenizer?.get();
            if (!instance) {
                return response.send({ ids: [], count: guesstimate(text) });
            }
            const { ids, count } = await countSentencepieceTokens(tokenizer, text);
            const chunks = instance?.encodePieces(text);
            return response.send({ ids, count, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding Sentencepiece tokens.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @returns {TokenizationHandler} Handler function
 */
function createSentencepieceDecodingHandler(tokenizer) {
    /**
     * Request handler for decoding Sentencepiece tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const instance = await tokenizer?.get();
            if (!instance) throw new Error('Failed to load the Sentencepiece tokenizer');
            const ops = ids.map(id => instance.decodeIds([id]));
            const chunks = await Promise.all(ops);
            const text = chunks.join('');
            return response.send({ text, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ text: '', chunks: [] });
        }
    };
}

/**
 * Creates an API handler for encoding Tiktoken tokens.
 * @param {string} modelId Tiktoken model ID
 * @returns {TokenizationHandler} Handler function
 */
function createTiktokenEncodingHandler(modelId) {
    /**
     * Request handler for encoding Tiktoken tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const tokenizer = getTiktokenTokenizer(modelId);
            const tokens = Object.values(tokenizer.encode(text));
            const chunks = await getTiktokenChunks(tokenizer, tokens);
            return response.send({ ids: tokens, count: tokens.length, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding Tiktoken tokens.
 * @param {string} modelId Tiktoken model ID
 * @returns {TokenizationHandler} Handler function
 */
function createTiktokenDecodingHandler(modelId) {
    /**
     * Request handler for decoding Tiktoken tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const tokenizer = getTiktokenTokenizer(modelId);
            const textBytes = tokenizer.decode(new Uint32Array(ids));
            const text = new TextDecoder().decode(textBytes);
            return response.send({ text });
        } catch (error) {
            console.error(error);
            return response.send({ text: '' });
        }
    };
}

/**
 * Creates an API handler for encoding WebTokenizer tokens.
 * @param {WebTokenizer|ExactJsonTokenizer} tokenizer WebTokenizer instance
 * @returns {TokenizationHandler} Handler function
 */
function createWebTokenizerEncodingHandler(tokenizer) {
    /**
     * Request handler for encoding WebTokenizer tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const instance = await tokenizer?.get();
            if (!instance) {
                return response.send({ ids: [], count: guesstimate(text), chunks: [] });
            }
            const tokens = Array.from(await instance.encode(text));
            const chunks = await getWebTokenizersChunks(instance, tokens);
            return response.send({ ids: tokens, count: tokens.length, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding WebTokenizer tokens.
 * @param {WebTokenizer|ExactJsonTokenizer} tokenizer WebTokenizer instance
 * @returns {TokenizationHandler} Handler function
 */
function createWebTokenizerDecodingHandler(tokenizer) {
    /**
     * Request handler for decoding WebTokenizer tokens.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     * @returns {Promise<any>}
     */
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const instance = await tokenizer?.get();
            if (!instance) throw new Error('Failed to load the Web tokenizer');
            const chunks = await getWebTokenizersChunks(instance, ids);
            const text = await instance.decode(new Int32Array(ids));
            return response.send({ text, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ text: '', chunks: [] });
        }
    };
}

/**
 * Maps a local tokenizer type string (matching the route paths registered below, e.g.
 * '/llama/encode' -> 'llama') to the already-instantiated tokenizer instance backing it. Reuses
 * the same module-private instances the Express routes use below - never instantiate new
 * tokenizer objects here, that would double-load the underlying model files.
 * @type {{[key: string]: SentencePieceTokenizer | Tokenizer}}
 */
const LOCAL_TOKENIZER_INSTANCES = {
    llama: spp_llama,
    nerdstash: spp_nerd,
    nerdstash_v2: spp_nerd_v2,
    mistral: spp_mistral,
    yi: spp_yi,
    gemma: spp_gemma,
    jamba: spp_jamba,
    claude: claude_tokenizer,
    llama3: llama3_tokenizer,
    qwen2: qwen2Tokenizer,
    'command-r': commandRTokenizer,
    'command-a': commandATokenizer,
    nemo: nemoTokenizer,
    deepseek: deepseekTokenizer,
};

const SENTENCEPIECE_TOKENIZER_TYPES = new Set(['llama', 'nerdstash', 'nerdstash_v2', 'mistral', 'yi', 'gemma', 'jamba']);
const WEB_TOKENIZER_TYPES = new Set(['claude', 'llama3', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek']);

/**
 * The tokenizer that encodes and decodes for a local tokenizer type on every path that awaits it. It
 * is LOCAL_TOKENIZER_INSTANCES' except for llama3, which gets the exact reader. A web tokenizer
 * instance's encode and decode may return promises.
 * @param {string} key A LOCAL_TOKENIZER_INSTANCES key
 * @returns {SentencePieceTokenizer|WebTokenizer|ExactJsonTokenizer|undefined}
 */
function getEncodingTokenizer(key) {
    return key === 'llama3' ? llama3ExactTokenizer : LOCAL_TOKENIZER_INSTANCES[key];
}

/**
 * The tokenizer that encodes and decodes for a local resolution: its registry entry's when it has
 * a `source`, else getEncodingTokenizer()'s.
 * @param {{id: number, source?: string}} tokenizer
 * @param {LocalTokenizerOptions} [options]
 * @returns {SentencePieceTokenizer|WebTokenizer|ExactJsonTokenizer|RegistryTokenizer|undefined}
 */
function getLocalTokenizer(tokenizer, options = {}) {
    if (tokenizer.source) {
        return new RegistryTokenizer(tokenizer.source, options);
    }
    return getEncodingTokenizer(TOKENIZER_TYPE_KEYS[tokenizer.id]);
}

/**
 * Encodes text to token ids using an already-instantiated local tokenizer, keyed by the same
 * type string used for the '/api/tokenizers/<type>/encode' routes below. Factors out the
 * per-type encode step that createSentencepieceEncodingHandler/createWebTokenizerEncodingHandler/
 * createTiktokenEncodingHandler wire up per-route, so callers that need raw token ids (not an
 * Express response) don't have to duplicate the dispatch-by-type logic.
 * @param {string} tokenizerType One of: llama, nerdstash, nerdstash_v2, mistral, yi, gemma, jamba,
 * claude, llama3, qwen2, command-r, command-a, nemo, deepseek, gpt2.
 * @param {string} text Text to encode.
 * @returns {Promise<number[]>} Array of token ids. Throws for an unrecognized tokenizer type.
 */
export async function encodeTextByLocalTokenizerType(tokenizerType, text) {
    if (tokenizerType === 'gpt2') {
        const tokenizer = getTiktokenTokenizer('gpt2');
        return Object.values(tokenizer.encode(text ?? ''));
    }

    if (SENTENCEPIECE_TOKENIZER_TYPES.has(tokenizerType)) {
        const { ids } = await countSentencepieceTokens(LOCAL_TOKENIZER_INSTANCES[tokenizerType], text ?? '');
        return ids;
    }

    if (WEB_TOKENIZER_TYPES.has(tokenizerType)) {
        const tokenizer = getEncodingTokenizer(tokenizerType);
        const instance = await tokenizer?.get();
        if (!instance) throw new Error(`Failed to load the Web tokenizer for type: ${tokenizerType}`);
        return Array.from(await instance.encode(text ?? ''));
    }

    throw new Error(`Unrecognized local tokenizer type: ${tokenizerType}`);
}

export const router = express.Router();

router.post('/llama/encode', createSentencepieceEncodingHandler(spp_llama));
router.post('/nerdstash/encode', createSentencepieceEncodingHandler(spp_nerd));
router.post('/nerdstash_v2/encode', createSentencepieceEncodingHandler(spp_nerd_v2));
router.post('/mistral/encode', createSentencepieceEncodingHandler(spp_mistral));
router.post('/yi/encode', createSentencepieceEncodingHandler(spp_yi));
router.post('/gemma/encode', createSentencepieceEncodingHandler(spp_gemma));
router.post('/jamba/encode', createSentencepieceEncodingHandler(spp_jamba));
router.post('/gpt2/encode', createTiktokenEncodingHandler('gpt2'));
router.post('/claude/encode', createWebTokenizerEncodingHandler(claude_tokenizer));
router.post('/llama3/encode', createWebTokenizerEncodingHandler(llama3ExactTokenizer));
router.post('/qwen2/encode', createWebTokenizerEncodingHandler(qwen2Tokenizer));
router.post('/command-r/encode', createWebTokenizerEncodingHandler(commandRTokenizer));
router.post('/command-a/encode', createWebTokenizerEncodingHandler(commandATokenizer));
router.post('/nemo/encode', createWebTokenizerEncodingHandler(nemoTokenizer));
router.post('/deepseek/encode', createWebTokenizerEncodingHandler(deepseekTokenizer));
router.post('/llama/decode', createSentencepieceDecodingHandler(spp_llama));
router.post('/nerdstash/decode', createSentencepieceDecodingHandler(spp_nerd));
router.post('/nerdstash_v2/decode', createSentencepieceDecodingHandler(spp_nerd_v2));
router.post('/mistral/decode', createSentencepieceDecodingHandler(spp_mistral));
router.post('/yi/decode', createSentencepieceDecodingHandler(spp_yi));
router.post('/gemma/decode', createSentencepieceDecodingHandler(spp_gemma));
router.post('/jamba/decode', createSentencepieceDecodingHandler(spp_jamba));
router.post('/gpt2/decode', createTiktokenDecodingHandler('gpt2'));
router.post('/claude/decode', createWebTokenizerDecodingHandler(claude_tokenizer));
router.post('/llama3/decode', createWebTokenizerDecodingHandler(llama3ExactTokenizer));
router.post('/qwen2/decode', createWebTokenizerDecodingHandler(qwen2Tokenizer));
router.post('/command-r/decode', createWebTokenizerDecodingHandler(commandRTokenizer));
router.post('/command-a/decode', createWebTokenizerDecodingHandler(commandATokenizer));
router.post('/nemo/decode', createWebTokenizerDecodingHandler(nemoTokenizer));
router.post('/deepseek/decode', createWebTokenizerDecodingHandler(deepseekTokenizer));

/**
 * Counts tiktoken tokens in chat messages the way OpenAI documents it.
 * @param {string} model A tiktoken model name
 * @param {object[]} messages
 * @returns {number}
 */
function countTiktokenMessages(model, messages) {
    const isTurbo0301 = model.includes('gpt-3.5-turbo-0301');
    const tokensPerName = isTurbo0301 ? -1 : 1;
    const tokensPerMessage = isTurbo0301 ? 4 : 3;
    const tokensPadding = 3;

    const tokenizer = getTiktokenTokenizer(model);
    let numTokens = 0;

    for (const msg of messages) {
        try {
            numTokens += tokensPerMessage;
            for (const [key, value] of Object.entries(msg)) {
                numTokens += tokenizer.encode(value).length;
                if (key == 'name') {
                    numTokens += tokensPerName;
                }
            }
        } catch {
            console.warn('Error tokenizing message:', msg);
        }
    }
    numTokens += tokensPadding;

    // NB: Since 2023-10-14, the GPT-3.5 Turbo 0301 model shoves in 7-9 extra tokens to every message.
    // More details: https://community.openai.com/t/gpt-3-5-turbo-0301-showing-different-behavior-suddenly/431326/14
    if (isTurbo0301) {
        numTokens += 9;
    }

    return numTokens;
}

/**
 * Counts chat-completion messages with a chat-completion resolveTokenizer() answer; the estimate
 * when there is no tokenizer or counting fails.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @param {object[]} messages
 * @param {import('../tokenizer-resolve.js').TokenizerOutcome} [outcome] Records a failed count and
 * a downloaded tokenizer file, for a send's or a response's warnings.
 * @param {import('../users.js').UserDirectoryList} [directories] For the user's saved Hugging Face token
 * @returns {Promise<number>}
 */
export async function countChatCompletionMessages(resolved, messages, outcome = undefined, directories = undefined) {
    if (resolved.kind === 'estimate') {
        return guesstimate(JSON.stringify(messages));
    }
    try {
        return await countMessagesWith(resolved, messages, outcome, directories);
    } catch (error) {
        console.error('An error counting tokens', error);
    }
    if (resolved.kind === 'remote' && resolved.localCopy) {
        try {
            const count = await countMessagesWith(resolved.localCopy, messages, outcome, directories);
            if (outcome) outcome.usedCopy = resolved.localCopy;
            return count;
        } catch (error) {
            console.error('An error counting tokens with the local copy', error);
        }
    }
    console.warn('Using fallback estimation method');
    if (outcome) {
        outcome.failed = true;
        outcome.countEstimated = true;
    }
    return guesstimate(JSON.stringify(messages));
}

/**
 * Counts chat-completion messages with one tokenizer. Throws when it fails.
 * @param {{id: number, source?: string, name: string, model?: string, kind?: string, llamaCpp?: import('../tokenizer-resolve.js').ResolvedTokenizer['llamaCpp']}} tokenizer
 * @param {object[]} messages
 * @param {import('../tokenizer-resolve.js').TokenizerOutcome} [outcome]
 * @param {import('../users.js').UserDirectoryList} [directories]
 * @returns {Promise<number>}
 */
async function countMessagesWith(tokenizer, messages, outcome, directories) {
    const jsonBody = () => messages.flatMap(x => Object.values(x)).join('\n\n');
    if (tokenizer.llamaCpp) {
        const result = await encodeViaCustomLlamaCpp(tokenizer.llamaCpp, jsonBody());
        if (!result) throw new Error('The llama.cpp tokenizer failed');
        return result.ids.length;
    }
    if (tokenizer.id === tokenizers.OPENAI) {
        return countTiktokenMessages(tokenizer.model, messages);
    }
    const key = TOKENIZER_TYPE_KEYS[tokenizer.id];
    if (!tokenizer.source && sentencepieceTokenizers.includes(key)) {
        return await countSentencepieceArrayTokens(LOCAL_TOKENIZER_INSTANCES[key], messages);
    }
    const instance = await getLocalTokenizer(tokenizer, { directories, outcome })?.get();
    if (!instance) throw new Error(`Failed to load the ${tokenizer.name} tokenizer`);
    return (await instance.encode(jsonBody())).length;
}

/**
 * Encodes with a chat-completion custom URL's llama.cpp `/tokenize`, as a single field: no BOS.
 * @param {NonNullable<import('../tokenizer-resolve.js').ResolvedTokenizer['llamaCpp']>} llamaCpp
 * @param {string} text
 * @param {boolean} [withPieces]
 * @returns {Promise<{ ids: number[], pieces?: Array<string|number[]> }|null>} null when it fails
 */
async function encodeViaCustomLlamaCpp(llamaCpp, text, withPieces = false) {
    const result = await encodeViaTextgenAPI(null, text, llamaCpp.url, llamaCpp.model, TEXTGEN_TYPES.LLAMACPP, { headers: llamaCpp.headers, withPieces });
    if ('error' in result || !Array.isArray(result.ids) || typeof result.count !== 'number') {
        return null;
    }
    return result;
}

/**
 * The encode or decode handler for a local chat-completion resolveTokenizer() answer.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @param {'encode'|'decode'} direction
 * @param {import('../users.js').UserDirectoryList} [directories] For the user's saved Hugging Face token
 * @returns {TokenizationHandler}
 */
function chatCompletionTokenizerHandler(resolved, direction, directories = undefined) {
    const encode = direction === 'encode';
    if (resolved.id === tokenizers.OPENAI) {
        return encode ? createTiktokenEncodingHandler(resolved.model) : createTiktokenDecodingHandler(resolved.model);
    }
    const key = TOKENIZER_TYPE_KEYS[resolved.id];
    const instance = getLocalTokenizer(resolved, { directories });
    if (!resolved.source && sentencepieceTokenizers.includes(key)) {
        return encode ? createSentencepieceEncodingHandler(instance) : createSentencepieceDecodingHandler(instance);
    }
    return encode ? createWebTokenizerEncodingHandler(instance) : createWebTokenizerDecodingHandler(instance);
}

/**
 * The tokenizers upstream's `/openai/*` routes accept by name (their `TOKENIZER_TYPE_KEYS` key) in
 * `?model=`. Naming one is an explicit pick of that tokenizer, whether or not the model map knows the name.
 */
const OPENAI_ROUTE_NAMED_TOKENIZERS = [
    tokenizers.CLAUDE, tokenizers.LLAMA3, tokenizers.LLAMA, tokenizers.MISTRAL, tokenizers.YI, tokenizers.GEMMA,
    tokenizers.JAMBA, tokenizers.QWEN2, tokenizers.COMMAND_R, tokenizers.COMMAND_A, tokenizers.NEMO, tokenizers.DEEPSEEK,
];

/**
 * The tokenizer for an `/openai/*` request: from the `X-ST-Connection-State` header's state when
 * there is one, else from `?model=`, the named tokenizer or the model map.
 * @param {import('express').Request} req
 * @returns {Promise<import('../tokenizer-resolve.js').ResolvedTokenizer|null>} null when the header holds no
 * chat-completion state.
 */
async function resolveOpenAIRouteRequest(req) {
    const state = readConnectionStateHeader(req);
    if (state === null) {
        return null;
    }
    if (state) {
        return resolveChatCompletionTokenizer(state.model, state.source, { url: state.url, directories: req.user?.directories });
    }
    const queryModel = String(req.query.model || '');
    const named = OPENAI_ROUTE_NAMED_TOKENIZERS.find(id => TOKENIZER_TYPE_KEYS[id] === queryModel);
    return named === undefined
        ? resolveChatCompletionTokenizer(queryModel)
        : localResolution(describeMapEntry(named, 'openai'), null);
}

router.post('/openai/encode', async function (req, res) {
    try {
        if (!req.body) return res.sendStatus(400);

        const resolved = await resolveOpenAIRouteRequest(req);
        if (!resolved) return res.sendStatus(400);
        const local = resolved.llamaCpp ? null : resolved;
        if (resolved.llamaCpp) {
            const text = String(req.body.text || '');
            const result = await encodeViaCustomLlamaCpp(resolved.llamaCpp, text, true);
            if (result) {
                return res.send({ ids: result.ids, count: result.ids.length, chunks: getBytePieceChunks(result.pieces ?? []) });
            }
            if (resolved.localCopy) {
                return chatCompletionTokenizerHandler(localResolution(resolved.localCopy, null), 'encode', req.user?.directories)(req, res);
            }
        }
        if (!local || local.kind === 'estimate') {
            return res.send({ ids: [], count: guesstimate(String(req.body.text || '')), chunks: [] });
        }
        return chatCompletionTokenizerHandler(local, 'encode', req.user?.directories)(req, res);
    } catch (error) {
        console.error(error);
        return res.send({ ids: [], count: 0, chunks: [] });
    }
});

router.post('/openai/decode', async function (req, res) {
    try {
        if (!req.body) return res.sendStatus(400);

        const resolved = await resolveOpenAIRouteRequest(req);
        if (!resolved) return res.sendStatus(400);
        // llama.cpp's ids decode with its exact local copy, as `/current/decode` does.
        const decoding = resolved.llamaCpp ? (resolved.localCopy && localResolution(resolved.localCopy, null)) : resolved;
        if (!decoding || decoding.kind === 'estimate') {
            return res.send({ text: '' });
        }
        return chatCompletionTokenizerHandler(decoding, 'decode', req.user?.directories)(req, res);
    } catch (error) {
        console.error(error);
        return res.send({ text: '' });
    }
});

router.post('/openai/count', async function (req, res) {
    if (!req.body) return res.sendStatus(400);

    const resolved = await resolveOpenAIRouteRequest(req);
    if (!resolved) return res.sendStatus(400);
    const num_tokens = await countChatCompletionMessages(resolved, req.body, undefined, req.user?.directories);
    return res.send({ 'token_count': num_tokens });
});

router.post('/remote/kobold/count', async function (request, response) {
    if (!request.body) {
        return response.sendStatus(400);
    }
    const text = String(request.body.text) || '';
    const baseUrl = String(request.body.url);

    const result = await encodeViaKoboldAPI(baseUrl, text);
    return response.send(result);
});

/**
 * Encodes one string against a textgen backend's own tokenize endpoint.
 * @param {import('express').Request} request Original request, for header forwarding via setAdditionalHeaders
 * @param {string} text Text to encode
 * @param {string} baseUrl Backend base URL
 * @param {string} model Model name (only some backends need this)
 * @param {string} apiType One of TEXTGEN_TYPES
 * @param {object} [llamaCpp] llama.cpp `/tokenize` only (llama.cpp server README, "POST `/tokenize`").
 * @param {boolean} [llamaCpp.addSpecial] Sends `add_special: true`: BOS goes in as it does for a generation's prompt.
 * @param {boolean} [llamaCpp.withPieces] Sends `with_pieces: true` and answers each token's `piece` in `pieces`.
 * @param {Record<string, string>} [llamaCpp.headers] Sent in place of the textgen type's own headers.
 * @returns {Promise<{count: number, ids: number[], pieces?: Array<string|number[]>}|{error: true}>}
 */
export async function encodeViaTextgenAPI(request, text, baseUrl, model, apiType, llamaCpp = {}) {
    try {
        const args = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        };

        if (apiType === TEXTGEN_TYPES.LLAMACPP && llamaCpp.headers) {
            args.headers = { ...args.headers, ...llamaCpp.headers };
        } else {
            setAdditionalHeaders(request, args, baseUrl);
        }

        // Convert to string + remove trailing slash + /v1 suffix
        let url = trimV1(baseUrl);

        switch (apiType) {
            case TEXTGEN_TYPES.TABBY:
                url += '/v1/token/encode';
                args.body = JSON.stringify({ 'text': text, 'add_bos_token': false, 'encode_special_tokens': false });
                break;
            case TEXTGEN_TYPES.KOBOLDCPP:
                url += '/api/extra/tokencount';
                args.body = JSON.stringify({ 'prompt': text, 'special': false });
                break;
            case TEXTGEN_TYPES.LLAMACPP:
                url += '/tokenize';
                args.body = JSON.stringify({
                    'model': model,
                    'content': text,
                    ...(llamaCpp.addSpecial ? { 'add_special': true } : {}),
                    ...(llamaCpp.withPieces ? { 'with_pieces': true } : {}),
                });
                break;
            case TEXTGEN_TYPES.VLLM:
                url += '/tokenize';
                args.body = JSON.stringify({ 'model': model, 'prompt': text });
                break;
            case TEXTGEN_TYPES.APHRODITE:
                url += '/v1/tokenize';
                args.body = JSON.stringify({ 'model': model, 'prompt': text });
                break;
            case TEXTGEN_TYPES.OOBA:
                url += '/v1/internal/encode';
                args.body = JSON.stringify({ 'text': text });
                break;
            default:
                return { error: true };
        }

        const result = await fetch(url, args);

        if (!result.ok) {
            console.warn(`API returned error: ${result.status} ${result.statusText}`);
            return { error: true };
        }

        /** @type {any} */
        const data = await result.json();
        if (apiType === TEXTGEN_TYPES.LLAMACPP && llamaCpp.withPieces) {
            const tokens = data?.tokens;
            if (!Array.isArray(tokens) || !tokens.every(token => Number.isInteger(token?.id) && (typeof token.piece === 'string' || Array.isArray(token.piece)))) {
                console.warn('llama.cpp /tokenize gave no token pieces');
                return { error: true };
            }
            return { count: tokens.length, ids: tokens.map(token => token.id), pieces: tokens.map(token => token.piece) };
        }
        const count = (data?.length ?? data?.count ?? data?.value ?? data?.tokens?.length);
        const ids = (data?.tokens ?? data?.ids ?? []);

        return { count, ids };
    } catch (error) {
        console.error(error);
        return { error: true };
    }
}

/** The api_types `encodeViaTextgenAPI` has a remote tokenize endpoint for. */
const TEXTGEN_ENCODE_TYPES = [
    TEXTGEN_TYPES.TABBY,
    TEXTGEN_TYPES.KOBOLDCPP,
    TEXTGEN_TYPES.LLAMACPP,
    TEXTGEN_TYPES.VLLM,
    TEXTGEN_TYPES.APHRODITE,
    TEXTGEN_TYPES.OOBA,
];

router.post('/remote/textgenerationwebui/encode', async function (request, response) {
    if (!request.body) {
        return response.sendStatus(400);
    }
    const text = String(request.body.text) || '';
    const baseUrl = String(request.body.url);
    const model = String(request.body.model) || '';

    const apiType = request.body.api_type;
    if (!TEXTGEN_ENCODE_TYPES.includes(apiType)) {
        return response.sendStatus(400);
    }

    const result = await encodeViaTextgenAPI(request, text, baseUrl, model, apiType);
    return response.send(result);
});

/**
 * Batch counterpart to /remote/textgenerationwebui/encode: encodes multiple texts in one round
 * trip. The client<->server hop is the one that can be on a slow link (VPN, mobile); the
 * server<->backend hop this fans out over is normally localhost/LAN, so batching here (not at
 * the backend protocol level, which varies per api_type and mostly doesn't support batch input
 * anyway) is what actually collapses N client round trips into 1.
 */
router.post('/remote/textgenerationwebui/encode-batch', async function (request, response) {
    if (!request.body || !Array.isArray(request.body.texts)) {
        return response.sendStatus(400);
    }
    const texts = request.body.texts.map(t => String(t ?? ''));
    const baseUrl = String(request.body.url);
    const model = String(request.body.model) || '';
    const apiType = request.body.api_type;

    const results = await Promise.all(texts.map(text => encodeViaTextgenAPI(request, text, baseUrl, model, apiType)));
    return response.send({ results });
});

/**
 * @param {{id: number, model?: string}} tokenizer An OPENAI or GPT2 tokenizer.
 * @returns {import('tiktoken').Tiktoken}
 */
function getTiktokenFor(tokenizer) {
    return getTiktokenTokenizer(tokenizer.id === tokenizers.OPENAI ? tokenizer.model : 'gpt2');
}

/**
 * The loaded instance of a local sentencepiece, web or registry tokenizer, and whether it is one of
 * the bundled sentencepiece files. Throws when it fails to load.
 * @param {{id: number, source?: string, name: string}} tokenizer
 * @param {LocalTokenizerOptions} options
 * @returns {Promise<{isSentencepiece: boolean, instance: any}>}
 */
async function getLocalInstance(tokenizer, options) {
    const instance = await getLocalTokenizer(tokenizer, options)?.get();
    if (!instance) {
        throw new Error(`Failed to load the ${tokenizer.name} tokenizer`);
    }
    return { isSentencepiece: !tokenizer.source && SENTENCEPIECE_TOKENIZER_TYPES.has(TOKENIZER_TYPE_KEYS[tokenizer.id]), instance };
}

/**
 * The token chunks for `ids` a local tokenizer gave for `text`, as its encode route shows them.
 * @param {{id: number, source?: string, name: string, model?: string}} tokenizer
 * @param {string} text
 * @param {number[]} ids
 * @param {LocalTokenizerOptions} [options]
 * @returns {Promise<string[]>}
 */
export async function getLocalEncodeChunks(tokenizer, text, ids, options = {}) {
    if (tokenizer.id === tokenizers.OPENAI || tokenizer.id === tokenizers.GPT2) {
        return getTiktokenChunks(getTiktokenFor(tokenizer), ids);
    }
    const { isSentencepiece, instance } = await getLocalInstance(tokenizer, options);
    return isSentencepiece ? instance.encodePieces(text) : await getWebTokenizersChunks(instance, ids);
}

/**
 * Decodes ids with a local tokenizer, as its decode route does. Throws when it fails to load.
 * @param {{id: number, source?: string, name: string, model?: string}} tokenizer
 * @param {number[]} ids
 * @param {LocalTokenizerOptions} [options]
 * @returns {Promise<{text: string, chunks?: string[]}>}
 */
export async function decodeWithLocalTokenizer(tokenizer, ids, options = {}) {
    if (tokenizer.id === tokenizers.OPENAI || tokenizer.id === tokenizers.GPT2) {
        return { text: new TextDecoder().decode(getTiktokenFor(tokenizer).decode(new Uint32Array(ids))) };
    }
    const { isSentencepiece, instance } = await getLocalInstance(tokenizer, options);
    if (isSentencepiece) {
        const chunks = await Promise.all(ids.map(id => instance.decodeIds([id])));
        return { text: chunks.join(''), chunks };
    }
    return { text: await instance.decode(new Int32Array(ids)), chunks: await getWebTokenizersChunks(instance, ids) };
}
