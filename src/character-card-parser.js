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

/**
 * sha256 over a PNG's concatenated IDAT chunk payload bytes (still-compressed pixel stream), not a decode-to-
 * pixels hash — cheap, and stable across encoder-side changes that touch other chunks but not IDAT. Not immune
 * to a re-encode that picks different zlib settings for identical pixels.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only).
 * @returns {string} sha256 hex digest
 */
export function computeAvatarIdentityHashFromChunks(chunks) {
    const hash = crypto.createHash('sha256');
    for (const chunk of chunks) {
        if (chunk.name === 'IDAT') hash.update(chunk.data);
    }
    return hash.digest('hex');
}

/**
 * computeAvatarIdentityHashFromChunks() for the bundled default avatar (constants.js's DEFAULT_AVATAR_PATH).
 * Cached forever — the asset never changes at runtime.
 * @returns {string} sha256 hex digest
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
 * computeAvatarIdentityHashFromChunks() for a PNG buffer with no pre-extracted chunk list (e.g. a Buffer
 * upload, or a crop that changed pixels).
 * @param {Buffer} image
 * @returns {string} sha256 hex digest
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
 * The chunk-list-manipulation half of write() — factored out so a caller that already extracted `image`'s
 * chunks (writeCardToFile()) can reuse them instead of extracting twice.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list, mutated in place.
 * @param {string} data Character data to write (same contract as write()).
 * @returns {Array<{name: string, data: Uint8Array}>} `chunks`, mutated: existing chara/ccv3 tEXt chunks
 * removed, a fresh 'chara' chunk inserted immediately before IEND.
 */
