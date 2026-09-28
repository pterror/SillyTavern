import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { character_world_link, resolveCharacterWorldLink } from '../public/scripts/character-world-link.js';

// A card exported from upstream carries both a link name (data.extensions.world) and the embedded book
// (character_book) under that name. Importing it here never makes a World file from the embedded book, so
// the link names a file that doesn't exist; prompts use the embedded book instead. Such a link counts as a
// link to the embedded book: nothing looks the name up as a file or prints "doesn't exist" for it.

/** @type {typeof import('../src/endpoints/worldinfo.js')} */
let worldinfo;
/** @type {typeof import('../src/world-info/candidate-resolution.js')} */
let candidates;
/** @type {typeof import('../src/character-card-normalize.js')} */
let normalize;
let tempDir;
let worldsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const OLD_MTIME = new Date('2020-01-01T00:00:00Z');

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-world-link-'));
    worldsDir = path.join(tempDir, 'worlds');
    fs.mkdirSync(worldsDir, { recursive: true });
    directories = /** @type {any} */ ({ worlds: worldsDir, root: tempDir });

    worldinfo = await import('../src/endpoints/worldinfo.js');
    candidates = await import('../src/world-info/candidate-resolution.js');
    normalize = await import('../src/character-card-normalize.js');
});

afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
    for (const entry of fs.readdirSync(worldsDir)) {
        fs.rmSync(path.join(worldsDir, entry), { recursive: true, force: true });
    }
});

afterEach(() => {
    jest.restoreAllMocks();
});

/** Backdates the worlds directory, so a miss seen now is trusted until the directory changes. */
function settleWorldsDir() {
    fs.utimesSync(worldsDir, OLD_MTIME, OLD_MTIME);
}

let worldsWritten = 0;

/** Writes a World file by hand and gives the directory an old mtime of its own, so no remembered miss outlives the write. */
function writeWorld(name, entries) {
    fs.writeFileSync(path.join(worldsDir, `${name}.json`), JSON.stringify({ entries }));
    const mtime = new Date(OLD_MTIME.getTime() + (++worldsWritten) * 60_000);
    fs.utimesSync(worldsDir, mtime, mtime);
}

/** Counts filesystem lookups of one book's file from now on. */
function countLookups(name) {
    const target = path.join(worldsDir, `${name}.json`);
    const spy = jest.spyOn(fs, 'existsSync');
    return () => spy.mock.calls.filter(([p]) => p === target).length;
}

function captureErrors() {
    return jest.spyOn(console, 'error').mockImplementation(() => {});
}

function printsFor(errorSpy, name) {
    return errorSpy.mock.calls.filter(([message]) => String(message).includes(`${name}.json`)).length;
}

function embeddedBook(bookName, content = 'Embedded content') {
    return {
        name: bookName,
        entries: [{ id: 0, keys: ['lighthouse'], content, insertion_order: 1, enabled: true }],
    };
}

function card(link, book) {
    const data = { extensions: { world: link } };
    if (book !== undefined) {
        data.character_book = book;
    }
    return { data };
}

describe('resolveCharacterWorldLink', () => {
    const exists = (...names) => (name) => names.includes(name);

    test('no link is NONE, with or without an embedded book', () => {
        expect(resolveCharacterWorldLink(card('', embeddedBook('Any')), exists())).toBe(character_world_link.NONE);
        expect(resolveCharacterWorldLink({ data: {} }, exists())).toBe(character_world_link.NONE);
        expect(resolveCharacterWorldLink(null, exists())).toBe(character_world_link.NONE);
        expect(resolveCharacterWorldLink(undefined, exists())).toBe(character_world_link.NONE);
    });

    test('a World file under the linked name is FILE, even when the card embeds a book', () => {
        expect(resolveCharacterWorldLink(card('Book', embeddedBook('Book')), exists('Book'))).toBe(character_world_link.FILE);
        expect(resolveCharacterWorldLink(card('Book'), exists('Book'))).toBe(character_world_link.FILE);
    });

    test('no file and an embedded book is EMBEDDED, whatever the embedded book is named', () => {
        expect(resolveCharacterWorldLink(card('Book', embeddedBook('Book')), exists())).toBe(character_world_link.EMBEDDED);
        expect(resolveCharacterWorldLink(card('Book', embeddedBook('Something Else')), exists())).toBe(character_world_link.EMBEDDED);
        expect(resolveCharacterWorldLink(card('Book', { entries: [] }), exists())).toBe(character_world_link.EMBEDDED);
    });

    test('no file and no embedded book is MISSING', () => {
        expect(resolveCharacterWorldLink(card('Book'), exists('Other'))).toBe(character_world_link.MISSING);
    });

    test('asks about the linked name only', () => {
        const asked = [];
        resolveCharacterWorldLink(card('Book', embeddedBook('Inner Name')), (name) => {
            asked.push(name);
            return false;
        });
        expect(asked).toEqual(['Book']);
    });
});

