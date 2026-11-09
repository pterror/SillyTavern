import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { matchKeys } from './key-matching.js';
import { References } from './references.js';
import { LOOSE } from './test-globals.js';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-references-test-');
const lib = user.store.lib;

const NAMES = [
    'cat', 'Elara', 'tavern', 'Sir Rowan of Vale', 'Rowan Vale', 'the old mill road', '/dr(a|e)gon/i', '/^Vale/',
    '{{char}}', '!!!', 'οδος', 'i̇stanbul', '東京', 'x', 'drEgon', 'Bob', 'averyveryverylongsinglewordname',
    '/the old (mill|road)/i', '/Sir Rowan of/',
];
const WORDS = [
    'the', 'tavern', 'Elara', 'elara\'s', 'concatenate', 'bobcat', 'BOB', 'dragon', 'dregon', 'Sir', 'Rowan', 'of', 'Vale',
    'old', 'mill', 'road', 'ΟΔΟΣ', 'İstanbul', '東京に行く', 'max', '_cat_', '!!!', 'xaveryveryverylongsinglewordnamez',
];

class Rng {
    constructor(seed) { this.s = seed; }
    next() {
        this.s ^= this.s << 13; this.s ^= this.s >>> 17; this.s ^= this.s << 5;
        return (this.s >>> 0) / 0x1_0000_0000;
    }
    pick(list) { return list[Math.floor(this.next() * list.length)]; }
    int(n) { return Math.floor(this.next() * n); }
}

/** @param {Rng} rng */
function randomEntry(rng, uid) {
    const words = Array.from({ length: 1 + rng.int(8) }, () => rng.pick(WORDS));
    return {
        uid,
        key: Array.from({ length: rng.int(3) }, () => rng.pick(NAMES)),
        keysecondary: [],
        comment: `entry ${uid}`,
        content: words.join(rng.next() < 0.3 ? '' : ' '),
        constant: rng.next() < 0.1,
        caseSensitive: rng.pick([null, true, false]),
        matchWholeWords: rng.pick([null, true, false]),
    };
}

async function bookOf(name) {
    const found = await lib.books.find(name);
    assert.ok(found?.defined);
    return found.id;
}

async function ids(book) {
    const out = new Map();
    for (const { entity } of await lib.books.storedEntries(book)) out.set(Number(entity.key.split(':')[1]), entity.id);
    return out;
}

function expected(entries) {
    const from = new Map();
    const to = new Map();
    for (const s of entries) {
        for (const t of entries) {
            if (s === t) continue;
            const flags = { caseSensitive: t.caseSensitive ?? undefined, matchWholeWords: t.matchWholeWords ?? undefined };
            const name = t.key.map(k => k.trim()).find(k => k && !k.includes('{{') && matchKeys(s.content, k, flags, LOOSE));
            if (name === undefined) continue;
            if (!from.has(s.uid)) from.set(s.uid, new Set());
            from.get(s.uid).add(t.uid);
            if (!to.has(t.uid)) to.set(t.uid, new Set());
            to.get(t.uid).add(s.uid);
        }
    }
    return { from, to };
}

async function all(read) {
    const out = [];
    let cursor;
    for (let i = 0; i < 1000; i++) {
        const page = await read(cursor);
        out.push(...page.references);
        if (page.next === null) return { list: out, page };
        cursor = page.next;
    }
    throw new Error('no end');
}

async function check(name, entries, label) {
    const refs = new References(lib, { defaults: LOOSE });
    const book = await bookOf(name);
    const uidOf = await ids(book);
    const back = new Map([...uidOf].map(([uid, id]) => [id, uid]));
    const want = expected(entries);
    for (const e of entries) {
        const id = uidOf.get(e.uid);
        const got = await all(cursor => refs.from(book, id, { cursor, limit: 2 }));
        assert.deepEqual(new Set(got.list.map(r => back.get(r.entry))), want.from.get(e.uid) ?? new Set(), `${label}: from ${e.uid} (${e.content})`);
        const gotTo = await all(cursor => refs.to(book, id, { cursor, limit: 2 }));
        assert.deepEqual(new Set(gotTo.list.map(r => back.get(r.entry))), want.to.get(e.uid) ?? new Set(), `${label}: to ${e.uid} (${e.key})`);
    }
}

