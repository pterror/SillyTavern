import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;

let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-try-set-meta-values-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('character-metadata-db.js: trySetMetaValues()', () => {
    test('writes every key', async () => {
        expect(await metadataDb.trySetMetaValues(directories, { a: '1', b: 2 })).toBe(true);
        expect(await metadataDb.getMetaValue(directories, 'a')).toBe('1');
        expect(await metadataDb.getMetaValue(directories, 'b')).toBe('2');
    });

    test('while another connection holds the write lock, returns false at once and writes none of the keys', async () => {
        await metadataDb.setMetaValue(directories, 'a', 'old');
        const blocker = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            blocker.exec('BEGIN IMMEDIATE');
            const started = Date.now();
            expect(await metadataDb.trySetMetaValues(directories, { a: 'new', b: 'new' })).toBe(false);
            expect(Date.now() - started).toBeLessThan(1000);
            expect(errorSpy).not.toHaveBeenCalled();
            blocker.exec('ROLLBACK');

            expect(await metadataDb.getMetaValue(directories, 'a')).toBe('old');
            expect(await metadataDb.getMetaValue(directories, 'b')).toBeNull();

            expect(await metadataDb.trySetMetaValues(directories, { a: 'new', b: 'new' })).toBe(true);
            expect(await metadataDb.getMetaValue(directories, 'a')).toBe('new');
            expect(await metadataDb.getMetaValue(directories, 'b')).toBe('new');
        } finally {
            errorSpy.mockRestore();
            blocker.close();
        }
    });
});
