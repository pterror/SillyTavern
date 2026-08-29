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
 * sha256 over a PNG's concatenated IDAT chunk payload bytes, in file order - see character-metadata-db.js's
 * SCHEMA_SQL comment on `avatar_identity_hash` for the full rationale. Deliberately IDAT-payload bytes (the
 * still-compressed pixel stream, exactly as extract() already handed back to every other chunk-list consumer
 * in this module), not a full decode-to-pixels hash: this fork already tried "decode/re-encode the avatar on
 * every write" once (the old unconditional Jimp re-encode this module's write() header describes retiring)
 * and it was a real, removed cost - reintroducing a full zlib-inflate+unfilter pass here, unconditionally, on
 * every content-identity-hash computation across an 80k+-character corpus would be the same regression
 * again. IDAT-payload hashing is cheap (the chunk list is already extracted for every caller of this
 * function - no extra I/O or decode step) and is stable across exactly the class of encoder-side change this
 * feature was motivated by (2026-08: a copy-loop bug + CRC library swap that changed re-encoded PNGs' exact
 * output bytes without touching pixel content) - both of those altered how OTHER chunks/CRCs were
 * reconstructed, never the IDAT payload itself, which encode.js writes through unchanged when the source
 * chunk list's IDAT entries are reused verbatim (see spliceCardDataIntoChunks(), which only ever touches tEXt
 * chunks). It is NOT immune to a genuine re-encode that picks different zlib compression/filter settings for
 * identical pixels - that would require a real decode-to-pixels hash, deliberately not implemented here for
 * the cost reason above; a future need for that stronger guarantee should introduce it as an opt-in, not
 * fold it into this hash silently.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only - never
 * mutated).
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
 * computeAvatarIdentityHashFromChunks() for the one fixed, bundled asset (constants.js's DEFAULT_AVATAR_PATH)
 * every json/yaml import without its own embedded image is written through - genuinely the same avatar bytes
 * every time (this app never mutates that asset at runtime), so this is computed at most once per process and
 * cached forever, not re-read/re-extracted/re-hashed per candidate the way a real per-character avatar is.
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
 * computeAvatarIdentityHashFromChunks() over an already-built PNG buffer that has no pre-existing extracted
 * chunk list yet - characters.js's writeCharacterData() slow path (Buffer upload, or a crop that legitimately
 * changes pixels, so there's no on-disk `sourcePath` chunk list to reuse the way writeCardFromChunks() does).
 * Pays one extract() over `image` - the same one-extra-extract cost every other consumer of this module works
 * to avoid on the HOT path, but this function is only ever reached off the already-uncommon crop/buffer-upload
 * branch, not the ordinary reflink fast path.
 * @param {Buffer} image
 * @returns {string} sha256 hex digest
 */
export function computeAvatarIdentityHashFromImageBuffer(image) {
    return computeAvatarIdentityHashFromChunks(extract(new Uint8Array(image)));
}

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
/**
 * The chunk-list-manipulation half of write() - factored out so a caller that has already extracted
 * `image`'s chunks for some other reason (writeCardToFile() below needs the same chunk list to compute
 * findReflinkablePrefixOffset()'s result) can reuse that extraction instead of paying extractChunks() a
 * second time over the same bytes. extractChunks() copies every chunk's data byte-by-byte (see
 * png-chunks-extract's own source) - for a multi-MB card, that copy is a real, measured cost (2026-08
 * local-import perf investigation: extractChunks() alone accounted for ~45% of writeCardToFile()'s wall
 * time on a real corpus, spread across what used to be three separate extract() calls per imported file -
 * this function's own doc comment on write() explains the other two), so calling it twice on identical
 * bytes for two different reasons is exactly the "redo expensive work instead of computing it once" shape
 * the tags.json bootstrapIfNeeded() bug had.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (mutated in place,
 * same as the inline logic this was factored out of - callers that still need the original list untouched
 * must extract their own copy).
 * @param {string} data Character data to write (same contract as write()).
 * @returns {Array<{name: string, data: Uint8Array}>} `chunks`, mutated: existing chara/ccv3 tEXt chunks
 * removed, fresh one(s) inserted immediately before IEND.
 */
function spliceCardDataIntoChunks(chunks, data) {
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

    return chunks;
}

export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    spliceCardDataIntoChunks(chunks, data);
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
    return readFromChunks(chunks);
};

