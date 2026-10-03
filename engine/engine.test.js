// Needs this checkout's native build and wasm build in engine/dist/ (node engine/build.js; node engine/build.js --wasm).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

import { DIST_DIR, sourceKey } from './source-hash.js';
import { currentPlatform, nativeFileName, wasmFileName } from './platform.js';
import { ensureEngine, EngineFetchError } from './fetch.js';
import { loadEngine, EngineLoadError } from './load.js';

const key = sourceKey();
const platform = currentPlatform();
const nativeName = nativeFileName(key, platform);
const wasmName = wasmFileName(key);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-engine-test-'));
/** @type {Map<string, string>} release path -> local file */
const release = new Map();
/** @type {string[]} */
const requests = [];
let releaseBase = '';
const server = http.createServer((req, res) => {
    requests.push(req.url);
    const file = release.get(req.url);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200).end(fs.readFileSync(file));
});

before(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    // @ts-ignore
    releaseBase = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

function freshDist() {
    requests.length = 0;
    return fs.mkdtempSync(path.join(tmp, 'dist-'));
}

function publish() {
    release.set(`/engine-${key}/${nativeName}`, path.join(DIST_DIR, nativeName));
    release.set(`/engine-${key}/${wasmName}`, path.join(DIST_DIR, wasmName));
}

test('a file already there for this hash is used with no request', async () => {
    const distDir = freshDist();
    fs.copyFileSync(path.join(DIST_DIR, wasmName), path.join(distDir, wasmName));
    assert.equal(await ensureEngine({ releaseBase, distDir }), path.join(distDir, wasmName));
    assert.deepEqual(requests, []);
});

test('an unpublished hash fails with one message naming it', async () => {
    release.clear();
    const distDir = freshDist();
    await assert.rejects(ensureEngine({ releaseBase, distDir }), (error) => {
        assert.ok(error instanceof EngineFetchError);
        assert.match(error.message, new RegExp(`source hash ${key} has no release yet.*Retry once CI has finished`));
        return true;
    });
    assert.deepEqual(fs.readdirSync(distDir), []);
});

test('the native file is fetched for this platform, and the server loads it', async () => {
    publish();
    const distDir = freshDist();
    assert.equal(await ensureEngine({ releaseBase, distDir }), path.join(distDir, nativeName));
    assert.deepEqual(fs.readdirSync(distDir), [nativeName]);
    const engine = loadEngine({ distDir });
    assert.equal(engine.kind, 'native');
    assert.equal(engine.binding.ping(), 'st-engine');
});

test('the wasm is fetched when the platform has no native build, and the server loads it', async () => {
    publish();
    const distDir = freshDist();
    assert.equal(await ensureEngine({ platform: null, releaseBase, distDir }), path.join(distDir, wasmName));
    assert.deepEqual(requests, [`/engine-${key}/${wasmName}`]);
    const engine = loadEngine({ platform: null, distDir });
    assert.equal(engine.kind, 'wasm');
    assert.equal(engine.binding.ping(), 'st-engine');
});

test('the wasm is fetched when the release has no native build for the platform', async () => {
    publish();
    release.delete(`/engine-${key}/${nativeName}`);
    const distDir = freshDist();
    assert.equal(await ensureEngine({ releaseBase, distDir }), path.join(distDir, wasmName));
    assert.deepEqual(requests, [`/engine-${key}/${nativeName}`, `/engine-${key}/${wasmName}`]);
});

test('another hash\'s file is never used', async () => {
    release.clear();
    const distDir = freshDist();
    fs.copyFileSync(path.join(DIST_DIR, nativeName), path.join(distDir, nativeFileName('0000000000000000', platform)));
    await assert.rejects(ensureEngine({ releaseBase, distDir }), EngineFetchError);
    assert.throws(() => loadEngine({ distDir }), EngineLoadError);
});

test('once this hash\'s file is there, other hashes\' files are removed', async () => {
    publish();
    const old = '0000000000000000';
    for (const [fetchPlatform, keptName] of [[platform, nativeName], [null, wasmName]]) {
        for (const present of [true, false]) {
            const distDir = freshDist();
            fs.writeFileSync(path.join(distDir, nativeFileName(old, platform)), '');
            fs.writeFileSync(path.join(distDir, wasmFileName(old)), '');
            fs.writeFileSync(path.join(distDir, 'unrelated.txt'), '');
            if (present) fs.copyFileSync(path.join(DIST_DIR, keptName), path.join(distDir, keptName));
            assert.equal(await ensureEngine({ platform: fetchPlatform, releaseBase, distDir }), path.join(distDir, keptName));
            assert.deepEqual(fs.readdirSync(distDir).sort(), [keptName, 'unrelated.txt'].sort());
        }
    }
});
