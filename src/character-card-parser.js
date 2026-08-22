import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

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

