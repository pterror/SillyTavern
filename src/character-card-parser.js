import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { loadReflinkModule } from './reflink-support.js';

/**
 * Writes Character metadata to a PNG image buffer.
 *
 * Always writes a 'chara' chunk holding `data` verbatim (whatever spec level it's already at - no field
 * mutation, no re-derivation). Only ALSO writes a 'ccv3' chunk when `data` itself already declares
 * `spec: 'chara_card_v3'`, and even then the chunk holds `data` byte-for-byte, not a re-stringified copy - so a
 * v2-sourced card never gets a synthesized v3 upgrade it didn't ask for, and a v3-sourced card doesn't pick up
 * incidental key-order churn from a redundant parse/stringify round trip. This used to force-upgrade every card
 * to v3 unconditionally (writing a 'ccv3' chunk with `spec`/`spec_version` overwritten to 3.0 regardless of
 * source), which is exactly the kind of import-time mutation that makes a stored card's bytes diverge from the
 * original even when nothing about the character actually changed - see the character-metadata-db.js
 * `content_identity_hash`/`import_poisoned` columns this behavior undermines.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const decoded = PNGtext.decode(tEXtChunk.data);
        if (decoded.keyword.toLowerCase() === 'chara' || decoded.keyword.toLowerCase() === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    // Add the chara (v2-or-whatever-the-source-was) chunk before the IEND chunk, holding `data` as-is.
    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    // Only mirror into a 'ccv3' chunk when the source already IS v3 - never synthesize one for a v2 (or
    // undetermined-spec) source. The chunk holds `data` verbatim, not a re-parsed/re-stringified copy, so this
    // never introduces its own formatting drift either.
    try {
        const parsed = JSON.parse(data);
        if (parsed.spec === 'chara_card_v3') {
            chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedData));
        }
    } catch (error) {
        // Ignore errors when inspecting spec - if `data` isn't valid JSON, `chara` alone is written above.
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(new Uint8Array(image));

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
};

/**
 * Reads ONLY the 'chara' tEXt chunk, verbatim - never falls through to 'ccv3' the way read() prefers to. This
 * exists for one narrow purpose: recovering a poisoned library row's pristine pre-mutation content (see
 * character-metadata-db.js's content_identity_hash/import_poisoned columns and this module's write() header).
 *
 * Before 293f4294b, write() unconditionally wrote a 'ccv3' chunk for every card, holding a LOCAL COPY of `data`
 * with `spec`/`spec_version` force-bumped to `chara_card_v3`/3.0 - but the 'chara' chunk it wrote alongside that
 * held the original, unmutated `data` verbatim; the bump never touched the object serialized into 'chara'. Since
 * read() prefers 'ccv3' whenever both are present, every character written by that old code path (create, edit,
 * import, or rename alike - write() is the shared low-level writer for all of them) reads back today as the
 * v3-bumped copy through the normal read()/parse() path, even though the original, unmutated content is still
 * sitting right there in 'chara'. This function is what makes that original content reachable again.
 *
 * Does NOT change read()'s own ccv3-preference behavior for any other caller - this is a new, narrowly-scoped
 * addition alongside it, not a change to existing read semantics.
 *
 * Defensive fallback: falls through to whatever OTHER tEXt chunk exists (ccv3, if present) rather than throw, for
 * a card with no 'chara' chunk at all - shouldn't happen for anything actually written by this app's own write()
 * (which always writes 'chara'), but a hand-edited or foreign-tool-written file is a real possibility this
 * function must not crash on.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data, exactly as it was written into the 'chara' chunk (or the best available
 * fallback chunk, if 'chara' itself is absent)
 */
export const readCharaChunkPristine = (image) => {
    const chunks = extract(new Uint8Array(image));
    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');
    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    // Defensive fallback only - see this function's own doc comment.
    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
};

