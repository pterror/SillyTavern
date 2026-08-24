import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/chat-metadata-db.js')} */
let chatMetadataDb;

let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    chatMetadataDb = await import('../src/chat-metadata-db.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-metadata-db-test-'));
    directories = { root: tempDir };
});

afterEach(() => {
    chatMetadataDb.disposeChatMetadataStores();
});

/**
 * A minimal but realistic chat array: a header item (chat_metadata only) followed by N message items.
 * @param {number} messageCount
 * @param {object} [overrides] Shallow-merged onto the last message item
 * @returns {Array<object>}
 */
function makeChatData(messageCount, overrides = {}) {
    const items = [{ chat_metadata: { integrity: 'seed-slug' } }];
    for (let i = 0; i < messageCount; i++) {
        items.push({ name: 'Alice', is_user: false, mes: `Message ${i}`, send_date: `2024-01-0${(i % 9) + 1}T00:00:00.000Z` });
    }
    if (items.length > 1) {
        items[items.length - 1] = { ...items[items.length - 1], ...overrides };
    }
    return items;
}

describe('upsertChatFromSave', () => {
    test('creates a row reflecting the just-saved chat array', async () => {
        const filePath = path.join(tempDir, 'chat1.jsonl');
        const chatData = makeChatData(3, { mes: 'The last message', send_date: '2024-01-05T00:00:00.000Z' });

        await chatMetadataDb.upsertChatFromSave(directories, filePath, chatData, 1000, 500);
        const row = await chatMetadataDb.getChatRow(directories, filePath);

        expect(row).toBeDefined();
        expect(row.file_name).toBe('chat1.jsonl');
        expect(row.message_count).toBe(3);
        expect(row.preview).toBe('The last message');
        expect(row.last_mes).toBe('2024-01-05T00:00:00.000Z');
        expect(row.mtime).toBe(1000);
        expect(row.file_size).toBe(500);
        expect(JSON.parse(row.chat_metadata_json).integrity).toBe('seed-slug');
        expect(row.rev).toBeGreaterThan(0);
    });

    test('handles an empty chat array without throwing', async () => {
        const filePath = path.join(tempDir, 'empty.jsonl');
        await chatMetadataDb.upsertChatFromSave(directories, filePath, [], 1000, 0);
        const row = await chatMetadataDb.getChatRow(directories, filePath);

        expect(row).toBeDefined();
        expect(row.message_count).toBe(0);
        expect(row.preview).toBe('[The chat is empty]');
    });

    test('a later save overwrites the row in place, bumping rev', async () => {
        const filePath = path.join(tempDir, 'chat1.jsonl');
        await chatMetadataDb.upsertChatFromSave(directories, filePath, makeChatData(1), 1000, 100);
        const firstRow = await chatMetadataDb.getChatRow(directories, filePath);

        await chatMetadataDb.upsertChatFromSave(directories, filePath, makeChatData(2), 2000, 200);
        const secondRow = await chatMetadataDb.getChatRow(directories, filePath);

        expect(secondRow.message_count).toBe(2);
        expect(secondRow.mtime).toBe(2000);
        expect(secondRow.rev).toBeGreaterThan(firstRow.rev);
    });
});

describe('upsertChatFromParse', () => {
    test('stores a row shaped from a getChatInfo()-like object', async () => {
        const filePath = path.join(tempDir, 'chat2.jsonl');
        const chatInfo = {
            chat_items: 5,
            mes: 'Last preview text',
            last_mes: '2024-02-01T00:00:00.000Z',
            chat_metadata: { note: 'hi' },
        };

        await chatMetadataDb.upsertChatFromParse(directories, filePath, { mtimeMs: 3000, size: 999 }, chatInfo);
        const row = await chatMetadataDb.getChatRow(directories, filePath);

        expect(row.message_count).toBe(5);
        expect(row.preview).toBe('Last preview text');
        expect(row.mtime).toBe(3000);
        expect(row.file_size).toBe(999);
        expect(JSON.parse(row.chat_metadata_json).note).toBe('hi');
    });
});

