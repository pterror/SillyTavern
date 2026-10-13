import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

// scripts/stats.js reads a running server's routes only: the totals it prints and the five top-10 lists it asks the
// server for, each at most 10 rows.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
/** The routes the script asked, and with what. @type {{ route: string, body: any }[]} */
const asked = [];
/** @type {string[]} */
let output;

const CHARACTER_COUNT = 12;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const fixture = await import('./converted-user.fixture.js');
    user = await fixture.emptyUser('st-stats-script-');
    globalThis.DATA_ROOT = user.dataRoot;
    const { lib } = user.store;
    const { directories } = user;

    // char1..char12: added, chatted, sized and used by tags in rising order; the odd ones favorites; one fav group.
    for (let i = 1; i <= CHARACTER_COUNT; i++) {
        const name = `char${i}`;
        const card = { name, data: { name, description: 'd'.repeat(i * 100), tags: [], extensions: { fav: false, world: '' } } };
        await lib.writeCard(directories, `${name}.png`, JSON.stringify(card), { fav: i % 2 === 1, dateAdded: Date.UTC(2026, 0, i) });
        await lib.tags.create({ id: `tag${i}`, name: `Tag ${i}` });
    }
    for (let i = 1; i <= CHARACTER_COUNT; i++) {
        for (let n = 1; n <= i; n++) await lib.tags.assign(`char${n}.png`, `tag${i}`);
    }
    for (let i = 1; i <= CHARACTER_COUNT; i++) {
        await fixture.saveBranch(user.store, { avatar: `char${i}.png` }, `chat ${i}`, [{}, ...Array.from({ length: i }, (_, m) => ({ name: 'User', is_user: true, mes: `message ${m}`, send_date: 'x', extra: {} }))]);
    }
    await lib.writeGroup({ id: 'g1', name: 'Group', members: [], fav: true });

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.get('/csrf-token', (_req, res) => res.json({ token: 'test' }));
    app.use((req, _res, next) => {
        req.user = user.user;
        if (req.method === 'POST') asked.push({ route: req.path, body: req.body });
        next();
    });
    app.use('/api/characters', (await import('../src/endpoints/characters.js')).router);
    app.use('/api/tags', (await import('../src/endpoints/tags.js')).router);
    app.use('/api/stats', (await import('../src/endpoints/stats.js')).router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    output = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const argv = process.argv;
    process.argv = [argv[0], 'stats.js', '--url', `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`];
    try {
        await import('../scripts/stats.js');
    } finally {
        process.argv = argv;
        log.mockRestore();
        warn.mockRestore();
    }
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/** The lines between a heading's underline and the next blank line. */
function section(title) {
    const start = output.indexOf(title);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = output.indexOf('', start);
    return output.slice(start + 2, end === -1 ? undefined : end);
}

describe('scripts/stats.js', () => {
    test('the five top-10 reads ask the server for at most 10 rows', () => {
        const lists = asked.filter(a => a.route === '/api/characters/query' && a.body.pageSize === 10);
        expect(lists).toHaveLength(4);
        const tags = asked.filter(a => a.route === '/api/tags/query');
        expect(tags).toHaveLength(1);
        expect(tags[0].body.pageSize).toBe(10);
        expect(asked.every(a => a.route.endsWith('/query') ? a.body.pageSize <= 10 || a.body.pageSize === 1 : true)).toBe(true);
    });

    test('prints the overview totals', () => {
        expect(output).toEqual(expect.arrayContaining([
            expect.stringMatching(/Total characters:\s+12$/),
            expect.stringMatching(/Total groups:\s+1$/),
            expect.stringMatching(/Total favorites:\s+6 characters, 1 groups$/),
            expect.stringMatching(/Messages counted:\s+78 user, 0 character$/),
        ]));
    });

    test('each top-10 section lists the 10 highest rows in order', () => {
        const top = (from) => Array.from({ length: 10 }, (_, i) => from - i);
        expect(section('Top 10 tags by usage').slice(2).map(l => l.trim().split(/\s{2,}/)))
            .toEqual(top(12).map(i => [`Tag ${i}`, String(i)]));
        for (const title of [
            '10 most recently added characters',
            '10 most recently chatted characters',
            'Top 10 characters by data size',
            'Top 10 characters by chat size',
        ]) {
            expect(section(title).slice(2).map(l => l.trim().split(/\s{2,}/)[0])).toEqual(top(12).map(i => `char${i}`));
        }
    });
});