/**
 * The chunk-list half of read() above - factored out so a caller that already extracted `image`'s chunks for
 * some other reason (local-import-worker.js's worker-owned-write pipeline - see writeCardFromChunks()'s own
 * doc comment for the redundant-extract() this avoids) can reuse that extraction to get the same
 * ccv3-preferring character data read() always returns, instead of paying extract() a second time over
 * identical bytes just to read what it already parsed.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only - never
 * mutated).
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
/**
 * The chunk-list half of readCharaChunkPristine() below, factored out the same way spliceCardDataIntoChunks()
 * was - so a caller that needs BOTH the pristine text AND something else derived from this same PNG's chunk
 * list (character-metadata-db.js's backfillContentIdentityHashes(), which now also backfills
 * avatar_identity_hash from computeAvatarIdentityHashFromChunks() of the exact same already-extracted list -
 * see that function's own call site) pays extract() once instead of once per derived value.
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only - never
 * mutated).
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

    // Defensive fallback only - see this function's own doc comment.
    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
}

/** @param {Buffer} image PNG image buffer
 * @returns {string} Character data, exactly as it was written into the 'chara' chunk (or the best available
 * fallback chunk, if 'chara' itself is absent) */
export const readCharaChunkPristine = (image) => readCharaChunkPristineFromChunks(extract(new Uint8Array(image)));

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
 * The chunk-list half of findReflinkablePrefixOffset() above - factored out so writeCardToFile() can reuse
 * a chunk list it already extracted for its own write, instead of paying extract() a second time over
 * identical bytes purely to answer this question (see spliceCardDataIntoChunks()'s own doc comment for the
 * measured cost this avoids). findReflinkablePrefixOffset(srcBuf) itself is kept as a thin extract-then-
 * delegate wrapper for its other caller (reclaimReflinkPrefix(), which has no reason to extract twice
 * either but only ever has a raw buffer on hand, not a pre-extracted chunk list).
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list (read-only - never
 * mutated).
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
 * @param {string|null} [crossReflinkCandidatePath] Absolute path to a DIFFERENT character's current file that
 * a caller believes might share content with this write (see writeCardFromChunks()'s own doc comment for the
 * verification this gets put through before ever being trusted).
 * @returns {Promise<{reflinked: boolean, avatarIdentityHash: string}>} Whether the reflink-preserving fast
 * path was used, and computeAvatarIdentityHashFromChunks() of the image actually written - see
 * writeCardFromChunks()'s own doc comment on why this is always safe to compute from `chunks` up front,
 * regardless of which of the three write branches below ends up taking.
 */
export async function writeCardToFile(sourcePath, destPath, data, crossReflinkCandidatePath = null) {
    const srcBuf = await fs.promises.readFile(sourcePath);

    // Extract srcBuf's chunks exactly once and reuse the same list for both the rewritten-buffer build
    // and the reflinkable-prefix computation - this used to call write(srcBuf, data) (its own internal
    // extract()) and findReflinkablePrefixOffset(srcBuf) (a second, independent extract() over the
    // identical bytes) back to back. See spliceCardDataIntoChunks()'s own doc comment for why that
    // duplicate extract() was a measured, real cost, not a theoretical one.
    const chunks = extract(new Uint8Array(srcBuf));
    return writeCardFromChunks(sourcePath, destPath, srcBuf, chunks, data, crossReflinkCandidatePath);
}

