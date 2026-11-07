import { EventEmitter } from 'node:events';

import { forEachBodyText, forwardFetchResponse } from '../../util.js';
import { persistAssistantReply, takeItemizationNotSaved, takeReplyNotSaved } from '../../assistant-reply-persist.js';
import { noteReplyText } from '../../reply-reasoning.js';
import { storedMessagesOf } from '../../stored-messages.js';
import { generationIdFor, isGenerationStopped } from '../../generation-stop.js';

export const FRAME_SENTINEL = 0xFF;
export const FRAME_TYPE_INDEX = 0x01;
export const FRAME_TYPE_PROBABILITIES = 0x02;
export const FRAME_TYPE_REASONING = 0x03;
export const FRAME_TYPE_ASSISTANT_NODE_ID = 0x04;
export const FRAME_TYPE_TOOL_CALL_DELTA = 0x05;
export const FRAME_TYPE_IMAGE = 0x06;
export const FRAME_TYPE_THOUGHT_SIGNATURE = 0x07;
export const FRAME_TYPE_CONTROL = 0x08;
export const FRAME_TYPE_KEEPALIVE = 0x09;

export const KEEPALIVE_INTERVAL_MS = 12 * 1000;

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

/**
 * @param {{node_id: string, mes?: string, extra?: object}|null} persisted
 * @param {object|null|undefined} persist
 * @returns {Buffer|null}
 */
export function encodeStoredReplyFrame(persisted, persist) {
    if (persisted) {
        const itemizationWarning = takeItemizationNotSaved(persist);
        const frames = [];
        if (typeof persisted.mes === 'string') {
            frames.push(encodeControlFrame({ stored_reply: { node_id: persisted.node_id, mes: persisted.mes, extra: persisted.extra ?? {} } }));
        }
        frames.push(encodeAssistantNodeIdFrame(persisted.node_id));
        if (itemizationWarning) frames.push(encodeControlFrame({ warnings: [itemizationWarning] }));
        return frames.length === 1 ? frames[0] : Buffer.concat(frames);
    }
    const warning = takeReplyNotSaved(persist);
    return warning ? encodeControlFrame({ warnings: [warning] }) : null;
}

/**
 * @param {{ write: (chunk: Buffer) => unknown }} writer
 * @param {import('express').Response} response
 */
export function writeStoredMessagesFrame(writer, response) {
    const stored = storedMessagesOf(response);
    if (stored) {
        writer.write(encodeControlFrame({ stored }));
    }
}

export function encodeKeepaliveFrame() {
    return Buffer.from([FRAME_SENTINEL, FRAME_TYPE_KEEPALIVE]);
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

const GENERATION_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
const GENERATION_CACHE_MAX = 50;
const GENERATION_TTL_MS = 10 * 60 * 1000;

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

    /** @param {Buffer} buf */
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
 * @param {{write: (buf: Buffer) => void, end: () => void}} writer
 * @param {number} [intervalMs]
 */
export function withKeepalive(writer, intervalMs = KEEPALIVE_INTERVAL_MS) {
    const keepaliveFrame = encodeKeepaliveFrame();
    let ended = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    function reschedule() {
        if (timer) clearTimeout(timer);
        if (ended) return;
        timer = setTimeout(() => {
            writer.write(keepaliveFrame);
            reschedule();
        }, intervalMs);
        timer.unref?.();
    }

    reschedule();

    return {
        write(/** @type {Buffer} */ buf) {
            if (ended) return;
            writer.write(buf);
            reschedule();
        },
        end() {
            if (ended) return;
            ended = true;
            if (timer) clearTimeout(timer);
            writer.end();
        },
    };
}

/**
 * @param {{write: (buf: Buffer) => void, end: () => void}} baseWriter
 * @param {GenerationRecord} record
 * @param {number} [intervalMs]
 * @returns {{writer: {write: (buf: Buffer) => void, end: () => void}, stopKeepalive: () => void}}
 */
export function createResumableWriter(baseWriter, record, intervalMs = KEEPALIVE_INTERVAL_MS) {
    const keepaliveWriter = withKeepalive(baseWriter, intervalMs);
    return {
        writer: withGenerationBuffer(keepaliveWriter, record),
        stopKeepalive: () => keepaliveWriter.end(),
    };
}

/**
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
 * @param {Response} upstreamResponse
 * @param {import('express').Response} response
 * @param {object} [persist]
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings]
 */
export async function pipeLlamaCppCompactStream(upstreamResponse, response, persist, warnings = null) {
    if (!upstreamResponse.ok || !upstreamResponse.body) {
        return forwardFetchResponse(upstreamResponse, response);
    }

    return new Promise((resolve) => {
        const id = generationIdFor(response);
        response.setHeader('X-ST-Stream-Format', 'compact-v1');
        response.setHeader('X-Generation-Id', id);

        const generationRecord = createGenerationRecord(id);
        const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord);
        let writer = initialWriter;
        writeStoredMessagesFrame(writer, response);
        if (warnings?.length) {
            writer.write(encodeControlFrame({ warnings }));
        }
        let sseBuffer = '';
        let lastIndex = 0;
        let settled = false;
        let accumulatedText = '';

        function finish() {
            if (settled) return;
            settled = true;

            if (persist && accumulatedText) {
                persistAssistantReply(persist, accumulatedText)
                    .then(persisted => {
                        const frame = encodeStoredReplyFrame(persisted, persist);
                        if (frame) writer.write(frame);
                    })
                    .catch(error => console.error('Failed to persist streamed llama.cpp assistant reply:', error))
                    .finally(() => {
                        writer.end();
                        resolve();
                    });
            } else {
                writer.end();
                resolve();
            }
        }

        function handleEvent(/** @type {any} */ data) {
            if (!data || isGenerationStopped(response)) return;

            if (persist && typeof data.content === 'string') {
                accumulatedText += data.content;
                noteReplyText(persist, accumulatedText);
            }

            const { bytes, index } = encodeEvent(data, lastIndex);
            lastIndex = index;
            writer.write(bytes);

            if (data.stop) {
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

        response.socket?.on('close', () => {
            stopKeepalive();
            writer = detachFromResponse(generationRecord);
        });

        forEachBodyText(upstreamResponse.body, (chunk) => {
            sseBuffer += chunk;
            processBuffer();
        }).then((error) => {
            if (error && !isGenerationStopped(response)) console.warn('llama.cpp compact stream upstream error:', error);
            processBuffer();
            finish();
        }, (error) => {
            console.warn('llama.cpp compact stream failed:', error);
            finish();
        });
    });
}
