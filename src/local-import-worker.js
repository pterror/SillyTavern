import fs from 'node:fs';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import extract from 'png-chunks-extract';

import { classifyJsonCandidate, computeCandidateContentIdentityHash, computeContentIdentityHashFromRawText } from './local-import-classify.js';
import { readFromChunks, writeImageOnlyCard, computeAvatarIdentityHashFromChunks, computeDefaultAvatarIdentityHash } from './character-card-parser.js';
import { copyCharacterFile } from './local-import-copy.js';
import { DEFAULT_AVATAR_PATH } from './constants.js';

/**
 * Reads each source file's bytes exactly once, reusing that buffer through hashing, classification, identity
 * hashing, and the eventual write. png/json candidates use a two-phase protocol: a 'parsed' reply stashes the
 * decoded buffer/chunks in `pendingTasks`, and a later `{ type: 'continue' }` message triggers the write.
 * charx/byaf/yaml stay on the original single-message protocol. Never touches sqlite - that stays on the main
 * thread (no WAL/busy_timeout here, and scanDirectory() wraps a pass in one write transaction).
 */

/** @type {Map<number, { sourcePath: string, sourceBuffer: Buffer, chunks: Array<{name: string, data: Uint8Array}> | null, format: string, allowCrossDeviceCopyFallback: boolean }>} */
const pendingTasks = new Map();

/**
 * @param {Buffer} sourceBuffer
 * @param {string} format
 * @returns {{ rawText: string, chunks: Array<{name: string, data: Uint8Array}> | null }}
 */
function decodeRawText(sourceBuffer, format) {
    if (format === 'png') {
        const chunks = extract(new Uint8Array(sourceBuffer));
        return { rawText: readFromChunks(chunks), chunks };
    }
    return { rawText: sourceBuffer.toString('utf8'), chunks: null };
}

parentPort.on('message', async (msg) => {
    if (msg.type === 'continue') {
        const pending = pendingTasks.get(msg.id);
        pendingTasks.delete(msg.id);
        if (!pending) return; // stray/duplicate continue
        await finishWrite(msg, pending);
        return;
    }

    const { id, sourcePath, format, allowIdentityFallback, allowCrossDeviceCopyFallback } = msg;
    try {
        const sourceBuffer = fs.readFileSync(sourcePath);
        const contentHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');

        let jsonClassification = null;
        if (format === 'json') {
            jsonClassification = classifyJsonCandidate(sourceBuffer);
        }

        // decode once and reuse for both the identity-hash fallback and the phase-2 payload - re-extracting
        // png chunks a second time measured ~43% of this phase's CPU.
        let decoded = null;
        if (!jsonClassification && (format === 'png' || format === 'json')) {
            decoded = decodeRawText(sourceBuffer, format);
        }

        let identityHash = null;
        if (!jsonClassification && allowIdentityFallback) {
            identityHash = decoded
                ? computeContentIdentityHashFromRawText(decoded.rawText, msg.directories)
                : await computeCandidateContentIdentityHash(sourceBuffer, format, msg.directories);
        }

        // not gated on allowIdentityFallback like identityHash - this is cheap and always needed for a write.
        const avatarIdentityHash = decoded?.chunks
            ? computeAvatarIdentityHashFromChunks(decoded.chunks)
            : (!jsonClassification && (format === 'json' || format === 'yaml' || format === 'yml')) ? computeDefaultAvatarIdentityHash() : null;

        if (decoded) {
            pendingTasks.set(id, { sourcePath, sourceBuffer, chunks: decoded.chunks, format, allowCrossDeviceCopyFallback });
            parentPort.postMessage({ id, phase: 'parsed', ok: true, contentHash, jsonClassification, identityHash, avatarIdentityHash, rawText: decoded.rawText });
            return;
        }

        parentPort.postMessage({ id, phase: 'done', ok: true, contentHash, jsonClassification, identityHash, avatarIdentityHash });
    } catch (err) {
        parentPort.postMessage({ id, phase: 'done', ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});

/**
 * @param {{ id: number, outcome: 'no-write' | 'write', destPath?: string, data?: string }} msg
 * @param {{ sourcePath: string, sourceBuffer: Buffer, chunks: Array<{name: string, data: Uint8Array}> | null, format: string }} pending
 */
async function finishWrite(msg, pending) {
    const { id, outcome } = msg;
    if (outcome !== 'write') {
        parentPort.postMessage({ id, phase: 'done', ok: true, outcome });
        return;
    }
    try {
        const { destPath } = msg;
        // Card data goes to the metadata db only (see local-import-scan.js's fireMetadataUpsertHook call) -
        // png gets an image-only reflink of its own source, json/yaml get a plain copy of the shared default
        // avatar template (no per-character source image to diverge from either way).
        const result = pending.format === 'png'
            ? await writeImageOnlyCard(pending.sourcePath, destPath)
            : await copyCharacterFile(DEFAULT_AVATAR_PATH, destPath, pending.allowCrossDeviceCopyFallback);
        parentPort.postMessage({ id, phase: 'done', ok: true, outcome: 'write', reflinked: 'method' in result ? result.method !== 'copy' : result.reflinked });
    } catch (err) {
        parentPort.postMessage({ id, phase: 'done', ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
}