test('references from and to every entry are exactly what recursion would see, through edits, renames and deletes', async () => {
    const rng = new Rng(0x2545_f491);
    let entries = Array.from({ length: 24 }, (_, i) => randomEntry(rng, i));
    const write = async () => lib.books.write('World', { entries: Object.fromEntries(entries.map(e => [e.uid, e])) });
    await write();
    await check('World', entries, 'first');
    for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 6; i++) {
            const e = rng.pick(entries);
            if (rng.next() < 0.5) e.key = Array.from({ length: rng.int(3) }, () => rng.pick(NAMES));
            else e.content = randomEntry(rng, e.uid).content;
        }
        if (rng.next() < 0.5) entries = entries.filter(e => e !== rng.pick(entries));
        entries.push(randomEntry(rng, 100 + round));
        await write();
        await check('World', entries, `round ${round}`);
    }
});

test('a name that only the index can answer reads candidates, never the whole book', async () => {
    await lib.books.write('Index', {
        entries: {
            0: { uid: 0, key: ['Sir Rowan of Vale'], content: 'the knight' },
            1: { uid: 1, key: ['Elara'], content: 'she met Sir Rowan of Vale at the mill' },
            2: { uid: 2, key: ['mill'], content: 'nothing here' },
        },
    });
    const book = await bookOf('Index');
    const uidOf = await ids(book);
    const reads = [];
    const store = lib.store;
    const original = store.worldRead.bind(store);
    store.worldRead = (op, args) => {
        reads.push(op);
        return original(op, args);
    };
    try {
        const refs = new References(lib, { defaults: LOOSE });
        const to = await refs.to(book, uidOf.get(0));
        assert.equal(to.scanned, false);
        assert.deepEqual(to.references.map(r => r.entry), [uidOf.get(1)]);
        assert.deepEqual(to.references[0].spans, [[8, 25]]);
        assert.ok(!reads.includes('entries'), `read ${reads}`);
        reads.length = 0;
        const from = await refs.from(book, uidOf.get(1));
        assert.deepEqual(new Set(from.references.map(r => r.entry)), new Set([uidOf.get(0), uidOf.get(2)]));
        assert.ok(!reads.includes('entries'), `read ${reads}`);
        const short = await refs.to(book, uidOf.get(2));
        assert.equal(short.scanned, true);
    } finally {
        store.worldRead = original;
    }
});

/**
 * Counts the entries each read hands back the text of.
 * @param {(texts: number[], ops: string[]) => Promise<void>} body
 */
async function counting(body) {
    const store = lib.store;
    const original = store.worldRead.bind(store);
    /** @type {number[]} */
    const texts = [];
    /** @type {string[]} */
    const ops = [];
    store.worldRead = (op, args) => {
        ops.push(op);
        if (op === 'entryTexts') texts.push(args.entries.length);
        return original(op, args);
    };
    try {
        await body(texts, ops);
    } finally {
        store.worldRead = original;
    }
}

/**
 * Every page from the first, each read at the cursor the one before ends at.
 * @param {(cursor: string | undefined) => Promise<any>} read
 */
async function pages(read) {
    const out = [];
    let cursor;
    for (let i = 0; i < 1000; i++) {
        const page = await read(cursor);
        out.push(page);
        if (page.next === null) return out;
        cursor = page.next;
    }
    throw new Error('no end');
}

test('a name the index can\'t look up walks the world, looking through at most the bound per read and going on from its cursor', async () => {
    /** @type {Record<number, object>} */
    const entries = { 0: { uid: 0, key: ['Ilse'], content: 'x' } };
    for (let uid = 1; uid <= 25; uid++) entries[uid] = { uid, key: [], content: uid % 10 === 0 ? 'Ilse was here' : 'nothing' };
    await lib.books.write('Bounded', { entries });
    const book = await bookOf('Bounded');
    const uidOf = await ids(book);
    const back = new Map([...uidOf].map(([uid, id]) => [id, uid]));
    const refs = new References(lib, { defaults: LOOSE });
    await counting(async texts => {
        const read = await pages(cursor => refs.to(book, uidOf.get(0), { cursor, checksAtMost: 7 }));
        assert.ok(read.every(page => page.scanned));
        assert.deepEqual(read.map(page => page.lookedThrough), [7, 14, 21, 25]);
        assert.deepEqual(read.map(page => page.stoppedForBound), [true, true, true, false]);
        assert.deepEqual(new Set(read.flatMap(page => page.references.map((/** @type {any} */ r) => back.get(r.entry)))), new Set([10, 20]));
        assert.ok(texts.every(n => n <= 7 + 1), `texts read per call: ${texts}`);
    });
    const filled = await refs.to(book, uidOf.get(0), { limit: 1 });
    assert.equal(filled.references.length, 1);
    assert.equal(filled.stoppedForBound, false, 'a page that fills is not stopped by the bound');
    assert.notEqual(filled.next, null);
});

