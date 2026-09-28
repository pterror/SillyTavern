import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A book's debounced saves still waiting when the book is deleted or renamed are never sent to the old name after
// its file is deleted, where a whole-book save would write the old book back. A rename carries their edits to the
// new name. A delete the server refuses leaves the book in place, and its waiting save still reaches the file.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** Past the debounce window (debounce_timeout.relaxed is 1000 ms): a save still waiting would have been sent. */
const PAST_DEBOUNCE_MS = 2500;

/**
 * Records every World Info write request (whole-book and single-entry) made from now on, by the book name it writes.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]} The live list of written book names, in request order
 */
function recordWrites(page) {
    const writes = [];
    page.on('request', request => {
        const url = request.url();
        if (url.endsWith('/api/worldinfo/edit') || url.endsWith('/api/worldinfo/entry/edit')) {
            writes.push(JSON.parse(request.postData() ?? '{}').name);
        }
    });
    return writes;
}

/**
 * Creates a book with one entry (uid 0, comment 'original').
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createBook(page, name) {
    await page.evaluate(async ({ name }) => {
        const { createNewWorldInfo, loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
        if (!await createNewWorldInfo(name)) {
            throw new Error(`Could not create '${name}'`);
        }
        const data = await loadWorldInfo(name);
        data.entries['0'] = { uid: 0, key: ['pending'], content: 'pending content', comment: 'original' };
        if (!await saveWorldInfo(name, data, true)) {
            throw new Error(`Could not save '${name}'`);
        }
    }, { name });
}

/**
 * Whether the server lists the book, and the comment of its entry 0 if it does.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<{exists: boolean, comment: string}>}
 */
async function savedBook(page, name) {
    return await page.evaluate(async ({ name }) => {
        const { updateWorldInfoList, world_names } = await import('./scripts/world-info.js');
        const { getRequestHeaders } = await import('./script.js');
        await updateWorldInfoList();
        if (!world_names.includes(name)) {
            return { exists: false, comment: '' };
        }
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }) });
        const data = await response.json();
        return { exists: true, comment: data.entries?.['0']?.comment ?? '' };
    }, { name });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 */
async function deleteBooks(page, names) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.evaluate(async ({ names }) => {
        const { deleteWorldInfo, updateWorldInfoList, world_names } = await import('./scripts/world-info.js');
        await updateWorldInfoList();
        for (const name of names) {
            if (world_names.includes(name)) {
                await deleteWorldInfo(name);
            }
        }
    }, { names });
}

/**
 * Renames the book open in the editor through its rename button, answering the name prompt with `newName` and the
 * relink prompt with no, while a debounced save of the old book's entry 0 (comment 'pending edit') is waiting.
 * @param {import('@playwright/test').Page} page
 * @param {string} oldName
 * @param {string} newName
 * @param {'book'|'entry'} pendingKind - Which debounced save of the old book is waiting when the rename starts
 */
async function renameWithPendingSave(page, oldName, newName, pendingKind) {
    await page.evaluate(async ({ oldName, newName, pendingKind }) => {
        const { loadWorldInfo, openWorldInfoEditor, saveWorldInfo, saveWorldInfoEntry } = await import('./scripts/world-info.js');
        const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');

        const waitFor = async (condition, timeoutMs = 10000) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                if (condition()) return true;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
        };
        const selectedName = () => String($('#world_editor_select').find(':selected').text());

        openWorldInfoEditor(oldName);
        if (!await waitFor(() => selectedName() === oldName)) {
            throw new Error(`The editor did not open '${oldName}'`);
        }

        const data = await loadWorldInfo(oldName);
        data.entries['0'].comment = 'pending edit';
        if (pendingKind === 'book') {
            await saveWorldInfo(oldName, data);
        } else {
            await saveWorldInfoEntry(oldName, data, 0);
        }

        const originalInput = Popup.show.input;
        const originalConfirm = Popup.show.confirm;
        Popup.show.input = async () => newName;
        Popup.show.confirm = async () => POPUP_RESULT.NEGATIVE;
        try {
            document.querySelector('#world_popup_name_button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            if (!await waitFor(() => selectedName() === newName)) {
                throw new Error('The rename did not complete in time');
            }
        } finally {
            Popup.show.input = originalInput;
            Popup.show.confirm = originalConfirm;
        }
    }, { oldName, newName, pendingKind });
}

test.describe('World Info saves waiting when a book is deleted or renamed', () => {
    test.beforeEach(testSetup.awaitST);

    test('a delete drops the book\'s waiting save, which never writes the book back', async ({ page }) => {
        const name = `WIPendingDelete-${Date.now()}`;
        await createBook(page, name);
        const writes = recordWrites(page);

        try {
            const deleted = await page.evaluate(async ({ name, wait }) => {
                const { deleteWorldInfo, loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
                const data = await loadWorldInfo(name);
                data.entries['0'].comment = 'pending edit';
                await saveWorldInfo(name, data);
                const deleted = await deleteWorldInfo(name);
                await new Promise(resolve => setTimeout(resolve, wait));
                return deleted;
            }, { name, wait: PAST_DEBOUNCE_MS });

            expect(deleted).toBe(true);
            expect(writes).toEqual([]);
            expect(await savedBook(page, name)).toEqual({ exists: false, comment: '' });
        } finally {
            await deleteBooks(page, [name]);
        }
    });

    test('a delete the server refuses keeps the book, and its waiting save still reaches the file', async ({ page }) => {
        const name = `WIPendingDeleteRefused-${Date.now()}`;
        await createBook(page, name);
        await page.route('**/api/worldinfo/delete', route => route.fulfill({ status: 500, body: 'refused' }));
        const writes = recordWrites(page);

        try {
            const deleted = await page.evaluate(async ({ name }) => {
                const { deleteWorldInfo, loadWorldInfo, saveWorldInfo } = await import('./scripts/world-info.js');
                const data = await loadWorldInfo(name);
                data.entries['0'].comment = 'pending edit';
                await saveWorldInfo(name, data);
                return await deleteWorldInfo(name);
            }, { name });

            expect(deleted).toBe(false);
            await expect.poll(() => savedBook(page, name), { timeout: 10000 }).toEqual({ exists: true, comment: 'pending edit' });
            expect(writes).toEqual([name]);
        } finally {
            await deleteBooks(page, [name]);
        }
    });

    for (const pendingKind of /** @type {const} */ (['book', 'entry'])) {
        test(`a rename carries the old book's waiting ${pendingKind} save to the new name and never writes the old name back`, async ({ page }) => {
            const oldName = `WIPendingRenameOld-${pendingKind}-${Date.now()}`;
            const newName = `WIPendingRenameNew-${pendingKind}-${Date.now()}`;
            await createBook(page, oldName);
            const writes = recordWrites(page);

            try {
                await renameWithPendingSave(page, oldName, newName, pendingKind);
                await page.evaluate(wait => new Promise(resolve => setTimeout(resolve, wait)), PAST_DEBOUNCE_MS);

                expect(await savedBook(page, newName)).toEqual({ exists: true, comment: 'pending edit' });
                expect(await savedBook(page, oldName)).toEqual({ exists: false, comment: '' });
                expect(writes).toEqual([newName]);
            } finally {
                await deleteBooks(page, [oldName, newName]);
            }
        });
    }
});
