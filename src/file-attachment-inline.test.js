import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendFileAttachments, readFileAttachment } from './file-attachment-inline.js';

function makeFilesDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-file-attachment-inline-test-'));
    const filesDir = path.join(root, 'user', 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    return { root, files: filesDir };
}

test('appendFileAttachments: extra.files absent - messageText unchanged', async () => {
    const result = await appendFileAttachments({}, 'hello world', { directories: makeFilesDir() });
    assert.equal(result, 'hello world');
});

test('appendFileAttachments: extra undefined/null - messageText unchanged', async () => {
    assert.equal(await appendFileAttachments(undefined, 'hi', {}), 'hi');
    assert.equal(await appendFileAttachments(null, 'hi', {}), 'hi');
});

test('appendFileAttachments: extra.files empty array - messageText unchanged', async () => {
    const result = await appendFileAttachments({ files: [] }, 'hello world', { directories: makeFilesDir() });
    assert.equal(result, 'hello world');
});

test('appendFileAttachments: file entry with .text already set - used verbatim, no fs read attempted', async () => {
    const directories = makeFilesDir();
    // No file on disk at all - if this attempted a real read it would throw/return undefined and
    // fail the assertion below, proving .text short-circuits the disk read.
    const extra = { files: [{ text: 'inline file text', url: '/user/files/does-not-exist.txt' }] };
    const result = await appendFileAttachments(extra, 'the message', { directories });
    assert.equal(result, 'inline file text\n\nthe message');
});

test('appendFileAttachments: file entry with only .url - real file read from a real temp directories.files fixture', async () => {
    const directories = makeFilesDir();
    fs.writeFileSync(path.join(directories.files, 'abc123.txt'), 'content from disk');
    const extra = { files: [{ url: '/user/files/abc123.txt' }] };
    const result = await appendFileAttachments(extra, 'the message', { directories });
    assert.equal(result, 'content from disk\n\nthe message');
});

test('appendFileAttachments: multiple files joined with \\n\\n in array order', async () => {
    const directories = makeFilesDir();
    fs.writeFileSync(path.join(directories.files, 'first.txt'), 'FIRST');
    fs.writeFileSync(path.join(directories.files, 'second.txt'), 'SECOND');
    const extra = {
        files: [
            { url: '/user/files/first.txt' },
            { text: 'MIDDLE' },
            { url: '/user/files/second.txt' },
        ],
    };
    const result = await appendFileAttachments(extra, 'the message', { directories });
    assert.equal(result, 'FIRST\n\nMIDDLE\n\nSECOND\n\nthe message');
});

test('appendFileAttachments: a missing file among multiple is gracefully skipped, valid ones still included', async () => {
    const directories = makeFilesDir();
    fs.writeFileSync(path.join(directories.files, 'exists.txt'), 'EXISTS');
    const extra = {
        files: [
            { url: '/user/files/exists.txt' },
            { url: '/user/files/does-not-exist.txt' },
        ],
    };
    const result = await appendFileAttachments(extra, 'the message', { directories });
    assert.equal(result, 'EXISTS\n\nthe message');
});

test('appendFileAttachments: EDGE CASE - files array non-empty but every resolved text is empty/falsy still prepends a bare \\n\\n', async () => {
    const directories = makeFilesDir();
    // Neither file exists on disk, and no .text is set - every individual fileText resolves falsy,
    // but the extra.files.length > 0 guard already let us into the branch, so per the client's
    // exact logic (fileTexts.join('\n\n') + '\n\n', where fileTexts ends up []) the merged prefix
    // degenerates to a bare '\n\n', not "no change at all".
    const extra = {
        files: [
            { url: '/user/files/missing-one.txt' },
            { url: '/user/files/missing-two.txt' },
        ],
    };
    const result = await appendFileAttachments(extra, 'the message', { directories });
    assert.equal(result, '\n\nthe message');
});

test('readFileAttachment: returns undefined for a missing url', async () => {
    const directories = makeFilesDir();
    assert.equal(await readFileAttachment(undefined, { directories }), undefined);
    assert.equal(await readFileAttachment('', { directories }), undefined);
});

test('readFileAttachment: returns undefined when directories.files is missing', async () => {
    assert.equal(await readFileAttachment('/user/files/x.txt', {}), undefined);
    assert.equal(await readFileAttachment('/user/files/x.txt', { directories: {} }), undefined);
});

test('readFileAttachment: returns undefined (not throw) for an unreadable file', async () => {
    const directories = makeFilesDir();
    const result = await readFileAttachment('/user/files/nope.txt', { directories });
    assert.equal(result, undefined);
});

test('readFileAttachment: rejects a crafted path that would escape directories.files', async () => {
    const directories = makeFilesDir();
    // Plant a secret file just outside the files dir, then try to reach it via a traversal URL.
    fs.writeFileSync(path.join(directories.root, 'secret.txt'), 'TOP SECRET');
    const result = await readFileAttachment('/user/files/../../secret.txt', { directories });
    assert.equal(result, undefined, 'path.basename() should strip the traversal segments, and the file should not be found inside directories.files');
});

test('readFileAttachment: real read succeeds for a real file', async () => {
    const directories = makeFilesDir();
    fs.writeFileSync(path.join(directories.files, 'real.txt'), 'REAL CONTENT');
    const result = await readFileAttachment('/user/files/real.txt', { directories });
    assert.equal(result, 'REAL CONTENT');
});