/**
 * Promise-based counterpart to parse(), reading a PNG off disk and returning its PRISTINE 'chara' chunk content
 * (see readCharaChunkPristine()'s own doc comment) rather than read()'s ccv3-preferring result. Same real-async
 * (fs.promises) I/O shape as parse() itself, for the same reason (see that function's own header) - a caller
 * batching many of these (character-metadata-db.js's backfillContentIdentityHashes()) needs actual overlapping
 * disk I/O, not one blocking read at a time.
 * @param {string} cardUrl Path to the card image
 * @returns {Promise<string>} Character data, pristine (see readCharaChunkPristine())
 */
export const parsePristine = async (cardUrl) => {
    const buffer = await fs.promises.readFile(cardUrl);
    return readCharaChunkPristine(buffer);
};

/**
 * Parses a card image and returns the character metadata.
 *
 * Reads via fs.promises (real async I/O), not fs.readFileSync: this is the function readCharacterData()
 * (characters.js) calls once per character file, and a synchronous read here means every "concurrent" caller
 * (e.g. characters-search-index.js's readCharacterBatches(), which processes a batch via Promise.all()) was
 * never actually overlapping disk I/O - each read blocked the whole event loop in turn, one file at a time, no
 * matter how many promises were nominally in flight. Switching to a real async read lets those Promise.all()
 * batches genuinely overlap I/O instead of just deferring execution of blocking calls.
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
 * Finds the byte offset in `srcBuf` up to which `write()`'s output is guaranteed byte-identical to
 * `srcBuf` itself - i.e. the end of the last chunk write() leaves untouched, letting a caller reflink
 * just that prefix instead of paying a full-file copy for bytes that never actually changed.
 *
 * write() only ever removes existing 'chara'/'ccv3' tEXt chunks and inserts fresh ones immediately
 * before IEND (see write()'s own doc comment) - every other chunk (IHDR, IDAT, any unrelated ancillary
 * chunk) passes through unmodified, in the same order, so the byte range up to the first REMOVED chunk
 * (or up to IEND itself, if nothing is being removed) is untouched by the rewrite.
 *
 * That is only true, though, when the removed chunks form one contiguous run immediately before IEND
 * with nothing else surviving after them - e.g. a chara chunk sitting BEFORE IDAT (a layout this app
 * never produces itself, but a foreign tool importing/re-exporting a card could) would mean removing it
 * shifts every byte that follows, so the "prefix stays identical" guarantee wouldn't hold. This function
 * detects exactly that condition and returns `null` when it doesn't hold, rather than guess - the caller
 * is expected to fall back to a full rewrite whenever this returns `null`.
 * @param {Buffer} srcBuf The source PNG buffer to inspect (NOT the rewritten output - the offset is
 * computed against the chunk layout as it exists in the source, which write-time verification then
 * confirms still matches the actual rewritten output's corresponding bytes).
 * @returns {number | null} Byte offset into `srcBuf` (and, if the layout condition holds, into write()'s
 * output for the same input) up to which both buffers are guaranteed identical, or `null` if the source's
 * chunk layout doesn't meet the contiguous-tail condition this optimization depends on.
 */
