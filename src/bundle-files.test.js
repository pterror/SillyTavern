import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    BUNDLE_FOLDERS, bundleFilesOf, deleteBundleFile, groupOfApi, listBundleFiles, readBundleFile, renameBundleFile, writeBundleFile,
} from './bundle-files.js';

function directories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-files-'));
    /** @type {Record<string, string>} */
    const dirs = { root };
    for (const key of Object.values(BUNDLE_FOLDERS)) {
        dirs[key] = path.join(root, key);
        fs.mkdirSync(dirs[key]);
    }
    return /** @type {any} */ (dirs);
}

test('upstream preset API ids name their groups', () => {
    assert.equal(groupOfApi('openai'), 'preset.openai');
    assert.equal(groupOfApi('koboldhorde'), 'preset.kobold');
    assert.equal(groupOfApi('kobold'), 'preset.kobold');
    assert.equal(groupOfApi('instruct'), 'template.instruct');
    assert.equal(groupOfApi('reasoning'), 'template.reasoning');
    assert.equal(groupOfApi('nope'), undefined);
});

test('a bundle file is written under its sanitized name, read, renamed and deleted', () => {
    const dirs = directories();
    assert.equal(writeBundleFile(dirs, 'preset.openai', 'My/Preset', { temperature: 1 }), 'MyPreset');
    assert.deepEqual(readBundleFile(dirs, 'preset.openai', 'MyPreset'), { temperature: 1 });
    assert.deepEqual(bundleFilesOf(dirs)('preset.openai', 'MyPreset'), { temperature: 1 });
    assert.equal(bundleFilesOf(dirs)('preset.openai', 'Nope'), undefined);
    writeBundleFile(dirs, 'preset.openai', 'Other', {});
    assert.equal(renameBundleFile(dirs, 'preset.openai', 'MyPreset', 'Other'), 'taken');
    assert.equal(renameBundleFile(dirs, 'preset.openai', 'Nope', 'Third'), 'missing');
    assert.equal(renameBundleFile(dirs, 'preset.openai', 'MyPreset', ''), 'invalid');
    assert.equal(renameBundleFile(dirs, 'preset.openai', 'MyPreset', 'Third'), 'renamed');
    assert.equal(readBundleFile(dirs, 'preset.openai', 'MyPreset'), null);
    assert.equal(deleteBundleFile(dirs, 'preset.openai', 'Third'), true);
    assert.equal(deleteBundleFile(dirs, 'preset.openai', 'Third'), false);
    assert.equal(writeBundleFile(dirs, 'nope', 'X', {}), undefined);
});

test('a group\'s files listed by name, skipping what isn\'t JSON, in locale or code-unit order', () => {
    const dirs = directories();
    const folder = dirs[BUNDLE_FOLDERS.theme];
    fs.writeFileSync(path.join(folder, 'b.json'), '{"name":"b"}');
    fs.writeFileSync(path.join(folder, 'B2.json'), '{"name":"B2"}');
    fs.writeFileSync(path.join(folder, 'a.json'), '{"name":"a"}');
    fs.writeFileSync(path.join(folder, 'broken.json'), '{');
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    assert.deepEqual(listBundleFiles(dirs, 'theme').map(entry => entry.name), ['B2', 'a', 'b']);
    assert.deepEqual(listBundleFiles(dirs, 'theme', { order: 'locale' }).map(entry => entry.name), ['a', 'b', 'B2']);
    const [first] = listBundleFiles(dirs, 'theme');
    assert.deepEqual([first.text, first.file], ['{"name":"B2"}', { name: 'B2' }]);
});
