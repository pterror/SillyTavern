import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

import { forwardFetchResponse } from '../../util.js';
import { persistAssistantReply } from '../../assistant-reply-persist.js';

/**
 * Compact wire protocol, originally for the llama.cpp raw-completions streaming path, now also used
 * by the general SSE-JSON text-completion path (forwardAndPersistSseText() below) - same encoder/
 * decoder, since both are ultimately "content text plus a handful of out-of-band signals."
 *
 * Plain bytes = raw UTF-8 text, appended directly to accumulated content.
 * `0xFF 0xFF`                                   = literal content byte 0xFF (escape).
 * `0xFF 0x01 <1 byte index>`                    = target/swipe index changed.
 * `0xFF 0x02 <4-byte BE length><length bytes>`  = token-probabilities JSON payload.
 * `0xFF 0x03 <4-byte BE length><length bytes>`  = reasoning/thinking text chunk (UTF-8), not content.
 * `0xFF 0x04 <4-byte BE length><length bytes>`  = assistant_node_id (UTF-8 string), sent once, at the
 *                                                 very end, once persistence is known - see
 *                                                 forwardAndPersistSseText()'s own doc comment for why
 *                                                 this must be the LAST frame before the stream ends.
 *
 * Private contract with the bundled client; not a public/supported surface.
 */
export const FRAME_SENTINEL = 0xFF;
export const FRAME_TYPE_INDEX = 0x01;
export const FRAME_TYPE_PROBABILITIES = 0x02;
export const FRAME_TYPE_REASONING = 0x03;
export const FRAME_TYPE_ASSISTANT_NODE_ID = 0x04;

/** Escapes any literal 0xFF byte so it can't be mistaken for a control frame. */
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

export function encodeIndexFrame(index) {
    return Buffer.from([FRAME_SENTINEL, FRAME_TYPE_INDEX, index & 0xFF]);
}

export function encodeProbabilitiesFrame(probabilities) {
    const json = Buffer.from(JSON.stringify(probabilities), 'utf-8');
    const header = Buffer.alloc(6);
    header[0] = FRAME_SENTINEL;
    header[1] = FRAME_TYPE_PROBABILITIES;
    header.writeUInt32BE(json.length, 2);
    return Buffer.concat([header, json]);
}

function encodeLengthPrefixedTextFrame(type, text) {
    const body = Buffer.from(text, 'utf-8');
    const header = Buffer.alloc(6);
    header[0] = FRAME_SENTINEL;
    header[1] = type;
    header.writeUInt32BE(body.length, 2);
    return Buffer.concat([header, body]);
}

export function encodeReasoningFrame(text) {
    return encodeLengthPrefixedTextFrame(FRAME_TYPE_REASONING, text);
}

export function encodeAssistantNodeIdFrame(nodeId) {
    return encodeLengthPrefixedTextFrame(FRAME_TYPE_ASSISTANT_NODE_ID, nodeId);
}

/** @returns {{bytes: Buffer, index: number}} */
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

// Kept reachable via /generate/meta/:id instead of re-sent on every final SSE event.
const META_KEYS =['prompt', 'generation_settings', 'timings', 'tokens_cached', 'model', 'truncated', 'stopping_word', 'has_new_line'];
const META_CACHE_MAX = 50;
const META_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, {data: any, storedAt: number}>} */
const metaCache = new Map();

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

/** @returns {any | null} */
export function getLlamaCppStreamMeta(id) {
    const entry = metaCache.get(id);
    if (!entry) return null;

    if (Date.now() - entry.storedAt > META_TTL_MS) {
        metaCache.delete(id);
        return null;
    }

    return entry.data;
}

/** Coalesces writes while waiting for `drain` under backpressure. */
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
 * Pipes a llama.cpp `/completion` streaming response using the compact wire format above, instead
 * of forwarding the upstream SSE-JSON envelope byte-for-byte.
 *
 * `persist` (`pendingAssistantPersist` from text-completions.js's `/generate` route -
 * `null`/`undefined` for every non-raw-action call) is OPTIONAL and purely additive: this function
 * already fully JSON-parses every upstream SSE event into `data` (to re-encode it into the compact
 * wire format below) - `data.content` is the exact same real per-chunk text llama.cpp itself sends.
 * When `persist` is set, that text is accumulated into a running buffer and, once the stream ends
 * (`data.stop`, the upstream body closing, an upstream error, or the client disconnecting - in
 * which case whatever was generated so far is still persisted as a real, if partial, reply), handed
 * to `persistAssistantReply()`. This adds one string concatenation per event and nothing else - the
 * compact-format bytes actually written to `response` are completely unchanged either way.
 * @param {import('node-fetch').Response} upstreamResponse
 * @param {import('express').Response} response
 * @param {object} [persist] `pendingAssistantPersist`, or omit/`null` to leave behavior unchanged.
 */
export async function pipeLlamaCppCompactStream(upstreamResponse, response, persist) {
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
        let accumulatedText = '';

        function finish() {
            if (settled) return;
            settled = true;
            writer.end();

            if (persist && accumulatedText) {
                persistAssistantReply(persist, accumulatedText)
                    .catch(error => console.error('Failed to persist streamed llama.cpp assistant reply:', error))
                    .finally(() => resolve());
            } else {
                resolve();
            }
        }

        function handleEvent(/** @type {any} */ data) {
            if (!data) return;

            if (persist && typeof data.content === 'string') {
                accumulatedText += data.content;
            }

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
