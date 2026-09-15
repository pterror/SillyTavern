import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// users.js (imported transitively by stats.js) reads process-wide config at import time via
// getConfigValue() - the config path must be set before that import chain runs, same as every
// other route-level test file in this directory (see e.g. groups.test.js's own comment).
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level Express-integration test for src/endpoints/stats.js's `/increment` route, covering
// the fix that moved word-count and date-stamping computation server-side (see this task's own
// report). Mirrors this directory's established convention (groups.test.js/horde.test.js): a real
// express app mounting the real router, no mocking of stats.js itself (no external dependency to
// stub - STATS is an in-memory Map owned by the module).
const { router: statsRouter } = await import('./stats.js');

function buildTestApp(handle) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle } };
        next();
    });
    app.use('/api/stats', statsRouter);
    return app;
}

async function postJson(app, urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

async function run() {
    // (a) word count is derived server-side from raw text, not trusted as a pre-computed number -
    // sending a `wordCount.text` of a known word count produces the correct stored delta, and any
    // (now-removed) `deltas.user_word_count`/`non_user_word_count` the client might still send is
    // ignored (the loop over numeric delta keys no longer includes those fields).
    {
        const app = buildTestApp('word-count-user');
        const { status, data } = await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: { user_msg_count: 1, user_word_count: 999999 }, // stray/spoofed value - must be ignored
            wordCount: { is_user: true, text: 'four little words here', is_edit: false },
        });
        assert.equal(status, 200);
        assert.equal(data.user_word_count, 4, 'word count was computed server-side from the raw text, ignoring the spoofed deltas.user_word_count');
        assert.equal(data.user_msg_count, 1);
        assert.equal(data.non_user_word_count, 0);
    }

    // (b) non-user (character) message word count, via the same mechanism.
    {
        const app = buildTestApp('word-count-non-user');
        const { data } = await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: { non_user_msg_count: 1 },
            wordCount: { is_user: false, text: 'one two three', is_edit: false },
        });
        assert.equal(data.non_user_word_count, 3);
        assert.equal(data.user_word_count, 0);
    }

    // (c) edit: word-count delta accounts for the prior text via `old_text`, matching the original
    // client-side formula (new count minus a plain space-split length of the old text).
    {
        const app = buildTestApp('word-count-edit');
        // First call establishes a baseline non-edit message: "one two three" -> 3 words.
        await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: { non_user_msg_count: 1 },
            wordCount: { is_user: false, text: 'one two three', is_edit: false },
        });
        // Edit extends it to "one two three four five" (5 words); old_text "one two three" split(' ') -> 3.
        const { data } = await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: {},
            wordCount: { is_user: false, text: 'one two three four five', is_edit: true, old_text: 'one two three' },
        });
        assert.equal(data.non_user_word_count, 3 + (5 - 3), 'edit applied as (new count - old split(\' \').length) on top of the prior total');
    }

    // (d) dates are stamped from the SERVER's own clock, not a client-supplied value - sending an
    // obviously-wrong future timestamp (as `dates` used to be shaped) has no field to land in any
    // more, and date_last_chat/date_first_chat reflect real server time.
    {
        const app = buildTestApp('dates-server-clock');
        const before = Date.now();
        const spoofedFuture = before + 1000 * 60 * 60 * 24 * 365 * 50; // 50 years in the future
        const { data } = await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: { user_msg_count: 1 },
            dates: { last_chat: spoofedFuture, first_chat_candidate: spoofedFuture }, // legacy/spoofed field - must be ignored entirely
            wordCount: { is_user: true, text: 'hi', is_edit: false },
        });
        const after = Date.now();
        assert.ok(data.date_last_chat >= before && data.date_last_chat <= after, 'date_last_chat came from the server clock, not the spoofed client value');
        assert.ok(data.date_first_chat >= before && data.date_first_chat <= after, 'date_first_chat came from the server clock, not the spoofed client value');
        assert.notEqual(data.date_last_chat, spoofedFuture);
    }

    // (e) date_first_chat still tracks the earliest server-observed timestamp across calls (min).
    {
        const app = buildTestApp('dates-first-chat-min');
        const { data: first } = await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: { user_msg_count: 1 },
            wordCount: { is_user: true, text: 'hi', is_edit: false },
        });
        await new Promise(resolve => setTimeout(resolve, 5));
        const { data: second } = await postJson(app, '/api/stats/increment', {
            avatar: 'char.png',
            deltas: { user_msg_count: 1 },
            wordCount: { is_user: true, text: 'hi again', is_edit: false },
        });
        assert.ok(second.date_last_chat >= first.date_last_chat, 'date_last_chat advances forward');
        assert.equal(second.date_first_chat, first.date_first_chat, 'date_first_chat stays pinned to the earliest server-observed call');
    }

    // (f) baseline route-shape regression guard: malformed body still 400s.
    {
        const app = buildTestApp('malformed');
        const { status } = await postJson(app, '/api/stats/increment', { avatar: '', deltas: {} });
        assert.equal(status, 400);
    }
    {
        const app = buildTestApp('malformed2');
        const { status } = await postJson(app, '/api/stats/increment', { avatar: 'char.png', deltas: 'not-an-object' });
        assert.equal(status, 400);
    }

    console.log('stats.test.js: all assertions passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
