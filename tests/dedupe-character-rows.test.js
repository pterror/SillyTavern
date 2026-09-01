import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

// character-shallow.js (imported transitively by the script under test, for calculateChatSize()) reads this
// config value at module load - same env-var treatment tests/chat-info.test.js already needs for the same
// reason, so the module imports without a config file being set up.
process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = 'false';

// A minimal valid 1x1 transparent PNG - same fixture dedupe-untouched-cards.test.js uses. The script under test
// re-derives content_identity_hash/avatar_identity_hash from real PNG bytes (see its own header on why a naive
// full-byte compare doesn't work here), so test fixtures have to be genuine parseable card PNGs, not arbitrary
// bytes.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

/** @type {typeof import('../scripts/dedupe-character-rows.mjs')} */
let dedupeScript;
/** @type {typeof import('better-sqlite3').default} */
let Database;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('../src/png/encode.js').default} */
let encode;
/** @type {any} */
let PNGtext;

beforeAll(async () => {
    dedupeScript = await import('../scripts/dedupe-character-rows.mjs');
    ({ default: Database } = await import('better-sqlite3'));
    cardParser = await import('../src/character-card-parser.js');
    ({ default: extract } = await import('png-chunks-extract'));
    ({ default: encode } = await import('../src/png/encode.js'));
    PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
});

