import { beforeAll, beforeEach, afterEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chats.js reads these config values at module load. Environment variables take
// precedence over config.yaml, so setting them here lets the module import
// without a config file present. The throttle interval is zeroed so lodash
// throttle timers don't keep the Jest process alive.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
// chats.js now also imports character-metadata-db.js (bumpGroupChatStats() - the groups-schema extension's
// write-path hook for /group/save), which reads these three config values at module load too (directly, plus
// character-shallow.js's own), so they need the same env-var treatment as the keys above.
process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = 'false';
process.env.SILLYTAVERN_PERFORMANCE_CHARACTERINDEXBUILDCONCURRENCY = '4';
process.env.SILLYTAVERN_PERFORMANCE_CHARACTERMETADATARECONCILEINTERVALMS = '300000';
// Groundwork for a not-yet-built duplicate scan (see character-metadata-db.js's own comment on this constant) -
// also read at module load, so it needs the same env-var treatment as the three keys above.
process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

/** @type {import('../src/endpoints/chats.js')} */
let chats;

beforeAll(async () => {
    chats = await import('../src/endpoints/chats.js');
});

const BOM = String.fromCharCode(0xFEFF);
const SLUG = '1e6905db-bab6-4901-913b-06d18cab5a8f';
const OTHER_SLUG = 'f1c1d103-464a-418a-a643-f9dab81589b9';

/**
 * Builds a chat array like the client sends it.
 * @param {string|null} slug Integrity slug for the header, or null for none
 * @returns {object[]} Chat array
 */
function makeChat(slug) {
    const metadata = slug ? { integrity: slug } : {};
    return [
        { user_name: 'User', character_name: 'Char', chat_metadata: metadata },
        { name: 'Char', is_user: false, mes: 'Hello' },
    ];
}

/**
 * Serializes a chat array the same way trySaveChat does.
 * @param {object[]} chatData Chat array
 * @returns {string} JSONL string
 */
function toJsonl(chatData) {
    return chatData.map(m => JSON.stringify(m)).join('\n');
}

describe('trySaveChat integrity check', () => {
    let tmpDir;
    let chatFile;
    let backupDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-integrity-'));
        chatFile = path.join(tmpDir, 'chat.jsonl');
        backupDir = path.join(tmpDir, 'backups');
        fs.mkdirSync(backupDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function save(chatData, { force = false } = {}) {
        return chats.trySaveChat(chatData, chatFile, force, 'default-user', 'Char', backupDir);
    }

    test('writes a new file when none exists', async () => {
        const chatData = makeChat(SLUG);
        await save(chatData);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(chatData));
    });

    test('overwrites when the integrity slug matches', async () => {
        fs.writeFileSync(chatFile, toJsonl(makeChat(SLUG)));
        const newChat = makeChat(SLUG);
        newChat[1].mes = 'Updated';
        await save(newChat);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('refuses to overwrite when the integrity slug mismatches and keeps the original bytes', async () => {
        const originalBytes = toJsonl(makeChat(SLUG));
        fs.writeFileSync(chatFile, originalBytes);
        await expect(save(makeChat(OTHER_SLUG))).rejects.toThrow(/integrity check failed/i);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
    });

    test('overwrites a legacy chat whose header has no integrity metadata', async () => {
        const legacyHeader = JSON.stringify({ user_name: 'User', character_name: 'Char', create_date: '2023-01-01' });
        fs.writeFileSync(chatFile, legacyHeader + '\n' + JSON.stringify({ name: 'Char', mes: 'Old' }));
        const newChat = makeChat(SLUG);
        await save(newChat);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('overwrites an empty file', async () => {
        fs.writeFileSync(chatFile, '');
        const newChat = makeChat(SLUG);
        await save(newChat);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('refuses to overwrite a non-empty file with an unparseable first line and keeps the original bytes', async () => {
        const originalBytes = 'this is not json{{{';
        fs.writeFileSync(chatFile, originalBytes);
        await expect(save(makeChat(SLUG))).rejects.toThrow(/integrity check failed/i);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
    });

    test('refuses to overwrite a truncated header and keeps the original bytes', async () => {
        const originalBytes = toJsonl(makeChat(SLUG)).slice(0, 25);
        fs.writeFileSync(chatFile, originalBytes);
        await expect(save(makeChat(SLUG))).rejects.toThrow(/integrity check failed/i);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
    });

    test('refuses to overwrite when the first line parses to a non-object', async () => {
        const originalBytes = '42\n' + JSON.stringify({ name: 'Char', mes: 'Orphan' });
        fs.writeFileSync(chatFile, originalBytes);
        await expect(save(makeChat(SLUG))).rejects.toThrow(/integrity check failed/i);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
    });

    test('refuses to overwrite when the file starts with a blank line but has content below', async () => {
        const originalBytes = '\n' + toJsonl(makeChat(SLUG));
        fs.writeFileSync(chatFile, originalBytes);
        await expect(save(makeChat(SLUG))).rejects.toThrow(/integrity check failed/i);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
    });

    test('ignores a UTF-8 BOM in front of a valid matching header', async () => {
        fs.writeFileSync(chatFile, BOM + toJsonl(makeChat(SLUG)));
        const newChat = makeChat(SLUG);
        newChat[1].mes = 'Updated';
        await save(newChat);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('still checks the integrity slug behind a UTF-8 BOM', async () => {
        const originalBytes = BOM + toJsonl(makeChat(SLUG));
        fs.writeFileSync(chatFile, originalBytes);
        await expect(save(makeChat(OTHER_SLUG))).rejects.toThrow(/integrity check failed/i);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
    });

    test('force overwrites a corrupted file when the user confirmed', async () => {
        fs.writeFileSync(chatFile, 'this is not json{{{');
        const newChat = makeChat(SLUG);
        await save(newChat, { force: true });
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('force overwrites a mismatching file when the user confirmed', async () => {
        fs.writeFileSync(chatFile, toJsonl(makeChat(SLUG)));
        const newChat = makeChat(OTHER_SLUG);
        await save(newChat, { force: true });
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('skips the check when the incoming chat has no integrity slug (existing behavior)', async () => {
        fs.writeFileSync(chatFile, toJsonl(makeChat(SLUG)));
        const newChat = makeChat(null);
        await save(newChat);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    describe('integrity slug rotation', () => {
        // Root cause of the original bug: the slug a tab first loaded was carried forward unchanged on every
        // subsequent save, including the one written to disk - so the "expected" slug on file never diverged
        // from what any tab that had ever loaded the chat was sending, and the check could never actually catch
        // a stale write. These tests pin the fix: every successful write mints a fresh slug, writes it into the
        // file, and returns it so the caller can carry it into that tab's next save.

        test('returns a fresh slug, different from the one that was sent, on a successful save', async () => {
            const chatData = makeChat(SLUG);
            const returned = await save(chatData);
            expect(typeof returned).toBe('string');
            expect(returned).not.toBe(SLUG);
        });

        test('writes the new slug into the saved file, not the slug the caller sent', async () => {
            const chatData = makeChat(SLUG);
            const returned = await save(chatData);
            const onDisk = fs.readFileSync(chatFile, 'utf8').split('\n')[0];
            expect(JSON.parse(onDisk).chat_metadata.integrity).toBe(returned);
        });

        test('mints a slug for a chat that had none yet, instead of leaving it unset', async () => {
            const chatData = makeChat(null);
            const returned = await save(chatData);
            expect(typeof returned).toBe('string');
            const onDisk = fs.readFileSync(chatFile, 'utf8').split('\n')[0];
            expect(JSON.parse(onDisk).chat_metadata.integrity).toBe(returned);
        });

        test('rotates again on a second save from the same caller, carrying the previous return value forward', async () => {
            const firstSlug = await save(makeChat(SLUG));
            const secondChat = makeChat(firstSlug);
            secondChat[1].mes = 'Updated';
            const secondSlug = await save(secondChat);
            expect(secondSlug).not.toBe(firstSlug);
            const onDisk = fs.readFileSync(chatFile, 'utf8').split('\n')[0];
            expect(JSON.parse(onDisk).chat_metadata.integrity).toBe(secondSlug);
        });

        test('does not mutate the caller\'s slug when the check rejects the save', async () => {
            fs.writeFileSync(chatFile, toJsonl(makeChat(SLUG)));
            const staleChat = makeChat(OTHER_SLUG);
            await expect(save(staleChat)).rejects.toThrow(/integrity check failed/i);
            // The stale caller's own in-memory chat_metadata must not have been mutated with a slug that was
            // never actually written anywhere - a rejected save has nothing to hand back.
            expect(staleChat[0].chat_metadata.integrity).toBe(OTHER_SLUG);
        });

        test('force-overwriting still mints and returns a fresh slug', async () => {
            fs.writeFileSync(chatFile, toJsonl(makeChat(SLUG)));
            const forced = makeChat(OTHER_SLUG);
            const returned = await save(forced, { force: true });
            expect(typeof returned).toBe('string');
            expect(returned).not.toBe(OTHER_SLUG);
            const onDisk = fs.readFileSync(chatFile, 'utf8').split('\n')[0];
            expect(JSON.parse(onDisk).chat_metadata.integrity).toBe(returned);
        });
    });

    describe('concurrent-tab simulation', () => {
        // Simulates the exact scenario from today's investigation: two browser tabs load the same chat (so
        // both start out holding the same load-time slug), then both try to save without either having seen
        // the other's write. Before the fix, both saves would silently succeed and the second write would
        // clobber the first with no error, no popup, and no data-loss signal. After the fix, the second tab's
        // save must be rejected, and the first tab's write must survive on disk untouched.

        test('second tab is rejected and the first tab\'s write survives, when both tabs share the load-time slug', async () => {
            // Both tabs load the same chat and see the same slug (this is exactly the bug: the slug never
            // rotates on load, so two tabs opening the same file at different times still converge on one
            // shared value once either of them has saved at least once - or, as here, on the very first load).
            const loadTimeSlug = SLUG;
            fs.writeFileSync(chatFile, toJsonl(makeChat(loadTimeSlug)));

            // Tab A types a message and saves first. Its save succeeds and the server hands back a new slug -
            // in the real client this lands in that tab's in-memory chat_metadata (see saveChat() in script.js).
            const tabAChat = makeChat(loadTimeSlug);
            tabAChat.push({ name: 'Char', is_user: false, mes: 'Reply seen only by tab A' });
            const tabANewSlug = await save(tabAChat);
            expect(tabANewSlug).toBeDefined();

            // Tab B never saw tab A's write - it still believes the load-time slug is current, and sends its
            // own (different) message on top of what it still thinks is the same base chat.
            const tabBChat = makeChat(loadTimeSlug);
            tabBChat.push({ name: 'Char', is_user: false, mes: 'Reply seen only by tab B' });

            // Before the fix this resolved successfully and silently overwrote tab A's message. Now it must
            // reject, because the slug on disk has already moved on to tabANewSlug.
            await expect(save(tabBChat)).rejects.toThrow(/integrity check failed/i);

            // Tab A's write must still be exactly what's on disk - nothing from tab B made it through.
            const onDisk = fs.readFileSync(chatFile, 'utf8');
            expect(onDisk).toBe(toJsonl(tabAChat));
            expect(onDisk).toContain('Reply seen only by tab A');
            expect(onDisk).not.toContain('Reply seen only by tab B');
        });

        test('tab B can recover by reloading (adopting the on-disk slug) and then saves cleanly', async () => {
            fs.writeFileSync(chatFile, toJsonl(makeChat(SLUG)));
            const tabAChat = makeChat(SLUG);
            tabAChat.push({ name: 'Char', is_user: false, mes: 'From tab A' });
            const tabANewSlug = await save(tabAChat);

            const tabBStaleChat = makeChat(SLUG);
            tabBStaleChat.push({ name: 'Char', is_user: false, mes: 'From tab B (stale)' });
            await expect(save(tabBStaleChat)).rejects.toThrow(/integrity check failed/i);

            // This is what saveChat()'s "reload to prevent data corruption" popup accomplishes on the client:
            // a fresh load re-reads the current on-disk state (and its current slug) instead of tab B's stale
            // in-memory copy, so both the base content and the slug for the next save are current.
            const tabBReloadedChat = tabAChat.map(m => JSON.parse(JSON.stringify(m)));
            tabBReloadedChat.push({ name: 'Char', is_user: false, mes: 'From tab B (after reload)' });
            const tabBNewSlug = await save(tabBReloadedChat);
            expect(tabBNewSlug).toBeDefined();

            const onDisk = fs.readFileSync(chatFile, 'utf8');
            expect(onDisk).toContain('From tab A');
            expect(onDisk).toContain('From tab B (after reload)');
        });

        test('two tabs saving back-to-back without conflict (sequential, not concurrent) both succeed', async () => {
            // Sanity check that the fix doesn't over-reject: a single tab saving twice in a row (the normal,
            // non-conflicting case) must keep working, carrying its own previous response's slug forward.
            let chatData = makeChat(SLUG);
            const firstSlug = await save(chatData);

            chatData = makeChat(firstSlug);
            chatData.push({ name: 'Char', is_user: false, mes: 'Second message, same tab' });
            const secondSlug = await save(chatData);

            expect(secondSlug).toBeDefined();
            expect(secondSlug).not.toBe(firstSlug);
            expect(fs.readFileSync(chatFile, 'utf8')).toContain('Second message, same tab');
        });
    });
});
