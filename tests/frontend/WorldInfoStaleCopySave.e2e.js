import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// An extension's saveWorldInfo(name, data) stores the changes it made to the copy it loaded, not the copy as a whole:
// an entry another tab added since is kept, and a change to an entry someone else changed since is not stored but
// named in a warning.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

test('saveWorldInfo() from a copy loaded before another tab\'s edits keeps them and reports a clash', async ({ page }) => {
    await testSetup.awaitST({ page });
    const name = `WIStaleCopy-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const entry = (uid, content, comment) => ({ uid, key: [`k${uid}`], content, comment, disable: false });

    await page.evaluate(async ({ name, entries }) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/worldinfo/create', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, unique: false, data: { entries } }) });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        const { updateWorldInfoList } = await import('./scripts/world-info.js');
        await updateWorldInfoList();
    }, { name, entries: { 0: entry(0, 'zero', 'Zero'), 1: entry(1, 'one', 'One'), 2: entry(2, 'two', 'Two') } });

    try {
        const result = await page.evaluate(async ({ name, elsewhereOne, elsewhereFive }) => {
            const { getRequestHeaders } = await import('./script.js');
            const { loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
            const data = await loadWorldInfo(name);

            // Another tab: changes entry 1 and adds entry 5.
            const post = (path, body) => fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            await post('/api/worldinfo/entry/edit', { name, uid: 1, data: elsewhereOne });
            await post('/api/worldinfo/entries/apply', { name, entries: [{ uid: 5, base_hash: null, data: elsewhereFive }] });

            // This copy: changes entries 0 and 1, and deletes entry 2.
            data.entries[0].content = 'zero, here';
            data.entries[1].content = 'one, here';
            delete data.entries[2];
            const saved = await saveWorldInfo(name, data, true);

            const stored = await (await post('/api/worldinfo/get', { name })).json();
            const warnings = Array.from(document.querySelectorAll('#toast-container .toast-warning')).map(e => e.textContent ?? '');
            return {
                saved,
                stored: Object.fromEntries(Object.entries(stored.entries).map(([uid, e]) => [uid, e.content])),
                warning: warnings.find(text => text.includes(name)) ?? null,
            };
        }, { name, elsewhereOne: entry(1, 'one, elsewhere', 'One'), elsewhereFive: entry(5, 'five, elsewhere', 'Five') });

        expect(result.saved).toBe(false);
        expect(result.stored).toEqual({ 0: 'zero, here', 1: 'one, elsewhere', 5: 'five, elsewhere' });
        expect(result.warning).toContain('One (#1)');
        expect(result.warning).not.toContain('Zero');
    } finally {
        await page.evaluate(async (name) => {
            const { deleteWorldInfo } = await import('./scripts/world-info.js');
            await deleteWorldInfo(name);
        }, name);
    }
});
