import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

// Route-level Express-integration test for src/endpoints/quick-replies.js's `/save-partial` route,
// added as part of migrating QuickReplySet.js's client-side accumulator+debounce off a single
// shared bundle and onto one-request-per-user-action dispatch (see this task's own report). Mirrors
// this directory's established convention (groups.test.js): a real express app mounting the real
// router, real on-disk quick-reply-set JSON fixtures, and direct filesystem assertions of the
// post-write state - no mocking of quick-replies.js itself, since it has no external network
// dependency to stub out. Each test case below corresponds to exactly one bucket the redesigned
// client now sends per real user action (setProps-only, qrUpdates-only, qrAdds-only, qrDeletes-only,
// qrOrder-only), plus the couple of legitimate multi-bucket single-action cases (add bumping
// idIndex, insert-before bundling an add with a reposition).
const { router: quickRepliesRouter } = await import('./quick-replies.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-quick-replies-save-partial-test-'));
const qrDir = path.join(root, 'quickreplies');
fs.mkdirSync(qrDir, { recursive: true });

const directories = { quickreplies: qrDir };

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/quick-replies', quickRepliesRouter);
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

/**
 * Writes a fresh baseline quick-reply-set fixture straight to disk (bypassing the route).
 * @param {string} name
 * @returns {object} The fixture object written.
 */
function writeSetFixture(name) {
    const fixture = {
        version: 2,
        name,
        disableSend: false,
        placeBeforeInput: false,
        injectInput: false,
        color: 'transparent',
        onlyBorderColor: false,
        idIndex: 2,
        qrList: [
            { id: 1, label: 'One', message: '/one', icon: '', showLabel: false },
            { id: 2, label: 'Two', message: '/two', icon: '', showLabel: false },
        ],
    };
    fs.writeFileSync(path.join(qrDir, `${name}.json`), JSON.stringify(fixture, null, 4));
    return fixture;
}

function readSetFromDisk(name) {
    return JSON.parse(fs.readFileSync(path.join(qrDir, `${name}.json`), 'utf8'));
}

