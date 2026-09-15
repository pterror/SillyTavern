import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import express from 'express';

// Real end-to-end stall-detection + resume test, distinct from resume-stream.test.js: that test
// exercises a hard socket close (AbortController.abort()). This one exercises the "heavy packet
// loss" case the streaming protocol's original design brief called out - a connection that goes
// silently dead with NO close/RST reaching either side, while the client sits in `await
// reader.read()`. The fake backend here genuinely never closes the socket; it just stops writing.
// `ResumableCompactStreamReader` must notice the silence on its own and proactively resume, rather
// than hang forever waiting on the browser/OS to eventually notice.

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

/**
 * Unit-level check for the offset-correctness requirement: a keepalive frame must never be written
 * into the resumable generation buffer, since there's nothing to replay about a no-op frame and
 * letting it in would shift the `from=<offset>` byte accounting every real frame after it relies on.
 */
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
        // Long enough for several keepalive intervals to fire with no other write() in between.
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

/**
 * Full integration test: a real Express app + real HTTP server + the real client-side
 * `ResumableCompactStreamReader`/`CompactStreamDecoder`. The fake "backend" writes one chunk, then
 * genuinely goes silent - no more writes, no `res.end()`, no socket close - well past the client's
 * own (deliberately short, for the test) stall-detection timeout. The client must detect this on its
 * own and resume, after which the "backend" is made to resume producing (and finish) so the test can
 * assert the final reconstructed text is complete and correct.
 */
async function testStalledConnectionTriggersProactiveResume() {
    const STALL_TIMEOUT_MS = 150;
    // Real, but far longer than STALL_TIMEOUT_MS, so nothing about this test depends on the server's
    // own keepalive ever firing - the client's stall timeout must fire on its own first.
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
        // Deliberately no more writes and no res.end() here - the "backend" just stops, simulating a
        // connection that's gone silent (heavy packet loss) without actually closing.

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

        // First read: the one real chunk the "backend" sent before going silent.
        const first = await reader.read();
        assert.ok(!first.done && first.value?.length, 'the first real chunk was received before the stall');
        for (const event of decoder.push(first.value)) {
            if ('content' in event) text += event.content;
        }
        assert.equal(text, 'Hello, ', 'the pre-stall content decoded correctly');
        assert.equal(reader.resumeAttempts, 0, 'no resume has happened yet - the stall has not been detected at this point');

        // Once the client is genuinely blocked waiting on the next chunk (which will never come on
        // this connection), make the "backend" resume producing - but only far enough in the future
        // that the client's own STALL_TIMEOUT_MS has already had to fire and trigger a resume for the
        // rest to actually arrive.
        setTimeout(() => {
            const gen = generations.get(generationId);
            const writer = gen.getWriter();
            writer.write(encodeContent('world!'));
            writer.end();
        }, STALL_TIMEOUT_MS * 3);

        // Second read: must not hang forever. The client's stall timeout should fire on its own,
        // cancel the dead read, and transparently resume - so this eventually resolves with the rest
        // of the content, not a hang and not an uncaught rejection.
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
