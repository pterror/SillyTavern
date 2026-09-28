import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A debounced whole-book save (saveWorldInfo without `immediately`) waits per book: a save of one book never
// absorbs or cancels another book's pending save, so every book's edits reach its file. An immediate save of a
// book still replaces that same book's pending debounced save, so the book is written once, with its latest data.

/**
 * Creates each book, and records every /api/worldinfo/edit request made from now on by the book name it writes.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 * @returns {Promise<string[]>} The live list of written book names, in request order
 */
async function createBooksAndRecordWrites(page, names) {
    await page.evaluate(async ({ names }) => {
        const { createNewWorldInfo } = await import('./scripts/world-info.js');
        for (const name of names) {
            if (!await createNewWorldInfo(name)) {
                throw new Error(`Could not create '${name}'`);
            }
        }
    }, { names });

    const writes = [];
    page.on('request', request => {
        if (request.url().endsWith('/api/worldinfo/edit')) {
            writes.push(JSON.parse(request.postData() ?? '{}').name);
        }
    });
    return writes;
}

/**
 * The comment of entry 0 in the book's file on the server.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function savedComment(page, name) {
    return await page.evaluate(async ({ name }) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }) });
        const data = await response.json();
        return data.entries?.['0']?.comment ?? '';
    }, { name });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 */
async function deleteBooks(page, names) {
    await page.evaluate(async ({ names }) => {
        const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
        for (const name of names) {
            if (world_names.includes(name)) {
                await deleteWorldInfo(name);
            }
        }
    }, { names });
}

test.describe('debounced World Info book saves', () => {
    test.beforeEach(testSetup.awaitST);

    test('debounced saves of two books inside one window both reach their files', async ({ page }) => {
        const first = `WIDebounceFirst-${Date.now()}`;
        const second = `WIDebounceSecond-${Date.now()}`;
        const writes = await createBooksAndRecordWrites(page, [first, second]);

        try {
            await page.evaluate(async ({ first, second }) => {
                const { loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
                for (const name of [first, second]) {
                    const data = await loadWorldInfo(name);
                    data.entries['0'] = { uid: 0, key: ['debounce'], content: 'debounced content', comment: `${name} edit` };
                    await saveWorldInfo(name, data);
                }
            }, { first, second });

            await expect.poll(() => savedComment(page, first), { timeout: 10000 }).toBe(`${first} edit`);
            await expect.poll(() => savedComment(page, second), { timeout: 10000 }).toBe(`${second} edit`);
            expect(writes.sort()).toEqual([first, second].sort());
        } finally {
            await deleteBooks(page, [first, second]);
        }
    });

    test('an immediate save of one book leaves another book\'s pending debounced save in place', async ({ page }) => {
        const pending = `WIDebouncePending-${Date.now()}`;
        const immediate = `WIDebounceImmediate-${Date.now()}`;
        const writes = await createBooksAndRecordWrites(page, [pending, immediate]);

        try {
            const written = await page.evaluate(async ({ pending, immediate }) => {
                const { loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
                const pendingData = await loadWorldInfo(pending);
                pendingData.entries['0'] = { uid: 0, key: ['debounce'], content: 'debounced content', comment: 'pending edit' };
                await saveWorldInfo(pending, pendingData);
                const immediateData = await loadWorldInfo(immediate);
                immediateData.entries['0'] = { uid: 0, key: ['debounce'], content: 'immediate content', comment: 'immediate edit' };
                return await saveWorldInfo(immediate, immediateData, true);
            }, { pending, immediate });

            expect(written).toBe(true);
            expect(await savedComment(page, immediate)).toBe('immediate edit');
            await expect.poll(() => savedComment(page, pending), { timeout: 10000 }).toBe('pending edit');
            expect(writes).toEqual([immediate, pending]);
        } finally {
            await deleteBooks(page, [pending, immediate]);
        }
    });

    test('an immediate save of a book replaces that book\'s own pending debounced save', async ({ page }) => {
        const name = `WIDebounceSame-${Date.now()}`;
        const writes = await createBooksAndRecordWrites(page, [name]);

        try {
            await page.evaluate(async ({ name }) => {
                const { loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
                const data = await loadWorldInfo(name);
                data.entries['0'] = { uid: 0, key: ['debounce'], content: 'debounced content', comment: 'debounced edit' };
                await saveWorldInfo(name, data);
                data.entries['0'].comment = 'immediate edit';
                if (!await saveWorldInfo(name, data, true)) {
                    throw new Error(`Could not save '${name}'`);
                }
                // Past the debounce window: a save still pending would have been sent by now.
                await new Promise(resolve => setTimeout(resolve, 2000));
            }, { name });

            expect(writes).toEqual([name]);
            expect(await savedComment(page, name)).toBe('immediate edit');
        } finally {
            await deleteBooks(page, [name]);
        }
    });
});
