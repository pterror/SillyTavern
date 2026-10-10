import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, test } from 'node:test';

import DiffMatchPatch from 'diff-match-patch';

const { main } = await import('./convert-itemized-prompts-to-nodes.js');
const tree = await import('../message-tree-db.js');
const { readItemization } = await import('../itemization-store.js');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-itemized-prompts-'));
const root = path.join(dataRoot, 'u');
const oldDir = path.join(root, 'itemized prompts');
fs.mkdirSync(oldDir, { recursive: true });
const directories = { root };
const NOW = new Date('2026-10-10T12:00:00.000Z');
const backupDir = path.join(root, 'backups', '_convert-itemized-prompts', '2026-10-10T12-00-00-000Z');

after(() => {
    tree.disposeMessageTreeStores();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

const reply = (mes) => ({ name: 'Rex', is_user: false, mes, send_date: 1, extra: {} });

/** A chat of `owner` with `count` messages, labelled `label`; its node ids. */
async function makeChat(owner, label, count) {
    const anchor = await tree.getOrCreateAnchor(directories, owner);
    const { node_ids: ids } = await tree.appendMessages(directories, owner, anchor,
        Array.from({ length: count }, (_, i) => reply(`${label} ${i}`)));
    await tree.labelNode(directories, ids[0], label, { ownerId: owner });
    return ids;
}

function frame(record) {
    const compressed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(record)));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(compressed.length, 0);
    return Buffer.concat([length, compressed]);
}

/** The pooled form the page saved: every non-empty string replaced by a reference into `pool`. */
function pooled(entries) {
    const pool = [];
    const ref = (value) => {
        if (typeof value === 'string' && value !== '') {
            let at = pool.indexOf(value);
            if (at < 0) at = pool.push(value) - 1;
            return { $r: at };
        }
        if (Array.isArray(value)) return value.map(ref);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ref(v)]));
        return value;
    };
    return { v: 2, pool, entries: entries.map(ref) };
}

/** The `IPL1` log: a full frame, then an append frame with the last entry. */
function writeLog(name, entries) {
    const all = pooled(entries);
    const head = pooled(entries.slice(0, -1));
    const tail = { t: 'append', pool: all.pool.slice(head.pool.length), entries: all.entries.slice(head.entries.length) };
    fs.writeFileSync(path.join(oldDir, `${name}.json.zst`), Buffer.concat([Buffer.from('IPL1'), frame({ t: 'full', data: head }), frame(tail)]));
}

/** The first server format: one zstd frame of the JSON. */
function writeSingle(name, value) {
    fs.writeFileSync(path.join(oldDir, `${name}.json.zst`), zlib.zstdCompressSync(Buffer.from(JSON.stringify(value))));
}

const lines = { log: [], warn: [] };
const run = (...args) => main([...args, '--data-root', dataRoot, '--handle', 'u'], {
    probeServer: async () => ({ running: false, lines: [] }),
    log: line => lines.log.push(line),
    warn: line => lines.warn.push(line),
    now: NOW,
});

test('converts each format onto the messages at the entries\' positions, listing what it leaves', async () => {
    const byLabel = await makeChat('Rex', 'Rex - 2026-01-01@10h00m00s', 4);
    const byNode = await makeChat('Ann', 'Ann chat', 3);
    const delta = await makeChat('Bob', 'Bob chat', 3);
    await makeChat('Cat', 'Shared name', 2);
    await makeChat('Dan', 'Shared name', 2);

    // By chat name, pooled log: positions 1 and 3; a second entry for 1 (the first was shown); 9 is past the end.
    writeLog('Rex - 2026-01-01@10h00m00s', [
        { mesId: 1, rawPrompt: 'prompt one', storyString: 'story' },
        { mesId: 1, rawPrompt: 'shadowed' },
        { mesId: 3, rawPrompt: 'prompt three', storyString: 'story' },
        { mesId: 9, rawPrompt: 'gone' },
    ]);
    // By node id, the first format, a plain list.
    writeSingle(byNode[0], [{ mesId: 2, presetName: 'P' }]);
    // The older delta form: each raw prompt as a delta from the one before.
    const dmp = new DiffMatchPatch();
    writeSingle('Bob chat', {
        entries: [{ mesId: 0, rawPrompt: 'alpha beta' }, { mesId: 2 }],
        rawPromptDelta: [null, dmp.diff_toDelta(dmp.diff_main('alpha beta', 'alpha gamma'))],
    });
    writeSingle('Shared name', [{ mesId: 0, rawPrompt: 'whose?' }]);
    writeSingle('Nobody', [{ mesId: 0, rawPrompt: 'orphan' }]);
    fs.writeFileSync(path.join(oldDir, 'Broken.json.zst'), Buffer.from('not zstd'));

    // The real run closes the store's handles when it is done, so each count opens it again.
    const rows = async () => (await tree.getMessageTreeDb(directories)).get('SELECT COUNT(*) AS n FROM itemizations').n;

    assert.equal(await run('--dry-run'), 1);
    assert.equal(await rows(), 0, 'a dry run writes nothing');
    assert.equal(fs.readdirSync(oldDir).length, 6);

    lines.warn.length = 0;
    assert.equal(await run('--apply', '--server-stopped'), 1, 'some entries were left');

    const entryOf = async (nodeId) => (await readItemization(directories, nodeId))?.entry ?? null;
    assert.deepEqual(await entryOf(byLabel[1]), { rawPrompt: 'prompt one', storyString: 'story' });
    assert.deepEqual(await entryOf(byLabel[3]), { rawPrompt: 'prompt three', storyString: 'story' });
    assert.equal(await entryOf(byLabel[0]), null);
    assert.deepEqual(await entryOf(byNode[2]), { presetName: 'P' });
    assert.deepEqual(await entryOf(delta[0]), { rawPrompt: 'alpha beta' });
    assert.deepEqual(await entryOf(delta[2]), { rawPrompt: 'alpha gamma' }, 'a raw prompt stored as a delta is rebuilt');
    assert.equal(await rows(), 5);

    const notConverted = lines.warn.filter(line => line.includes('NOT CONVERTED')).map(line => line.replace(/^.*NOT CONVERTED /, ''));
    assert.deepEqual(notConverted.sort(), [
        'Nobody.json.zst message 0: no chat has this name or id now',
        'Rex - 2026-01-01@10h00m00s.json.zst message 1: an earlier entry for this message was the one shown',
        'Rex - 2026-01-01@10h00m00s.json.zst message 9: the chat has 4 messages now',
        'Shared name.json.zst message 0: more than one character or group has a chat by this name',
    ]);
    assert.ok(lines.warn.some(line => line.includes('LEFT AS IT IS Broken.json.zst')));

    assert.deepEqual(fs.readdirSync(oldDir), ['Broken.json.zst'], 'an unreadable file stays where it was');
    assert.deepEqual(fs.readdirSync(backupDir).sort(), [
        `${byNode[0]}.json.zst`, 'Bob chat.json.zst', 'Nobody.json.zst', 'Rex - 2026-01-01@10h00m00s.json.zst', 'Shared name.json.zst',
    ].sort());

    // A second run finds only the unreadable file.
    lines.warn.length = 0;
    assert.equal(await run('--apply', '--server-stopped'), 1);
    assert.equal(await rows(), 5);
});

test('the real run refuses without --server-stopped', async () => {
    assert.equal(await run('--apply'), 1);
    assert.equal(await run(), 2);
});
