import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// character-metadata-db.js (imported transitively by groups.js) reads process-wide config at import
// time via getConfigValue() - the config path must be set before that import chain runs, same as
// every other route-level test file in this directory (see e.g. horde.test.js's own comment).
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level Express-integration test for src/endpoints/groups.js's `/save-partial` field-level save
// route, added as part of migrating every group-chats.js call site off the whole-object `/edit` route
// (see this task's own report). Mirrors this directory's established convention (horde.test.js/
// novelai.test.js/backends/*.test.js): a real express app mounting the real router, real on-disk group
// JSON fixtures, and direct filesystem assertions of the post-write state - no mocking of groups.js
// itself, since it has no external network dependency to stub out.
const { router: groupsRouter } = await import('./groups.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-save-partial-test-'));
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(groupsDir, { recursive: true });

const directories = { root, groups: groupsDir };

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/groups', groupsRouter);
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
 * Writes a fresh baseline group fixture straight to disk (bypassing the route), matching the full
 * `Group` shape (public/global.d.ts) so every field save-partial now has to handle (per the
 * group-chats.js migration) has a real starting value to check for accidental corruption.
 * @param {string} id
 * @returns {object} The fixture object written (same reference is NOT re-read from disk by the caller).
 */
function writeGroupFixture(id) {
    const fixture = {
        id,
        name: 'Original Name',
        members: ['alice.png', 'bob.png'],
        disabled_members: ['bob.png'],
        chat_id: 'chat-1',
        chats: ['chat-1'],
        generation_mode: 0,
        generation_mode_join_prefix: '',
        generation_mode_join_suffix: '',
        activation_strategy: 0,
        auto_mode_delay: 5,
        allow_self_responses: false,
        avatar_url: '',
        hideMutedSprites: false,
        fav: false,
        date_last_chat: 1000,
    };
    fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify(fixture, null, 4));
    return fixture;
}

function readGroupFromDisk(id) {
    return JSON.parse(fs.readFileSync(path.join(groupsDir, `${id}.json`), 'utf8'));
}