/**
 * The core of writeCardToFile() above, factored out to accept an already-extracted chunk list and the exact
 * buffer it came from - so a caller that extracted `srcBuf`'s chunks for some OTHER reason already (2026-08
 * local-import worker-owned-write extension: local-import-worker.js reads a discovered file's bytes exactly
 * once and reuses that single extraction all the way through hashing, classification, AND this write, rather
 * than re-reading/re-extracting a staged copy of the identical bytes purely to reach this function - see that
 * module's own header) never pays extract() a second time over bytes it already has in memory.
 * writeCardToFile() is now a thin read+extract wrapper around this.
 * @param {string} sourcePath Absolute path to the PNG `chunks`/`srcBuf` were extracted from - used only as the
 * reflink-clone source for the fast path (see writeSharedPrefixThenAppend()); never re-read here.
 * @param {string} destPath Absolute path to write the result to. May already exist.
 * @param {Buffer} srcBuf The exact bytes `chunks` was extracted from - needed for the fast path's byte-identity
 * verification and length checks (never trusted on the structural check alone - see this function's own logic).
 * @param {Array<{name: string, data: Uint8Array}>} chunks Already-extracted chunk list for `srcBuf`. Mutated in
 * place by spliceCardDataIntoChunks() - callers that still need the original list untouched must extract their
 * own copy first.
 * @param {string} data Character data to embed (same contract as write()).
 * @param {string|null} [crossReflinkCandidatePath] Absolute path to a DIFFERENT character's current file
 * that a caller (character-metadata-db.js's `content_identity_hash` index, via characters.js's live write
 * path) believes might carry the same content as this write - tried BEFORE `sourcePath` itself, since a
 * successful cross-character reflink is the only outcome of this function that actually converges two
 * independently-stored files onto shared extents (a self-reflink from `sourcePath` never does: `sourcePath`
 * is either about to be overwritten in place, or was never sharing extents with anything else to begin
 * with, so it can't reduce total disk usage the way linking to an unrelated already-live file can).
 *
 * `content_identity_hash` is computed purely from the character's JSON (fav/chat/create_date stripped) -
 * see computeContentIdentityHash()'s own doc comment. It says NOTHING about whether the candidate's actual
 * AVATAR IMAGE bytes match this write's intended image (from `sourcePath`/`srcBuf`) - two characters can
 * have byte-identical personality JSON with completely different portraits. Trusting the hash match alone
 * would silently swap the wrong picture onto `destPath`. So this candidate is never trusted on the hash
 * match alone: exactly the same byte-level prefix verification reclaimReflinkPrefix() applies to a frozen
 * import source gets applied here too, against the candidate's OWN current on-disk bytes, before it's ever
 * used as a reflink source. If that verification fails (different portrait, ineligible chunk layout, file
 * went missing, whatever) this silently declines the candidate and falls through to the ordinary
 * self/full-write path below - never a partial or guessed write.
 *
 * Both `sourcePath` and any `crossReflinkCandidatePath` are only ever reflinked FROM (via
 * writeSharedPrefixThenAppend(), which clones into a fresh same-directory temp file, truncates/appends
 * there, then atomically renames that temp file over `destPath`) - neither is ever opened for writing
 * itself. That's what keeps this safe even though a cross-character candidate is, unlike
 * reclaimReflinkPrefix()'s frozen import source, a live file some OTHER request could edit at any time: an
 * edit to the candidate later runs through this exact same clone-into-temp-then-rename shape, so it only
 * ever replaces the candidate's OWN inode, never mutates bytes `destPath` is now sharing extents with (COW
 * on top of "never write in place" - two independent safety properties, not one relying on the other).
 * @returns {Promise<{reflinked: boolean, avatarIdentityHash: string}>} Whether the reflink-preserving fast
 * path was used, and computeAvatarIdentityHashFromChunks() of the image actually written.
 */
