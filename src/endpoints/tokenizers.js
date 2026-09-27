import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { Tokenizer } from '@agnai/web-tokenizers';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';
import tiktoken from 'tiktoken';

import { TEXTGEN_TYPES } from '../constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from '../tokenizer-ids.js';
import { resolveChatCompletionTokenizer, describeMapEntry, localResolution } from '../tokenizer-map-resolution.js';
import { setAdditionalHeaders } from '../additional-headers.js';
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
 * @param {string|undefined} fallbackModel Fallback model path
 * @returns {Promise<string>} Path to the tokenizer model
 */
async function getPathToTokenizer(model, fallbackModel) {
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

        console.info('Downloading tokenizer model:', model);
        const response = await fetch(model);
        if (!response.ok) {
            throw new Error(`Failed to fetch the model: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (isCompressed) {
            const decompressedBuffer = await gunzip(arrayBuffer);
            writeFileAtomicSync(uncompressedPath, decompressedBuffer);
            return uncompressedPath;
        }

        writeFileAtomicSync(cachedFile, Buffer.from(arrayBuffer));
        return cachedFile;
    } catch (error) {
        const getLastSegment = str => str?.split('/')?.pop() || '';
        if (fallbackModel) {
            console.error(`Could not get a tokenizer from ${getLastSegment(model)}. Reason: ${error.message}. Using a fallback model: ${getLastSegment(fallbackModel)}.`);
            return fallbackModel;
        }

        throw new Error(`Failed to instantiate a tokenizer and fallback is not provided. Reason: ${error.message}`);
    }
}

/**
 * Sentencepiece tokenizer for tokenizing text.
 */
class SentencePieceTokenizer {
    /**
     * @type {import('@agnai/sentencepiece-js').SentencePieceProcessor} Sentencepiece tokenizer instance
     */
    #instance;
    /**
     * @type {string} Path to the tokenizer model
     */
    #model;
    /**
     * @type {string|undefined} Path to the fallback model
     */
    #fallbackModel;
    /**
     * @type {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>|null}
     */
    #loadPromise;

    /**
     * Creates a new Sentencepiece tokenizer.
     * @param {string} model Path to the tokenizer model
     * @param {string} [fallbackModel] Path to the fallback model
     */
    constructor(model, fallbackModel) {
        this.#model = model;
        this.#fallbackModel = fallbackModel;
    }

    /**
     * Gets the Sentencepiece tokenizer instance.
     * @returns {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>} Sentencepiece tokenizer instance
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
     * Loads the Sentencepiece tokenizer instance.
     * @returns {Promise<import('@agnai/sentencepiece-js').SentencePieceProcessor|null>} Sentencepiece tokenizer instance
     */
    async #load() {
        try {
            const pathToModel = await getPathToTokenizer(this.#model, this.#fallbackModel);
            const instance = new SentencePieceProcessor();
            await instance.load(pathToModel);
            console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
            this.#instance = instance;
            return this.#instance;
        } catch (error) {
            console.error('Sentencepiece tokenizer failed to load: ' + this.#model, error);
            return null;
        } finally {
            this.#loadPromise = null;
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
     * @type {string|undefined} Path to the fallback model
     */
    #fallbackModel;

    /**
     * Creates a new Web tokenizer.
     * @param {string} model Path to the tokenizer model
     * @param {string} [fallbackModel] Path to the fallback model
     */
    constructor(model, fallbackModel) {
        this.#model = model;
        this.#fallbackModel = fallbackModel;
    }

    /**
     * Gets the Web tokenizer instance.
     * @returns {Promise<Tokenizer|null>} Web tokenizer instance
     */
    async get() {
        if (this.#instance) {
            return this.#instance;
        }

        try {
            const pathToModel = await getPathToTokenizer(this.#model, this.#fallbackModel);
            const fileBuffer = await fs.promises.readFile(pathToModel);
            this.#instance = await Tokenizer.fromJSON(fileBuffer);
            console.info('Instantiated the tokenizer for', path.parse(pathToModel).name);
            return this.#instance;
        } catch (error) {
            console.error('Web tokenizer failed to load: ' + this.#model, error);
            return null;
        }
    }
}

const spp_llama = new SentencePieceTokenizer('src/tokenizers/llama.model');
const spp_nerd = new SentencePieceTokenizer('src/tokenizers/nerdstash.model');
const spp_nerd_v2 = new SentencePieceTokenizer('src/tokenizers/nerdstash_v2.model');
const spp_mistral = new SentencePieceTokenizer('src/tokenizers/mistral.model');
const spp_yi = new SentencePieceTokenizer('src/tokenizers/yi.model');
const spp_gemma = new SentencePieceTokenizer('src/tokenizers/gemma.model');
const spp_jamba = new SentencePieceTokenizer('src/tokenizers/jamba.model');
const claude_tokenizer = new WebTokenizer('src/tokenizers/claude.json');
const llama3_tokenizer = new WebTokenizer('src/tokenizers/llama3.json');
const commandRTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-r.json.gz', 'src/tokenizers/llama3.json');
const commandATokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-a.json.gz', 'src/tokenizers/llama3.json');
const qwen2Tokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz', 'src/tokenizers/llama3.json');
const nemoTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/nemo.json.gz', 'src/tokenizers/llama3.json');
const deepseekTokenizer = new WebTokenizer('https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/deepseek.json.gz', 'src/tokenizers/llama3.json');

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
 * @returns { Promise<{ids: number[], count: number}> } Tokenization result
 */
async function countSentencepieceTokens(tokenizer, text) {
    const instance = await tokenizer?.get();

    // Fallback to strlen estimation
    if (!instance) {
        return {
            ids: [],
            count: guesstimate(text),
        };
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
 * @param {Tokenizer} tokenizer Web tokenizer instance
 * @param {number[]} ids Token IDs
 * @returns {string[]} Token chunks
 */
function getWebTokenizersChunks(tokenizer, ids) {
    const chunks = [];

    for (let i = 0, lastProcessed = 0; i < ids.length; i++) {
        const chunkIds = ids.slice(lastProcessed, i + 1);
        const chunkText = tokenizer.decode(new Int32Array(chunkIds));
        if (chunkText === '�') {
            continue;
        }
        chunks.push(chunkText);
        lastProcessed = i + 1;
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
 * @param {((text: string) => Uint32Array)|null} encode Function to encode text to token ids; null
 * when there is no tokenizer.
 * @returns {Uint32Array|null} Array of token ids; null when the entry needs a tokenizer and there is none.
 */
function getEntryTokens(text, encode) {
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
    return encode ? encode(text) : null;
}

/**
 * An encoder for a local resolveTokenizer() answer, or null when its tokenizer fails to load.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @returns {Promise<((text: string) => Uint32Array)|null>}
 */
async function getLocalEncoder(resolved) {
    if (resolved.id === tokenizers.OPENAI) {
        const tokenizer = getTiktokenTokenizer(resolved.model);
        return tokenizer.encode.bind(tokenizer);
    }
    const key = TOKENIZER_TYPE_KEYS[resolved.id];
    const instance = await LOCAL_TOKENIZER_INSTANCES[key]?.get();
    if (!instance) {
        return null;
    }
    if (sentencepieceTokenizers.includes(key)) {
        return (text) => new Uint32Array(instance.encodeIds(text));
    }
    return (text) => new Uint32Array(instance.encode(text));
}

/**
 * Computes a token-id-keyed logit bias map from bias-preset entries for a server-built
 * chat-completion send, with the model's chat-completion tokenizer resolution (the model map).
 * Claude models get {} (no bias support), as does a tokenizer that fails to load. With no tokenizer
 * for the model, raw-id entries are kept and every other entry is left out and listed in `dropped`.
 * Entries without `text` are skipped, and an encode failure is warned about, not thrown.
 *
 * @param {{text?: string, value?: number}[]} biasPresetEntries Raw bias-preset entries, e.g.
 * oai_settings.bias_presets[oai_settings.bias_preset_selected] client-side - {id, text, value}[]
 * shaped, though only `text`/`value` are used here.
 * @param {string} requestModel The chat-completion model name.
 * @param {string[]} [dropped] Receives the text of each entry left out because there is no tokenizer.
 * @returns {Promise<{[tokenId: number]: number}>} Token-id-keyed bias map
 */
export async function computeLogitBias(biasPresetEntries, requestModel, dropped = undefined) {
    const result = {};

    if (!Array.isArray(biasPresetEntries)) {
        return result;
    }

    const modelName = String(requestModel || '');

    // no bias for claude
    if (modelName.toLowerCase().includes('claude')) {
        return result;
    }

    const resolved = resolveChatCompletionTokenizer(modelName);
    let encodeFunction = null;
    if (resolved.kind !== 'estimate') {
        encodeFunction = await getLocalEncoder(resolved);
        if (!encodeFunction) {
            console.error('Tokenizer not initialized:', resolved.name);
            return {};
        }
    }

    for (const entry of biasPresetEntries) {
        if (!entry || !entry.text) {
            continue;
        }

        try {
            const tokens = getEntryTokens(entry.text, encodeFunction);

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
 * The `/api/backends/chat-completions/bias` route's encoding: the tokenizer upstream picks from the
 * model name with getTokenizerModel(), and the same result for the same input. It stays until the
 * route and its browser caller change together.
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
        const tokenizer = getWebTokenizer(model);
        const instance = await tokenizer?.get();
        if (!instance) {
            console.warn('Tokenizer not initialized:', model);
            return {};
        }
        encodeFunction = (text) => new Uint32Array(instance.encode(text));
    } else {
        const tokenizer = getTiktokenTokenizer(model);
        encodeFunction = (tokenizer.encode.bind(tokenizer));
    }

    for (const entry of biasPresetEntries) {
        if (!entry || !entry.text) {
            continue;
        }

        try {
            const tokens = getEntryTokens(entry.text, encodeFunction);

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
 * @param {WebTokenizer} tokenizer WebTokenizer instance
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
            if (!instance) throw new Error('Failed to load the Web tokenizer');
            const tokens = Array.from(instance.encode(text));
            const chunks = getWebTokenizersChunks(instance, tokens);
            return response.send({ ids: tokens, count: tokens.length, chunks });
        } catch (error) {
            console.error(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding WebTokenizer tokens.
 * @param {WebTokenizer} tokenizer WebTokenizer instance
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
            const chunks = getWebTokenizersChunks(instance, ids);
            const text = instance.decode(new Int32Array(ids));
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
        const tokenizer = LOCAL_TOKENIZER_INSTANCES[tokenizerType];
        const instance = await tokenizer?.get();
        if (!instance) throw new Error(`Failed to load the Web tokenizer for type: ${tokenizerType}`);
        return Array.from(instance.encode(text ?? ''));
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
router.post('/llama3/encode', createWebTokenizerEncodingHandler(llama3_tokenizer));
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
router.post('/llama3/decode', createWebTokenizerDecodingHandler(llama3_tokenizer));
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
 * @returns {Promise<number>}
 */
export async function countChatCompletionMessages(resolved, messages) {
    try {
        if (resolved.kind === 'estimate') {
            return guesstimate(JSON.stringify(messages));
        }
        if (resolved.id === tokenizers.OPENAI) {
            return countTiktokenMessages(resolved.model, messages);
        }
        const key = TOKENIZER_TYPE_KEYS[resolved.id];
        if (sentencepieceTokenizers.includes(key)) {
            return await countSentencepieceArrayTokens(LOCAL_TOKENIZER_INSTANCES[key], messages);
        }
        const instance = await LOCAL_TOKENIZER_INSTANCES[key]?.get();
        if (!instance) throw new Error(`Failed to load the ${resolved.name} tokenizer`);
        return countWebTokenizerTokens(instance, messages);
    } catch (error) {
        console.error('An error counting tokens, using fallback estimation method', error);
        return guesstimate(JSON.stringify(messages));
    }
}

/**
 * The encode or decode handler for a local chat-completion resolveTokenizer() answer.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @param {'encode'|'decode'} direction
 * @returns {TokenizationHandler}
 */
function chatCompletionTokenizerHandler(resolved, direction) {
    const encode = direction === 'encode';
    if (resolved.id === tokenizers.OPENAI) {
        return encode ? createTiktokenEncodingHandler(resolved.model) : createTiktokenDecodingHandler(resolved.model);
    }
    const key = TOKENIZER_TYPE_KEYS[resolved.id];
    const instance = LOCAL_TOKENIZER_INSTANCES[key];
    if (sentencepieceTokenizers.includes(key)) {
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
 * The tokenizer for an `/openai/*` route's `?model=`: the named tokenizer, else the model map.
 * @param {string} queryModel
 * @returns {import('../tokenizer-resolve.js').ResolvedTokenizer}
 */
function resolveOpenAIRouteModel(queryModel) {
    const named = OPENAI_ROUTE_NAMED_TOKENIZERS.find(id => TOKENIZER_TYPE_KEYS[id] === queryModel);
    return named === undefined
        ? resolveChatCompletionTokenizer(queryModel)
        : localResolution(describeMapEntry(named, 'openai'), null);
}

router.post('/openai/encode', async function (req, res) {
    try {
        if (!req.body) return res.sendStatus(400);

        const resolved = resolveOpenAIRouteModel(String(req.query.model || ''));
        if (resolved.kind === 'estimate') {
            return res.send({ ids: [], count: guesstimate(String(req.body.text || '')), chunks: [] });
        }
        return chatCompletionTokenizerHandler(resolved, 'encode')(req, res);
    } catch (error) {
        console.error(error);
        return res.send({ ids: [], count: 0, chunks: [] });
    }
});

router.post('/openai/decode', async function (req, res) {
    try {
        if (!req.body) return res.sendStatus(400);

        const resolved = resolveOpenAIRouteModel(String(req.query.model || ''));
        if (resolved.kind === 'estimate') {
            return res.send({ text: '' });
        }
        return chatCompletionTokenizerHandler(resolved, 'decode')(req, res);
    } catch (error) {
        console.error(error);
        return res.send({ text: '' });
    }
});

router.post('/openai/count', async function (req, res) {
    if (!req.body) return res.sendStatus(400);

    const resolved = resolveOpenAIRouteModel(String(req.query.model || ''));
    const num_tokens = await countChatCompletionMessages(resolved, req.body);
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
 * @returns {Promise<{count: number, ids: number[]}|{error: true}>}
 */
export async function encodeViaTextgenAPI(request, text, baseUrl, model, apiType) {
    try {
        const args = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        };

        setAdditionalHeaders(request, args, baseUrl);

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
                args.body = JSON.stringify({ 'model': model, 'content': text });
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