function spliceCardDataIntoChunks(chunks, data) {
    removeCharaChunks(chunks);

    // Add the chara chunk before IEND, holding `data` as-is.
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
 * Removes any 'chara'/'ccv3' tEXt chunks in place, leaving the pure image chunks with no embedded character
 * data. Shared by stripCardData() and writeImageOnlyCard() below.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Mutated in place.
 * @returns {Array<{name: string, data: Uint8Array}>} `chunks`
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
 * @returns {Buffer} `image` with any embedded chara/ccv3 tEXt chunk removed - pure image bytes.
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
 * The chunk-list half of read() above — for a caller that already extracted `image`'s chunks.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only).
 * @returns {string} Character data, same ccv3-preferring contract as read().
 */
export function readFromChunks(chunks) {
    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');

    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');

    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
}

/**
 * Reads ONLY the 'chara' tEXt chunk, verbatim - never falls through to 'ccv3' the way read() prefers to.
 * Recovers pre-v3-bump original content for cards written by the old write() that force-upgraded every card
 * to a v3-bumped 'ccv3' chunk while leaving the unmutated original in 'chara'.
 *
 * Falls back to whatever other tEXt chunk exists if 'chara' itself is absent (e.g. a foreign-tool-written file).
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data, exactly as written into 'chara' (or the best available fallback chunk).
 */
/**
 * The chunk-list half of readCharaChunkPristine() below.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only).
 * @returns {string} Character data, same contract as readCharaChunkPristine().
 */
export function readCharaChunkPristineFromChunks(chunks) {
    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');
    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
}

export const readCharaChunkPristine = (image) => readCharaChunkPristineFromChunks(extract(new Uint8Array(image)));

/**
 * Promise-based counterpart to parse(), returning the PRISTINE 'chara' chunk content (see
 * readCharaChunkPristine()) rather than read()'s ccv3-preferring result.
 * @param {string} cardUrl Path to the card image
 * @returns {Promise<string>} Character data, pristine (see readCharaChunkPristine())
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
 * Finds the byte offset in `srcBuf` up to which `write()`'s output is guaranteed byte-identical to `srcBuf`,
 * so a caller can reflink just that prefix instead of copying the whole file.
 *
 * Only holds when the chara/ccv3 chunks write() removes form one contiguous run immediately before IEND with
 * nothing surviving after them (e.g. a foreign tool could place a chara chunk before IDAT, which would shift
 * every following byte). Returns `null` when that condition doesn't hold — caller must fall back to a full write.
 * @param {Buffer} srcBuf The source PNG buffer to inspect.
 * @returns {number | null} Shared-prefix byte offset, or `null` if the layout is ineligible.
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
 * The chunk-list half of findReflinkablePrefixOffset() above, for a caller that already extracted the chunks.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only).
 * @returns {number | null} Same contract as findReflinkablePrefixOffset().
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

    const lastIdx = chunks.length - 1; // IEND's index
    const sortedRemoveIdxs = [...removeIdxs].sort((a, b) => a - b);
    const contiguousTail = sortedRemoveIdxs.every((idx, k) => idx === lastIdx - sortedRemoveIdxs.length + k);
    if (!contiguousTail) {
        return null;
    }

    const keepCount = lastIdx - sortedRemoveIdxs.length; // chunks strictly before the removed run (or before IEND, if nothing's removed)
    let offset = 8; // PNG signature
    for (let i = 0; i < keepCount; i++) {
        offset += 12 + chunks[i].data.length; // 4-byte length + 4-byte type + data + 4-byte CRC
    }
    return offset;
}

/**
 * Writes character metadata into a PNG file on disk, preserving btrfs/XFS reflink extent-sharing with
 * `sourcePath` for the untouched image bytes whenever the layout allows it (findReflinkablePrefixOffset()),
 * instead of always paying a full-file rewrite for a change that typically only touches a few KB of metadata.
 *
 * Strategy, cheapest first: compute the rewritten buffer via write(); if a safe prefix is found and verified
 * byte-identical, reflink-clone `sourcePath`, truncate to the shared prefix, append the changed tail, and
 * atomically rename over `destPath`; otherwise fall back to a full write-file-atomic write.
 * @param {string} sourcePath Absolute path to the source PNG already on disk.
 * @param {string} destPath Absolute path to write the result to. May already exist.
 * @param {string} data Character data to embed (same contract as write()).
 * @param {string|null} [crossReflinkCandidatePath] Absolute path to a different character's current file that
 * might share content with this write (verified before being trusted — see writeCardFromChunks()).
 * @returns {Promise<{reflinked: boolean, avatarIdentityHash: string}>}
 */
export async function writeCardToFile(sourcePath, destPath, data, crossReflinkCandidatePath = null) {
    const srcBuf = await fs.promises.readFile(sourcePath);

    // Extract once and reuse for both the rewritten-buffer build and the reflinkable-prefix computation.
    const chunks = extract(new Uint8Array(srcBuf));
    return writeCardFromChunks(sourcePath, destPath, srcBuf, chunks, data, crossReflinkCandidatePath);
}

/**
 * The core of writeCardToFile() above, factored out to accept an already-extracted chunk list and buffer for
 * a caller that extracted them for another reason already.
 *
 * `crossReflinkCandidatePath`, if given, is tried before `sourcePath`: a successful cross-character reflink is
 * the only outcome that actually converges two independently-stored files onto shared extents. Content-identity
 * hash alone says nothing about whether the candidate's avatar image bytes match this write's — two characters
 * can share identical JSON with different portraits — so the candidate is byte-verified against its own current
 * on-disk bytes before ever being trusted; on failure this silently falls through to the ordinary path.
 *
 * Both `sourcePath` and any `crossReflinkCandidatePath` are only ever reflinked FROM, never opened for writing.
 * @param {string} sourcePath Absolute path to the PNG `chunks`/`srcBuf` were extracted from.
 * @param {string} destPath Absolute path to write the result to. May already exist.
 * @param {Buffer} srcBuf The exact bytes `chunks` was extracted from.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list for `srcBuf`, mutated
 * in place by spliceCardDataIntoChunks().
 * @param {string} data Character data to embed (same contract as write()).
 * @param {string|null} [crossReflinkCandidatePath] Absolute path to a different character's current file that
 * might carry the same content as this write.
 * @returns {Promise<{reflinked: boolean, avatarIdentityHash: string}>}
 */
export async function writeCardFromChunks(sourcePath, destPath, srcBuf, chunks, data, crossReflinkCandidatePath = null) {
    // Must be computed before spliceCardDataIntoChunks() mutates `chunks` below; spliceCardDataIntoChunks()
    // only touches tEXt chunks, so IDAT (and this hash) is unaffected by which write branch ends up taken.
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
 * The reflink-preserving fast path's actual write. Reflinks `sourcePath` into a same-directory temp file (so
 * the closing rename is same-filesystem-atomic), truncates to the shared prefix, appends the changed tail,
 * matches an existing `destPath`'s mode/uid/gid, then renames over `destPath`. On failure, cleans up the temp
 * file and rethrows — `destPath` itself is never touched until the final atomic rename.
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {Buffer|Uint8Array} tail Bytes to append after truncating the reflinked clone to `offset`.
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

        // Mirror write-file-atomic's own behavior of preserving an existing target's mode/uid/gid.
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
 * Retroactively reclaims reflink extent-sharing for a character file already fully written out (independent
 * bytes, no sharing) before writeCardToFile() existed.
 *
 * The caller is expected to have already matched `existingPath`/`sourcePath` some way; this function does the
 * verification of whether that match is safe to act on before touching anything, one of two ways - see
 * `options`.
 * @param {string} existingPath Absolute path to the already-imported character file to repair in place.
 * @param {string} sourcePath Absolute path to the believed-original source file, still on disk.
 * @param {{skipByteVerification?: boolean, expectedAvatarHash?: string}} [options] At most one of the two.
 * `skipByteVerification`: the caller's own match key already guarantees prefix identity (e.g. an IDAT-only hash
 * where the prefix is IDAT-only too), so skip both reading `existingPath`'s prefix bytes and comparing them -
 * only its tail (past the shared prefix) is read, since that's the only part of `existingPath` this function
 * ever uses. `expectedAvatarHash`: the caller's match isn't independently verified yet (e.g. a provenance
 * record, not a content match) - checked here against `sourcePath`'s own IDAT hash, computed from the same
 * chunk list already extracted to find the prefix offset (no extra read), and treated as `skipByteVerification`
 * on a match; declines immediately on a mismatch, without ever reading `existingPath`. Neither option: full
 * read-and-compare of both files' prefix bytes, for a match with no independent verification at all.
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

