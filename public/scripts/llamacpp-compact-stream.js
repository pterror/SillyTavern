/**
 * Decoder for the compact streaming wire format emitted by the server's
 * `/api/backends/text-completions/generate` route, signaled by the `X-ST-Stream-Format: compact-v1`
 * response header - originally llama.cpp-only, now also used by the general SSE-JSON text-completion
 * path. See src/endpoints/backends/llamacpp-compact-stream.js on the server for the encoder side and
 * the full protocol description.
 *
 * Plain bytes = raw UTF-8 text, appended directly to accumulated content.
 * `0xFF 0xFF`                                    = one literal content byte 0xFF (defensive escape).
 * `0xFF 0x01 <1 byte index>`                     = target/swipe index changed.
 * `0xFF 0x02 <4-byte BE length><length bytes>`    = token-probabilities payload (JSON) for the current token.
 * `0xFF 0x03 <4-byte BE length><length bytes>`    = reasoning/thinking text chunk (UTF-8), not content.
 * `0xFF 0x04 <4-byte BE length><length bytes>`    = assistant_node_id (UTF-8 string), the final frame.
 * `0xFF 0x05 <4-byte BE length><length bytes>`    = one tool-call delta (JSON).
 * `0xFF 0x06 <4-byte BE length><length bytes>`    = one generated image (JSON {mimeType, data}).
 * `0xFF 0x07 <4-byte BE length><length bytes>`    = thought signature (UTF-8 string).
 * `0xFF 0x08 <4-byte BE length><length bytes>`    = control JSON - an out-of-band signal with no
 *                                                   dedicated frame of its own (currently only the
 *                                                   server-tool-calling stream's end-of-round
 *                                                   signals: `{tool_call_handoff}`/
 *                                                   `{tool_call_aborted}`/`{error}`).
 * `0xFF 0x09`                                     = keepalive - no payload (2 bytes total). A pure
 *                                                   liveness signal for lossy connections; decoded as
 *                                                   a no-op (no event pushed) but still resets
 *                                                   `ResumableCompactStreamReader`'s stall-detection
 *                                                   timer, same as any real frame would.
 *
 * This is a private contract between ST's own server and ST's own client, not a public/supported surface.
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
export const FRAME_TYPE_KEEPALIVE = 0x09;

// Must match src/endpoints/backends/llamacpp-compact-stream.js's own KEEPALIVE_INTERVAL_MS - how often
// the server injects a keepalive frame into an in-flight raw-action stream.
export const SERVER_KEEPALIVE_INTERVAL_MS = 12 * 1000;

// How long ResumableCompactStreamReader waits for ANY frame (content or keepalive) before deciding the
// connection has silently died and proactively resuming, rather than waiting on the browser's own
// fetch/reader (which can take minutes, or never, to notice a dead socket on a lossy link). 3x the
// server's own keepalive interval: comfortably past one missed keepalive (a single slow/lost packet)
// while still being much faster than relying on OS-level detection.
export const STREAM_STALL_TIMEOUT_MS = 3 * SERVER_KEEPALIVE_INTERVAL_MS;

/**
 * @typedef {{content: string} | {index: number} | {probabilities: any} | {reasoning: string} | {assistantNodeId: string} | {toolCallDelta: any} | {image: {mimeType: string, data: string}} | {thoughtSignature: string} | {control: any}} CompactStreamEvent
 */

/**
 * Incrementally decodes compact-stream bytes into structured events, correctly handling both multi-byte
 * UTF-8 characters and control frames that are split across chunk boundaries.
 */