describe('getChatRow', () => {
    test('returns undefined for an untracked file', async () => {
        const row = await chatMetadataDb.getChatRow(directories, path.join(tempDir, 'nope.jsonl'));
        expect(row).toBeUndefined();
    });
});

describe('deleteChatRow', () => {
    test('removes the row and records a change-log delete entry', async () => {
        const filePath = path.join(tempDir, 'chat1.jsonl');
        await chatMetadataDb.upsertChatFromSave(directories, filePath, makeChatData(1), 1000, 100);
        const revBeforeDelete = await chatMetadataDb.getLatestRev(directories);

        await chatMetadataDb.deleteChatRow(directories, filePath);

        const row = await chatMetadataDb.getChatRow(directories, filePath);
        expect(row).toBeUndefined();

        const changes = await chatMetadataDb.getChangesSince(directories, revBeforeDelete);
        expect(changes).toHaveLength(1);
        expect(changes[0].op).toBe('delete');
        expect(changes[0].file_path).toBe(filePath);
    });

    test('deleting an untracked file is a no-op, not an error', async () => {
        await expect(chatMetadataDb.deleteChatRow(directories, path.join(tempDir, 'nope.jsonl'))).resolves.not.toThrow();
    });
});

describe('renameChatRow', () => {
    test('moves the row content to the new path and drops the old one', async () => {
        const oldPath = path.join(tempDir, 'old.jsonl');
        const newPath = path.join(tempDir, 'new.jsonl');
        await chatMetadataDb.upsertChatFromSave(directories, oldPath, makeChatData(2, { mes: 'hi there' }), 1000, 100);

        await chatMetadataDb.renameChatRow(directories, oldPath, newPath);

        const oldRow = await chatMetadataDb.getChatRow(directories, oldPath);
        const newRow = await chatMetadataDb.getChatRow(directories, newPath);
        expect(oldRow).toBeUndefined();
        expect(newRow).toBeDefined();
        expect(newRow.file_name).toBe('new.jsonl');
        expect(newRow.message_count).toBe(2);
        expect(newRow.preview).toBe('hi there');
        expect(newRow.mtime).toBe(1000);
    });

    test('renaming an untracked file is a no-op, not an error', async () => {
        const oldPath = path.join(tempDir, 'old.jsonl');
        const newPath = path.join(tempDir, 'new.jsonl');
        await expect(chatMetadataDb.renameChatRow(directories, oldPath, newPath)).resolves.not.toThrow();
        expect(await chatMetadataDb.getChatRow(directories, newPath)).toBeUndefined();
    });
});

describe('getLatestRev / getChangesSince', () => {
    test('rev is monotonically increasing across multiple writes to different files', async () => {
        const revStart = await chatMetadataDb.getLatestRev(directories);
        expect(revStart).toBe(0);

        await chatMetadataDb.upsertChatFromSave(directories, path.join(tempDir, 'a.jsonl'), makeChatData(1), 1000, 10);
        await chatMetadataDb.upsertChatFromSave(directories, path.join(tempDir, 'b.jsonl'), makeChatData(1), 1000, 10);
        await chatMetadataDb.deleteChatRow(directories, path.join(tempDir, 'a.jsonl'));

        const revEnd = await chatMetadataDb.getLatestRev(directories);
        expect(revEnd).toBe(3);

        const changes = await chatMetadataDb.getChangesSince(directories, 0);
        expect(changes.map(c => c.op)).toEqual(['upsert', 'upsert', 'delete']);
        expect(changes.every((c, i) => i === 0 || c.rev > changes[i - 1].rev)).toBe(true);
    });

    test('getChangesSince only returns changes strictly newer than the given rev', async () => {
        await chatMetadataDb.upsertChatFromSave(directories, path.join(tempDir, 'a.jsonl'), makeChatData(1), 1000, 10);
        const midRev = await chatMetadataDb.getLatestRev(directories);
        await chatMetadataDb.upsertChatFromSave(directories, path.join(tempDir, 'b.jsonl'), makeChatData(1), 1000, 10);

        const changes = await chatMetadataDb.getChangesSince(directories, midRev);
        expect(changes).toHaveLength(1);
        expect(changes[0].file_path).toBe(path.join(tempDir, 'b.jsonl'));
    });
});