// PNG's IEND chunk always has zero-length data, so its bytes (4-byte length + 4-byte type + 4-byte CRC) are
// a fixed constant, independent of any character - never per-import content.
const IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Writes `destPath` as a pure image copy of `sourcePath`: any embedded chara/ccv3 tEXt chunk is dropped, and
 * nothing character-derived is written in its place. Reflinks the shared image-chunk prefix from `sourcePath`
 * when the layout allows it (findReflinkablePrefixOffset()) and appends only the fixed IEND_CHUNK - never any
 * per-character data - so a successful reflink leaves `destPath` sharing every extent with `sourcePath` up to
 * that prefix. Falls back to a full independent write (still image-only) when reflinking isn't available or
 * `sourcePath`'s chunk layout is ineligible.
 * @param {string} sourcePath Absolute path to the source PNG already on disk.
 * @param {string} destPath Absolute path to write the result to. May already exist.
 * @returns {Promise<{reflinked: boolean}>}
 */
export async function writeImageOnlyCard(sourcePath, destPath) {
    const srcBuf = await fs.promises.readFile(sourcePath);
    const offset = findReflinkablePrefixOffset(srcBuf);

    if (offset !== null && offset <= srcBuf.length) {
        try {
            await writeSharedPrefixThenAppend(sourcePath, destPath, IEND_CHUNK, offset);
            return { reflinked: true };
        } catch (error) {
            console.debug(`character-card-parser: image-only reflink-preserving write failed for ${sourcePath} -> ${destPath}, falling back to a full write.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    writeFileAtomicSync(destPath, stripCardData(srcBuf));
    return { reflinked: false };
}

