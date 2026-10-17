import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Typing in a World Info entry writes only a draft; a finished edit commits as one write

const SAVE_URL = /\/api\/worldinfo\/(entry\/edit|entries\/apply|create)$/;
const STORED_CONTENT = 'stored content';

/**
 * Records every save request the page sends from now on.
 * @param {import('@playwright/test').Page} page
 * @returns {{ url: string, body: any }[]} The live list, in request order
 */
function recordSaves(page) {
    const saves = [];
    page.on('request', request => {
        if (request.method() === 'POST' && SAVE_URL.test(request.url())) {
            saves.push({ url: new URL(request.url()).pathname, body: JSON.parse(request.postData() ?? '{}') });
        }
    });
    return saves;
}

/**
 * Creates a book with one entry.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<number>} The entry's uid
 */
async function createBook(page, name) {
    return await page.evaluate(async ({ name, content }) => {
        const { createNewWorldInfo, loadWorldInfo, createWorldInfoEntry, saveWorldInfo } = await import('./scripts/world-info.js');
        if (!await createNewWorldInfo(name, { interactive: false })) throw new Error(`Could not create '${name}'`);
        const data = await loadWorldInfo(name);
        const entry = await createWorldInfoEntry(name, data);
        entry.key = ['firstkey'];
        entry.content = content;
        if (await saveWorldInfo(name, data, true) !== true) throw new Error(`Could not save '${name}'`);
        return entry.uid;
    }, { name, content: STORED_CONTENT });
}

/**
 * Opens the editor on the book and opens its first entry. Keys use the picker (the plain text box is the default).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} [shown] What the entry's content shows once open
 */
async function openEntry(page, name, shown = STORED_CONTENT) {
    await page.evaluate(async ({ name }) => {
        const { openWorldInfoEditor } = await import('./scripts/world-info.js');
        const { power_user } = await import('./scripts/power-user.js');
        power_user.wi_key_input_plaintext = false;
        openWorldInfoEditor(name);
    }, { name });
    const entry = page.locator('#world_popup_entries_list .world_entry').first();
    await entry.locator('.inline-drawer-toggle').first().click();
    const content = entry.locator('textarea[name="content"]');
    await expect(content).toBeVisible();
    await expect(content).toHaveValue(shown);
    return { entry, content };
}

/**
 * Reloads the page, then opens the book's first entry again.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} shown What the entry's content shows once open
 */
async function reopenEntry(page, name, shown) {
    await page.goto('/');
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    return await openEntry(page, name, shown);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {number} uid
 * @returns {Promise<any>} The entry as the server has it
 */
async function storedEntry(page, name, uid) {
    return await page.evaluate(async ({ name, uid }) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-cache' });
        return (await response.json()).entries?.[uid] ?? null;
    }, { name, uid });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} The keys of the entry drafts in browser storage
 */
async function draftKeys(page) {
    return await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('FieldDraft')));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function deleteBook(page, name) {
    await page.evaluate(async ({ name }) => {
        const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
        if (world_names.includes(name)) await deleteWorldInfo(name);
    }, { name });
}

// Long enough for a delayed save to have gone out.
const QUIET_MS = 2500;

