import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { findKeySpans, matchKeys } from './key-matching.js';
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
    const key = Array.from({ length: rng.int(3) }, () => rng.pick(NAMES));
    return {
        uid,
        key,
        extensions: { names: key.filter(() => rng.next() < 0.7) },
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
    const links = new Map();
    const to = new Map();
    for (const s of entries) {
        const spans = [];
        for (const t of entries) {
            if (s === t) continue;
            const flags = { caseSensitive: t.caseSensitive ?? undefined, matchWholeWords: t.matchWholeWords ?? undefined };
            for (const raw of t.key.filter(k => t.extensions.names.includes(k))) {
                const name = raw.trim();
                if (!name || name.includes('{{')) continue;
                for (const [from, end] of findKeySpans(s.content, name, flags, LOOSE)) spans.push({ uid: t.uid, from, to: end });
            }
            const name = t.key.map(k => k.trim()).find(k => k && !k.includes('{{') && matchKeys(s.content, k, flags, LOOSE));
            if (name === undefined) continue;
            if (!to.has(t.uid)) to.set(t.uid, new Set());
            to.get(t.uid).add(s.uid);
        }
        spans.sort((a, b) => a.from - b.from || b.to - a.to || a.uid - b.uid);
        const kept = [];
        for (const span of spans) if (span.from >= (kept[kept.length - 1]?.to ?? 0)) kept.push(span);
        links.set(s.uid, kept);
    }
    return { links, to };
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
        const got = await refs.links(book, id, e.content);
        assert.equal(got.complete, true);
        assert.deepEqual(got.links.map(l => ({ uid: back.get(l.entry), from: l.from, to: l.to })), want.links.get(e.uid), `${label}: links of ${e.uid} (${e.content})`);
        const gotTo = await all(cursor => refs.to(book, id, { cursor, limit: 2 }));
        assert.deepEqual(new Set(gotTo.list.map(r => back.get(r.entry))), want.to.get(e.uid) ?? new Set(), `${label}: to ${e.uid} (${e.key})`);
    }
}

test('the names every text writes and what mentions every entry are exactly what recursion would see, through edits, renames and deletes', async () => {
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
            0: { uid: 0, key: ['Sir Rowan of Vale'], content: 'the knight', extensions: { names: ['Sir Rowan of Vale'] } },
            1: { uid: 1, key: ['Elara'], content: 'she met Sir Rowan of Vale at the mill' },
            2: { uid: 2, key: ['mill'], content: 'nothing here', extensions: { names: ['mill'] } },
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
        const text = 'she met Sir Rowan of Vale at the mill';
        const links = await refs.links(book, uidOf.get(1), text);
        assert.deepEqual(links, { links: [{ entry: uidOf.get(0), from: 8, to: 25 }, { entry: uidOf.get(2), from: 33, to: 37 }], complete: true });
        assert.deepEqual(reads, ['textLinkCandidates']);
        const short = await refs.to(book, uidOf.get(2));
        assert.equal(short.scanned, true);
    } finally {
        store.worldRead = original;
    }
});

test('a text with more to look through than its bound links what was found and says it stopped', async () => {
    await lib.books.write('Long', {
        entries: {
            0: { uid: 0, key: ['Ilse'], content: 'x', extensions: { names: ['Ilse'] } },
            1: { uid: 1, key: ['Varro'], content: 'y', extensions: { names: ['Varro'] } },
            2: { uid: 2, key: [], content: 'z' },
        },
    });
    const book = await bookOf('Long');
    const uidOf = await ids(book);
    const refs = new References(lib, { defaults: LOOSE });
    const text = `Ilse ${'and so on '.repeat(50)}Varro`;
    const whole = await refs.links(book, uidOf.get(2), text);
    assert.deepEqual(whole.links.map(l => l.entry), [uidOf.get(0), uidOf.get(1)]);
    assert.equal(whole.complete, true);
    const cut = await refs.links(book, uidOf.get(2), text, { readsAtMost: 40 });
    assert.deepEqual(cut, { links: [{ entry: uidOf.get(0), from: 0, to: 4 }], complete: false });
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

test('an entry deleted and restored leaves the names a text writes and comes back to them', async () => {
    await lib.books.write('Kept', {
        entries: {
            0: { uid: 0, key: ['/kept/i'], content: 'kept text', extensions: { names: ['/kept/i'] } },
            1: { uid: 1, key: ['other'], content: 'mentions kept' },
        },
    });
    const book = await bookOf('Kept');
    const uidOf = await ids(book);
    const refs = new References(lib, { defaults: LOOSE });
    const linked = async () => (await refs.links(book, uidOf.get(1), 'mentions kept')).links.map(l => l.entry);
    assert.deepEqual(await linked(), [uidOf.get(0)]);
    assert.deepEqual(await lib.books.deleteEntryById(book, uidOf.get(0)), { unreachedLoops: [] });
    assert.deepEqual(await linked(), []);
    const restored = await lib.books.restore('Kept', uidOf.get(0));
    assert.equal(restored.uid, '0');
    assert.deepEqual(await linked(), [uidOf.get(0)]);
});

test('a card\'s own book answers the same way', async () => {
    const { writeLibraryCard } = await import('../../tests/converted-user.fixture.js');
    const { write: writeCard } = await import('../character-card-parser.js');
    const fs = await import('node:fs');
    const png = fs.readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
    const character_book = {
        entries: [
            { id: 0, keys: ['Sir Rowan of Vale'], content: 'knight', extensions: { names: ['Sir Rowan of Vale'] } },
            { id: 1, keys: ['Elara'], content: 'met Sir Rowan of Vale', extensions: {} },
            { id: 2, keys: ['Vale'], content: 'the vale', extensions: { names: ['Vale'], case_sensitive: true } },
        ],
    };
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Cara', data: { name: 'Cara', first_mes: 'Hi.', character_book, extensions: {} } };
    const json = JSON.stringify(card);
    await writeLibraryCard(user, 'cara.png', json, writeCard(png, json));
    const [character] = await lib.ids(0, ['cara.png']);
    const [book] = await lib.ids(4, [`${character}:c`]);
    assert.ok(book);
    const uidOf = await ids(book);
    const refs = new References(lib, { defaults: LOOSE });
    const to = await refs.to(book, uidOf.get(0));
    assert.deepEqual(to.references.map(r => r.entry), [uidOf.get(1)]);
    const links = await refs.links(book, uidOf.get(1), 'met Sir Rowan of Vale, not the vale but the Vale');
    assert.deepEqual(links.links.map(l => [l.entry, l.from, l.to]), [[uidOf.get(0), 4, 21], [uidOf.get(2), 44, 48]], 'a case-sensitive name is checked with its case');
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