export async function writeCardFromChunks(sourcePath, destPath, srcBuf, chunks, data, crossReflinkCandidatePath = null) {
    // Computed from `chunks` BEFORE spliceCardDataIntoChunks() mutates it below, and correct regardless of
    // which of the three branches beneath this ends up writing: spliceCardDataIntoChunks() only ever touches
    // tEXt chunks (see its own doc comment), so `chunks`' IDAT entries - and therefore this hash - are exactly
    // the same whether the eventual write reflinks from `sourcePath`, reflinks from `crossReflinkCandidatePath`
    // (only ever taken after byte-verifying `outputImage`'s shared prefix against that candidate - see below -
    // so its stored bytes are provably a match for `outputImage`'s own, i.e. for THIS hash, up to the verified
    // prefix; IDAT sits inside that prefix on every real card layout this app produces, chara/ccv3 tEXt chunks
    // always being spliced in immediately before IEND), or falls all the way through to a full write of
    // `outputImage` itself.
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
                await writeSharedPrefixThenAppend(crossReflinkCandidatePath, destPath, outputImage, crossOffset);
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
            await writeSharedPrefixThenAppend(sourcePath, destPath, outputImage, offset);
            return { reflinked: true, avatarIdentityHash };
        } catch (error) {
            console.debug(`character-card-parser: reflink-preserving write failed for ${sourcePath} -> ${destPath}, falling back to a full write.`, /** @type {any} */ (error)?.message ?? error);
        }
    }

    writeFileAtomicSync(destPath, outputImage);
    return { reflinked: false, avatarIdentityHash };
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

/**
 * Retroactively reclaims reflink extent-sharing for a character file that was already fully written out
 * (independent bytes, no sharing with its original source) before writeCardToFile() existed - the exact
 * gap that let a local-import bulk-consume real disk space despite copyCharacterFile()'s staging reflink
 * succeeding every time (see writeCardToFile()'s own header for the mechanism this repairs).
 *
 * Same safety shape as writeCardToFile(), just applied after the fact: `sourcePath` is a candidate
 * original this repair believes `existingPath` was imported from (the caller is expected to have already
 * matched them by content_hash - this function does not do that matching itself, only the byte-level
 * verification of whether the match is actually safe to act on). Never trusts that match on its own -
 * finds the reflinkable-prefix boundary from `sourcePath`'s own chunk layout, then requires
 * `existingPath`'s bytes to be LITERALLY IDENTICAL to `sourcePath`'s bytes for that entire prefix before
 * doing anything. If that verification fails for any reason (wrong match, the file was cropped at import
 * time so its pixel data genuinely differs, a foreign chunk layout, anything) this declines and leaves
 * `existingPath` completely untouched, rather than guess.
 *
 * When it does proceed: reflinks `sourcePath` into a temp file, truncates to the verified shared prefix,
 * appends `existingPath`'s OWN current tail bytes verbatim (not a re-derived value - whatever
 * `existingPath` currently has after that offset is preserved exactly), then atomically renames over
 * `existingPath`. `existingPath`'s own mode/uid/gid are preserved on the replacement (writeSharedPrefixThenAppend()
 * always stats and preserves whatever currently exists at the destination it's replacing).
 * @param {string} existingPath Absolute path to the already-imported character file to repair in place.
 * @param {string} sourcePath Absolute path to the believed-original source file, still on disk.
 * @returns {Promise<{reflinked: boolean, reason?: string}>}
 */
export async function reclaimReflinkPrefix(existingPath, sourcePath) {
    const [existingBuf, sourceBuf] = await Promise.all([
        fs.promises.readFile(existingPath),
        fs.promises.readFile(sourcePath),
    ]);

    const offset = findReflinkablePrefixOffset(sourceBuf);
    const prefixVerified = offset !== null && offset <= existingBuf.length && offset <= sourceBuf.length
        && Buffer.compare(existingBuf.subarray(0, offset), sourceBuf.subarray(0, offset)) === 0;

    if (!prefixVerified) {
        return { reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' };
    }

    try {
        await writeSharedPrefixThenAppend(sourcePath, existingPath, existingBuf, offset);
        return { reflinked: true };
    } catch (error) {
        console.debug(`character-card-parser: reclaimReflinkPrefix failed for ${existingPath} <- ${sourcePath}, leaving it untouched.`, /** @type {any} */ (error)?.message ?? error);
        return { reflinked: false, reason: 'reflink-failed' };
    }
}

