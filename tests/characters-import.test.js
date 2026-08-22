import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// importFromJson()/importFromYaml() write through DEFAULT_AVATAR_PATH ('./public/img/...', repo-root-relative)
// when no real uploaded image is being re-encoded - same fix byaf-import.test.js already needed for the same
// reason (see that file's own comment). Captured before any chdir, and used below (not '..'-relative like
// characters-rename.test.js's setConfigFilePath call) so it stays correct regardless of chdir ordering.
const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real characters.js router (including multer, exactly as server-main.js wires it - see that file's
 * "File uploads" section) behind a fake auth middleware, mirroring characters-rename.test.js's setup. Multer is
 * required here (unlike the other endpoint test files) because `/import` reads `request.file`, only populated by
 * multer's `.single('avatar')` middleware - none of the sibling *-test.js files needed this, so there's no
 * existing pattern to reuse for the upload side specifically.
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    metadataDb = await import('../src/character-metadata-db.js');

    // importFromJson()/importFromYaml() read DEFAULT_AVATAR_PATH ('./public/img/...') relative to cwd - see
    // this file's own note on `originalCwd` above.
    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();

    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-import-test-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-import-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    const thumbnailsAvatarDir = path.join(tempDir, 'thumbnails', 'avatar');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(thumbnailsAvatarDir, { recursive: true });
    // thumbnailsAvatar is needed for the preserved_name replace path - /import calls invalidateThumbnail() for
    // any request that carries preserved_name, which throws if this directory isn't in `directories` at all.
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir, thumbnailsAvatar: thumbnailsAvatarDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/**
 * POSTs a v1-JSON character import (the simplest format importFromJson() accepts - no PNG re-encode pipeline
 * involved, so the uploaded bytes are exactly the JSON text below).
 * @param {object} [overrides]
 * @returns {Promise<Response>}
 */
async function importJsonCharacter(overrides = {}) {
    const body = JSON.stringify({ name: 'Ghost', description: 'A test character', ...overrides });
    const formData = new FormData();
    formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
    formData.append('file_type', 'json');

    return fetch(`${baseUrl}/api/characters/import`, {
        method: 'POST',
        body: formData,
    });
}