test('a name the index looks up still looks through at most the bound per read', async () => {
    /** @type {Record<number, object>} */
    const entries = { 0: { uid: 0, key: ['Lord of Winter'], content: 'x' } };
    for (let uid = 1; uid <= 12; uid++) entries[uid] = { uid, key: [], content: uid === 9 ? 'the Lord of Winter came' : 'a tale of nothing' };
    entries[13] = { uid: 13, key: [], content: 'Winter came' };
    await lib.books.write('Common', { entries });
    const book = await bookOf('Common');
    const uidOf = await ids(book);
    const refs = new References(lib, { defaults: LOOSE });
    await counting(async (texts, ops) => {
        const read = await pages(cursor => refs.to(book, uidOf.get(0), { cursor, checksAtMost: 5 }));
        assert.ok(read.every(page => !page.scanned));
        assert.ok(!ops.includes('entries'), `read ${ops}`);
        assert.deepEqual(read.map(page => page.lookedThrough), [5, 10, 12]);
        assert.deepEqual(read.flatMap(page => page.references.map((/** @type {any} */ r) => r.entry)), [uidOf.get(9)]);
        assert.ok(texts.every(n => n <= 5), `texts read per call: ${texts}`);
    });
});

test('a regular expression key is looked up by a word every match of it holds, and found exactly', async () => {
    const contents = ['The Old King sat', 'the old  king', 'old king', 'bathe old queen', 'they old king', 'THE OLD QUEENS'];
    await lib.books.write('Regex', {
        entries: {
            0: { uid: 0, key: ['/the old (king|queen)/i'], content: 'x' },
            ...Object.fromEntries(contents.map((content, at) => [at + 1, { uid: at + 1, key: [], content }])),
        },
    });
    const book = await bookOf('Regex');
    const uidOf = await ids(book);
    const back = new Map([...uidOf].map(([uid, id]) => [id, uid]));
    await counting(async (_texts, ops) => {
        const to = await new References(lib, { defaults: LOOSE }).to(book, uidOf.get(0));
        assert.equal(to.scanned, false);
        assert.ok(!ops.includes('entries'), `read ${ops}`);
        assert.deepEqual(to.references.map(r => back.get(r.entry)).sort(), [1, 4, 6]);
    });
});

test('a mention by a form the name doesn\'t match is an unlinked mention; a macro name is reported as unresolved', async () => {
    await lib.books.write('Forms', {
        entries: {
            0: { uid: 0, key: ['Elara', '{{char}}'], content: 'x', caseSensitive: true, matchWholeWords: true },
            1: { uid: 1, key: [], content: 'ELARA\'s hall and Elaras' },
        },
    });
    const book = await bookOf('Forms');
    const uidOf = await ids(book);
    const to = await new References(lib, { defaults: LOOSE }).to(book, uidOf.get(0));
    assert.deepEqual(to.references, []);
    assert.deepEqual(to.unlinked, [{ entry: uidOf.get(1), name: 'Elara' }]);
    assert.deepEqual(to.unresolved, ['{{char}}']);
    const withContext = await new References(lib, { defaults: LOOSE, macroContext: { name2: 'Elara' } }).to(book, uidOf.get(0));
    assert.deepEqual(withContext.unresolved, []);
});

test('issues: never comes up, shared names and heavy entries, paged', async () => {
    const long = 'word '.repeat(400);
    await lib.books.write('Issues', {
        entries: {
            0: { uid: 0, key: [], content: 'lost', constant: false },
            1: { uid: 1, key: ['Elara'], content: 'one' },
            2: { uid: 2, key: ['elara'], content: 'two' },
            3: { uid: 3, key: [], content: 'always', constant: true },
            4: { uid: 4, key: ['big'], content: long },
            5: { uid: 5, key: ['small'], content: 's' },
        },
    });
    const book = await bookOf('Issues');
    const uidOf = await ids(book);
    const back = new Map([...uidOf].map(([uid, id]) => [id, uid]));
    const refs = new References(lib, { defaults: LOOSE });
    const found = new Map();
    let after;
    for (;;) {
        const page = await refs.issues(book, { after, limit: 2 });
        for (const i of page.issues) found.set(back.get(i.entry), i.issues.map(x => x.kind).sort());
        if (page.next === null) break;
        after = page.next;
    }
    assert.deepEqual(found.get(0), ['never']);
    assert.deepEqual(found.get(1), ['shared']);
    assert.deepEqual(found.get(2), ['shared']);
    assert.equal(found.get(3), undefined);
    assert.deepEqual(found.get(4), ['heavy']);
});

