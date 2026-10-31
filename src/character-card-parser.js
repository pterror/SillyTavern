import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { loadReflinkModule } from './reflink-support.js';
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
 * @param {Buffer} image
 * @returns {Buffer}
 */
export function stripCardData(image) {
    const chunks = extract(new Uint8Array(image));
    removeCharaChunks(chunks);
    return Buffer.from(encode(chunks));
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

/**
 * @param {Buffer} srcBuf
 * @returns {number | null}
 */
export function findReflinkablePrefixOffset(srcBuf) {
    /** @type {Array<{name: string, data: Uint8Array}>} */
    let chunks;
    try {
        chunks = extract(new Uint8Array(srcBuf));
    } catch (error) {
        return null;
    }

    return findReflinkablePrefixOffsetFromChunks(chunks);
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @returns {number | null}
 */
function findReflinkablePrefixOffsetFromChunks(chunks) {
    if (chunks.length === 0 || chunks[chunks.length - 1].name !== 'IEND') {
        return null;
    }

    const removeIdxs = [];
    chunks.forEach((chunk, i) => {
        if (chunk.name === 'tEXt') {
            const decoded = PNGtext.decode(chunk.data);
            if (decoded.keyword.toLowerCase() === 'chara' || decoded.keyword.toLowerCase() === 'ccv3') {
                removeIdxs.push(i);
            }
        }
    });

    const lastIdx = chunks.length - 1;
    const sortedRemoveIdxs = [...removeIdxs].sort((a, b) => a - b);
    const contiguousTail = sortedRemoveIdxs.every((idx, k) => idx === lastIdx - sortedRemoveIdxs.length + k);
    if (!contiguousTail) {
        return null;
    }

    const keepCount = lastIdx - sortedRemoveIdxs.length;
    let offset = 8;
    for (let i = 0; i < keepCount; i++) {
        offset += 12 + chunks[i].data.length;
    }
    return offset;
}

/**
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {string} data
 * @param {string|null} [crossReflinkCandidatePath]
 * @returns {Promise<{reflinked: boolean, avatarIdentityHash: string}>}
 */
export async function writeCardToFile(sourcePath, destPath, data, crossReflinkCandidatePath = null) {
    const srcBuf = await fs.promises.readFile(sourcePath);

    const chunks = extract(new Uint8Array(srcBuf));
    return writeCardFromChunks(sourcePath, destPath, srcBuf, chunks, data, crossReflinkCandidatePath);
}

/**
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {Buffer} srcBuf
 * @param {Array<{name: string, data: Uint8Array}>} chunks
 * @param {string} data
 * @param {string|null} [crossReflinkCandidatePath]
 * @returns {Promise<{reflinked: boolean, avatarIdentityHash: string}>}
 */
export async function writeCardFromChunks(sourcePath, destPath, srcBuf, chunks, data, crossReflinkCandidatePath = null) {
    const avatarIdentityHash = computeAvatarIdentityHashFromChunks(chunks);

    const offset = findReflinkablePrefixOffsetFromChunks(chunks);
    spliceCardDataIntoChunks(chunks, data);
    const outputImage = Buffer.from(encode(chunks));

    if (crossReflinkCandidatePath && crossReflinkCandidatePath !== sourcePath) {
        try {
            const crossBuf = await fs.promises.readFile(crossReflinkCandidatePath);
            const crossOffset = findReflinkablePrefixOffset(crossBuf);
            const crossVerified = crossOffset !== null && crossOffset <= crossBuf.length && crossOffset <= outputImage.length
                && Buffer.compare(outputImage.subarray(0, crossOffset), crossBuf.subarray(0, crossOffset)) === 0;

            if (crossVerified) {
                await writeSharedPrefixThenAppend(crossReflinkCandidatePath, destPath, outputImage.subarray(crossOffset), crossOffset);
                return { reflinked: true, avatarIdentityHash };
            }
        } catch (error) {
            console.debug(`character-card-parser: cross-character reflink candidate ${crossReflinkCandidatePath} unusable for ${destPath}, falling back.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    const prefixVerified = offset !== null && offset <= srcBuf.length && offset <= outputImage.length
        && Buffer.compare(outputImage.subarray(0, offset), srcBuf.subarray(0, offset)) === 0;

    if (prefixVerified) {
        try {
            await writeSharedPrefixThenAppend(sourcePath, destPath, outputImage.subarray(offset), offset);
            return { reflinked: true, avatarIdentityHash };
        } catch (error) {
            console.debug(`character-card-parser: reflink-preserving write failed for ${sourcePath} -> ${destPath}, falling back to a full write.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    writeFileAtomicSync(destPath, outputImage);
    return { reflinked: false, avatarIdentityHash };
}

/**
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {Buffer|Uint8Array} tail
 * @param {number} offset
 * @returns {Promise<void>}
 */
async function writeSharedPrefixThenAppend(sourcePath, destPath, tail, offset) {
    const reflinkModule = await loadReflinkModule();
    if (!reflinkModule) {
        throw new Error('@reflink/reflink native binding is unavailable on this platform.');
    }

    const tempPath = `${destPath}.${crypto.randomUUID()}.tmp`;
    try {
        await reflinkModule.reflinkFile(sourcePath, tempPath);
        await fsPromises.truncate(tempPath, offset);
        await fsPromises.appendFile(tempPath, tail);

        try {
            const existingStat = await fsPromises.stat(destPath);
            await fsPromises.chmod(tempPath, existingStat.mode);
            if (process.getuid) {
                await fsPromises.chown(tempPath, existingStat.uid, existingStat.gid).catch(() => {});
            }
        } catch (error) {
            // destPath doesn't exist yet - nothing to preserve.
        }

        await fsPromises.rename(tempPath, destPath);
    } catch (error) {
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

/**
 * @param {string} existingPath
 * @param {string} sourcePath
 * @param {{skipByteVerification?: boolean, expectedAvatarHash?: string}} [options]
 * @returns {Promise<{reflinked: boolean, reason?: string}>}
 */
export async function reclaimReflinkPrefix(existingPath, sourcePath, { skipByteVerification = false, expectedAvatarHash } = {}) {
    const sourceBuf = await fs.promises.readFile(sourcePath);

    /** @type {Array<{name: string, data: Uint8Array}>} */
    let chunks;
    try {
        chunks = extract(new Uint8Array(sourceBuf));
    } catch (error) {
        return { reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' };
    }
    const offset = findReflinkablePrefixOffsetFromChunks(chunks);
    if (offset === null) {
        return { reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' };
    }

    if (expectedAvatarHash !== undefined && computeAvatarIdentityHashFromChunks(chunks) !== expectedAvatarHash) {
        return { reflinked: false, reason: 'avatar-hash-mismatch' };
    }

    /** @type {Buffer | Uint8Array} */
    let existingTail;
    if (skipByteVerification || expectedAvatarHash !== undefined) {
        const existingSize = (await fs.promises.stat(existingPath)).size;
        if (offset > existingSize) {
            return { reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' };
        }
        existingTail = Buffer.alloc(existingSize - offset);
        const handle = await fs.promises.open(existingPath, 'r');
        try {
            await handle.read(existingTail, 0, existingTail.length, offset);
        } finally {
            await handle.close();
        }
    } else {
        const existingBuf = await fs.promises.readFile(existingPath);
        const prefixVerified = offset <= existingBuf.length
            && Buffer.compare(existingBuf.subarray(0, offset), sourceBuf.subarray(0, offset)) === 0;
        if (!prefixVerified) {
            return { reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' };
        }
        existingTail = existingBuf.subarray(offset);
    }

    try {
        await writeSharedPrefixThenAppend(sourcePath, existingPath, existingTail, offset);
        return { reflinked: true };
    } catch (error) {
        console.debug(`character-card-parser: reclaimReflinkPrefix failed for ${existingPath} <- ${sourcePath}, leaving it untouched.`, /** @type {any} */ (error)?.message ?? error);
        return { reflinked: false, reason: 'reflink-failed' };
    }
}