describe('dedupe-character-rows.mjs', () => {
    let tempDir;
    let charactersDir;
    let chatsDir;
    let dbPath;
    let db;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dedupe-character-rows-'));
        charactersDir = path.join(tempDir, 'characters');
        chatsDir = path.join(tempDir, 'chats');
        fs.mkdirSync(charactersDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });
        dbPath = path.join(tempDir, 'character-metadata.sqlite');

        db = new Database(dbPath);
        // Minimal slice of character-metadata-db.js's real schema - only the columns/tables this script touches.
        db.exec(`
            CREATE TABLE characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                content_identity_hash TEXT,
                fav INTEGER NOT NULL DEFAULT 0,
                active_chat TEXT,
                date_added INTEGER NOT NULL DEFAULT 0,
                date_last_chat INTEGER NOT NULL DEFAULT 0,
                chat_size INTEGER NOT NULL DEFAULT 0,
                rev INTEGER NOT NULL DEFAULT 0,
                shallow_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE character_tags (
                character_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (character_id, tag_id)
            );
            CREATE TABLE changes (
                rev INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL,
                op TEXT NOT NULL
            );
            CREATE TABLE local_import_mtimes (
                source_path TEXT PRIMARY KEY,
                mtime_ms INTEGER NOT NULL,
                duplicate_of TEXT
            );
        `);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /**
     * @param {{id: string, content_identity_hash: string, fav?: number, active_chat?: string|null,
     * date_added?: number, date_last_chat?: number, chat_size?: number, name?: string}[]} rows
     */
    function seedRows(rows) {
        const insert = db.prepare(`
            INSERT INTO characters (id, name, content_identity_hash, fav, active_chat, date_added, date_last_chat, chat_size, shallow_json)
            VALUES (@id, @name, @content_identity_hash, @fav, @active_chat, @date_added, @date_last_chat, @chat_size, @shallow_json)
        `);
        for (const row of rows) {
            const defaults = { name: '', fav: 0, active_chat: null, date_added: 0, date_last_chat: 0, chat_size: 0 };
            const full = { ...defaults, ...row };
            insert.run({ ...full, shallow_json: JSON.stringify({ fav: !!full.fav, chat_size: full.chat_size, date_last_chat: full.date_last_chat, chat: full.active_chat }) });
        }
    }

    function queryRows() {
        return db.prepare('SELECT id, name, content_identity_hash, fav, active_chat, date_added, date_last_chat, chat_size FROM characters WHERE content_identity_hash IS NOT NULL').all();
    }

    /**
     * Builds a genuine parseable card PNG (chara tEXt chunk + a real, valid image) and writes it to disk -
     * verifyContentAndAvatarIdentical() re-derives real identity hashes from these bytes, so fixtures have to be
     * real cards, not arbitrary bytes.
     * @param {string} id
     * @param {object} charaData
     * @param {Buffer} [baseImage] Defaults to a shared blank image - pass a different one to simulate a
     * genuinely different portrait.
     */
    function writeCardPng(id, charaData, baseImage = BLANK_PNG) {
        const png = cardParser.write(baseImage, JSON.stringify(charaData));
        fs.writeFileSync(path.join(charactersDir, id), png);
    }

    /** A second base image with different IDAT bytes - for the "genuinely different portrait" test case. */
    function makeDifferentImage() {
        const chunks = extract(new Uint8Array(BLANK_PNG));
        const idat = chunks.find(c => c.name === 'IDAT');
        idat.data = new Uint8Array(idat.data);
        idat.data[0] ^= 0xff;
        return Buffer.from(encode(chunks));
    }

    function writeChat(id, fileName, content) {
        const dir = path.join(chatsDir, id.replace(/\.png$/, ''));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fileName), Buffer.from(content));
    }

    test('picks the row with real chat activity as survivor, not the lowest id', () => {
        // Mirrors the real "Mommy Unohana.png" vs UUID-named duplicate case: lowest-id sort alone would pick
        // the row with zero chat activity.
        writeCardPng('AAAA-uuid.png', { name: 'Zed' });
        writeCardPng('Zed.png', { name: 'Zed' });
        writeChat('Zed.png', 'chat1.jsonl', 'real conversation');

        seedRows([
            { id: 'AAAA-uuid.png', content_identity_hash: 'h', date_added: 2 },
            { id: 'Zed.png', content_identity_hash: 'h', date_added: 1, date_last_chat: 100, chat_size: 999 },
        ]);

        const counters = dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: false });

        expect(counters.needsReview).toBe(0);
        // survivor kept its own PNG, loser would be removed - confirm by re-running with apply and checking ids.
        const applyCounters = dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });
        expect(applyCounters.losersRemoved).toBe(1);
        const remaining = db.prepare('SELECT id FROM characters').all().map(r => r.id);
        expect(remaining).toEqual(['Zed.png']);
    });

    test('fav is inherited (OR) onto the survivor even when the survivor itself was not favorited', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        // Alice wins survivor selection on real chat activity (policy's top-priority signal); Bob is the loser
        // here purely because he has no chat, despite carrying fav=1 - that fav still has to survive the merge.
        writeChat('Alice.png', 'chat.jsonl', 'a real conversation');
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1, fav: 0, chat_size: 20 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2, fav: 1 },
        ]);

        dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        const survivor = db.prepare('SELECT fav, shallow_json FROM characters WHERE id = ?').get('Alice.png');
        expect(survivor.fav).toBe(1);
        expect(JSON.parse(survivor.shallow_json).fav).toBe(true);
    });

    test('tags are unioned onto the survivor from every loser', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2 },
        ]);
        db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run('Alice.png', 'tag-shared');
        db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run('Bob.png', 'tag-shared');
        db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run('Bob.png', 'tag-only-on-loser');

        dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        const survivorTags = db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ?').all('Alice.png').map(r => r.tag_id).sort();
        expect(survivorTags).toEqual(['tag-only-on-loser', 'tag-shared']);
    });

    test('moves a real chat from a loser onto the survivor, and inherits its active_chat pointer', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        // Alice wins survivor selection on chat_size (bigger real chat) but has no active_chat pointer of her
        // own - Bob is the loser, smaller real chat, but DOES carry a verified real active_chat pointer, which
        // has to transfer since the survivor has nothing of its own to prefer instead.
        writeChat('Alice.png', 'Alice - old.jsonl', 'a much longer real conversation history here');
        writeChat('Bob.png', 'Bob - session.jsonl', 'shorter');
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2, active_chat: 'Bob - session' },
        ]);

        dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        expect(fs.existsSync(path.join(chatsDir, 'Alice', 'Bob - session.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(chatsDir, 'Bob'))).toBe(false); // loser's chat dir cleaned up
        const survivor = db.prepare('SELECT active_chat, chat_size, date_last_chat FROM characters WHERE id = ?').get('Alice.png');
        expect(survivor.active_chat).toBe('Bob - session');
        expect(survivor.chat_size).toBeGreaterThan(0);
    });

    test('never inherits a dangling active_chat pointer whose file does not actually exist', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        // Bob claims an active_chat, but no matching file/directory exists on disk - the real "Barbie" case.
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2, active_chat: 'phantom-chat' },
        ]);

        dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        const survivor = db.prepare('SELECT active_chat FROM characters WHERE id = ?').get('Alice.png');
        expect(survivor.active_chat).toBeNull();
    });

    test('two different real chats that happen to share a byte size both survive, neither overwrites the other', () => {
        // The real "Lucy Liubot.png" / "Lucy Liubot1.png" case: same chat_size, genuinely different content.
        writeCardPng('LucyA.png', { name: 'Same' });
        writeCardPng('LucyB.png', { name: 'Same' });
        const sameSizeDifferentContent1 = 'aaaa';
        const sameSizeDifferentContent2 = 'bbbb';
        writeChat('LucyA.png', 'chat.jsonl', sameSizeDifferentContent1);
        writeChat('LucyB.png', 'chat.jsonl', sameSizeDifferentContent2);
        seedRows([
            { id: 'LucyA.png', content_identity_hash: 'h', date_added: 1, chat_size: 4, date_last_chat: 10 },
            { id: 'LucyB.png', content_identity_hash: 'h', date_added: 2, chat_size: 4, date_last_chat: 5 },
        ]);

        dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        const survivorDir = path.join(chatsDir, 'LucyA');
        const filesAfter = fs.readdirSync(survivorDir);
        expect(filesAfter).toHaveLength(2); // original + the renamed incoming one, never overwritten
        const contents = filesAfter.map(f => fs.readFileSync(path.join(survivorDir, f), 'utf8')).sort();
        expect(contents).toEqual([sameSizeDifferentContent1, sameSizeDifferentContent2]);
    });

    test('an identical chat file already on the survivor is dropped, not duplicated', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        writeChat('Alice.png', 'chat.jsonl', 'same content');
        writeChat('Bob.png', 'chat.jsonl', 'same content');
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1, chat_size: 12 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2, chat_size: 12 },
        ]);

        dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        expect(fs.readdirSync(path.join(chatsDir, 'Alice'))).toHaveLength(1);
    });

    test('a genuinely different card pair (despite sharing a db content_identity_hash label) declines the whole group into manual review, touching nothing', () => {
        // Different portraits (not just different JSON) - the stricter of the two checks
        // verifyContentAndAvatarIdentical() runs (avatar_identity_hash), simulating a hash collision or a stale
        // db content_identity_hash column that no longer matches what's actually on disk.
        writeCardPng('Alice.png', { name: 'Alice' }, BLANK_PNG);
        writeCardPng('Bob.png', { name: 'Alice' }, makeDifferentImage());
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1, fav: 0 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2, fav: 1 },
        ]);

        const counters = dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true });

        expect(counters.needsReview).toBe(1);
        expect(counters.applied).toBe(0);
        // Nothing touched - both rows still exist, fav untouched.
        const rows = db.prepare('SELECT id, fav FROM characters ORDER BY id').all();
        expect(rows).toEqual([{ id: 'Alice.png', fav: 0 }, { id: 'Bob.png', fav: 1 }]);
        expect(fs.existsSync(path.join(charactersDir, 'Bob.png'))).toBe(true);
    });

    test('dry run (apply: false) touches no rows and no files', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        writeChat('Bob.png', 'chat.jsonl', 'real conversation');
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h', date_added: 1 },
            { id: 'Bob.png', content_identity_hash: 'h', date_added: 2, fav: 1, chat_size: 20 },
        ]);

        const counters = dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: false });

        expect(counters.losersRemoved).toBe(1); // reported as "would remove"
        expect(counters.applied).toBe(0);
        expect(db.prepare('SELECT COUNT(*) c FROM characters').get().c).toBe(2);
        expect(fs.existsSync(path.join(charactersDir, 'Bob.png'))).toBe(true);
        expect(fs.existsSync(path.join(chatsDir, 'Bob', 'chat.jsonl'))).toBe(true);
    });

    test('buildDuplicateGroups groups by content_identity_hash and drops singleton groups', () => {
        const rows = [
            { id: 'A.png', content_identity_hash: 'h1' },
            { id: 'B.png', content_identity_hash: 'h1' },
            { id: 'Solo.png', content_identity_hash: 'h2' },
        ];
        const groups = dedupeScript.buildDuplicateGroups(rows);
        expect(groups).toHaveLength(1);
        expect(groups[0].map(r => r.id).sort()).toEqual(['A.png', 'B.png']);
    });

    test('--only filters the sweep down to the group containing a given id', () => {
        writeCardPng('Alice.png', { name: 'Same' });
        writeCardPng('Bob.png', { name: 'Same' });
        // Carol/Dave's group is filtered out before any card is ever parsed/verified - arbitrary bytes are fine.
        fs.writeFileSync(path.join(charactersDir, 'Carol.png'), Buffer.from('y'));
        fs.writeFileSync(path.join(charactersDir, 'Dave.png'), Buffer.from('y'));
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'h1', date_added: 1 },
            { id: 'Bob.png', content_identity_hash: 'h1', date_added: 2 },
            { id: 'Carol.png', content_identity_hash: 'h2', date_added: 1 },
            { id: 'Dave.png', content_identity_hash: 'h2', date_added: 2 },
        ]);

        const counters = dedupeScript.runMergeSweep(queryRows(), { db, charactersDir, chatsDir, apply: true, only: 'Bob.png' });

        expect(counters.groups).toBe(1);
        expect(counters.losersRemoved).toBe(1);
        expect(db.prepare('SELECT COUNT(*) c FROM characters').get().c).toBe(3); // Carol/Dave group untouched
    });
});
