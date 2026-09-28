import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A save of a book already sent when the book is deleted, or renamed (which deletes the old name), is never let
// reach the server after the delete, where it would write the book back: the delete is sent only once that save has
// landed.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** How long a delete is given to go out while the save is held, if it doesn't wait for it. */
const DELETE_WINDOW_MS = 1500;

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
        data.entries['0'] = { uid: 0, key: ['inflight'], content: 'in flight content', comment: 'original' };
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
 * Holds the next write request (whole-book or single-entry) to `name` until release() is called, and logs, in the
 * order they are let through to the server, that write ('write') and every delete of `name` ('delete').
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<{ log: string[], held: Promise<void>, release: () => void }>}
 */
async function holdNextWrite(page, name) {
    /** @type {string[]} */
    const log = [];
    let release = () => {};
    const released = new Promise(resolve => { release = resolve; });
    let markHeld = () => {};
    const held = new Promise(resolve => { markHeld = resolve; });
    let holding = true;

    const onWrite = async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        if (body.name !== name || !holding) {
            return route.fallback();
        }
        holding = false;
        markHeld();
        await released;
        log.push('write');
        await route.continue();
    };
    await page.route('**/api/worldinfo/edit', onWrite);
    await page.route('**/api/worldinfo/entry/edit', onWrite);
    await page.route('**/api/worldinfo/delete', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        if (body.name === name) {
            log.push('delete');
        }
        await route.fallback();
    });
    return { log, held, release };
}

/**
 * Starts a save of `name`'s entry 0 with the comment 'in flight', sent right away, without waiting for it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {'book'|'entry'} kind - A whole-book save or a single-entry save
 */
async function startSave(page, name, kind) {
    await page.evaluate(async ({ name, kind }) => {
        const { loadWorldInfo, saveWorldInfo, saveWorldInfoEntry } = await import('./scripts/world-info.js');
        const data = await loadWorldInfo(name);
        data.entries['0'].comment = 'in flight';
        // Not awaited: the request stays on its way while the test goes on.
        if (kind === 'book') {
            void saveWorldInfo(name, data, true);
        } else {
            void saveWorldInfoEntry(name, data, 0, true);
        }
    }, { name, kind });
}

test.describe('World Info saves already sent when a book is deleted or renamed', () => {
    test.beforeEach(testSetup.awaitST);

    for (const kind of /** @type {const} */ (['book', 'entry'])) {
        test(`a delete waits for a ${kind === 'book' ? 'whole-book' : 'single-entry'} save already sent, which never writes the book back`, async ({ page }) => {
            const name = `WIInFlightDelete-${kind}-${Date.now()}`;
            await createBook(page, name);
            const { log, held, release } = await holdNextWrite(page, name);

            try {
                await startSave(page, name, kind);
                await held;

                const deletion = page.evaluate(async ({ name }) => {
                    const { deleteWorldInfo } = await import('./scripts/world-info.js');
                    return await deleteWorldInfo(name);
                }, { name });
                await page.evaluate(wait => new Promise(resolve => setTimeout(resolve, wait)), DELETE_WINDOW_MS);
                expect(log).toEqual([]);

                release();
                expect(await deletion).toBe(true);
                expect(log).toEqual(['write', 'delete']);
                expect(await savedBook(page, name)).toEqual({ exists: false, comment: '' });
            } finally {
                release();
                await deleteBooks(page, [name]);
            }
        });
    }

    test('a rename deletes the old name only once a save of it already sent has landed', async ({ page }) => {
        const oldName = `WIInFlightRenameOld-${Date.now()}`;
        const newName = `WIInFlightRenameNew-${Date.now()}`;
        await createBook(page, oldName);
        const { log, held, release } = await holdNextWrite(page, oldName);

        try {
            await page.evaluate(async ({ oldName }) => {
                const { openWorldInfoEditor } = await import('./scripts/world-info.js');
                openWorldInfoEditor(oldName);
                const start = Date.now();
                while (String($('#world_editor_select').find(':selected').text()) !== oldName) {
                    if (Date.now() - start > 10000) throw new Error(`The editor did not open '${oldName}'`);
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }, { oldName });
            await startSave(page, oldName, 'book');
            await held;

            const rename = page.evaluate(async ({ oldName, newName }) => {
                const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');
                const originalInput = Popup.show.input;
                const originalConfirm = Popup.show.confirm;
                Popup.show.input = async () => newName;
                Popup.show.confirm = async () => POPUP_RESULT.NEGATIVE;
                try {
                    document.querySelector('#world_popup_name_button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    const start = Date.now();
                    while (String($('#world_editor_select').find(':selected').text()) !== newName) {
                        if (Date.now() - start > 20000) throw new Error('The rename did not complete in time');
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                } finally {
                    Popup.show.input = originalInput;
                    Popup.show.confirm = originalConfirm;
                }
            }, { oldName, newName });
            await page.evaluate(wait => new Promise(resolve => setTimeout(resolve, wait)), DELETE_WINDOW_MS);
            expect(log).toEqual([]);

            release();
            await rename;
            expect(log).toEqual(['write', 'delete']);
            expect(await savedBook(page, oldName)).toEqual({ exists: false, comment: '' });
            expect(await savedBook(page, newName)).toEqual({ exists: true, comment: 'in flight' });
        } finally {
            release();
            await deleteBooks(page, [oldName, newName]);
        }
    });
});