test.describe('World Info entry drafts', () => {
    test.beforeEach(testSetup.awaitST);

    test('typing in an entry\'s content sends no save; blur sends exactly one, with the full text', async ({ page }) => {
        const name = `WIDraftsBlur-${Date.now()}`;
        const uid = await createBook(page, name);
        try {
            const { content } = await openEntry(page, name);
            const saves = recordSaves(page);

            await content.focus();
            await content.press('End');
            await content.pressSequentially(' plus typed words');
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(QUIET_MS);
            expect(saves).toEqual([]);
            expect((await storedEntry(page, name, uid)).content).toBe(STORED_CONTENT);

            await content.blur();
            await expect.poll(() => saves.length).toBe(1);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(QUIET_MS);
            expect(saves).toHaveLength(1);
            expect(saves[0].url).toBe('/api/worldinfo/entry/edit');
            expect(saves[0].body.data.content).toBe(`${STORED_CONTENT} plus typed words`);
            expect((await storedEntry(page, name, uid)).content).toBe(`${STORED_CONTENT} plus typed words`);
            expect(await draftKeys(page)).toEqual([]);
        } finally {
            await deleteBook(page, name);
        }
    });

    test('a reload before blur brings the text back marked as an unsaved draft; blur commits it', async ({ page }) => {
        const name = `WIDraftsReload-${Date.now()}`;
        const uid = await createBook(page, name);
        try {
            const { content } = await openEntry(page, name);
            await content.focus();
            await content.press('End');
            await content.pressSequentially(' typed before reload');
            expect(await draftKeys(page)).not.toEqual([]);

            const saves = recordSaves(page);
            const reloaded = await reopenEntry(page, name, `${STORED_CONTENT} typed before reload`);
            expect(saves).toEqual([]);
            expect((await storedEntry(page, name, uid)).content).toBe(STORED_CONTENT);

            await expect(reloaded.content).toHaveClass(/wi_field_draft/);
            await expect(reloaded.entry.locator('.world_entry_draft_badge')).toBeVisible();
            await expect(reloaded.entry.locator('.world_entry_draft_badge')).toHaveText('unsaved draft');

            await reloaded.content.focus();
            await reloaded.content.blur();
            await expect.poll(() => saves.length).toBe(1);
            expect(saves[0].body.data.content).toBe(`${STORED_CONTENT} typed before reload`);
            await expect.poll(async () => (await storedEntry(page, name, uid)).content).toBe(`${STORED_CONTENT} typed before reload`);
            await expect(reloaded.content).not.toHaveClass(/wi_field_draft/);
            await expect(reloaded.entry.locator('.world_entry_draft_badge')).toBeHidden();
            expect(await draftKeys(page)).toEqual([]);
        } finally {
            await deleteBook(page, name);
        }
    });

    test('a toggle and an added key each save at once, with one request each', async ({ page }) => {
        const name = `WIDraftsAtOnce-${Date.now()}`;
        const uid = await createBook(page, name);
        try {
            const { entry } = await openEntry(page, name);
            const saves = recordSaves(page);

            await entry.locator('[name="entryKillSwitch"]').click();
            await expect.poll(() => saves.length).toBe(1);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(QUIET_MS);
            expect(saves).toHaveLength(1);
            expect(saves[0].url).toBe('/api/worldinfo/entry/edit');
            expect(saves[0].body.data.disable).toBe(true);
            expect((await storedEntry(page, name, uid)).disable).toBe(true);

            const picker = entry.locator('select.keyprimaryselect + .select2-container .select2-search__field');
            await picker.click();
            await picker.pressSequentially('secondkey');
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(QUIET_MS);
            expect(saves).toHaveLength(1);
            await picker.press('Enter');
            await expect.poll(() => saves.length).toBe(2);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(QUIET_MS);
            expect(saves).toHaveLength(2);
            expect(saves[1].url).toBe('/api/worldinfo/entry/edit');
            expect(saves[1].body.data.key).toEqual(['firstkey', 'secondkey']);
            expect((await storedEntry(page, name, uid)).key).toEqual(['firstkey', 'secondkey']);
        } finally {
            await deleteBook(page, name);
        }
    });

    test('deleting an entry saves straight away and its drafts are gone afterwards', async ({ page }) => {
        const name = `WIDraftsDelete-${Date.now()}`;
        const uid = await createBook(page, name);
        try {
            const { entry, content } = await openEntry(page, name);

            // A draft that stays: its commit fails, which keeps the draft.
            await page.route('**/api/worldinfo/entry/edit', route => route.fulfill({ status: 500, body: 'refused' }));
            await content.focus();
            await content.press('End');
            await content.pressSequentially(' never stored');
            await content.blur();
            await expect.poll(() => draftKeys(page)).not.toEqual([]);
            await page.unroute('**/api/worldinfo/entry/edit');
            await expect(entry.locator('.world_entry_draft_badge')).toBeVisible();

            const saves = recordSaves(page);
            await entry.locator('.delete_entry_button').click();
            await page.locator('dialog[open] .popup-button-ok').click();

            await expect.poll(() => saves.length).toBe(1);
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(QUIET_MS);
            expect(saves).toHaveLength(1);
            expect(saves[0].url).toBe('/api/worldinfo/entries/apply');
            expect(saves[0].body.name).toBe(name);
            expect(await storedEntry(page, name, uid)).toBeNull();
            expect(await draftKeys(page)).toEqual([]);
        } finally {
            await deleteBook(page, name);
        }
    });

    test.describe('a draft in conflict with what another tab stored', () => {
        const DRAFT_TEXT = `${STORED_CONTENT} (draft in tab A)`;
        const OTHER_TEXT = 'stored by tab B';

        /**
         * Tab A types a draft and reloads; tab B (its own browser context, so its own browser storage) stores the same
         * field; tab A reloads again and shows the conflict.
         * @param {import('@playwright/test').Page} page
         * @param {import('@playwright/test').Browser} browser
         * @param {string} name
         * @param {number} uid
         */
        async function conflictInTabA(page, browser, name, uid) {
            const { content } = await openEntry(page, name);
            await content.focus();
            await content.press('End');
            await content.pressSequentially(' (draft in tab A)');
            expect(await draftKeys(page)).not.toEqual([]);

            const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
            try {
                const tabB = await context.newPage();
                await testSetup.awaitST({ page: tabB });
                await tabB.evaluate(async ({ name, uid, text }) => {
                    const { loadWorldInfo, saveWorldInfoEntry } = await import('./scripts/world-info.js');
                    const data = await loadWorldInfo(name);
                    data.entries[uid].content = text;
                    if (await saveWorldInfoEntry(name, data, uid, true) !== true) throw new Error('Tab B could not save');
                }, { name, uid, text: OTHER_TEXT });
            } finally {
                await context.close();
            }
            expect((await storedEntry(page, name, uid)).content).toBe(OTHER_TEXT);

            const reloaded = await reopenEntry(page, name, OTHER_TEXT);
            const notice = reloaded.entry.locator('.wi_draft_conflict');
            await expect(notice).toBeVisible();
            const values = notice.locator('.wi_draft_conflict_value');
            await expect(values).toHaveText([OTHER_TEXT, DRAFT_TEXT]);
            await expect(reloaded.content).toBeDisabled();
            return { ...reloaded, notice };
        }

        test('Keep my edit puts the draft in the field, commits it at the next blur', async ({ page, browser }) => {
            const name = `WIDraftsKeep-${Date.now()}`;
            const uid = await createBook(page, name);
            try {
                const { content, notice, entry } = await conflictInTabA(page, browser, name, uid);
                const saves = recordSaves(page);

                await notice.getByRole('button', { name: 'Keep my edit' }).click();
                await expect(notice).toBeHidden();
                await expect(content).toBeEnabled();
                await expect(content).toHaveValue(DRAFT_TEXT);
                await expect(content).toHaveClass(/wi_field_draft/);
                expect(saves).toEqual([]);
                expect((await storedEntry(page, name, uid)).content).toBe(OTHER_TEXT);

                await content.focus();
                await content.blur();
                await expect.poll(() => saves.length).toBe(1);
                expect(saves[0].body.data.content).toBe(DRAFT_TEXT);
                await expect.poll(async () => (await storedEntry(page, name, uid)).content).toBe(DRAFT_TEXT);
                await expect(entry.locator('.world_entry_draft_badge')).toBeHidden();
                expect(await draftKeys(page)).toEqual([]);
            } finally {
                await deleteBook(page, name);
            }
        });

        test('Keep the stored one shows the stored text and drops the draft, with no save', async ({ page, browser }) => {
            const name = `WIDraftsDiscard-${Date.now()}`;
            const uid = await createBook(page, name);
            try {
                const { content, notice, entry } = await conflictInTabA(page, browser, name, uid);
                const saves = recordSaves(page);

                await notice.getByRole('button', { name: 'Keep the stored one' }).click();
                await expect(notice).toBeHidden();
                await expect(content).toBeEnabled();
                await expect(content).toHaveValue(OTHER_TEXT);
                await expect(content).not.toHaveClass(/wi_field_draft/);
                await expect(entry.locator('.world_entry_draft_badge')).toBeHidden();
                expect(await draftKeys(page)).toEqual([]);

                await content.focus();
                await content.blur();
                // eslint-disable-next-line playwright/no-wait-for-timeout
                await page.waitForTimeout(QUIET_MS);
                expect(saves).toEqual([]);
                expect((await storedEntry(page, name, uid)).content).toBe(OTHER_TEXT);
            } finally {
                await deleteBook(page, name);
            }
        });
    });
});
