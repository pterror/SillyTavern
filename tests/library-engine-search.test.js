import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The library's `/query` search on the engine (src/library-engine.js `query({ search })`) against a model of the
 * cards and groups written: which entities match, every page through cursors in relevance and list orders, labels,
 * closed and unclosed quotes, tag matches, and a write found by the next query.
 */

/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {any} */
let engine;
/** @type {string} */
let tempDir;
/** @type {import('../src/library-engine.js').LibraryEngine} */
let library;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    lib = await import('../src/library-engine.js');
    engine = (await import('../engine/load.js')).loadEngine().binding;
});

beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-library-search-test-'));
    library = await lib.LibraryEngine.open(engine, path.join(tempDir, 'store'));
});

afterEach(async () => {
    await library.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS = ['dark', 'knight', 'dragon', 'drab', 'love', 'quokka', 'east', 'the'];
const tokens = (/** @type {string} */ s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Whether `value` holds the phrase's tokens adjacent, the last a prefix of 2 characters or more when `prefix`. */
function holds(value, phrase, prefix) {
    const v = tokens(value);
    const p = tokens(phrase);
    for (let i = 0; i + p.length <= v.length; i++) {
        if (p.every((t, k) => v[i + k] === t || (prefix && k === p.length - 1 && t.length >= 2 && v[i + k].startsWith(t)))) return true;
    }
    return false;
}

/**
 * Writes `n` cards and groups; answers the model of each by key.
 * @param {number} n
 */
async function build(n) {
    const r = rng(7);
    const pick = () => WORDS[Math.floor(r() * WORDS.length)];
    await library.writeTag({ id: 't-riders', name: 'dragon riders' });
    await library.writeTag({ id: 't-love', name: 'love' });
    /** @type {Map<string, { group: boolean, name: string, description: string, members: string[], fav: boolean, riders: boolean }>} */
    const model = new Map();
    for (let i = 0; i < n; i++) {
        const name = `${pick()} ${pick()}`;
        const fav = r() < 0.3;
        const riders = r() < 0.3;
        if (r() < 0.2) {
            const id = String(1_700_000_000_000 + i);
            const members = [`${pick()}.png`];
            await library.writeGroup({ id, name, members, fav });
            if (riders) await library.assignTag(lib.TYPE.group, id, 't-riders', true);
            model.set(id, { group: true, name, description: '', members, fav, riders });
        } else {
            const avatar = `c${String(i).padStart(4, '0')}.png`;
            const description = Array.from({ length: Math.floor(r() * 6) }, pick).join(' ');
            await library.writeCard({}, avatar, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, description, data: { name, description } }), { dateAdded: 1000 + i });
            await library.setFav(lib.TYPE.character, avatar, fav);
            if (riders) await library.assignTag(lib.TYPE.character, avatar, 't-riders', true);
            model.set(avatar, { group: false, name, description, members: [], fav, riders });
        }
    }
    return model;
}

/** The keys a query's every page holds, read through cursors (or page offsets where none is given). */
async function allPages(params) {
    const keys = [];
    let cursor;
    let first;
    for (let page = 0; page < 1000; page++) {
        const out = /** @type {any} */ (await library.query({ ...params, cursor, offset: cursor === undefined ? keys.length : 0 }));
        first ??= out;
        keys.push(...out.rows.map((/** @type {any} */ row) => row.id));
        if (out.rows.length === 0 || (out.cursor === undefined && out.rows.length < params.limit)) break;
        cursor = out.cursor;
    }
    return { keys, first };
}

describe('library search on the engine', () => {
    test('pages hold every match once, in relevance and in the list orders', async () => {
        const model = await build(150);
        // A word in any field: the name (a prefix field), a card's description, a group's members.
        const body = (/** @type {any} */ x, /** @type {string} */ w, /** @type {boolean} */ prefix) => holds(x.description, w, prefix) || x.members.some((/** @type {string} */ m) => holds(m, w, prefix));
        const cases = [
            { search: 'dark', match: (/** @type {any} */ x) => holds(x.name, 'dark', true) || body(x, 'dark', false) },
            { search: 'dr', match: (/** @type {any} */ x) => holds(x.name, 'dr', true) || body(x, 'dr', false) },
            { search: 'name:dark', match: (/** @type {any} */ x) => holds(x.name, 'dark', true) },
            { search: 'love -name:the', match: (/** @type {any} */ x) => (holds(x.name, 'love', true) || body(x, 'love', false)) && !holds(x.name, 'the', false) },
            { search: '"dark kn', match: (/** @type {any} */ x) => holds(x.name, 'dark kn', true) || body(x, 'dark kn', true) },
            { search: '"dark kn"', match: (/** @type {any} */ x) => holds(x.name, 'dark kn', false) || body(x, 'dark kn', false) },
            { search: 'tag:riders', match: (/** @type {any} */ x) => x.riders },
            { search: 'members:quokka', match: (/** @type {any} */ x) => x.members.some((/** @type {string} */ m) => holds(m, 'quokka', false)) },
        ];
        for (const c of cases) {
            const want = [...model.keys()].filter(k => c.match(model.get(k))).sort();
            const relevance = await allPages({ search: c.search, sortField: 'search', limit: 7, includeGroups: true });
            expect([...relevance.keys].sort()).toEqual(want);
            expect(relevance.keys.length).toBe(want.length);
            // The list orders: the same pages as the list's own for the matches as ids.
            for (const sort of [{ sortField: 'name' }, { sortField: 'name', sortOrder: 'desc' }, { sortField: 'fav', sortOrder: 'desc' }, { sortField: 'date_added', sortOrder: 'desc' }]) {
                const searched = await allPages({ search: c.search, ...sort, limit: 7, includeGroups: true });
                const listed = want.length === 0 ? { keys: [] } : await allPages({ ids: want, ...sort, limit: 7, includeGroups: true });
                expect(searched.keys).toEqual(listed.keys);
            }
        }
    }, 120_000);

    test('a tag whose name matches is answered beside the page', async () => {
        await build(30);
        const out = /** @type {any} */ (await library.query({ search: 'riders', sortField: 'search', limit: 5, includeGroups: true }));
        expect(out.tagMatches.map((/** @type {any} */ t) => [t.id, t.name])).toEqual([['t-riders', 'dragon riders']]);
        expect(out.tagMatchesExact).toBe(true);
    });

    test('a write is found by the next query', async () => {
        await library.writeCard({}, 'a.png', JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Quiet', description: 'an old tower' } }), { dateAdded: 1 });
        const find = async (/** @type {string} */ s) => (/** @type {any} */ (await library.query({ search: s, sortField: 'search', limit: 5 }))).rows.map((/** @type {any} */ r) => r.id);
        expect(await find('tower')).toEqual(['a.png']);
        await library.writeCard({}, 'a.png', JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Quiet', description: 'an old castle' } }), { dateAdded: 1 });
        expect(await find('tower')).toEqual([]);
        expect(await find('castle')).toEqual(['a.png']);
        await library.deleteEntity(lib.TYPE.character, 'a.png');
        expect(await find('castle')).toEqual([]);
    });
});

describe('pair postings on the engine', () => {
    test('turned on, built in the background, used, and turned off', async () => {
        await build(60);
        const phrase = async () => (/** @type {any} */ (await library.query({ search: '"dark knight"', sortField: 'search', limit: 100, includeGroups: true }))).rows.map((/** @type {any} */ r) => r.id).sort();
        const before = await phrase();
        expect(await library.pairPostings()).toEqual({ on: false, pending: false });
        await library.setPairPostings(true);
        await library.runPairPostings(0);
        expect(await library.pairPostings()).toEqual({ on: true, pending: false });
        expect(await phrase()).toEqual(before);
        await library.setPairPostings(false);
        await library.runPairPostings(0);
        expect(await library.pairPostings()).toEqual({ on: false, pending: false });
        expect(await phrase()).toEqual(before);
    });
});
