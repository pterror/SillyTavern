import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { forwardFetchResponse } from '../../util.js';
import { persistAssistantReply } from '../../assistant-reply-persist.js';

/**
 * Compact wire protocol, originally for the llama.cpp raw-completions streaming path, now also used
 * by every other raw-action streaming backend (text-completions.js's forwardAndPersistCompactStream(),
 * chat-completions.js's own copy, kobold.js, novelai.js) - same encoder/decoder, since all of them are
 * ultimately "content text plus a handful of out-of-band signals."
 *
 * Plain bytes = raw UTF-8 text, appended directly to accumulated content.
 * `0xFF 0xFF`                                   = literal content byte 0xFF (escape).
 * `0xFF 0x01 <1 byte index>`                    = target/swipe index changed.
 * `0xFF 0x02 <4-byte BE length><length bytes>`  = token-probabilities JSON payload.
 * `0xFF 0x03 <4-byte BE length><length bytes>`  = reasoning/thinking text chunk (UTF-8), not content.
 * `0xFF 0x04 <4-byte BE length><length bytes>`  = assistant_node_id (UTF-8 string), sent once, at the
 *                                                 very end, once persistence is known - must be the
 *                                                 LAST frame before the stream ends, since the
 *                                                 client's stream reader stops at the natural end of
 *                                                 the byte stream rather than a sentinel line.
 * `0xFF 0x05 <4-byte BE length><length bytes>`  = one tool-call delta (JSON, the same per-chunk shape
 *                                                 ToolManager.parseToolCalls() already accepts client-
 *                                                 side - {index, id?, type?, function:{name?,arguments?}}).
 * `0xFF 0x06 <4-byte BE length><length bytes>`  = one generated image (JSON {mimeType, data} - `data`
 *                                                 is base64, matching the shape image consumers already
 *                                                 expect as a data: URL body).
 * `0xFF 0x07 <4-byte BE length><length bytes>`  = thought signature (UTF-8 string) - Gemini's opaque
 *                                                 token for continuing a thinking turn across requests.
 * `0xFF 0x08 <4-byte BE length><length bytes>`  = control JSON - an out-of-band signal that isn't
 *                                                 generated content, a tool-call delta, or any of the
 *                                                 above, and has no dedicated frame type of its own.
 *                                                 Used by chat-completions.js's server-tool-calling
 *                                                 stream loop (forwardAndPersistCompactStreamWithServerTools())
 *                                                 for its three end-of-round signals - the payload is
 *                                                 always one of `{tool_call_handoff: {node_id,
 *                                                 pending_tool_calls}}`, `{tool_call_aborted: true}`, or
 *                                                 `{error: {message}}`.
 *
 * Private contract with the bundled client; not a public/supported surface.
 *
 * RESUMABILITY: every raw-action generation is buffered server-side, keyed by its `X-Generation-Id`
 * (see `createGenerationRecord()`/`withGenerationBuffer()` below), so a client that drops mid-stream
 * can reconnect and ask for what it's missing. No new frame type or sequence-number field was added
 * for this: the sequence number IS the raw byte offset into the compact-stream byte sequence the
 * server already writes to the response, which the client already needs to count as it reads
 * `response.body` chunks - a length-prefix/periodic-marker scheme would just be redundant with that.
 * A reconnecting client calls `GET /generate/resume/:id?from=<bytesReceivedSoFar>`, which replays the
 * exact buffered bytes from that offset (then keeps streaming live ones if the generation is still in
 * flight) into the SAME decoder instance the dropped connection was feeding, so split multi-byte
 * UTF-8 characters and control frames straddling the resume boundary decode correctly. See
 * `streamGenerationResume()`.
 */
export const FRAME_SENTINEL = 0xFF;
export const FRAME_TYPE_INDEX = 0x01;
export const FRAME_TYPE_PROBABILITIES = 0x02;
export const FRAME_TYPE_REASONING = 0x03;
export const FRAME_TYPE_ASSISTANT_NODE_ID = 0x04;
export const FRAME_TYPE_TOOL_CALL_DELTA = 0x05;
export const FRAME_TYPE_IMAGE = 0x06;
export const FRAME_TYPE_THOUGHT_SIGNATURE = 0x07;
export const FRAME_TYPE_CONTROL = 0x08;

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

export function encodeThoughtSignatureFrame(signature) {
    return encodeLengthPrefixedTextFrame(FRAME_TYPE_THOUGHT_SIGNATURE, signature);
}

