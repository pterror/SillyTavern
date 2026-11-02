import './local-import-worker-config.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import extract from 'png-chunks-extract';

import { classifyJsonCandidate, computeCandidateContentIdentityHash, computeContentIdentityHashFromRawText } from './local-import-classify.js';
import { readFromChunks, computeAnimatedHashFromChunks, computeAvatarIdentityHashFromChunks, computeAvatarIdentityHashFromImageBuffer, computeDefaultAvatarIdentityHash, stripCardData } from './character-card-parser.js';
import { DEFAULT_AVATAR_PATH } from './constants.js';

/** @type {Map<number, { sourcePath: string, sourceBuffer: Buffer, chunks: Array<{name: string, data: Uint8Array}> | null, format: string }>} */
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
        if (!pending) return;
        await finishWrite(msg, pending);
        return;
    }

    const { id, sourcePath, format, allowIdentityFallback } = msg;
    try {
        const sourceBuffer = fs.readFileSync(sourcePath);
        const contentHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');

        let jsonClassification = null;
        if (format === 'json') {
            jsonClassification = classifyJsonCandidate(sourceBuffer);
        }

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

        const avatarIdentityHash = decoded?.chunks
            ? computeAvatarIdentityHashFromChunks(decoded.chunks)
            : (!jsonClassification && (format === 'json' || format === 'yaml' || format === 'yml')) ? computeDefaultAvatarIdentityHash() : null;
        const animatedHash = decoded?.chunks ? computeAnimatedHashFromChunks(decoded.chunks) : null;

        if (decoded) {
            pendingTasks.set(id, { sourcePath, sourceBuffer, chunks: decoded.chunks, format });
            parentPort.postMessage({ id, phase: 'parsed', ok: true, contentHash, jsonClassification, identityHash, avatarIdentityHash, animatedHash, rawText: decoded.rawText });
            return;
        }

        parentPort.postMessage({ id, phase: 'done', ok: true, contentHash, jsonClassification, identityHash, avatarIdentityHash, animatedHash });
    } catch (err) {
        parentPort.postMessage({ id, phase: 'done', ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
});

/**
 * @param {{ id: number, outcome: 'no-write' | 'write' }} msg
 * @param {{ sourcePath: string, sourceBuffer: Buffer, chunks: Array<{name: string, data: Uint8Array}> | null, format: string }} pending
 */
async function finishWrite(msg, pending) {
    const { id, outcome } = msg;
    if (outcome !== 'write') {
        parentPort.postMessage({ id, phase: 'done', ok: true, outcome });
        return;
    }
    try {
        const image = stripCardData(fs.readFileSync(DEFAULT_AVATAR_PATH));
        const avatarIdentityHash = computeAvatarIdentityHashFromImageBuffer(image);
        parentPort.postMessage({ id, phase: 'done', ok: true, outcome: 'write', image, avatarIdentityHash });
    } catch (err) {
        parentPort.postMessage({ id, phase: 'done', ok: false, error: /** @type {any} */ (err)?.message ?? String(err) });
    }
}
