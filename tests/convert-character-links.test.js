// The one-off src/migrations/convert-character-links.js, deleted with it.
import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';

/** @type {any} */
let engine;
/** @type {typeof import('../src/migrations/convert-character-links.js')} */
let script;
/** @type {typeof import('../src/library-engine.js')} */
let lib;
/** @type {typeof import('../src/character-links.js')} */
let links;
/** @type {(card: any) => string} */
let identityHash;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    engine = (await import('../engine/load.js')).loadEngine().binding;
    script = await import('../src/migrations/convert-character-links.js');
    lib = await import('../src/library-engine.js');
    links = await import('../src/character-links.js');
    ({ computeContentIdentityHash: identityHash } = await import('../src/character-card-normalize.js'));
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CHAR_LORE = [
    { name: 'a', extraBooks: ['Extra', 'Lore', 'Extra'] },
    { name: 'c', extraBooks: ['Extra', 'Nobook'] },
    { name: 'nobody', extraBooks: ['Extra'] },
    { bad: 1 },
];

/**
 * A data root whose user `u` has a store as the server left it before links were a list: characters a (`bookLink` to
 * the book Lore), b (`bookLink` to Ghost, a name no book has) and c (no link, an empty `world`), and the books Lore
 * and Extra; and `charLore` in its settings, sharded or (`legacy`) in the root settings.json.
 * @param {boolean} [legacy]
 */
async function oldUser(legacy = false) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-character-links-'));
    dirs.push(dataRoot);
    const root = path.join(dataRoot, 'u');
    const directories = { root, characters: path.join(root, 'characters') };
    const library = await lib.LibraryEngine.open(engine, path.join(root, 'store'));
    await library.books.write('Lore', { entries: {} });
    await library.books.write('Extra', { entries: {} });
    const card = (/** @type {string} */ name, /** @type {object} */ extensions) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, extensions } });
    await library.writeCard(directories, 'a.png', card('A', {}));
    await library.writeCard(directories, 'b.png', card('B', {}));
    await library.writeCard(directories, 'c.png', card('C', { world: '' }));
    const [a, b] = await library.ids(lib.TYPE.character, ['a.png', 'b.png']);
    const [lore] = await library.ids(lib.TYPE.book, ['Lore']);
    const ghost = library.nextId++;
    await library.store.commit([
        { kind: 'entityCreate', entity: ghost, type: lib.TYPE.book, key: 'Ghost', added: 0 },
        { kind: 'bookLink', entity: a, book: lore },
        { kind: 'bookLink', entity: b, book: ghost },
    ]);
    // Their identity hashes as the old server kept them: of the card reading its link's name as `world`.
    const [ea, eb] = await library.entities([a, b]);
    await library.store.commit([await library.identityRecord(ea, 'Lore'), await library.identityRecord(eb, 'Ghost')]);
    await library.close();
    const worldInfoSettings = { world_info: { globalSelect: ['Lore'], charLore: CHAR_LORE }, world_info_depth: 2 };
    if (legacy) {
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ username: 'U', world_info_settings: worldInfoSettings }, null, 4));
    } else {
        fs.mkdirSync(path.join(root, 'settings'), { recursive: true });
        fs.writeFileSync(path.join(root, 'settings', 'world_info_settings.json'), JSON.stringify(worldInfoSettings, null, 4));
    }
    return { dataRoot, root };
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
 * Each character's links by name, its card's `world`, and whether its stored identity hash is its card's as it reads.
 * @param {string} root
 */
async function read(root) {
    const library = await lib.LibraryEngine.open(engine, path.join(root, 'store'));
    try {
        /** @type {Record<string, any>} */
        const out = {};
        for (const avatar of ['a.png', 'b.png', 'c.png']) {
            const [e] = await library.entities(await library.ids(lib.TYPE.character, [avatar]));
            const names = await library.bookNames(links.storedLinks(e).map(l => l.book));
            const [card] = await library.cards([avatar]);
            out[avatar] = {
                links: links.storedLinks(e).map(l => names.get(l.book)),
                world: /** @type {any} */ (card).data.extensions.world,
                hashed: await library.findByHash(lib.HASH.identity, identityHash(card)) === avatar,
            };
        }
        out.legacy = (await library.store.worldRead('legacyLinks', { limit: 10 })).links.length;
        out.charLore = await library.charLore();
        return out;
    } finally {
        await library.close();
    }
}

describe('convert-character-links', () => {
    test('a dry run writes nothing and lists what it drops', async () => {
        const { dataRoot, root } = await oldUser();
        const file = path.join(root, 'settings', 'world_info_settings.json');
        const before = fs.readFileSync(file, 'utf8');
        const { code, text } = await run(dataRoot, false);
        expect(code).toBe(0);
        expect(text).toContain('charLore[2] names no character (nobody.png)');
        expect(text).toContain('charLore[3] isn\'t { name: string, extraBooks: string[] }');
        expect(text).toContain('no book has the name "Nobook"');
        expect(text).toContain('characters with a bookLink: 2; charLore entries dropped: 2; characters the apply would write: 3');
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        const now = await read(root);
        expect(now.legacy).toBe(2);
        expect(now['a.png'].links).toEqual([]);
    }, 120_000);

    test('apply makes each bookLink the first link and charLore the rest, then removes charLore; a re-run writes nothing', async () => {
        const { dataRoot, root } = await oldUser();
        const { code, text } = await run(dataRoot, true);
        expect(code).toBe(0);
        expect(text).toContain('read back: every character\'s links as planned');
        expect(text).toContain('flushed and reopened: no bookLink is pointed at');
        const now = await read(root);
        expect(now['a.png']).toEqual({ links: ['Lore', 'Extra'], world: 'Lore', hashed: true });
        expect(now['b.png']).toEqual({ links: ['Ghost'], world: 'Ghost', hashed: true });
        // No bookLink: the first extra book is its first link, its world.
        expect(now['c.png']).toEqual({ links: ['Extra', 'Nobook'], world: 'Extra', hashed: true });
        expect(now.legacy).toBe(0);
        expect(now.charLore).toEqual([{ name: 'a', extraBooks: ['Extra'] }, { name: 'c', extraBooks: ['Nobook'] }]);
        // The settings file keeps everything but charLore.
        const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings', 'world_info_settings.json'), 'utf8'));
        expect(settings).toEqual({ world_info: { globalSelect: ['Lore'] }, world_info_depth: 2 });

        const again = await run(dataRoot, true);
        expect(again.code).toBe(0);
        expect(again.text).toContain('characters written: 0 (0 records)');
    }, 120_000);

    test('charLore from a root settings.json is moved, and only it is removed there', async () => {
        const { dataRoot, root } = await oldUser(true);
        expect((await run(dataRoot, true)).code).toBe(0);
        expect((await read(root))['a.png'].links).toEqual(['Lore', 'Extra']);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))).toEqual({
            username: 'U',
            world_info_settings: { world_info: { globalSelect: ['Lore'] }, world_info_depth: 2 },
        });
    }, 120_000);

    test('refuses while the server runs, and without a store', async () => {
        const { dataRoot } = await oldUser();
        const lines = [];
        const running = await script.runConvert({
            dataRoot, handle: 'u', apply: true, engine: async () => engine, probeServer: async () => ({ running: true, lines: [] }),
            log: l => lines.push(l), warn: l => lines.push(l),
        });
        expect(running).toBe(1);
        expect((await run(`${dataRoot}-none`, true)).code).toBe(1);
    }, 120_000);
});