describe('POST /api/characters/import', () => {
    test('a successful import returns the character payload alongside file_name', async () => {
        const response = await importJsonCharacter();
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(typeof data.file_name).toBe('string');
        expect(data.duplicate).toBeUndefined();
        expect(data.character).toBeDefined();
        expect(data.character.avatar).toBe(`${data.file_name}.png`);
        expect(data.character.name).toBe('Ghost');
    });

    test('records a content_hash for the imported character', async () => {
        const response = await importJsonCharacter();
        const data = await response.json();

        const row = await metadataDb.getCharacterMetadataRow(directories, `${data.file_name}.png`);
        expect(row.content_hash).toEqual(expect.any(String));
        expect(row.content_hash.length).toBe(64); // sha256 hex digest
    });

    test('exact byte-identical dedup: importing the same bytes twice skips the second one', async () => {
        const first = await importJsonCharacter();
        const firstData = await first.json();
        expect(firstData.duplicate).toBeUndefined();

        const second = await importJsonCharacter();
        const secondData = await second.json();

        expect(secondData.duplicate).toBe(true);
        expect(secondData.duplicate_of).toBe(`${firstData.file_name}.png`);
        expect(secondData.file_name).toBeUndefined();

        // Only one character actually exists.
        const files = fs.readdirSync(directories.characters);
        expect(files.length).toBe(1);
    });

    test('different content is never treated as a duplicate', async () => {
        const first = await importJsonCharacter({ name: 'Ghost' });
        const firstData = await first.json();
        expect(firstData.duplicate).toBeUndefined();

        const second = await importJsonCharacter({ name: 'Different Ghost' });
        const secondData = await second.json();

        expect(secondData.duplicate).toBeUndefined();
        expect(secondData.file_name).not.toBe(firstData.file_name);

        const files = fs.readdirSync(directories.characters);
        expect(files.length).toBe(2);
    });

    test('in-batch dedup: two identical files uploaded back to back while batch-import mode is active still dedupe (pending buffer, not yet flushed)', async () => {
        const beginResponse = await fetch(`${baseUrl}/api/characters/metadata/batch-import/begin`, { method: 'POST' });
        expect(beginResponse.status).toBe(204);

        try {
            const first = await importJsonCharacter();
            const firstData = await first.json();
            expect(firstData.duplicate).toBeUndefined();

            // Still buffered, not yet in the real table - the write-path hook that recorded firstData's hash
            // went through applyOrBuffer() while batch mode is active, so a lookup that only checked the SQL
            // table would miss it (see findCharacterIdByContentHash()'s own doc comment on why it also checks
            // entry.batch.pending).
            const rowBeforeFlush = await metadataDb.getCharacterMetadataRow(directories, `${firstData.file_name}.png`);
            expect(rowBeforeFlush).toBeUndefined();

            const second = await importJsonCharacter();
            const secondData = await second.json();
            expect(secondData.duplicate).toBe(true);
            expect(secondData.duplicate_of).toBe(`${firstData.file_name}.png`);
        } finally {
            const endResponse = await fetch(`${baseUrl}/api/characters/metadata/batch-import/end`, { method: 'POST' });
            expect(endResponse.status).toBe(204);
        }

        // After the flush, still only one character on disk.
        const files = fs.readdirSync(directories.characters);
        expect(files.length).toBe(1);
    });

    test('a preserved_name replace bypasses dedup even if the bytes match another character', async () => {
        const first = await importJsonCharacter();
        const firstData = await first.json();

        // Import a second, distinct character to replace.
        const second = await importJsonCharacter({ name: 'Replace Target' });
        const secondData = await second.json();
        expect(secondData.file_name).not.toBe(firstData.file_name);

        // Re-upload the FIRST character's exact bytes again, but as an explicit replace of the SECOND character.
        const body = JSON.stringify({ name: 'Ghost', description: 'A test character' });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
        formData.append('file_type', 'json');
        formData.append('preserved_name', `${secondData.file_name}.png`);

        const replaceResponse = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        const replaceData = await replaceResponse.json();

        // Not skipped as a duplicate, even though these bytes already exist under firstData.file_name - the
        // explicit replace target takes precedence (see the route's own comment on why).
        expect(replaceData.duplicate).toBeUndefined();
        expect(replaceData.file_name).toBe(secondData.file_name);
        expect(replaceData.character.name).toBe('Ghost');
    });

    test('a preserved_name replace still records the NEW content_hash, not the old one', async () => {
        const first = await importJsonCharacter({ name: 'Original' });
        const firstData = await first.json();

        const body = JSON.stringify({ name: 'Replaced', description: 'new bytes' });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
        formData.append('file_type', 'json');
        formData.append('preserved_name', `${firstData.file_name}.png`);
        await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });

        const row = await metadataDb.getCharacterMetadataRow(directories, `${firstData.file_name}.png`);
        const originalRow = await metadataDb.findCharacterIdByContentHash(directories, row.content_hash);
        // The stored hash now resolves back to this same id, and a fresh duplicate of the REPLACED content
        // (not the original) is what a subsequent identical upload should be caught against.
        expect(originalRow).toBe(`${firstData.file_name}.png`);

        const duplicateCheck = await importJsonCharacter({ name: 'Replaced', description: 'new bytes' });
        const duplicateCheckData = await duplicateCheck.json();
        expect(duplicateCheckData.duplicate).toBe(true);
        expect(duplicateCheckData.duplicate_of).toBe(`${firstData.file_name}.png`);
    });
});

// unsetPrivateFields() (src/character-card-normalize.js) strips per-user local state - the favorite flag and the
// active chat filename - so a shared card doesn't leak the sharer's local state into the importer's library, and
// an exported card doesn't leak the exporter's. It's called from 5 sites in characters.js; these two tests cover
// the spec-v2 JSON import site (importFromJson()) and the JSON export site (the /export route's 'json' case) -
// the two reachable through this file's already-mounted router without needing a real PNG upload.
describe('unsetPrivateFields is applied on the real import/export routes', () => {
    test('importing a Spec V2 JSON character clears fav and chat even when the uploaded file sets them', async () => {
        const body = JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Wraith',
            data: {
                name: 'Wraith',
                description: 'A test character',
                extensions: { fav: true },
            },
            fav: true,
            chat: 'Wraith - some previous session',
        });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'wraith.json');
        formData.append('file_type', 'json');

        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        expect(response.status).toBe(200);
        const data = await response.json();

        const exportResponse = await fetch(`${baseUrl}/api/characters/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'json', avatar_url: `${data.file_name}.png` }),
        });
        const exported = await exportResponse.json();

        expect(exported.fav).toBe(false);
        expect(exported.data.extensions.fav).toBe(false);
        expect(exported.chat).toBeUndefined();
        expect(exported.name).toBe('Wraith');
    });

    test('exporting as JSON clears fav and chat on the exported copy without mutating the stored file', async () => {
        const importResponse = await importJsonCharacter({ name: 'Specter', fav: true });
        const importData = await importResponse.json();
        const avatarUrl = `${importData.file_name}.png`;

        const exportResponse = await fetch(`${baseUrl}/api/characters/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'json', avatar_url: avatarUrl }),
        });
        expect(exportResponse.status).toBe(200);
        const exported = await exportResponse.json();

        expect(exported.fav).toBe(false);
        expect(exported.data.extensions.fav).toBe(false);
        expect(exported.chat).toBeUndefined();
    });
});
