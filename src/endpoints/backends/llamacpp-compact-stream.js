import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

import { forwardFetchResponse } from '../../util.js';

/**
 * Compact wire protocol for the llama.cpp raw-completions streaming path only.
 *
 * Plain bytes = raw UTF-8 text, appended directly to accumulated content.
 * `0xFF 0xFF`                                    = one literal content byte 0xFF (defensive escape).
 * `0xFF 0x01 <1 byte index>`                     = target/swipe index changed.
 * `0xFF 0x02 <4-byte BE length><length bytes>`    = token-probabilities payload (JSON) for the current token.
 *
 * This format is a private contract between this server and its own bundled client. It is not exposed as a
 * public/supported surface, so the shape is free to change without a compat concern.
 */
export const FRAME_SENTINEL = 0xFF;
export const FRAME_TYPE_INDEX = 0x01;
export const FRAME_TYPE_PROBABILITIES = 0x02;

/**
 * Encodes a raw text chunk, escaping any literal 0xFF byte so it can never be mistaken for a control frame.
 * @param {string} text Text to encode
 * @returns {Buffer} Encoded bytes
 */
export function encodeContent(text) {
    if (!text) {
        return Buffer.alloc(0);
    }

    const raw = Buffer.from(text, 'utf-8');

    if (!raw.includes(FRAME_SENTINEL)) {
        return raw;
    }

    const out = [];
    for (const byte of raw) {
        out.push(byte);
        if (byte === FRAME_SENTINEL) {
            out.push(FRAME_SENTINEL);
        }
    }

    return Buffer.from(out);
}

/**
 * Encodes an index-change control frame.
 * @param {number} index New index value (0-255)
 * @returns {Buffer} Encoded bytes
 */
export function encodeIndexFrame(index) {
    return Buffer.from([FRAME_SENTINEL, FRAME_TYPE_INDEX, index & 0xFF]);
}

/**
 * Encodes a token-probabilities control frame.
 * @param {any} probabilities The `completion_probabilities` value from upstream
 * @returns {Buffer} Encoded bytes
 */
export function encodeProbabilitiesFrame(probabilities) {
    const json = Buffer.from(JSON.stringify(probabilities), 'utf-8');
    const header = Buffer.alloc(6);
    header[0] = FRAME_SENTINEL;
    header[1] = FRAME_TYPE_PROBABILITIES;
    header.writeUInt32BE(json.length, 2);
    return Buffer.concat([header, json]);
}

/**
 * Encodes a single upstream llama.cpp SSE event into compact-stream bytes.
 * @param {any} data Parsed JSON of one upstream `data:` event
 * @param {number} lastIndex The last index value already signaled to the client (0 if none yet)
 * @returns {{bytes: Buffer, index: number}} Bytes to write and the new "last signaled index"
 */
export function encodeEvent(data, lastIndex) {
    const parts = [];
    const index = typeof data?.index === 'number' ? data.index : 0;
    let nextIndex = lastIndex;

    if (index !== lastIndex) {
        parts.push(encodeIndexFrame(index));
        nextIndex = index;
    }

    if (Array.isArray(data?.completion_probabilities) && data.completion_probabilities.length > 0) {
        parts.push(encodeProbabilitiesFrame(data.completion_probabilities));
    }

    if (data?.content) {
        parts.push(encodeContent(data.content));
    }

    return { bytes: parts.length ? Buffer.concat(parts) : Buffer.alloc(0), index: nextIndex };
}

// Metadata that used to be re-sent (and echoed the whole prompt) on every final SSE event. It costs nothing
// when nobody asks for it (which is every generation today), and is kept reachable via /generate/meta/:id.
const META_KEYS = ['prompt', 'generation_settings', 'timings', 'tokens_cached', 'model', 'truncated', 'stopping_word', 'has_new_line'];
const META_CACHE_MAX = 50;
const META_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, {data: any, storedAt: number}>} */
const metaCache = new Map();

/**
 * Stashes final-event metadata for later retrieval, evicting expired/oldest entries opportunistically.
 * @param {string} id Generation id
 * @param {any} data Metadata to stash
 */
