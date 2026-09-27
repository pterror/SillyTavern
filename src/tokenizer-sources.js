import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';
import { getConfigValue } from './util.js';

/**
 * @typedef {'hf-json' | 'sentencepiece' | 'tekken' | 'tiktoken'} TokenizerFileFormat
 */

/**
 * One place a registry entry's file can be downloaded from, pinned to a commit.
 * @typedef {object} TokenizerSource
 * @property {string} repo Hugging Face repo, `owner/name`
 * @property {string} revision Full 40-hex commit sha
 * @property {string} path File path inside the repo at that revision
 * @property {boolean} gated Whether the repo is gated. Only the model's own (official) repo can be.
 */

/**
 * One official tokenizer file. Every source of an entry serves the same bytes.
 * @typedef {object} TokenizerSourceEntry
 * @property {string} id
 * @property {string} family
 * @property {TokenizerFileFormat} format
 * @property {string} sha256 64-hex sha256 of the file
 * @property {number} bytes File size in bytes
 * @property {string} license License name
 * @property {string} licenseUrl
 * @property {readonly TokenizerSource[]} sources Tried in order: the model's own repo first, then verified byte-identical copies
 * @property {import('./tokenizer-loader.js').TiktokenConfig} [tiktoken] For the `tiktoken` format: how the repo's own code builds its encoding
 */

/**
 * The pinned tokenizer registry. A fixed list in code: disk and memory are bounded by it, not by user data.
 * @type {readonly TokenizerSourceEntry[]}
 */
