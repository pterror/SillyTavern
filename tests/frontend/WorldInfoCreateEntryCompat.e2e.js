import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// createWorldInfoEntry() and getFreeWorldEntryUid() keep upstream's contract: the entry comes back synchronously,
// under the lowest uid free in the page's copy, and is stored under that uid unless another page took it meanwhile.

test.describe('createWorldInfoEntry keeps upstream\'s contract', () => {
    test.beforeEach(testSetup.awaitST);

    test('returns the entry synchronously, under the lowest free uid, and saves it there', async ({ page }) => {
        const name = `WICreateSync-${Date.now()}`;
        const result = await page.evaluate(async ({ name }) => {
            const wi = await import('./scripts/world-info.js');
            if (!await wi.createNewWorldInfo(name, { interactive: false })) throw new Error(`Could not create '${name}'`);
            const data = await wi.loadWorldInfo(name);
            data.entries[0] = { uid: 0, ...structuredClone(wi.newWorldInfoEntryTemplate), comment: 'zero' };
            data.entries[2] = { uid: 2, ...structuredClone(wi.newWorldInfoEntryTemplate), comment: 'two' };
            await wi.saveWorldInfo(name, data, true);
            const free = wi.getFreeWorldEntryUid(data);
            const entry = wi.createWorldInfoEntry(name, data);
            const synchronous = !(entry instanceof Promise);
            entry.comment = 'one';
            entry.key = ['k'];
            await wi.saveWorldInfoEntry(name, data, entry.uid, true);
            const stored = await (await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: (await import('./script.js')).getRequestHeaders(),
                body: JSON.stringify({ name }),
            })).json();
            await wi.deleteWorldInfo(name);
            return { free, synchronous, uid: entry.uid, stored: Object.fromEntries(Object.entries(stored.entries).map(([k, e]) => [k, e.comment])) };
        }, { name });
        expect(result.synchronous).toBe(true);
        expect(result.free).toBe(1);
        expect(result.uid).toBe(1);
        expect(result.stored).toEqual({ 0: 'zero', 1: 'one', 2: 'two' });
    });

    test('a uid another page took meanwhile moves the new entry; nothing is overwritten', async ({ page }) => {
        const name = `WICreateTaken-${Date.now()}`;
        const result = await page.evaluate(async ({ name }) => {
            const wi = await import('./scripts/world-info.js');
            const { getRequestHeaders } = await import('./script.js');
            const post = (/** @type {string} */ url, /** @type {any} */ body) => fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            if (!await wi.createNewWorldInfo(name, { interactive: false })) throw new Error(`Could not create '${name}'`);
            const data = await wi.loadWorldInfo(name);
            // Another page stores an entry under uid 0, which this page's copy still has free.
            await post('/api/worldinfo/entry/create', { name, uid: 0 });
            await post('/api/worldinfo/entry/edit', { name, uid: 0, data: { ...structuredClone(wi.newWorldInfoEntryTemplate), comment: 'elsewhere' } });
            const first = wi.createWorldInfoEntry(name, data);
            const second = wi.createWorldInfoEntry(name, data);
            const asked = [first.uid, second.uid];
            first.comment = 'first';
            second.comment = 'second';
            await wi.saveWorldInfo(name, data, true);
            const stored = await (await post('/api/worldinfo/get', { name })).json();
            await wi.deleteWorldInfo(name);
            return {
                asked,
                local: Object.fromEntries(Object.entries(data.entries).map(([k, e]) => [k, [e.uid, e.comment]])),
                stored: Object.fromEntries(Object.entries(stored.entries).map(([k, e]) => [k, e.comment])),
            };
        }, { name });
        expect(result.asked).toEqual([0, 1]);
        expect(Object.values(result.stored).sort()).toEqual(['elsewhere', 'first', 'second']);
        expect(result.stored[0]).toBe('elsewhere');
        // The page's copy names each entry under the uid the server holds it by.
        for (const [key, [uid, comment]] of Object.entries(result.local)) {
            expect(String(uid)).toBe(key);
            expect(result.stored[key]).toBe(comment);
        }
    });
});
