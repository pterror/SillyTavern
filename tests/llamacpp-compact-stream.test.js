import { describe, test, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import path from 'node:path';

import {
    FRAME_SENTINEL,
    FRAME_TYPE_INDEX,
    FRAME_TYPE_PROBABILITIES,
    encodeContent,
    encodeIndexFrame,
    encodeProbabilitiesFrame,
    encodeEvent,
    pipeLlamaCppCompactStream,
    getLlamaCppStreamMeta,
} from '../src/endpoints/backends/llamacpp-compact-stream.js';

import { CompactStreamDecoder } from '../public/scripts/llamacpp-compact-stream.js';

/**
 * @param {Buffer|Uint8Array} bytes
 * @param {number[]} chunkSizes
 */
function decodeInChunks(bytes, chunkSizes) {
    const decoder = new CompactStreamDecoder();
    const events = [];
    let offset = 0;
    let sizeIdx = 0;
    while (offset < bytes.length) {
        const size = chunkSizes[Math.min(sizeIdx, chunkSizes.length - 1)];
        sizeIdx++;
        const chunk = bytes.subarray(offset, offset + size);
        offset += size;
        events.push(...decoder.push(chunk));
    }
    events.push(...decoder.flush());
    return events;
}

function replay(events) {
    let currentIndex = 0;
    let text = '';
    const swipes = {};
    const probPairings = [];
    let pending = null;
    for (const event of events) {
        if ('index' in event) {
            currentIndex = event.index;
        } else if ('probabilities' in event) {
            pending = event.probabilities;
        } else if ('content' in event) {
            if (currentIndex > 0) {
                swipes[currentIndex - 1] = (swipes[currentIndex - 1] || '') + event.content;
            } else {
                text += event.content;
            }
            if (pending !== null) {
                probPairings.push({ text: event.content, probabilities: pending });
                pending = null;
            }
        }
    }
    return { text, swipes, probPairings };
}

describe('encodeContent', () => {
    test('empty/undefined text yields zero bytes', () => {
        expect(encodeContent('')).toEqual(Buffer.alloc(0));
        expect(encodeContent(undefined)).toEqual(Buffer.alloc(0));
    });

    test('plain ASCII passes through unchanged', () => {
        expect(encodeContent('hello world')).toEqual(Buffer.from('hello world', 'utf-8'));
    });

    test('multi-byte UTF-8 (emoji, CJK) passes through unchanged', () => {
        const text = 'héllo 世界 🎉';
        expect(encodeContent(text)).toEqual(Buffer.from(text, 'utf-8'));
    });

    test('a literal 0xFF byte in the raw buffer gets escaped as 0xFF 0xFF', () => {
        const raw = Buffer.from([0x61, FRAME_SENTINEL, 0x62, FRAME_SENTINEL, FRAME_SENTINEL, 0x63]);
        const out = [];
        for (const byte of raw) {
            out.push(byte);
            if (byte === FRAME_SENTINEL) out.push(FRAME_SENTINEL);
        }
        expect(Buffer.from(out)).toEqual(Buffer.from([0x61, 0xFF, 0xFF, 0x62, 0xFF, 0xFF, 0xFF, 0xFF, 0x63]));
    });
});

describe('encodeIndexFrame / encodeProbabilitiesFrame', () => {
    test('index frame is sentinel, type, 1-byte index', () => {
        expect(encodeIndexFrame(3)).toEqual(Buffer.from([FRAME_SENTINEL, FRAME_TYPE_INDEX, 3]));
    });

    test('index masks to a single byte', () => {
        expect(encodeIndexFrame(256 + 5)).toEqual(Buffer.from([FRAME_SENTINEL, FRAME_TYPE_INDEX, 5]));
    });

    test('probabilities frame header carries a correct 4-byte BE length', () => {
        const probs = [{ tok_str: 'a', prob: 0.5 }];
        const json = JSON.stringify(probs);
        const frame = encodeProbabilitiesFrame(probs);
        expect(frame[0]).toBe(FRAME_SENTINEL);
        expect(frame[1]).toBe(FRAME_TYPE_PROBABILITIES);
        expect(frame.readUInt32BE(2)).toBe(Buffer.byteLength(json, 'utf-8'));
        expect(frame.subarray(6).toString('utf-8')).toBe(json);
    });

    test('probabilities payload can itself legitimately contain 0xFF-adjacent byte patterns without corrupting length framing', () => {
        const probs = Array.from({ length: 5000 }, (_, i) => ({ tok_str: `tok${i}`, prob: Math.random() }));
        const frame = encodeProbabilitiesFrame(probs);
        const len = frame.readUInt32BE(2);
        expect(frame.length).toBe(6 + len);
        expect(JSON.parse(frame.subarray(6).toString('utf-8'))).toEqual(probs);
    });
});

describe('encodeEvent', () => {
    test('index frame is only emitted when the index actually changes', () => {
        const first = encodeEvent({ index: 0, content: 'a' }, 0);
        expect(first.bytes).toEqual(Buffer.from('a', 'utf-8'));
        expect(first.index).toBe(0);

        const second = encodeEvent({ index: 1, content: 'b' }, first.index);
        expect(second.bytes).toEqual(Buffer.concat([encodeIndexFrame(1), Buffer.from('b', 'utf-8')]));
        expect(second.index).toBe(1);
    });

    test('probabilities are placed before content, index before probabilities', () => {
        const { bytes } = encodeEvent({ index: 2, content: 'x', completion_probabilities: [{ a: 1 }] }, 0);
        const expected = Buffer.concat([
            encodeIndexFrame(2),
            encodeProbabilitiesFrame([{ a: 1 }]),
            Buffer.from('x', 'utf-8'),
        ]);
        expect(bytes).toEqual(expected);
    });

    test('an event with no content, no index change, and no probabilities encodes to zero bytes', () => {
        const { bytes, index } = encodeEvent({ index: 0 }, 0);
        expect(bytes.length).toBe(0);
        expect(index).toBe(0);
    });

    test('empty completion_probabilities array is not encoded as a frame', () => {
        const { bytes } = encodeEvent({ index: 0, content: 'a', completion_probabilities: [] }, 0);
        expect(bytes).toEqual(Buffer.from('a', 'utf-8'));
    });

    test('missing index on the event defaults to 0', () => {
        const { index } = encodeEvent({ content: 'a' }, 0);
        expect(index).toBe(0);
    });
});

describe('CompactStreamDecoder - single push, whole buffer at once', () => {
    test('decodes plain text', () => {
        const bytes = encodeContent('hello');
        const events = decodeInChunks(bytes, [bytes.length]);
        expect(events).toEqual([{ content: 'hello' }]);
    });

    test('decodes an index frame', () => {
        const bytes = encodeIndexFrame(7);
        const events = decodeInChunks(bytes, [bytes.length]);
        expect(events).toEqual([{ index: 7 }]);
    });

    test('decodes a probabilities frame', () => {
        const probs = [{ tok_str: 'a', prob: 0.9 }];
        const bytes = encodeProbabilitiesFrame(probs);
        const events = decodeInChunks(bytes, [bytes.length]);
        expect(events).toEqual([{ probabilities: probs }]);
    });

    test('an escaped literal 0xFF content byte is NOT round-tripped to U+00FF - it becomes U+FFFD', () => {
        const bytes = Buffer.from([0x61, FRAME_SENTINEL, FRAME_SENTINEL, 0x62]);
        const events = decodeInChunks(bytes, [bytes.length]);
        expect(events).toEqual([{ content: 'a�b' }]);
    });

    test('an unknown frame type byte is recovered as a literal content byte, not an infinite loop / crash', () => {
        const bytes = Buffer.from([0x61, FRAME_SENTINEL, 0x99, 0x62]);
        const events = decodeInChunks(bytes, [bytes.length]);
        const text = events.filter(e => 'content' in e).map(e => e.content).join('');
        expect(text.startsWith('a')).toBe(true);
        expect(text.endsWith('b')).toBe(true);
    });
});

describe('CompactStreamDecoder - chunk boundaries splitting a frame or multi-byte char', () => {
    test('multi-byte UTF-8 character split byte-by-byte across pushes reassembles correctly', () => {
        const text = 'a🎉世界b';
        const bytes = encodeContent(text);
        const events = decodeInChunks(bytes, [1]);
        const joined = events.map(e => e.content).join('');
        expect(joined).toBe(text);
    });

    test('index frame split at every possible byte boundary decodes correctly', () => {
        const bytes = encodeIndexFrame(42);
        for (let split = 1; split < bytes.length; split++) {
            const events = decodeInChunks(bytes, [split, bytes.length - split]);
            expect(events).toEqual([{ index: 42 }]);
        }
    });

    test('probabilities frame split at every possible byte boundary decodes correctly', () => {
        const probs = [{ tok_str: 'hello', prob: 0.123 }, { tok_str: 'world', prob: 0.456 }];
        const bytes = encodeProbabilitiesFrame(probs);
        for (let split = 1; split < bytes.length; split++) {
            const events = decodeInChunks(bytes, [split, bytes.length - split]);
            expect(events).toEqual([{ probabilities: probs }]);
        }
    });

    test('probabilities frame split byte-by-byte (worst case, many pending carry-overs) decodes correctly', () => {
        const probs = [{ tok_str: 'x', prob: 1 }];
        const bytes = encodeProbabilitiesFrame(probs);
        const events = decodeInChunks(bytes, [1]);
        expect(events).toEqual([{ probabilities: probs }]);
    });

    test('escaped 0xFF split so the two sentinel bytes land in different chunks still decodes consistently with the unsplit case', () => {
        const bytes = Buffer.from([0x61, FRAME_SENTINEL, FRAME_SENTINEL, 0x62]);
        const events = decodeInChunks(bytes, [2, 2]);
        const joined = events.map(e => e.content).join('');
        expect(joined).toBe('a�b');
    });

    test('a run of content immediately followed by a control frame, chunked at the exact boundary', () => {
        const bytes = Buffer.concat([Buffer.from('hi ', 'utf-8'), encodeIndexFrame(1), Buffer.from('there', 'utf-8')]);
        const events = decodeInChunks(bytes, [3, bytes.length - 3]);
        expect(events).toEqual([{ content: 'hi ' }, { index: 1 }, { content: 'there' }]);
    });
});

describe('CompactStreamDecoder - empty tokens', () => {
    test('an event with truly empty content produces no content event at all', () => {
        const bytes = encodeContent('');
        const events = decodeInChunks(bytes, [1]);
        expect(events).toEqual([]);
    });

    test('back-to-back index-only frames with nothing else produce only index events', () => {
        const bytes = Buffer.concat([encodeIndexFrame(1), encodeIndexFrame(2), encodeIndexFrame(3)]);
        const events = decodeInChunks(bytes, [4]);
        expect(events).toEqual([{ index: 1 }, { index: 2 }, { index: 3 }]);
    });
});

describe('end-to-end encode -> decode round trip against realistic llama.cpp SSE event sequences', () => {
    /**
     * @param {any[]} sseEvents
     * @param {number[]} chunkSizes
     */
    function roundTrip(sseEvents, chunkSizes) {
        let lastIndex = 0;
        const parts = [];
        for (const data of sseEvents) {
            const { bytes, index } = encodeEvent(data, lastIndex);
            lastIndex = index;
            parts.push(bytes);
        }
        const full = Buffer.concat(parts);
        return decodeInChunks(full, chunkSizes);
    }

    test('single-completion stream (no swipes, no probabilities) reconstructs full text', () => {
        const sseEvents = [
            { index: 0, content: 'The ' },
            { index: 0, content: 'quick ' },
            { index: 0, content: 'brown fox' },
            { index: 0, content: '', stop: true },
        ];
        const events = roundTrip(sseEvents, [7]);
        const { text } = replay(events);
        expect(text).toBe('The quick brown fox');
    });

    test('multi-completion (swipe) stream keeps each index separate', () => {
        const sseEvents = [
            { index: 0, content: 'main ' },
            { index: 1, content: 'alt-one ' },
            { index: 0, content: 'text' },
            { index: 1, content: 'continues' },
        ];
        const events = roundTrip(sseEvents, [3]);
        const { text, swipes } = replay(events);
        expect(text).toBe('main text');
        expect(swipes[0]).toBe('alt-one continues');
    });

    test('probabilities pair with the content of the same server event when content is non-empty', () => {
        const sseEvents = [
            { index: 0, content: 'foo', completion_probabilities: [{ tok_str: 'foo', prob: 0.7 }] },
            { index: 0, content: 'bar', completion_probabilities: [{ tok_str: 'bar', prob: 0.3 }] },
        ];
        const events = roundTrip(sseEvents, [5]);
        const { probPairings } = replay(events);
        expect(probPairings).toEqual([
            { text: 'foo', probabilities: [{ tok_str: 'foo', prob: 0.7 }] },
            { text: 'bar', probabilities: [{ tok_str: 'bar', prob: 0.3 }] },
        ]);
    });

    test('probabilities pair with the whole token text when that token arrives as a single decoder chunk (the common case)', () => {
        const sseEvents = [
            { index: 0, content: 'foo', completion_probabilities: [{ tok_str: 'foo', prob: 0.7 }] },
            { index: 0, content: 'bar-token', completion_probabilities: [{ tok_str: 'bar-token', prob: 0.3 }] },
        ];
        const events = roundTrip(sseEvents, [1024]);
        const { probPairings } = replay(events);
        expect(probPairings).toEqual([
            { text: 'foo', probabilities: [{ tok_str: 'foo', prob: 0.7 }] },
            { text: 'bar-token', probabilities: [{ tok_str: 'bar-token', prob: 0.3 }] },
        ]);
    });

    test('a token with probabilities but empty content silently reassigns its probabilities to the next token (protocol gap, not a crash)', () => {
        const sseEvents = [
            { index: 0, content: '', completion_probabilities: [{ tok_str: '', prob: 0.99 }] },
            { index: 0, content: 'first-real-token' },
        ];
        const events = roundTrip(sseEvents, [1024]);
        const { probPairings, text } = replay(events);
        expect(text).toBe('first-real-token');
        expect(probPairings).toEqual([
            { text: 'first-real-token', probabilities: [{ tok_str: '', prob: 0.99 }] },
        ]);
    });

    test('network fragmentation mid-token can pair probabilities with only a prefix of that token\'s text (protocol gap, not a crash)', () => {
        const sseEvents = [
            { index: 0, content: 'first-real-token', completion_probabilities: [{ tok_str: 'first-real-token', prob: 0.5 }] },
        ];
        const events = roundTrip(sseEvents, [4]);
        const { probPairings, text } = replay(events);
        expect(text).toBe('first-real-token');
        expect(probPairings).toEqual([
            { text: 'fir', probabilities: [{ tok_str: 'first-real-token', prob: 0.5 }] },
        ]);
    });

    test('literal sentinel-byte-producing content (surrogate-pair emoji) round-trips exactly across split chunks', () => {
        const sseEvents = [
            { index: 0, content: '🎉' },
            { index: 0, content: '🚀 more 世界 text' },
        ];
        for (let split = 1; split < 8; split++) {
            const events = roundTrip(sseEvents, [split]);
            const { text } = replay(events);
            expect(text).toBe('🎉🚀 more 世界 text');
        }
    });

    test('a long realistic token stream with interleaved index changes and probabilities round-trips byte-by-byte', () => {
        const sseEvents = [];
        for (let i = 0; i < 50; i++) {
            sseEvents.push({ index: 0, content: `tok${i} `, completion_probabilities: [{ tok_str: `tok${i}`, prob: Math.random() }] });
            if (i % 10 === 0) {
                sseEvents.push({ index: 1, content: `swipe${i} ` });
            }
        }
        sseEvents.push({ index: 0, content: '', stop: true });

        const events = roundTrip(sseEvents, [1]);
        const { text, swipes } = replay(events);

        const expectedText = sseEvents.filter(e => e.index === 0).map(e => e.content).join('');
        const expectedSwipe = sseEvents.filter(e => e.index === 1).map(e => e.content).join('');
        expect(text).toBe(expectedText);
        expect(swipes[0]).toBe(expectedSwipe);
    });
});

describe('CompactStreamDecoder.flush()', () => {
    test('flushes a trailing incomplete multi-byte UTF-8 sequence left in the internal TextDecoder', () => {
        const full = Buffer.from('世', 'utf-8');
        const decoder = new CompactStreamDecoder();
        const first = decoder.push(full.subarray(0, 2));
        expect(first).toEqual([]);
        const rest = decoder.push(full.subarray(2));
        expect(rest).toEqual([{ content: '世' }]);
        expect(decoder.flush()).toEqual([]);
    });

    test('flush() on a decoder with no pending state returns nothing', () => {
        const decoder = new CompactStreamDecoder();
        decoder.push(Buffer.from('done', 'utf-8'));
        decoder.flush();
        expect(decoder.flush()).toEqual([]);
    });
});

class FakeResponse extends EventEmitter {
    constructor({ backpressureUntilWriteN = Infinity } = {}) {
        super();
        this.headers = {};
        this.writes = [];
        this.writeCount = 0;
        this.ended = false;
        this.endedChunk = null;
        this.backpressureUntilWriteN = backpressureUntilWriteN;
        this.socket = undefined;
    }
    setHeader(name, value) {
        this.headers[name] = value;
    }
    write(chunk) {
        this.writeCount++;
        this.writes.push(chunk);
        return this.writeCount > this.backpressureUntilWriteN ? true : this.writeCount <= this.backpressureUntilWriteN - 1;
    }
    end(chunk) {
        this.ended = true;
        if (chunk) {
            this.writes.push(chunk);
            this.endedChunk = chunk;
        }
    }
}

function fakeUpstream(sseEvents, rawChunkSize = 64) {
    const sseText = sseEvents.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const sseBytes = Buffer.from(sseText, 'utf-8');
    const chunks = [];
    for (let i = 0; i < sseBytes.length; i += rawChunkSize) {
        chunks.push(sseBytes.subarray(i, i + rawChunkSize));
    }
    return { ok: true, body: Readable.from(chunks) };
}

describe('pipeLlamaCppCompactStream - integration over a fake upstream + fake response', () => {
    test('decodes to the expected final text, and stashes retrievable meta on stop', async () => {
        const sseEvents = [
            { index: 0, content: 'Hello ' },
            { index: 0, content: 'world', completion_probabilities: [{ tok_str: 'world', prob: 0.8 }] },
            { index: 0, content: '', stop: true, prompt: 'the prompt', model: 'test-model', timings: { a: 1 } },
        ];
        const res = new FakeResponse();
        await pipeLlamaCppCompactStream(fakeUpstream(sseEvents, 17), res);

        expect(res.ended).toBe(true);
        expect(res.headers['X-ST-Stream-Format']).toBe('compact-v1');
        const genId = res.headers['X-Generation-Id'];
        expect(genId).toBeTruthy();

        const allBytes = Buffer.concat(res.writes.filter(Boolean));
        const events = decodeInChunks(allBytes, [allBytes.length || 1]);
        const { text } = replay(events);
        expect(text).toBe('Hello world');

        const meta = getLlamaCppStreamMeta(genId);
        expect(meta.prompt).toBe('the prompt');
        expect(meta.model).toBe('test-model');
        expect(meta.timings).toEqual({ a: 1 });
    });

    test('backpressure: pending writes coalesce while draining and nothing is lost or duplicated', async () => {
        const sseEvents = Array.from({ length: 20 }, (_, i) => ({ index: 0, content: `chunk${i}-` }));
        sseEvents.push({ index: 0, content: '', stop: true });

        const res = new FakeResponse({ backpressureUntilWriteN: 3 });
        const originalWrite = res.write.bind(res);
        let drainScheduled = false;
        res.write = (chunk) => {
            const ok = originalWrite(chunk);
            if (!ok && !drainScheduled) {
                drainScheduled = true;
                setImmediate(() => {
                    drainScheduled = false;
                    res.emit('drain');
                });
            }
            return ok;
        };

        await pipeLlamaCppCompactStream(fakeUpstream(sseEvents, 8), res);

        expect(res.ended).toBe(true);
        const allBytes = Buffer.concat(res.writes.filter(Boolean));
        const events = decodeInChunks(allBytes, [allBytes.length || 1]);
        const { text } = replay(events);
        expect(text).toBe(sseEvents.filter(e => e.content).map(e => e.content).join(''));
    });

    test('non-ok upstream response falls back to plain forwarding without throwing', async () => {
        const res = new FakeResponse();
        await pipeLlamaCppCompactStream({ ok: false, body: null, status: 500, statusText: 'err', text: async () => 'err body' }, res);
        expect(res.headers['X-ST-Stream-Format']).toBeUndefined();
        expect(res.ended).toBe(true);
    });
});

function fakeCompletionsUpstream(texts) {
    const sseText = texts.map(t => `data: ${JSON.stringify({ choices: [{ index: 0, text: t }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return { ok: true, status: 200, statusText: 'OK', body: Readable.from([Buffer.from(sseText, 'utf-8')]) };
}

function decodeWrites(res) {
    const allBytes = Buffer.concat(res.writes.filter(Boolean));
    return decodeInChunks(allBytes, [allBytes.length || 1]);
}

describe('warnings control frame', () => {
    const warnings = [{ kind: 'dropped', key: 'textgenerationwebui|llamacpp|http://x|m|none', message: 'Dropped 1 entry', entries: ['foo'] }];
    const llamaEvents = [
        { index: 0, content: 'Hello' },
        { index: 0, content: '', stop: true },
    ];

    async function runForward(res, extraArgs) {
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
        const { forwardAndPersistCompactStream } = await import('../src/endpoints/backends/text-completions.js');
        await forwardAndPersistCompactStream(fakeCompletionsUpstream(['Hello']), res, null, json => json?.choices?.[0]?.text, null, ...extraArgs);
    }

    test('pipeLlamaCppCompactStream writes a {warnings} control frame before any content', async () => {
        const res = new FakeResponse();
        await pipeLlamaCppCompactStream(fakeUpstream(llamaEvents), res, null, warnings);
        const events = decodeWrites(res);
        expect(events[0]).toEqual({ control: { warnings } });
        expect(replay(events).text).toBe('Hello');
    });

    test('pipeLlamaCppCompactStream writes no warnings frame for an empty or omitted array', async () => {
        for (const extra of [[[]], []]) {
            const res = new FakeResponse();
            await pipeLlamaCppCompactStream(fakeUpstream(llamaEvents), res, null, ...extra);
            const controls = decodeWrites(res).filter(e => 'control' in e);
            expect(controls).toEqual([]);
        }
    });

    test('text-completions forwardAndPersistCompactStream writes a {warnings} control frame before any content', async () => {
        const res = new FakeResponse();
        await runForward(res, [warnings]);
        const events = decodeWrites(res);
        expect(events[0]).toEqual({ control: { warnings } });
        expect(replay(events).text).toBe('Hello');
    });

    test('text-completions forwardAndPersistCompactStream writes no warnings frame for an empty or omitted array', async () => {
        for (const extra of [[[]], []]) {
            const res = new FakeResponse();
            await runForward(res, extra);
            const controls = decodeWrites(res).filter(e => 'control' in e);
            expect(controls).toEqual([]);
        }
    });
});