describe('getCharacterWorldLink (server)', () => {
    test('answers from the worlds directory and never prints', () => {
        settleWorldsDir();
        writeWorld('On Disk', {});
        const errors = captureErrors();

        expect(worldinfo.getCharacterWorldLink(directories, card('On Disk', embeddedBook('On Disk')))).toBe(character_world_link.FILE);
        expect(worldinfo.getCharacterWorldLink(directories, card('Link Embedded', embeddedBook('Link Embedded')))).toBe(character_world_link.EMBEDDED);
        expect(worldinfo.getCharacterWorldLink(directories, card('Link Missing'))).toBe(character_world_link.MISSING);
        expect(worldinfo.getCharacterWorldLink(directories, card(''))).toBe(character_world_link.NONE);
        expect(errors).not.toHaveBeenCalled();
    });
});

describe('generation (resolveWorldInfoCandidates) with a link to the embedded book', () => {
    test('uses the embedded book, prints nothing and looks the name up once across repeated generations', async () => {
        settleWorldsDir();
        const character = card('Harbor Lore', embeddedBook('Harbor Lore', 'The lighthouse keeper is named Ida.'));
        const errors = captureErrors();
        const lookups = countLookups('Harbor Lore');

        for (let i = 0; i < 3; i++) {
            const entries = await candidates.resolveWorldInfoCandidates({ directories, character });
            expect(entries).toHaveLength(1);
            expect(entries[0].world).toBe(candidates.EMBEDDED_WORLD_NAME);
            expect(entries[0].content).toBe('The lighthouse keeper is named Ida.');
        }

        expect(printsFor(errors, 'Harbor Lore')).toBe(0);
        expect(lookups()).toBe(1);
    });

    test('the same name as an additional lorebook is not looked up as a file either', async () => {
        settleWorldsDir();
        const character = card('Pier Lore', embeddedBook('Pier Lore'));
        const errors = captureErrors();

        const entries = await candidates.resolveWorldInfoCandidates({ directories, character, characterExtraBooks: ['Pier Lore'] });

        expect(entries.map(e => e.world)).toEqual([candidates.EMBEDDED_WORLD_NAME]);
        expect(printsFor(errors, 'Pier Lore')).toBe(0);
    });

    test('a World file under the linked name wins over the embedded book', async () => {
        writeWorld('Harbor File', { 0: { uid: 0, key: ['pier'], content: 'From the file', order: 5 } });
        const character = card('Harbor File', embeddedBook('Harbor File', 'From the card'));

        const entries = await candidates.resolveWorldInfoCandidates({ directories, character });

        expect(entries.map(e => [e.world, e.content])).toEqual([['Harbor File', 'From the file']]);
    });

    test('a link with no file and no embedded book still reads the name, printing once, as before', async () => {
        settleWorldsDir();
        const character = card('Nowhere Lore');
        const errors = captureErrors();

        for (let i = 0; i < 3; i++) {
            expect(await candidates.resolveWorldInfoCandidates({ directories, character })).toEqual([]);
        }

        expect(printsFor(errors, 'Nowhere Lore')).toBe(1);
    });
});

describe('card save (charaFormatData) with a link to the embedded book', () => {
    function saveBody(world, cardJson) {
        return { ch_name: 'Keeper', world, json_data: JSON.stringify(cardJson) };
    }

    test('keeps the card\'s embedded book as sent and prints nothing', () => {
        settleWorldsDir();
        const book = embeddedBook('Keeper Lore', 'Kept as sent');
        const errors = captureErrors();
        const lookups = countLookups('Keeper Lore');

        for (let i = 0; i < 2; i++) {
            const saved = normalize.charaFormatData(saveBody('Keeper Lore', card('Keeper Lore', book)), directories);
            expect(saved.data.extensions.world).toBe('Keeper Lore');
            expect(saved.data.character_book).toEqual(book);
        }

        expect(printsFor(errors, 'Keeper Lore')).toBe(0);
        expect(lookups()).toBe(1);
    });

    test('a World file under the linked name still replaces the card\'s book, as upstream', () => {
        writeWorld('Keeper File', { 0: { uid: 0, key: ['pier'], content: 'From the file', order: 5 } });

        const saved = normalize.charaFormatData(saveBody('Keeper File', card('Keeper File', embeddedBook('Keeper File', 'From the card'))), directories);

        expect(saved.data.character_book.name).toBe('Keeper File');
        expect(saved.data.character_book.entries.map(e => e.content)).toEqual(['From the file']);
    });

    test('a link with no file and no embedded book still reads the name, printing once, as before', () => {
        settleWorldsDir();
        const errors = captureErrors();

        const saved = normalize.charaFormatData(saveBody('Nowhere Saved', card('Nowhere Saved')), directories);
        normalize.charaFormatData(saveBody('Nowhere Saved', card('Nowhere Saved')), directories);

        expect(saved.data.character_book).toBeUndefined();
        expect(printsFor(errors, 'Nowhere Saved')).toBe(1);
    });
});
