/**
 * Decoder for the compact llama.cpp streaming wire format emitted by the server's
 * `/api/backends/text-completions/generate` route (llama.cpp raw-completions path only, signaled by the
 * `X-ST-Stream-Format: compact-v1` response header). See src/endpoints/backends/llamacpp-compact-stream.js
 * on the server for the encoder side and the full protocol description.
 *
 * Plain bytes = raw UTF-8 text, appended directly to accumulated content.
 * `0xFF 0xFF`                                    = one literal content byte 0xFF (defensive escape).
 * `0xFF 0x01 <1 byte index>`                     = target/swipe index changed.
 * `0xFF 0x02 <4-byte BE length><length bytes>`    = token-probabilities payload (JSON) for the current token.
 *
 * This is a private contract between ST's own server and ST's own client, not a public/supported surface.
 */
export const FRAME_SENTINEL = 0xFF;
export const FRAME_TYPE_INDEX = 0x01;
export const FRAME_TYPE_PROBABILITIES = 0x02;

/**
 * @typedef {{content: string} | {index: number} | {probabilities: any}} CompactStreamEvent
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