export const TOKENIZER_SOURCES = Object.freeze([
    {
        id: 'qwen3',
        family: 'Qwen3',
        format: 'hf-json',
        sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
        bytes: 11422654,
        license: 'Apache-2.0',
        licenseUrl: 'https://huggingface.co/Qwen/Qwen3-8B/blob/b968826d9c46dd6066d109eabc6255188de91218/LICENSE',
        sources: [
            { repo: 'Qwen/Qwen3-8B', revision: 'b968826d9c46dd6066d109eabc6255188de91218', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'llama3.1',
        family: 'Llama 3.1',
        format: 'hf-json',
        sha256: '79e3e522635f3171300913bb421464a87de6222182a0570b9b2ccba2a964b2b4',
        bytes: 9085657,
        license: 'Llama 3.1 Community License',
        licenseUrl: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/blob/0e9e39f249a16976918f6564b8830bc894c89659/LICENSE',
        sources: [
            { repo: 'meta-llama/Llama-3.1-8B-Instruct', revision: '0e9e39f249a16976918f6564b8830bc894c89659', path: 'tokenizer.json', gated: true },
            { repo: 'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', revision: '031d4042f36adc1a52cca51b331d25cbe3cf1022', path: 'tokenizer.json', gated: false },
            { repo: 'NousResearch/Meta-Llama-3.1-8B-Instruct', revision: 'd10aef7999a2b5ba950ab3974312feeedbfe0b77', path: 'tokenizer.json', gated: false },
        ],
    },
    {
        id: 'nemo-tekken',
        family: 'Mistral Nemo',
        format: 'tekken',
        sha256: 'eccd1665d2e477697c33cb7f0daa6f6dfefc57a0a6bceb66d4be52952f827516',
        bytes: 14801223,
        license: 'Apache-2.0',
        // The pinned revision has no LICENSE file; its model card declares apache-2.0.
        licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        sources: [
            { repo: 'mistralai/Mistral-Nemo-Instruct-2407', revision: '04d8a90549d23fc6bd7f642064003592df51e9b3', path: 'tekken.json', gated: false },
        ],
    },
    {
        id: 'kimi',
        family: 'Kimi K2',
        format: 'tiktoken',
        sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103',
        bytes: 2795286,
        license: 'Modified MIT',
        licenseUrl: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/fd1984e2b7a3350dbf7305fe73a4ede25c14de50/LICENSE',
        sources: [
            { repo: 'moonshotai/Kimi-K2-Instruct', revision: 'fd1984e2b7a3350dbf7305fe73a4ede25c14de50', path: 'tiktoken.model', gated: false },
        ],
        // tokenization_kimi.py and tokenizer_config.json at the same revision.
        tiktoken: {
            patStr: [
                String.raw`[\p{Han}]+`,
                String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
                String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
                String.raw`\p{N}{1,3}`,
                String.raw` ?[^\s\p{L}\p{N}]+[\r\n]*`,
                String.raw`\s*[\r\n]+`,
                String.raw`\s+(?!\S)`,
                String.raw`\s+`,
            ].join('|'),
            specialTokens: {
                '[BOS]': 163584,
                '[EOS]': 163585,
                '<|im_end|>': 163586,
                '<|im_user|>': 163587,
                '<|im_assistant|>': 163588,
                '<|start_header_id|>': 163590,
                '<|end_header_id|>': 163591,
                '[EOT]': 163593,
                '<|im_system|>': 163594,
                '<|tool_calls_section_begin|>': 163595,
                '<|tool_calls_section_end|>': 163596,
                '<|tool_call_begin|>': 163597,
                '<|tool_call_argument_begin|>': 163598,
                '<|tool_call_end|>': 163599,
                '<|im_middle|>': 163601,
                '[UNK]': 163838,
                '[PAD]': 163839,
            },
            reservedSpecialTokens: { start: 163584, count: 256, name: '<|reserved_token_{id}|>' },
            allowedSpecial: 'all',
            split: { maxChars: 400000, maxRun: 25000 },
        },
    },
]);

/**
 * @param {string} id
 * @param {readonly TokenizerSourceEntry[]} [registry]
 * @returns {TokenizerSourceEntry|undefined}
 */
export function findTokenizerSource(id, registry = TOKENIZER_SOURCES) {
    return registry.find(entry => entry.id === id);
}

/**
 * The name an entry's tokenizer is shown under, also its Advanced Formatting → Tokenizer option.
 * @param {TokenizerSourceEntry} entry
 * @returns {string}
 */
export function getTokenizerDisplayName(entry) {
    return `${entry.family} (official)`;
}

/**
 * Cache file extension per format. The sha256 is the file's identity and the format decides its
 * loader, so one sha256 always gets one name, whatever path it came from.
 * @type {Readonly<Record<TokenizerFileFormat, string>>}
 */
export const CACHE_EXTENSIONS = Object.freeze({
    'hf-json': '.json',
    'tekken': '.json',
    'sentencepiece': '.model',
    'tiktoken': '.tiktoken',
});

export const DOWNLOAD_RETRY_MS = 60_000;

const IS_DOWNLOAD_ALLOWED = getConfigValue('enableDownloadableTokenizers', true, 'boolean');

/**
 * URL -> `performance.now()` of its last failed download. Monotonic, so a wall-clock change
 * can't stretch or skip the wait. Shared by every tokenizer download.
 * @type {Map<string, number>}
 */
const failedDownloads = new Map();

/**
 * Whether a download from this URL failed less than {@link DOWNLOAD_RETRY_MS} ago.
 * @param {string} url
 * @returns {boolean}
 */
export function isDownloadBackedOff(url) {
    const failedAt = failedDownloads.get(url);
    return failedAt !== undefined && performance.now() - failedAt < DOWNLOAD_RETRY_MS;
}

/**
 * Records a failed download from this URL.
 * @param {string} url
 */
export function recordDownloadFailure(url) {
    failedDownloads.set(url, performance.now());
}

/**
 * Forgets a failed download from this URL after a successful one.
 * @param {string} url
 */
export function clearDownloadFailure(url) {
    failedDownloads.delete(url);
}

/**
 * @param {TokenizerSource} source
 * @returns {string}
 */
export function getSourceUrl(source) {
    return `https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.path}`;
}

/**
 * @param {TokenizerSourceEntry} entry
 * @returns {string} The entry's cache file name, `<sha256>.<ext>`
 */
export function getCacheFileName(entry) {
    const extension = CACHE_EXTENSIONS[entry.format];
    if (!extension) {
        throw new Error(`Unknown tokenizer file format: ${entry.format}`);
    }
    return `${entry.sha256.toLowerCase()}${extension}`;
}

/**
 * sha256 -> the download in flight for it, so parallel calls share one fetch.
 * @type {Map<string, Promise<string>>}
 */
const inFlight = new Map();

/**
 * Reads a response body, failing once it grows past `maxBytes`.
 * @param {any} body
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readCappedBody(body, maxBytes) {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw new Error(`The body is larger than the expected ${maxBytes} bytes`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
}

/**
 * Downloads one source and checks it against the entry's size and sha256.
 * @param {TokenizerSourceEntry} entry
 * @param {TokenizerSource} source
 * @param {string} hfToken The user's saved Hugging Face token, or ''
 * @returns {Promise<Buffer>}
 */
async function downloadSource(entry, source, hfToken) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (source.gated) {
        headers.Authorization = `Bearer ${hfToken}`;
    }
    const response = await fetch(getSourceUrl(source), { headers });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    const body = await readCappedBody(response.body, entry.bytes);
    if (body.length !== entry.bytes) {
        throw new Error(`Expected ${entry.bytes} bytes, got ${body.length}`);
    }
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (sha256 !== entry.sha256.toLowerCase()) {
        throw new Error(`Expected sha256 ${entry.sha256}, got ${sha256}`);
    }
    return body;
}

/**
 * Tries the entry's sources in order and writes the first verified body to the cache.
 * @param {TokenizerSourceEntry} entry
 * @param {string} cachedFile
 * @param {string} hfToken
 * @returns {Promise<string>} The cached file's path
 */
async function downloadEntry(entry, cachedFile, hfToken) {
    /** @type {string[]} */
    const reasons = [];
    for (const source of entry.sources) {
        const url = getSourceUrl(source);
        if (source.gated && !hfToken) {
            reasons.push(`${url}: gated, no Hugging Face token saved`);
            continue;
        }
        if (isDownloadBackedOff(url)) {
            reasons.push(`${url}: the last download failed less than ${DOWNLOAD_RETRY_MS / 1000} s ago`);
            continue;
        }
        try {
            console.info('Downloading tokenizer file:', url);
            const body = await downloadSource(entry, source, hfToken);
            writeFileAtomicSync(cachedFile, body);
            clearDownloadFailure(url);
            console.info(`Downloaded the ${entry.family} tokenizer. License: ${entry.license}`);
            return cachedFile;
        } catch (error) {
            recordDownloadFailure(url);
            reasons.push(`${url}: ${error.message}`);
        }
    }
    throw new Error(`Could not download the ${entry.family} tokenizer (${entry.id}). ${reasons.join('; ')}`);
}

/**
 * Gets a registry entry's file from the cache, downloading it from its pinned sources when absent.
 * @param {TokenizerSourceEntry} entry Registry entry
 * @param {import('./users.js').UserDirectoryList} [directories] The requesting user's directories, for their saved Hugging Face token
 * @returns {Promise<{ path: string, downloaded: boolean, license: string }>} `downloaded` is true only for the call that fetched the file
 */
export async function getPinnedTokenizerFile(entry, directories) {
    const cacheDir = path.join(globalThis.DATA_ROOT, '_cache');
    const cachedFile = path.join(cacheDir, getCacheFileName(entry));
    if (fs.existsSync(cachedFile)) {
        return { path: cachedFile, downloaded: false, license: entry.license };
    }

    const sha256 = entry.sha256.toLowerCase();
    const pending = inFlight.get(sha256);
    if (pending) {
        return { path: await pending, downloaded: false, license: entry.license };
    }

    if (!IS_DOWNLOAD_ALLOWED) {
        throw new Error('Downloading tokenizers is disabled, the file is not cached');
    }

    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const hfToken = directories ? readSecret(directories, SECRET_KEYS.HUGGINGFACE) : '';
    const download = downloadEntry(entry, cachedFile, hfToken);
    inFlight.set(sha256, download);
    try {
        return { path: await download, downloaded: true, license: entry.license };
    } finally {
        inFlight.delete(sha256);
    }
}
