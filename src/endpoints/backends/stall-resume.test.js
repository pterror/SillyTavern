import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import express from 'express';

const {
    createGenerationRecord,
    createResumableWriter,
    createBackpressureWriter,
    detachFromResponse,
    encodeContent,
    encodeKeepaliveFrame,
    handleGenerationResume,
} = await import('./llamacpp-compact-stream.js');
const { ResumableCompactStreamReader, CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');

function testKeepaliveExcludedFromBuffer() {
    const record = createGenerationRecord(randomUUID());
    /** @type {Buffer[]} */
    const rawWrites = [];
    const fakeBaseWriter = {
        write: (buf) => rawWrites.push(buf),
        end: () => { },
    };

    const KEEPALIVE_INTERVAL_MS = 5;
    const { writer, stopKeepalive } = createResumableWriter(fakeBaseWriter, record, KEEPALIVE_INTERVAL_MS);

    writer.write(encodeContent('abc'));

    return new Promise((resolve) => {
        setTimeout(() => {
            writer.write(encodeContent('def'));
            stopKeepalive();

            const keepaliveCount = rawWrites.filter(buf => buf.equals(encodeKeepaliveFrame())).length;
            assert.ok(keepaliveCount >= 1, 'at least one keepalive frame was actually written to the live response while idle');

            const bufferedBytes = Buffer.concat(record.chunks);
            assert.equal(bufferedBytes.toString('utf-8'), 'abcdef', 'the resumable buffer contains only the real content, with every keepalive frame excluded');
            assert.equal(record.storedBytes, Buffer.byteLength('abcdef'), 'storedBytes (the resume offset accounting) counts only real content bytes, never keepalive bytes');

            console.log('stall-resume.test.js: keepalive-excluded-from-buffer assertions passed');
            resolve();
        }, KEEPALIVE_INTERVAL_MS * 6);
    });
}

async function testStalledConnectionTriggersProactiveResume() {
    const STALL_TIMEOUT_MS = 150;
    const KEEPALIVE_INTERVAL_MS = 60_000;

    /** @type {Map<string, {record: import('./llamacpp-compact-stream.js').GenerationRecord, getWriter: () => any, setWriter: (w: any) => void}>} */
    const generations = new Map();

    const app = express();
    app.get('/stream', (req, res) => {
        const id = randomUUID();
        res.setHeader('X-ST-Stream-Format', 'compact-v1');
        res.setHeader('X-Generation-Id', id);

        const record = createGenerationRecord(id);
        const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(res), record, KEEPALIVE_INTERVAL_MS);
        let writer = initialWriter;
        generations.set(id, { record, getWriter: () => writer, setWriter: (w) => { writer = w; } });

        writer.write(encodeContent('Hello, '));

        res.socket?.once('close', () => {
            stopKeepalive();
            writer = detachFromResponse(record);
            generations.get(id).setWriter(writer);
        });
    });
    app.get('/resume/:id', handleGenerationResume);

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;

    try {
        const response = await fetch(`http://127.0.0.1:${port}/stream`);
        assert.equal(response.status, 200);
        const generationId = response.headers.get('X-Generation-Id');
        assert.ok(generationId, 'a real X-Generation-Id header was sent');

        const reader = new ResumableCompactStreamReader(response, `http://127.0.0.1:${port}/resume`, null, 5, STALL_TIMEOUT_MS);
        const decoder = new CompactStreamDecoder();
        let text = '';

        const first = await reader.read();
        assert.ok(!first.done && first.value?.length, 'the first real chunk was received before the stall');
        for (const event of decoder.push(first.value)) {
            if ('content' in event) text += event.content;
        }
        assert.equal(text, 'Hello, ', 'the pre-stall content decoded correctly');
        assert.equal(reader.resumeAttempts, 0, 'no resume has happened yet - the stall has not been detected at this point');

        setTimeout(() => {
            const gen = generations.get(generationId);
            const writer = gen.getWriter();
            writer.write(encodeContent('world!'));
            writer.end();
        }, STALL_TIMEOUT_MS * 3);

        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.length) {
                for (const event of decoder.push(value)) {
                    if ('content' in event) text += event.content;
                }
            }
        }
        for (const event of decoder.flush()) {
            if ('content' in event) text += event.content;
        }

        assert.ok(reader.resumeAttempts >= 1, 'the client actually detected the stall and performed at least one proactive resume - not just a lucky slow read');
        assert.equal(text, 'Hello, world!', 'the reconstructed text is complete and correct across the stall/resume boundary');

        console.log('stall-resume.test.js: stalled-connection-triggers-proactive-resume assertions passed');
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

async function run() {
    await testKeepaliveExcludedFromBuffer();
    await testStalledConnectionTriggersProactiveResume();
    console.log('stall-resume.test.js: all assertions passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