async function run() {
    const app = buildTestApp();

    // (a) setProps only - a single discrete set-level property toggle (e.g. a checkbox click)
    // touches exactly that property and nothing else.
    {
        const name = 'set-props-only';
        writeSetFixture(name);
        const { status, data } = await postJson(app, '/api/quick-replies/save-partial', { name, setProps: { disableSend: true } });
        assert.equal(status, 200);
        assert.deepEqual(data, { ok: true, assignedIds: [] });
        const onDisk = readSetFromDisk(name);
        assert.equal(onDisk.disableSend, true);
        assert.equal(onDisk.placeBeforeInput, false, 'sibling set-level props are untouched');
        assert.equal(onDisk.qrList.length, 2, 'qrList is untouched by a setProps-only call');
    }

    // (b) qrUpdates only - a single entry's rename/edit touches only that entry, by stable id.
    {
        const name = 'qr-update-only';
        writeSetFixture(name);
        const { status } = await postJson(app, '/api/quick-replies/save-partial', { name, qrUpdates: [{ id: 2, label: 'Two Renamed', message: '/two-renamed' }] });
        assert.equal(status, 200);
        const onDisk = readSetFromDisk(name);
        assert.equal(onDisk.qrList.find(qr => qr.id === 2).label, 'Two Renamed');
        assert.equal(onDisk.qrList.find(qr => qr.id === 2).message, '/two-renamed');
        assert.equal(onDisk.qrList.find(qr => qr.id === 1).label, 'One', 'the other entry is untouched');
        assert.equal(onDisk.disableSend, false, 'set-level props are untouched by a qrUpdates-only call');
    }

    // (c) qrAdds bundled with the idIndex bump - this is the ONE legitimate multi-bucket single
    // action (see QuickReplySet.saveQrAdd's own comment): adding a QR and bumping idIndex are two
    // facets of the same "add a quick reply" gesture, not two different actions.
    {
        const name = 'qr-add-with-id-index';
        writeSetFixture(name);
        const { status, data } = await postJson(app, '/api/quick-replies/save-partial', {
            name,
            qrAdds: [{ id: 3, label: 'Three', message: '/three', icon: '', showLabel: false }],
            setProps: { idIndex: 3 },
        });
        assert.equal(status, 200);
        assert.deepEqual(data.assignedIds, [3]);
        const onDisk = readSetFromDisk(name);
        assert.equal(onDisk.qrList.length, 3);
        assert.equal(onDisk.qrList[2].label, 'Three');
        assert.equal(onDisk.idIndex, 3);
    }

    // (c2) qrAdds without a client-picked id - the server mints one, matching addQuickReplyRemote()'s
    // wire shape (used whenever the client can't safely assert an id itself).
    {
        const name = 'qr-add-server-minted-id';
        writeSetFixture(name);
        const { status, data } = await postJson(app, '/api/quick-replies/save-partial', {
            name,
            qrAdds: [{ label: 'NoId', message: '/noid', icon: '', showLabel: false }],
        });
        assert.equal(status, 200);
        assert.equal(data.assignedIds.length, 1);
        const mintedId = data.assignedIds[0];
        const onDisk = readSetFromDisk(name);
        assert.ok(onDisk.qrList.some(qr => qr.id === mintedId && qr.label === 'NoId'));
    }

    // (d) qrDeletes only - a single delete-click removes exactly that entry.
    {
        const name = 'qr-delete-only';
        writeSetFixture(name);
        const { status } = await postJson(app, '/api/quick-replies/save-partial', { name, qrDeletes: [1] });
        assert.equal(status, 200);
        const onDisk = readSetFromDisk(name);
        assert.equal(onDisk.qrList.length, 1);
        assert.equal(onDisk.qrList[0].id, 2, 'the other entry survives');
    }

    // (e) qrOrder only - a drag-and-drop reorder is one action touching every item's position, sent
    // in one bulk request (the legitimate bulk exception, matching tags.js's saveTagsNow()).
    {
        const name = 'qr-order-only';
        writeSetFixture(name);
        const { status } = await postJson(app, '/api/quick-replies/save-partial', { name, qrOrder: [2, 1] });
        assert.equal(status, 200);
        const onDisk = readSetFromDisk(name);
        assert.deepEqual(onDisk.qrList.map(qr => qr.id), [2, 1]);
    }

    // (f) insert-before: a single request bundling qrAdds + setProps(idIndex) + qrOrder - the other
    // legitimate multi-bucket single action (see QuickReplySet.js's onInsertBefore comment): minting
    // the new entry and placing it at a specific position are two facets of one "insert before"
    // gesture, sent together instead of racing two separate requests against the same file.
    {
        const name = 'qr-insert-before';
        writeSetFixture(name);
        const { status, data } = await postJson(app, '/api/quick-replies/save-partial', {
            name,
            qrAdds: [{ id: 3, label: 'Inserted', message: '/inserted', icon: '', showLabel: false }],
            setProps: { idIndex: 3 },
            qrOrder: [1, 3, 2],
        });
        assert.equal(status, 200);
        assert.deepEqual(data.assignedIds, [3]);
        const onDisk = readSetFromDisk(name);
        assert.deepEqual(onDisk.qrList.map(qr => qr.id), [1, 3, 2]);
        assert.equal(onDisk.idIndex, 3);
    }

    // (g) unrecognized top-level body fields (qrList/name riding along inside setProps) are stripped,
    // matching the route's own safe-props guard.
    {
        const name = 'qr-setprops-guard';
        writeSetFixture(name);
        const { status } = await postJson(app, '/api/quick-replies/save-partial', {
            name,
            setProps: { qrList: [{ id: 99, label: 'Injected' }], name: 'renamed-on-disk', color: 'red' },
        });
        assert.equal(status, 200);
        const onDisk = readSetFromDisk(name);
        assert.equal(onDisk.name, name, 'name cannot be overwritten via setProps');
        assert.equal(onDisk.qrList.length, 2, 'qrList cannot be overwritten via setProps');
        assert.equal(onDisk.color, 'red', 'the one legitimate sibling field in the same call was still applied');
    }

    // (h) a missing `name` still 400s (baseline route-shape regression guard).
    {
        const { status } = await postJson(app, '/api/quick-replies/save-partial', { setProps: { color: 'red' } });
        assert.equal(status, 400);
    }

    console.log('quick-replies.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