function stashMeta(id, data) {
    const now = Date.now();

    for (const [key, entry] of metaCache) {
        if (now - entry.storedAt > META_TTL_MS) {
            metaCache.delete(key);
        }
    }

    while (metaCache.size >= META_CACHE_MAX) {
        const oldestKey = metaCache.keys().next().value;
        if (oldestKey === undefined) break;
        metaCache.delete(oldestKey);
    }

    metaCache.set(id, { data, storedAt: now });
}

/**
 * Retrieves previously stashed final-event metadata for a generation id.
 * @param {string} id Generation id
 * @returns {any | null} Metadata, or null if missing/expired
 */
export function getLlamaCppStreamMeta(id) {
    const entry = metaCache.get(id);
    if (!entry) return null;

    if (Date.now() - entry.storedAt > META_TTL_MS) {
        metaCache.delete(id);
        return null;
    }

    return entry.data;
}

/**
 * A tiny backpressure-aware writer. Callers hand it bytes as they're produced; it only calls `res.write()`
 * when the response isn't backpressured, coalescing pending bytes while waiting for `drain` otherwise.
 * @param {import('express').Response} res Express response to write to
 */
function createBackpressureWriter(res) {
    /** @type {Buffer[]} */
    let pending = [];
    let waitingDrain = false;
    let ended = false;

    function flush() {
        if (waitingDrain || ended || pending.length === 0) return;

        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];

        const ok = res.write(chunk);
        if (!ok) {
            waitingDrain = true;
            res.once('drain', () => {
                waitingDrain = false;
                flush();
            });
        }
    }

    return {
        write(/** @type {Buffer} */ buf) {
            if (buf && buf.length) pending.push(buf);
            flush();
        },
        end() {
            if (ended) return;
            ended = true;
            if (pending.length) {
                const chunk = Buffer.concat(pending);
                pending = [];
                res.end(chunk);
            } else {
                res.end();
            }
        },
    };
}

/**
 * Pipes a llama.cpp `/completion` streaming response to the client using the compact wire format above,
 * instead of forwarding the upstream SSE-JSON envelope byte-for-byte. Only used for `TEXTGEN_TYPES.LLAMACPP`.
 * @param {import('node-fetch').Response} upstreamResponse The upstream llama.cpp fetch response
 * @param {import('express').Response} response Express response to stream to
 * @returns {Promise<void>}
 */
export async function pipeLlamaCppCompactStream(upstreamResponse, response) {
    if (!upstreamResponse.ok || !upstreamResponse.body) {
        return forwardFetchResponse(upstreamResponse, response);
    }

    return new Promise((resolve) => {
        const id = randomUUID();
        response.setHeader('X-ST-Stream-Format', 'compact-v1');
        response.setHeader('X-Generation-Id', id);

        const writer = createBackpressureWriter(response);
        const decoder = new StringDecoder('utf8');
        let sseBuffer = '';
        let lastIndex = 0;
        let settled = false;

        function finish() {
            if (settled) return;
            settled = true;
            writer.end();
            resolve();
        }

        function handleEvent(/** @type {any} */ data) {
            if (!data) return;

            const { bytes, index } = encodeEvent(data, lastIndex);
            lastIndex = index;
            writer.write(bytes);

            if (data.stop) {
                stashMeta(id, Object.fromEntries(META_KEYS.map(key => [key, data[key]])));
                finish();
            }
        }

        function processBuffer() {
            let idx;
            while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
                const rawEvent = sseBuffer.slice(0, idx);
                sseBuffer = sseBuffer.slice(idx + 2);

                for (const line of rawEvent.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;

                    const payload = trimmed.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;

                    try {
                        handleEvent(JSON.parse(payload));
                    } catch (error) {
                        console.warn('Failed to parse llama.cpp compact stream event:', error);
                    }
                }
            }
        }

        upstreamResponse.body.on('data', (chunk) => {
            sseBuffer += decoder.write(chunk);
            processBuffer();
        });

        upstreamResponse.body.on('end', () => {
            sseBuffer += decoder.end();
            processBuffer();
            finish();
        });

        upstreamResponse.body.on('error', (error) => {
            console.warn('llama.cpp compact stream upstream error:', error);
            finish();
        });

        response.socket?.on('close', () => {
            if (upstreamResponse.body instanceof Readable) upstreamResponse.body.destroy();
            finish();
        });
    });
}