export class CompactStreamDecoder {
    constructor() {
        /** @type {Uint8Array} Bytes carried over from a previous push() because a frame was incomplete. */
        this.pending = new Uint8Array(0);
        this.textDecoder = new TextDecoder('utf-8', { fatal: false });
        /** @type {number} `Date.now()` of the last time push() saw any bytes at all (content, a
         * control frame, or a keepalive) - a keepalive resets this exactly like real content does,
         * since its only job is proving the connection is still alive. Read by
         * `ResumableCompactStreamReader` to detect a stalled-but-not-closed connection. */
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
     * Feeds a chunk of raw bytes into the decoder.
     * @param {Uint8Array} chunk Raw bytes received from the network
     * @returns {CompactStreamEvent[]} Structured events decoded from this chunk (plus any carried-over bytes)
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

            // buf[i] is the sentinel byte; we need at least the type byte to know what kind of frame this is.
            if (i + 1 >= buf.length) {
                flushContent();
                this.pending = buf.subarray(i);
                return events;
            }

            const type = buf[i + 1];

            if (type === FRAME_SENTINEL) {
                // Escaped literal 0xFF content byte.
                contentRuns.push(Uint8Array.of(FRAME_SENTINEL));
                i += 2;
                continue;
            }

            if (type === FRAME_TYPE_KEEPALIVE) {
                // No payload, no length prefix - just the sentinel + type byte, both already in hand
                // at this point. A no-op: no event pushed, but push()'s lastActivityAt update above
                // already counts it as activity.
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
                    } else {
                        events.push({ control: parsed });
                    }
                } catch (error) {
                    console.warn('Failed to parse compact stream tool-call/image/control frame:', error);
                }
                i += total;
                continue;
            }

            // Unknown frame type. Shouldn't happen; treat the sentinel byte itself as content so we can't
            // ever get stuck in an infinite loop on unexpected input.
            contentRuns.push(Uint8Array.of(FRAME_SENTINEL));
            i += 1;
        }

        flushContent();
        return events;
    }

    /**
     * Finalizes the decoder, flushing any trailing bytes the internal TextDecoder was still holding onto
     * while waiting for the rest of a multi-byte character. Call this once after the stream ends.
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

/**
 * Wraps a raw-action compact-stream fetch() Response's `body.getReader()` with automatic
 * resume-on-drop, exposing the exact same `{done, value}` `read()` contract so an existing consumer
 * loop (`while (true) { const {done, value} = await reader.read(); ... }`) needs no changes beyond
 * constructing this instead of calling `response.body.getReader()` directly.
 *
 * The "sequence number" a reconnect needs is just the count of raw bytes already read from
 * `response.body` - the server's generation buffer is indexed by that same byte offset (see
 * src/endpoints/backends/llamacpp-compact-stream.js's module doc comment for the full design), so no
 * wire-format change was needed to carry it.
 *
 * On a genuine drop (a network error from `reader.read()`, not the caller's own `AbortController`),
 * this calls `GET <resumeUrlBase>/<generationId>?from=<bytesReceived>`, and - if that succeeds -
 * keeps reading from its response body instead, transparently, so the SAME `CompactStreamDecoder`
 * instance the caller is feeding continues mid-frame/mid-codepoint exactly as if nothing happened.
 * If resume itself fails (expired/unknown generation buffer, server restarted, or the resume request
 * also drops after exhausting `maxResumeAttempts`), the original read error is re-thrown so the
 * caller's existing failure handling (today's "treat as a partial/failed generation" behavior) is
 * unchanged.
 *
 * STALL DETECTION: a dead connection doesn't always surface as a `reader.read()` error - on a lossy
 * link/flaky NAT/proxy, the socket can go silently dead with no RST reaching either side, so `read()`
 * would otherwise just hang forever waiting on OS-level detection (which can take minutes, or never
 * happen at all). To avoid that, every `read()` races the underlying read against a
 * `STREAM_STALL_TIMEOUT_MS` timer that only the arrival of bytes (real content OR a `0x09` keepalive
 * frame - see the server's `KEEPALIVE_INTERVAL_MS`) resets; if it fires, the stalled read is cancelled
 * and treated exactly like a genuine `reader.read()` error, going through the same resume path above.
 */
export class ResumableCompactStreamReader {
    /**
     * @param {Response} response The initial fetch() Response; its body starts being read immediately.
     * @param {string} resumeUrlBase e.g. '/api/backends/text-completions/generate/resume' - the
     * generation id and `?from=` offset are appended by this class.
     * @param {() => Record<string, string>} [getRequestHeaders] Same auth/CSRF headers the original
     * request used, re-sent on the resume GET. Omit if the resume endpoint needs none.
     * @param {number} [maxResumeAttempts] Gives up (and re-throws the last read error) after this
     * many consecutive successful-resume-but-dropped-again cycles, so a persistently bad connection
     * can't loop forever.
     * @param {number} [stallTimeoutMs] How long to wait for ANY bytes before treating the connection as
     * stalled and proactively resuming; see STALL DETECTION above.
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
     * Races `this.reader.read()` against `this.stallTimeoutMs`; on timeout, cancels the stalled reader
     * (so its underlying connection is actually torn down rather than left dangling) and throws a
     * `StreamStallError` - deliberately not named `AbortError`, so `read()`'s catch block below treats
     * it as a genuine drop rather than the caller's own intentional abort.
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
                // Loop back around and read from the newly-resumed reader.
            }
        }
    }

    /** @returns {Promise<boolean>} Whether the resume request succeeded and `this.reader` now reads its body. */
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