async function run() {
    const app = buildTestApp();

    // (a) activation_strategy - only that field changes.
    {
        const id = 'group-activation';
        const fixture = writeGroupFixture(id);
        const { status, data } = await postJson(app, '/api/groups/save-partial', { id, props: { activation_strategy: 2 } });
        assert.equal(status, 200);
        assert.deepEqual(data, { ok: true });
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.activation_strategy, 2, 'activation_strategy was updated');
        assert.deepEqual({ ...onDisk, activation_strategy: fixture.activation_strategy }, fixture, 'every other field is untouched');
    }

    // (b) generation_mode - only that field changes.
    {
        const id = 'group-generation-mode';
        const fixture = writeGroupFixture(id);
        const { status } = await postJson(app, '/api/groups/save-partial', { id, props: { generation_mode: 1 } });
        assert.equal(status, 200);
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.generation_mode, 1);
        assert.deepEqual({ ...onDisk, generation_mode: fixture.generation_mode }, fixture, 'every other field is untouched');
    }

    // (c) auto_mode_delay - only that field changes.
    {
        const id = 'group-auto-mode-delay';
        const fixture = writeGroupFixture(id);
        const { status } = await postJson(app, '/api/groups/save-partial', { id, props: { auto_mode_delay: 15 } });
        assert.equal(status, 200);
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.auto_mode_delay, 15);
        assert.deepEqual({ ...onDisk, auto_mode_delay: fixture.auto_mode_delay }, fixture, 'every other field is untouched');
    }

    // (d) template fields (generation_mode_join_prefix/suffix) - bundled in one call, matching
    // onGroupGenerationModeTemplateInput()'s real one-field-per-keystroke shape in group-chats.js
    // (each textarea saves its own single field; tested together here just to cover both fields).
    {
        const id = 'group-templates';
        const fixture = writeGroupFixture(id);
        const { status: s1 } = await postJson(app, '/api/groups/save-partial', { id, props: { generation_mode_join_prefix: '<PREFIX>' } });
        assert.equal(s1, 200);
        const { status: s2 } = await postJson(app, '/api/groups/save-partial', { id, props: { generation_mode_join_suffix: '<SUFFIX>' } });
        assert.equal(s2, 200);
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.generation_mode_join_prefix, '<PREFIX>');
        assert.equal(onDisk.generation_mode_join_suffix, '<SUFFIX>');
        assert.deepEqual(
            { ...onDisk, generation_mode_join_prefix: fixture.generation_mode_join_prefix, generation_mode_join_suffix: fixture.generation_mode_join_suffix },
            fixture,
            'every other field is untouched',
        );
    }

    // (e) allow_self_responses / hideMutedSprites - independent single-field saves.
    {
        const id = 'group-toggles';
        const fixture = writeGroupFixture(id);
        const { status: s1 } = await postJson(app, '/api/groups/save-partial', { id, props: { allow_self_responses: true } });
        assert.equal(s1, 200);
        let onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.allow_self_responses, true);
        assert.deepEqual({ ...onDisk, allow_self_responses: fixture.allow_self_responses }, fixture, 'hideMutedSprites/everything else untouched by the self-responses save');

        const { status: s2 } = await postJson(app, '/api/groups/save-partial', { id, props: { hideMutedSprites: true } });
        assert.equal(s2, 200);
        onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.hideMutedSprites, true);
        assert.equal(onDisk.allow_self_responses, true, 'the earlier self-responses save is still in effect');
    }

    // (f) avatar_url clear - saving an empty string round-trips (not dropped as falsy).
    {
        const id = 'group-avatar';
        const fixture = { ...writeGroupFixture(id), avatar_url: 'user/images/custom.png' };
        fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify(fixture, null, 4));
        const { status } = await postJson(app, '/api/groups/save-partial', { id, props: { avatar_url: '' } });
        assert.equal(status, 200);
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.avatar_url, '', 'avatar clear (empty string) is actually written, not treated as absent');
        assert.deepEqual({ ...onDisk, avatar_url: fixture.avatar_url }, fixture, 'every other field is untouched');
    }

    // (g) members add/remove - the highest-risk site per this task's own instructions (subtle shape
    // requirements): confirm a member-list save leaves disabled_members/chats/chat_id/name alone.
    {
        const id = 'group-members';
        const fixture = writeGroupFixture(id);
        const newMembers = ['alice.png', 'bob.png', 'carol.png'];
        const { status, data } = await postJson(app, '/api/groups/save-partial', { id, props: { members: newMembers } });
        assert.equal(status, 200);
        assert.deepEqual(data, { ok: true });
        const onDisk = readGroupFromDisk(id);
        assert.deepEqual(onDisk.members, newMembers, 'member was added');
        assert.deepEqual({ ...onDisk, members: fixture.members }, fixture, 'disabled_members/chats/chat_id/name/etc. are all untouched by a members-only save');

        // Removal, bundled with a disabled_members update the same way onGroupActionClick's
        // enable/disable handler already saves (an established two-field bundle at one call site).
        const prunedMembers = ['alice.png', 'carol.png'];
        const prunedDisabled = [];
        const { status: s2 } = await postJson(app, '/api/groups/save-partial', { id, props: { members: prunedMembers, disabled_members: prunedDisabled } });
        assert.equal(s2, 200);
        const onDisk2 = readGroupFromDisk(id);
        assert.deepEqual(onDisk2.members, prunedMembers);
        assert.deepEqual(onDisk2.disabled_members, prunedDisabled);
        assert.deepEqual({ ...onDisk2, members: fixture.members, disabled_members: fixture.disabled_members }, fixture, 'chats/chat_id/name/etc. are still untouched');
    }

    // (h) name rename.
    {
        const id = 'group-name';
        const fixture = writeGroupFixture(id);
        const { status } = await postJson(app, '/api/groups/save-partial', { id, props: { name: 'Renamed Group' } });
        assert.equal(status, 200);
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.name, 'Renamed Group');
        assert.deepEqual({ ...onDisk, name: fixture.name }, fixture, 'every other field is untouched');
    }

    // (i) allowlist hardening: `id` in the props body is ignored - the write still targets the URL/body
    // `id` used to locate the file, and the file's own `id` field is never retargeted.
    {
        const id = 'group-id-guard';
        const fixture = writeGroupFixture(id);
        const { status } = await postJson(app, '/api/groups/save-partial', { id, props: { id: 'some-other-id', name: 'Still This Group' } });
        assert.equal(status, 200);
        assert.ok(!fs.existsSync(path.join(groupsDir, 'some-other-id.json')), 'no file was written under the spoofed id');
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.id, id, 'the stored id field was not overwritten by the stray id in props');
        assert.equal(onDisk.name, 'Still This Group', 'the allowed sibling field in the same call was still applied');
        assert.deepEqual({ ...onDisk, name: fixture.name }, fixture, 'every other field is untouched');
    }

    // (j) allowlist hardening: an unrecognized/non-schema key (including a `__proto__` key riding along
    // in the JSON body) is dropped rather than Object.assign-ed onto the live group object.
    {
        const id = 'group-allowlist-guard';
        const fixture = writeGroupFixture(id);
        const maliciousProps = JSON.parse('{"__proto__": {"polluted": true}, "someStrayField": "nope", "auto_mode_delay": 30}');
        const { status } = await postJson(app, '/api/groups/save-partial', { id, props: maliciousProps });
        assert.equal(status, 200);
        const onDisk = readGroupFromDisk(id);
        assert.equal(onDisk.auto_mode_delay, 30, 'the one allowed field in the same call was still applied');
        assert.equal(onDisk.someStrayField, undefined, 'an unrecognized top-level key was dropped, not written');
        assert.equal(Object.prototype.polluted, undefined, 'global Object.prototype was never touched');
        assert.deepEqual({ ...onDisk, auto_mode_delay: fixture.auto_mode_delay }, fixture, 'every other field is untouched');
    }

    // (k) unknown id still 404s, and a malformed body still 400s (baseline route-shape regression guard).
    {
        const { status } = await postJson(app, '/api/groups/save-partial', { id: 'does-not-exist', props: { name: 'x' } });
        assert.equal(status, 404);
    }
    {
        const { status } = await postJson(app, '/api/groups/save-partial', { id: 'group-name', props: 'not-an-object' });
        assert.equal(status, 400);
    }

    console.log('groups.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