test('a book\'s size and hash follow its entries\' own writes and come back to the same hash with the same content', async () => {
    const book0 = { entries: { 0: { uid: 0, key: ['a'], content: 'alpha' }, 1: { uid: 1, key: ['b'], content: 'beta' } } };
    await lib.books.write('Sized', book0);
    const book = await bookOf('Sized');
    const uidOf = await ids(book);
    const refs = new References(lib, { defaults: LOOSE });
    const first = await refs.sizes(book, [uidOf.get(0)]);
    assert.equal(first.entries, 2);
    await lib.books.editEntry('Sized', 0, { ...book0.entries[0], content: 'alpha and more' });
    const edited = await refs.sizes(book, [uidOf.get(0)]);
    assert.equal(edited.bytes - first.bytes, ' and more'.length);
    assert.notEqual(edited.hash, first.hash);
    assert.equal(edited.of[0].bytes - first.of[0].bytes, ' and more'.length);
    await lib.books.editEntry('Sized', 0, book0.entries[0]);
    const back = await refs.sizes(book, [uidOf.get(0)]);
    assert.equal(back.hash, first.hash);
    assert.equal(back.bytes, first.bytes);
});

test('an entry deleted with its history kept leaves the book\'s totals, and restored brings them back exactly', async () => {
    const { jsonHash } = await import('../../public/scripts/hash-utils.js');
    await lib.books.write('Kept', {
        entries: {
            0: { uid: 0, key: ['/kept/i'], content: 'kept text' },
            1: { uid: 1, key: ['other'], content: 'mentions kept' },
        },
    });
    const book = await bookOf('Kept');
    const uidOf = await ids(book);
    const refs = new References(lib, { defaults: LOOSE });
    const before = await refs.sizes(book, []);
    const fromBefore = await refs.from(book, uidOf.get(1));
    assert.deepEqual(fromBefore.references.map(r => r.entry), [uidOf.get(0)]);
    const was = (await lib.books.read('Kept')).entries[0];
    await lib.books.apply('Kept', [{ uid: 0, base_hash: jsonHash(was), data: null }], []);
    const gone = await refs.sizes(book, []);
    assert.equal(gone.entries, before.entries - 1);
    assert.ok(gone.bytes < before.bytes);
    assert.deepEqual((await refs.from(book, uidOf.get(1))).references, []);
    const restored = await lib.books.restore('Kept', uidOf.get(0));
    assert.equal(restored.uid, '0');
    const after = await refs.sizes(book, []);
    assert.deepEqual([after.entries, after.bytes, after.hash], [before.entries, before.bytes, before.hash]);
    assert.deepEqual((await refs.from(book, uidOf.get(1))).references.map(r => r.entry), [uidOf.get(0)]);
});

test('a card\'s own book answers the same way', async () => {
    const { writeLibraryCard } = await import('../../tests/converted-user.fixture.js');
    const { write: writeCard } = await import('../character-card-parser.js');
    const fs = await import('node:fs');
    const png = fs.readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
    const character_book = {
        entries: [
            { id: 0, keys: ['Sir Rowan of Vale'], content: 'knight', extensions: {} },
            { id: 1, keys: ['Elara'], content: 'met Sir Rowan of Vale', extensions: {} },
        ],
    };
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Cara', data: { name: 'Cara', first_mes: 'Hi.', character_book, extensions: {} } };
    const json = JSON.stringify(card);
    await writeLibraryCard(user, 'cara.png', json, writeCard(png, json));
    const [character] = await lib.ids(0, ['cara.png']);
    const [book] = await lib.ids(4, [`${character}:c`]);
    assert.ok(book);
    const uidOf = await ids(book);
    const to = await new References(lib, { defaults: LOOSE }).to(book, uidOf.get(0));
    assert.deepEqual(to.references.map(r => r.entry), [uidOf.get(1)]);
});

test('a name without its own flags follows the global case and whole-word settings, as activation does', async () => {
    await lib.books.write('GlobalFlags', {
        entries: {
            0: { uid: 0, key: ['Elara'], content: 'x' },
            1: { uid: 1, key: ['mill'], content: 'y' },
            2: { uid: 2, key: [], content: 'ELARA walked past the millstone.' },
        },
    });
    const book = await bookOf('GlobalFlags');
    const uidOf = await ids(book);
    const linkedTo = async (defaults, uid) => (await new References(lib, { defaults }).to(book, uidOf.get(uid))).references.map(r => r.entry);
    assert.deepEqual(await linkedTo(LOOSE, 0), [uidOf.get(2)]);
    assert.deepEqual(await linkedTo(LOOSE, 1), [uidOf.get(2)]);
    const strict = { caseSensitive: true, matchWholeWords: true };
    assert.deepEqual(await linkedTo(strict, 0), []);
    assert.deepEqual(await linkedTo(strict, 1), []);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