function findReflinkablePrefixOffset(srcBuf) {
    /** @type {Array<{name: string, data: Uint8Array}>} */
    let chunks;
    try {
        chunks = extract(new Uint8Array(srcBuf));
    } catch (error) {
        return null;
    }

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
 * `sourcePath` for the untouched image-data bytes whenever the source's chunk layout allows it (see
 * findReflinkablePrefixOffset()) - instead of always paying a full-file rewrite for a change that, in the
 * common case, only ever touches a few KB of trailing metadata out of a multi-MB card.
 *
 * Strategy, cheapest-first, same "always correct even when the shortcut doesn't apply" shape as
 * local-import-copy.js's copyCharacterFile():
 *   1. Compute the ordinary rewritten buffer via write() - needed either way, and doubles as the source
 *      of truth this function verifies the fast path against (never trusts the structural check on its
 *      own - see below).
 *   2. If findReflinkablePrefixOffset() finds a safe prefix AND the rewritten buffer's own bytes in that
 *      range are actually byte-identical to the source's (a real verification, not an assumption from
 *      the structural check alone), reflink-clone `sourcePath` into a temp file, truncate it down to the
 *      shared prefix, append just the changed tail, and atomically rename it over `destPath`. Only the
 *      appended tail is ever a real, disk-cost write.
 *   3. Otherwise (reflink unavailable/unsupported/fails, or the layout/verification didn't clear step 2),
 *      fall back to writing the full rewritten buffer with write-file-atomic, identical to what this
 *      write path did before this optimization existed.
 * `destPath` may already exist (an edit/re-import overwriting a character's existing avatar) - like
 * write-file-atomic, this preserves that existing file's mode/uid/gid on the replacement rather than
 * silently resetting them to the process default.
 * @param {string} sourcePath Absolute path to the source PNG already on disk (the file whose image data
 * should end up, byte-for-byte, as the new file's image data).
 * @param {string} destPath Absolute path to write the result to. May already exist.
 * @param {string} data Character data to embed (same contract as write()).
 * @returns {Promise<{reflinked: boolean}>} Whether the reflink-preserving fast path was used.
 */
export async function writeCardToFile(sourcePath, destPath, data) {
    const srcBuf = await fs.promises.readFile(sourcePath);
    const outputImage = write(srcBuf, data);

    const offset = findReflinkablePrefixOffset(srcBuf);
    const prefixVerified = offset !== null && offset <= srcBuf.length && offset <= outputImage.length
        && Buffer.compare(outputImage.subarray(0, offset), srcBuf.subarray(0, offset)) === 0;

    if (prefixVerified) {
        try {
            await writeSharedPrefixThenAppend(sourcePath, destPath, outputImage, offset);
            return { reflinked: true };
        } catch (error) {
            console.debug(`character-card-parser: reflink-preserving write failed for ${sourcePath} -> ${destPath}, falling back to a full write.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    writeFileAtomicSync(destPath, outputImage);
    return { reflinked: false };
}

/**
 * The reflink-preserving fast path's actual write, split out of writeCardToFile() for clarity. Reflinks
 * `sourcePath` into a same-directory temp file (so the closing rename is same-filesystem-atomic, same
 * reasoning as local-import-copy.js's hardlinkOntoCanonical()), truncates it down to the shared prefix,
 * appends the already-computed changed tail, matches an existing `destPath`'s mode/uid/gid if there is
 * one, then renames over `destPath`. Any failure along the way cleans up the abandoned temp file and
 * rethrows, rather than leaving a stray `.tmp` sibling or a partially-written `destPath` - `destPath`
 * itself is never touched until the final atomic rename.
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {Buffer} outputImage The full rewritten buffer from write() - only its tail (from `offset`
 * onward) is actually written; bytes before `offset` come from the reflinked clone instead.
 * @param {number} offset
 * @returns {Promise<void>}
 */
async function writeSharedPrefixThenAppend(sourcePath, destPath, outputImage, offset) {
    const reflinkModule = await loadReflinkModule();
    if (!reflinkModule) {
        throw new Error('@reflink/reflink native binding is unavailable on this platform.');
    }

    const tempPath = `${destPath}.${crypto.randomUUID()}.tmp`;
    try {
        await reflinkModule.reflinkFile(sourcePath, tempPath);
        await fsPromises.truncate(tempPath, offset);
        await fsPromises.appendFile(tempPath, outputImage.subarray(offset));

        // Mirror write-file-atomic's own behavior of preserving an existing target's mode/uid/gid on
        // replacement, rather than silently resetting them to the process default - see its lib/index.js.
        try {
            const existingStat = await fsPromises.stat(destPath);
            await fsPromises.chmod(tempPath, existingStat.mode);
            if (process.getuid) {
                await fsPromises.chown(tempPath, existingStat.uid, existingStat.gid).catch(() => {});
            }
        } catch (error) {
            // destPath doesn't exist yet (the common case - a fresh import) - nothing to preserve.
        }

        await fsPromises.rename(tempPath, destPath);
    } catch (error) {
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