function encodeLengthPrefixedJsonFrame(type, data) {
    const json = Buffer.from(JSON.stringify(data), 'utf-8');
    const header = Buffer.alloc(6);
    header[0] = FRAME_SENTINEL;
    header[1] = type;
    header.writeUInt32BE(json.length, 2);
    return Buffer.concat([header, json]);
}

export function encodeToolCallDeltaFrame(delta) {
    return encodeLengthPrefixedJsonFrame(FRAME_TYPE_TOOL_CALL_DELTA, delta);
}

export function encodeImageFrame(image) {
    return encodeLengthPrefixedJsonFrame(FRAME_TYPE_IMAGE, image);
}

export function encodeControlFrame(data) {
    return encodeLengthPrefixedJsonFrame(FRAME_TYPE_CONTROL, data);
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

// Bounds how much of one generation's raw compact-stream bytes are kept around for a resume - once a
// generation's buffered bytes exceed this, it's marked `truncated` and stops growing (the live stream
// itself is completely unaffected; only the ability to resume past this point is lost). Mirrors
// META_CACHE_MAX/META_TTL_MS's role above, for the same "don't buffer unboundedly" reason.
const GENERATION_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
const GENERATION_CACHE_MAX = 50;
const GENERATION_TTL_MS = 10 * 60 * 1000;

/** One in-flight or recently-finished generation's buffered bytes, resumable by `id`. */
class GenerationRecord extends EventEmitter {
    constructor(id) {
        super();
        this.id = id;
        /** @type {Buffer[]} */
        this.chunks = [];
        this.storedBytes = 0;
        this.truncated = false;
        this.finished = false;
        this.storedAt = Date.now();
    }

    /** @param {Buffer} buf Exactly what was just written to the live response. */
    append(buf) {
        if (!buf || !buf.length) return;
        this.storedAt = Date.now();
        if (!this.truncated) {
            if (this.storedBytes + buf.length > GENERATION_BUFFER_MAX_BYTES) {
                this.truncated = true;
            } else {
                this.chunks.push(buf);
                this.storedBytes += buf.length;
            }
        }
        this.emit('data', buf);
    }

    finish() {
        if (this.finished) return;
        this.finished = true;
        this.storedAt = Date.now();
        this.emit('end');
    }
}

/** @type {Map<string, GenerationRecord>} */
const generationBuffers = new Map();

function evictStaleGenerationRecords() {
    const now = Date.now();
    for (const [key, record] of generationBuffers) {
        if (record.finished && now - record.storedAt > GENERATION_TTL_MS) {
            generationBuffers.delete(key);
        }
    }
    while (generationBuffers.size >= GENERATION_CACHE_MAX) {
        const oldestKey = generationBuffers.keys().next().value;
        if (oldestKey === undefined) break;
        generationBuffers.delete(oldestKey);
    }
}

/**
 * Registers a new resumable generation buffer under `id` (the same id already sent as
 * `X-Generation-Id`). Call once per raw-action stream, before the first byte is written.
 * @param {string} id
 * @returns {GenerationRecord}
 */
export function createGenerationRecord(id) {
    evictStaleGenerationRecords();
    const record = new GenerationRecord(id);
    generationBuffers.set(id, record);
    return record;
}

/** @returns {GenerationRecord | null} */
export function getGenerationRecord(id) {
    return generationBuffers.get(id) ?? null;
}

/**
 * Wraps a writer (`createBackpressureWriter()`'s return value, or any `{write, end}` pair with that
 * same contract) so every byte it actually writes is also appended to `record`, and `end()` also
 * marks the generation finished. Purely additive - the wrapped writer's own behavior/timing toward
 * `res` is completely unchanged.
 * @param {{write: (buf: Buffer) => void, end: () => void}} writer
 * @param {GenerationRecord} record
 */
export function withGenerationBuffer(writer, record) {
    return {
        write(/** @type {Buffer} */ buf) {
            record.append(buf);
            writer.write(buf);
        },
        end() {
            record.finish();
            writer.end();
        },
    };
}

/**
 * A `{write, end}` writer that only appends to `record` - no longer touches a real response at all.
 * Swapped in for the real writer once the client's own connection has genuinely gone, so the
 * still-in-flight upstream generation can keep running and buffering into `record` (for a later
 * `/generate/resume/:id` call, and for normal persistence once it completes) without writing to, or
 * erroring on, a dead socket.
 * @param {GenerationRecord} record
 */
export function detachFromResponse(record) {
    return {
        write(/** @type {Buffer} */ buf) {
            record.append(buf);
        },
        end() {
            record.finish();
        },
    };
}

/**
 * Serves a resume request against `record`: replays whatever's buffered from byte offset `fromByte`
 * onward, then - if the generation is still in flight - keeps forwarding new bytes live until it
 * finishes, at which point it ends `writer` itself. The caller is responsible for ending `writer`
 * only in the synchronous-completion case (`live: false`); for `live: true` it is ended for you.
 * @param {GenerationRecord} record
 * @param {number} fromByte
 * @param {{write: (buf: Buffer) => void, end: () => void}} writer
 * @returns {{ok: true, live: boolean, cancel?: () => void} | {ok: false, reason: string}}
 */
export function streamGenerationResume(record, fromByte, writer) {
    if (!Number.isInteger(fromByte) || fromByte < 0 || fromByte > record.storedBytes) {
        return { ok: false, reason: 'invalid_offset' };
    }
    if (record.truncated) {
        // The buffer stopped growing before this generation finished - there is no way to guarantee
        // a gap-free replay past the truncation point, so refuse the whole resume rather than risk
        // silently dropping bytes. The client falls back to treating this as a failed generation.
        return { ok: false, reason: 'buffer_truncated' };
    }

    let offset = 0;
    for (const chunk of record.chunks) {
        const chunkEnd = offset + chunk.length;
        if (chunkEnd > fromByte) {
            writer.write(chunk.subarray(Math.max(0, fromByte - offset)));
        }
        offset = chunkEnd;
    }

    if (record.finished) {
        writer.end();
        return { ok: true, live: false };
    }

    const onData = (/** @type {Buffer} */ buf) => writer.write(buf);
    const onEnd = () => {
        cancel();
        writer.end();
    };
    function cancel() {
        record.off('data', onData);
        record.off('end', onEnd);
    }
    record.on('data', onData);
    record.on('end', onEnd);

    return { ok: true, live: true, cancel };
}

/**
 * Express handler for `GET /generate/resume/:id?from=<byte offset>` - mounted identically by both
 * text-completions.js and chat-completions.js's routers, since generation ids are unique regardless
 * of which backend produced them (this module's `generationBuffers` map is shared process state).
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 */
export function handleGenerationResume(request, response) {
    const record = getGenerationRecord(request.params.id);
    if (!record) {
        return response.status(404).json({ error: 'unknown_generation' });
    }

    const fromByte = Number(request.query.from ?? 0);
    const writer = createBackpressureWriter(response);
    response.setHeader('X-ST-Stream-Format', 'compact-v1');

    const result = streamGenerationResume(record, fromByte, writer);
    if (!result.ok) {
        return response.status(410).json({ error: result.reason });
    }

    if (result.live) {
        response.socket?.once('close', () => result.cancel?.());
    }
}

/** Coalesces writes while waiting for `drain` under backpressure. */
export function createBackpressureWriter(res) {
    /** @type {Buffer[]} */
    let pending = [];
    let waitingDrain = false;
    let ended = false;

    function flush() {
        if (waitingDrain || ended || pending.length === 0 || res.writableEnded) return;

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
            // `res.writableEnded` guards against a real client-disconnect race: the underlying
            // socket can close (and this writer's caller may not yet have reacted to that) between
            // one write() call and the next, and writing to an already-ended response throws
            // ERR_STREAM_WRITE_AFTER_END.
            if (ended || res.writableEnded || !buf || !buf.length) return;
            pending.push(buf);
            flush();
        },
        end() {
            if (ended) return;
            ended = true;
            if (res.writableEnded) {
                pending = [];
                return;
            }
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

        const generationRecord = createGenerationRecord(id);
        let writer = withGenerationBuffer(createBackpressureWriter(response), generationRecord);
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
            // The client's own connection dropped - keep consuming the still-in-flight upstream
            // generation into the resumable buffer (module doc comment above) instead of tearing it
            // down, so a client that reconnects via GET /generate/resume/:id gets the live
            // continuation rather than just whatever streamed before the drop. `finish()` still runs,
            // persisting the full reply, once the upstream body actually ends on its own below.
            writer = detachFromResponse(generationRecord);
        });
    });
}
