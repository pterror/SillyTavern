import fs from 'node:fs';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { DEFAULT_AVATAR_PATH } from './constants.js';
import { NO_CARD_DATA } from './character-import-error.js';

/**
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function noCardData(message) {
    return Object.assign(new Error(message), { code: NO_CARD_DATA });
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @returns {string}
 */
export function computeAvatarIdentityHashFromChunks(chunks) {
    const hash = crypto.createHash('sha256');
    for (const chunk of chunks) {
        if (chunk.name === 'IDAT') hash.update(chunk.data);
    }
    return hash.digest('hex');
}

const FRAME_CHUNKS = new Set(['acTL', 'fcTL', 'IDAT', 'fdAT']);

/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @returns {string | null}
 */
export function computeAnimatedHashFromChunks(chunks) {
    if (!chunks.some(c => c.name === 'acTL')) return null;
    const hash = crypto.createHash('sha256');
    for (const chunk of chunks) {
        if (!FRAME_CHUNKS.has(chunk.name)) continue;
        hash.update(chunk.name);
        hash.update(chunk.data);
    }
    return hash.digest('hex');
}

/**
 * @returns {string}
 */
export function computeDefaultAvatarIdentityHash() {
    if (defaultAvatarIdentityHashCache === null) {
        const buf = fs.readFileSync(DEFAULT_AVATAR_PATH);
        defaultAvatarIdentityHashCache = computeAvatarIdentityHashFromChunks(extract(new Uint8Array(buf)));
    }
    return defaultAvatarIdentityHashCache;
}
/** @type {string | null} */
let defaultAvatarIdentityHashCache = null;

/**
 * @param {Buffer} image
 * @returns {string}
 */
export function computeAvatarIdentityHashFromImageBuffer(image) {
    return computeAvatarIdentityHashFromChunks(extract(new Uint8Array(image)));
}

/**
 * Writes Character metadata to a PNG image buffer. Always writes a 'chara' chunk holding `data` verbatim,
 * and only that chunk.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @param {string} data
 * @returns {Array<{name: string, data: Uint8Array}>}
 */
function spliceCardDataIntoChunks(chunks, data) {
    removeCharaChunks(chunks);

    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    return chunks;
}

export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    spliceCardDataIntoChunks(chunks, data);
    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @returns {Array<{name: string, data: Uint8Array}>}
 */
function removeCharaChunks(chunks) {
    for (const chunk of chunks.filter(c => c.name === 'tEXt')) {
        const decoded = PNGtext.decode(chunk.data);
        if (decoded.keyword.toLowerCase() === 'chara' || decoded.keyword.toLowerCase() === 'ccv3') {
            chunks.splice(chunks.indexOf(chunk), 1);
        }
    }
    return chunks;
}

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(new Uint8Array(image));
    return readFromChunks(chunks);
};

/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @returns {string}
 */
export function readFromChunks(chunks) {
    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        throw noCardData('PNG metadata does not contain any text chunks.');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');

    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');

    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    throw noCardData('PNG metadata does not contain any character data.');
}

/**
 * @param {Buffer} image
 * @returns {string}
 */
/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @returns {string}
 */
export function readCharaChunkPristineFromChunks(chunks) {
    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        throw noCardData('PNG metadata does not contain any text chunks.');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');
    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    throw noCardData('PNG metadata does not contain any character data.');
}

export const readCharaChunkPristine = (image) => readCharaChunkPristineFromChunks(extract(new Uint8Array(image)));

/**
 * @param {string} cardUrl
 * @returns {Promise<string>}
 */
export const parsePristine = async (cardUrl) => {
    const buffer = await fs.promises.readFile(cardUrl);
    return readCharaChunkPristine(buffer);
};

/**
 * Parses a card image and returns the character metadata. Reads via fs.promises, not fs.readFileSync, so
 * batched Promise.all() callers actually overlap disk I/O instead of blocking one file at a time.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = await fs.promises.readFile(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};
