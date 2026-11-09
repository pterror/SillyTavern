const FRAME_SENTINEL = 0xFF;
const FRAME_TYPE_INDEX = 0x01;
const FRAME_TYPE_PROBABILITIES = 0x02;
const FRAME_TYPE_REASONING = 0x03;
const FRAME_TYPE_ASSISTANT_NODE_ID = 0x04;
const FRAME_TYPE_TOOL_CALL_DELTA = 0x05;
const FRAME_TYPE_IMAGE = 0x06;
const FRAME_TYPE_THOUGHT_SIGNATURE = 0x07;
const FRAME_TYPE_CONTROL = 0x08;
const FRAME_TYPE_KEEPALIVE = 0x09;

const SERVER_KEEPALIVE_INTERVAL_MS = 12 * 1000;

const STREAM_STALL_TIMEOUT_MS = 3 * SERVER_KEEPALIVE_INTERVAL_MS;

/** @typedef {{mes: string, extra: Record<string, any>}} StoredReply */

/** @type {Map<string, StoredReply>} */
const storedReplies = new Map();
const STORED_REPLIES_MAX = 16;

/** @param {{node_id: string, mes: string, extra?: Record<string, any>}} reply */
function rememberStoredReply(reply) {
    if (typeof reply.mes !== 'string') return;
    storedReplies.delete(reply.node_id);
    storedReplies.set(reply.node_id, { mes: reply.mes, extra: reply.extra && typeof reply.extra === 'object' ? reply.extra : {} });
    for (const oldest of storedReplies.keys()) {
        if (storedReplies.size <= STORED_REPLIES_MAX) break;
        storedReplies.delete(oldest);
    }
}

/**
 * @param {string|null|undefined} nodeId
 * @returns {StoredReply|null}
 */
export function takeStoredReply(nodeId) {
    if (typeof nodeId !== 'string') return null;
    const reply = storedReplies.get(nodeId) ?? null;
    storedReplies.delete(nodeId);
    return reply;
}

/** @typedef {{content: string} | {index: number} | {probabilities: any} | {reasoning: string} | {assistantNodeId: string} | {toolCallDelta: any} | {image: {mimeType: string, data: string}} | {thoughtSignature: string} | {control: any}} CompactStreamEvent */

