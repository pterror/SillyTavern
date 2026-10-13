import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-tags-backup-stream-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
});

/** Stores tag definitions, creation order. @param {{ id: string, name: string }[]} tags */
async function saveTags(tags) {
    for (const tag of tags) await user.store.lib.tags.create(tag);
}

/** Ids that don't sort in insertion order, so id order and rowid order differ. */
function makeTags(count) {
    return Array.from({ length: count }, (_, i) => ({ id: `t${String(count - i).padStart(5, '0')}`, name: `Tag ${i}` }));
}

const postBackup = () => fetch(`${baseUrl}/api/tags/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });


describe('POST /api/tags/backup: the tag definitions', () => {
    test('streams every live definition in alphabetical order', async () => {
        const tags = makeTags(2500);
        await saveTags(tags);
        await user.store.lib.tags.delete(tags[1234].id);

        const response = await postBackup();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^application\/json/);
        const body = await response.json();
        // The names are ASCII and distinct, so their lower-cased code unit order is the folded names' order.
        const byName = (a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
        expect(body.tags.map(tag => ({ id: tag.id, name: tag.name }))).toEqual(tags.filter((_, i) => i !== 1234).sort(byName));
    }, 120000);

    test('answers an empty list when there are no definitions', async () => {
        expect((await (await postBackup()).json()).tags).toEqual([]);
    });

    test('a failure after the first write logs and ends the connection, leaving the body incomplete', async () => {
        await saveTags(makeTags(1500));
        const store = user.store.lib.store;
        const tagPage = store.tagPage.bind(store);
        let reads = 0;
        store.tagPage = async (/** @type {any} */ q) => {
            if (++reads > 1) throw new Error('injected read failure');
            return tagPage(q);
        };
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await postBackup();
        expect(response.status).toBe(200);
        const text = await response.text().catch(() => '');

        expect(() => JSON.parse(text)).toThrow();
        expect(errorSpy.mock.calls.some(args => String(args[0]).includes('[tags/backup]'))).toBe(true);
    }, 120000);
});
