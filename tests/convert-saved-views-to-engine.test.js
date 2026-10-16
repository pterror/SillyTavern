// The one-off src/migrations/convert-saved-views-to-engine.js, deleted with it.
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {any} */
let engine;
/** @type {typeof import('../src/migrations/convert-saved-views-to-engine.js')} */
let script;
/** @type {typeof import('../src/saved-views.js')} */
let views;
/** @type {any} */
let LibraryEngine;
/** @type {any} */
let Database;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    script = await import('../src/migrations/convert-saved-views-to-engine.js');
    views = await import('../src/saved-views.js');
    ({ LibraryEngine } = await import('../src/library-engine.js'));
    Database = await (await import('../src/endpoints/native-sqlite.js')).getBetterSqlite3();
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROWS = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Plain', view: { text: 'elf', fav: true }, position: 1, updated_at: 111 },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Odd', view: { tags: { include: ['a'] }, theirs: { deep: [1, 2] } }, position: 1.5, updated_at: 222 },
    {
        id: '00000000-0000-4000-8000-000000000003',
        name: 'Conditions',
        view: { conditions: [{ field: 'name', op: 'contains', value: 'x' }, { field: 'name', op: 'is', value: 'y' }] },
        position: 1.75,
        updated_at: 333,
    },
];

/** A data root whose user `u` has a store and a character-metadata.sqlite holding ROWS (and another table). */
async function userWithViews() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-saved-views-'));
    dirs.push(dataRoot);
    const root = path.join(dataRoot, 'u');
    const store = await engine.Store.open(path.join(root, 'store'));
    await store.close();
    const db = new Database(path.join(root, 'character-metadata.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE saved_views (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_fold TEXT NOT NULL, view_json TEXT NOT NULL, position REAL NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO meta VALUES ('views_version', '3');`);
    const insert = db.prepare('INSERT INTO saved_views VALUES (@id, @name, @name, @json, @position, @updated_at)');
    for (const r of ROWS) insert.run({ ...r, json: JSON.stringify(r.view) });
    db.close();
    return dataRoot;
}

/**
 * @param {string} dataRoot
 * @param {boolean} apply
 */
async function run(dataRoot, apply) {
    /** @type {string[]} */
    const lines = [];
    const code = await script.runConvert({
        dataRoot, handle: 'u', apply, engine: async () => engine, probeServer: async () => ({ running: false, lines: [] }),
        log: l => lines.push(l), warn: l => lines.push(l),
    });
    return { code, text: lines.join('\n') };
}

/**
 * The store's views in order, as stored.
 * @param {string} dataRoot
 * @param {(lib: any) => Promise<void>} [also] Run on the open store first.
 */
async function storedList(dataRoot, also) {
    const lib = await LibraryEngine.open(engine, path.join(dataRoot, 'u', 'store'));
    try {
        await lib.store.ready();
        if (also) await also(lib);
        const holder = await views.viewHolder(lib);
        if (holder === null) return [];
        const page = await views.viewPlaces(lib, holder, { limit: 100 });
        return (await views.storedViews(lib, page.entries.map(e => e.id))).map(s => ({ id: s?.key, ...views.assembleView(/** @type {any} */ (s)) }));
    } finally {
        await lib.close();
    }
}

/** @param {string} dataRoot */
function tables(dataRoot) {
    const db = new Database(path.join(dataRoot, 'u', 'character-metadata.sqlite'), { readonly: true });
    try {
        return [...db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name LIMIT 100').pluck().iterate()];
    } finally {
        db.close();
    }
}

const WANT = [
    { id: ROWS[0].id, name: 'Plain', view: ROWS[0].view },
    { id: ROWS[1].id, name: 'Odd', view: ROWS[1].view },
    { id: ROWS[2].id, name: 'Conditions', view: { conditions: [{ field: 'name', op: 'contains', value: 'x' }] } },
];

describe('convert-saved-views-to-engine', () => {
    test('a dry run writes nothing and lists every dropped updated_at and the condition left out', async () => {
        const dataRoot = await userWithViews();
        const { code, text } = await run(dataRoot, false);
        expect(code).toBe(0);
        for (const r of ROWS) expect(text).toContain(`dropped updated_at: view ${r.id} "${r.name}": ${r.updated_at}`);
        expect(text).toContain(`left out of view ${ROWS[2].id} "Conditions": conditions[1]: op is not contains or not_contains {"field":"name","op":"is","value":"y"}`);
        expect(text).toContain('views the apply would write: 3');
        expect(await storedList(dataRoot)).toEqual([]);
        expect(tables(dataRoot)).toEqual(['meta', 'saved_views']);
    });

    test('apply writes the views in order, reads them back equal and drops only saved_views; a re-run does nothing', async () => {
        const dataRoot = await userWithViews();
        const { code, text } = await run(dataRoot, true);
        expect(text).toContain('read back: 3 views, all equal');
        expect(code).toBe(0);
        expect(await storedList(dataRoot)).toEqual(WANT);
        expect(tables(dataRoot)).toEqual(['meta']);
        const again = await run(dataRoot, true);
        expect(again.code).toBe(0);
        expect(again.text).toContain('has no saved_views table: nothing to do');
        expect(await storedList(dataRoot)).toEqual(WANT);
    });

    test('a view the store holds with other content stops it before anything is written', async () => {
        const dataRoot = await userWithViews();
        await storedList(dataRoot, async (lib) => {
            const { records } = views.createRecords(lib, { holder: null, key: ROWS[1].id, name: 'Odd', view: { fav: false }, position: 2 ** 20 });
            await lib.store.commit(records);
        });
        const { code, text } = await run(dataRoot, true);
        expect(code).toBe(1);
        expect(text).toContain(`STOPPED: the store holds these views with other content: ${ROWS[1].id}`);
        expect((await storedList(dataRoot)).map(v => v.id)).toEqual([ROWS[1].id]);
        expect(tables(dataRoot)).toEqual(['meta', 'saved_views']);
    });
});
