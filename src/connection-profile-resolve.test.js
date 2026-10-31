import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConnectionProfile } from './connection-profile-resolve.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-connection-profile-test-'));
fs.mkdirSync(path.join(root, 'settings'), { recursive: true });

function writeExtensionSettings(profiles) {
    fs.writeFileSync(
        path.join(root, 'settings', 'extension_settings.json'),
        JSON.stringify({ connectionManager: { profiles } }),
    );
}

const directories = { root };

writeExtensionSettings([
    { id: 'p1', mode: 'cc', api: 'koboldcpp', model: 'my-model', 'api-url': 'http://127.0.0.1:5001' },
]);
{
    const { profile, selectedApiMap } = resolveConnectionProfile(directories, 'p1');
    assert.equal(profile.model, 'my-model');
    assert.equal(selectedApiMap.selected, 'textgenerationwebui');
    assert.equal(selectedApiMap.type, 'koboldcpp');
}

writeExtensionSettings([
    { id: 'p2', mode: 'cc', api: 'openrouter', model: 'some/model' },
]);
{
    const { selectedApiMap } = resolveConnectionProfile(directories, 'p2');
    assert.equal(selectedApiMap.selected, 'openai');
    assert.equal(selectedApiMap.source, 'openrouter');
}

writeExtensionSettings([{ id: 'p1', api: 'koboldcpp' }]);
assert.throws(() => resolveConnectionProfile(directories, 'does-not-exist'), /Profile not found/);

writeExtensionSettings([{ id: 'p3' }]);
assert.throws(() => resolveConnectionProfile(directories, 'p3'), /has an API/);

writeExtensionSettings([{ id: 'p4', api: 'totally-not-a-real-api' }]);
assert.throws(() => resolveConnectionProfile(directories, 'p4'), /Unknown API type/);

writeExtensionSettings([{ id: 'p5', api: 'vllm' }, { id: 'p6', api: 'claude' }]);
{
    const vllm = resolveConnectionProfile(directories, 'p5');
    assert.equal(vllm.selectedApiMap.type, 'vllm');
    const claude = resolveConnectionProfile(directories, 'p6');
    assert.equal(claude.selectedApiMap.source, 'claude');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('connection-profile-resolve.test.js: all assertions passed');