export class CompactStreamDecoder {
    constructor() {
        /** @type {Uint8Array} */
        this.pending = new Uint8Array(0);
        this.textDecoder = new TextDecoder('utf-8', { fatal: false });
        /** @type {number} */
        this.lastActivityAt = Date.now();
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {Uint8Array}
     */
    static concat(a, b) {
        if (a.length === 0) return b;
        if (b.length === 0) return a;
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    /**
     * @param {Uint8Array} chunk
     * @returns {CompactStreamEvent[]}
     */
    push(chunk) {
        if (chunk?.length) this.lastActivityAt = Date.now();

        const buf = CompactStreamDecoder.concat(this.pending, chunk);
        this.pending = new Uint8Array(0);

        /** @type {CompactStreamEvent[]} */
        const events = [];
        /** @type {Uint8Array[]} */
        let contentRuns = [];

        const flushContent = () => {
            if (contentRuns.length === 0) return;
            const merged = contentRuns.length === 1 ? contentRuns[0] : CompactStreamDecoder.concatAll(contentRuns);
            contentRuns = [];
            const text = this.textDecoder.decode(merged, { stream: true });
            if (text.length) events.push({ content: text });
        };

        let i = 0;
        while (i < buf.length) {
            if (buf[i] !== FRAME_SENTINEL) {
                let j = i + 1;
                while (j < buf.length && buf[j] !== FRAME_SENTINEL) j++;
                contentRuns.push(buf.subarray(i, j));
                i = j;
                continue;
            }

            if (i + 1 >= buf.length) {
                flushContent();
                this.pending = buf.subarray(i);
                return events;
            }

            const type = buf[i + 1];

            if (type === FRAME_SENTINEL) {
                contentRuns.push(Uint8Array.of(FRAME_SENTINEL));
                i += 2;
                continue;
            }

            if (type === FRAME_TYPE_KEEPALIVE) {
                flushContent();
                i += 2;
                continue;
            }

            if (type === FRAME_TYPE_INDEX) {
                if (i + 2 >= buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                flushContent();
                events.push({ index: buf[i + 2] });
                i += 3;
                continue;
            }

            if (type === FRAME_TYPE_PROBABILITIES) {
                if (i + 6 > buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                const len = ((buf[i + 2] << 24) | (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5]) >>> 0;
                const total = 6 + len;
                if (i + total > buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                flushContent();
                const jsonBytes = buf.subarray(i + 6, i + total);
                try {
                    events.push({ probabilities: JSON.parse(new TextDecoder('utf-8').decode(jsonBytes)) });
                } catch (error) {
                    console.warn('Failed to parse compact stream probabilities frame:', error);
                }
                i += total;
                continue;
            }

            if (type === FRAME_TYPE_REASONING || type === FRAME_TYPE_ASSISTANT_NODE_ID || type === FRAME_TYPE_THOUGHT_SIGNATURE) {
                if (i + 6 > buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                const len = ((buf[i + 2] << 24) | (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5]) >>> 0;
                const total = 6 + len;
                if (i + total > buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                flushContent();
                const textBytes = buf.subarray(i + 6, i + total);
                const text = new TextDecoder('utf-8').decode(textBytes);
                if (type === FRAME_TYPE_REASONING) {
                    events.push({ reasoning: text });
                } else if (type === FRAME_TYPE_ASSISTANT_NODE_ID) {
                    events.push({ assistantNodeId: text });
                } else {
                    events.push({ thoughtSignature: text });
                }
                i += total;
                continue;
            }

            if (type === FRAME_TYPE_TOOL_CALL_DELTA || type === FRAME_TYPE_IMAGE || type === FRAME_TYPE_CONTROL) {
                if (i + 6 > buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                const len = ((buf[i + 2] << 24) | (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5]) >>> 0;
                const total = 6 + len;
                if (i + total > buf.length) {
                    flushContent();
                    this.pending = buf.subarray(i);
                    return events;
                }
                flushContent();
                const jsonBytes = buf.subarray(i + 6, i + total);
                try {
                    const parsed = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
                    if (type === FRAME_TYPE_TOOL_CALL_DELTA) {
                        events.push({ toolCallDelta: parsed });
                    } else if (type === FRAME_TYPE_IMAGE) {
                        events.push({ image: parsed });
                    } else if (parsed?.stored_reply && typeof parsed.stored_reply.node_id === 'string') {
                        rememberStoredReply(parsed.stored_reply);
                    } else {
                        events.push({ control: parsed });
                    }
                } catch (error) {
                    console.warn('Failed to parse compact stream tool-call/image/control frame:', error);
                }
                i += total;
                continue;
            }

            contentRuns.push(Uint8Array.of(FRAME_SENTINEL));
            i += 1;
        }

        flushContent();
        return events;
    }

    /**
     * @returns {CompactStreamEvent[]}
     */
    flush() {
        const text = this.textDecoder.decode();
        return text.length ? [{ content: text }] : [];
    }

    /**
     * @param {Uint8Array[]} arrays
     * @returns {Uint8Array}
     */
    static concatAll(arrays) {
        const length = arrays.reduce((sum, a) => sum + a.length, 0);
        const out = new Uint8Array(length);
        let offset = 0;
        for (const a of arrays) {
            out.set(a, offset);
            offset += a.length;
        }
        return out;
    }
}

export class ResumableCompactStreamReader {
    /**
     * @param {Response} response
     * @param {string} resumeUrlBase
     * @param {() => Record<string, string>} [getRequestHeaders]
     * @param {number} [maxResumeAttempts]
     * @param {number} [stallTimeoutMs]
     */
    constructor(response, resumeUrlBase, getRequestHeaders = null, maxResumeAttempts = 5, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS) {
        this.reader = response.body.getReader();
        this.generationId = response.headers.get('X-Generation-Id');
        this.resumeUrlBase = resumeUrlBase;
        this.getRequestHeaders = getRequestHeaders;
        this.maxResumeAttempts = maxResumeAttempts;
        this.stallTimeoutMs = stallTimeoutMs;
        this.bytesReceived = 0;
        this.resumeAttempts = 0;
        this.gaveUp = false;
    }

    /**
     * @returns {Promise<{done: boolean, value: Uint8Array | undefined}>}
     */
    async readWithStallTimeout() {
        let timer;
        const stalled = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`No data received for ${this.stallTimeoutMs}ms; treating connection as stalled`);
                error.name = 'StreamStallError';
                reject(error);
            }, this.stallTimeoutMs);
        });

        try {
            return await Promise.race([this.reader.read(), stalled]);
        } catch (error) {
            if (error?.name === 'StreamStallError') {
                this.reader.cancel().catch(() => { });
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /** @returns {Promise<{done: boolean, value: Uint8Array | undefined}>} */
    async read() {
        for (; ;) {
            try {
                const result = await this.readWithStallTimeout();
                if (result.value) this.bytesReceived += result.value.length;
                return result;
            } catch (error) {
                if (error?.name === 'AbortError' || !this.generationId || this.gaveUp) throw error;
                if (this.resumeAttempts >= this.maxResumeAttempts) {
                    this.gaveUp = true;
                    throw error;
                }
                this.resumeAttempts++;
                const resumed = await this.tryResume();
                if (!resumed) {
                    this.gaveUp = true;
                    throw error;
                }
            }
        }
    }

    /** @returns {Promise<boolean>} */
    async tryResume() {
        try {
            const url = `${this.resumeUrlBase}/${encodeURIComponent(this.generationId)}?from=${this.bytesReceived}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: this.getRequestHeaders?.() ?? undefined,
            });
            if (!response.ok || !response.body) return false;
            this.reader = response.body.getReader();
            return true;
        } catch (error) {
            return false;
        }
    }
}
