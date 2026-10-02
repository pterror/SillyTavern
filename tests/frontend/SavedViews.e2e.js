import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/** @param {import('@playwright/test').Page} page */
function readView(page) {
    return page.evaluate(async () => (await import('/scripts/character-list.js')).getCharacterView());
}

/** @param {import('@playwright/test').Page} page @param {object} view */
function setView(page, view) {
    return page.evaluate(async (view) => (await import('/scripts/character-list.js')).setCharacterView(view), view);
}

/** Deletes every saved view this user has, so each test starts from none. @param {import('@playwright/test').Page} page */
async function clearViews(page) {
    await page.evaluate(async () => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        for (;;) {
            const list = await (await fetch('/api/views/list', { method: 'POST', headers, body: '{}' })).json();
            if (list.views.length === 0) return;
            for (const view of list.views) await fetch('/api/views/delete', { method: 'POST', headers, body: JSON.stringify({ id: view.id }) });
        }
    });
}

/** @param {import('@playwright/test').Page} page */
async function openPicker(page) {
    if (!(await page.locator('#character_search_bar').isVisible())) await page.locator('#rm_button_search').click();
    await page.locator('#character_view_picker').click();
    await expect(page.locator('.view_picker_popover')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {string} name */
async function saveAs(page, name) {
    await openPicker(page);
    await page.locator('.view_picker_save input').fill(name);
    await page.locator('.view_picker_save .menu_button').click();
    await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText(name);
}

/** @param {import('@playwright/test').Page} page */
async function pickerNames(page) {
    return page.locator('.view_picker_popover .view_picker_row .view_picker_row_name').allTextContents();
}

test.describe('saved views', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await clearViews(page);
        await page.evaluate(() => {
            localStorage.removeItem('characterListViewId');
        });
    });

    test('the list can be saved as a view, "All characters" clears it, picking the view brings it back, and a reload keeps it', async ({ page }) => {
        await setView(page, { text: 'castle', fav: true });
        await saveAs(page, 'Castles');

        await openPicker(page);
        await page.locator('.view_picker_row[data-view-id=""] .view_picker_row_name').click();
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('All characters');
        expect(await readView(page)).toMatchObject({ text: '', fav: undefined });

        await openPicker(page);
        await page.locator('.view_picker_row_name', { hasText: 'Castles' }).click();
        expect(await readView(page)).toMatchObject({ text: 'castle', fav: true });

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('Castles', { useInnerText: false });
        await expect.poll(async () => (await readView(page)).text).toBe('castle');
    });

    test('views are renamed, moved and deleted in the picker, one action each', async ({ page }) => {
        for (const name of ['One', 'Two', 'Three']) {
            await setView(page, { text: name.toLowerCase() });
            await saveAs(page, name);
        }
        await openPicker(page);
        await expect.poll(() => pickerNames(page)).toEqual(['All characters', 'One', 'Two', 'Three']);

        await page.locator('.view_picker_row', { hasText: 'Three' }).locator('[data-action="up"]').click();
        await expect.poll(() => pickerNames(page)).toEqual(['All characters', 'One', 'Three', 'Two']);

        await page.locator('.view_picker_row', { hasText: 'One' }).locator('[data-action="rename"]').click();
        await page.locator('.view_picker_rename').fill('First');
        await page.locator('.view_picker_rename').press('Enter');
        await expect.poll(() => pickerNames(page)).toEqual(['All characters', 'First', 'Three', 'Two']);

        await page.locator('.view_picker_row', { hasText: 'Three' }).locator('[data-action="delete"]').click();
        await page.locator('.view_picker_confirm').click();
        await expect.poll(() => pickerNames(page)).toEqual(['All characters', 'First', 'Two']);
        // Three was the view in use, so the list is back to "All characters".
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('All characters');
    });

    test('Escape in the picker closes it and leaves the drawer open', async ({ page }) => {
        await openPicker(page);
        await page.locator('.view_picker_popover input[type="search"]').press('Escape');
        await expect(page.locator('.view_picker_popover')).toHaveCount(0);
        await expect(page.locator('#rm_characters_block')).toBeVisible();
    });

    test('changing a saved view marks it unsaved; Discard puts it back, Save stores it', async ({ page }) => {
        await setView(page, { text: 'knight' });
        await saveAs(page, 'Knights');
        await expect(page.locator('#character_view_picker')).not.toHaveClass(/unsaved/);

        await setView(page, { text: 'knight', fav: true });
        await expect(page.locator('#character_view_picker')).toHaveClass(/unsaved/);
        await openPicker(page);
        await page.locator('.view_picker_unsaved [data-action="discard"]').click();
        await expect(page.locator('#character_view_picker')).not.toHaveClass(/unsaved/);
        expect(await readView(page)).toMatchObject({ text: 'knight', fav: undefined });

        await setView(page, { text: 'paladin' });
        await page.locator('.view_picker_unsaved [data-action="save"]').click();
        await expect(page.locator('#character_view_picker')).not.toHaveClass(/unsaved/);
        const id = await page.locator('#character_view_picker').getAttribute('data-view-id');
        const stored = await page.evaluate(async (id) => {
            const headers = window['SillyTavern'].getContext().getRequestHeaders();
            return (await (await fetch('/api/views/get', { method: 'POST', headers, body: JSON.stringify({ id }) })).json()).view;
        }, id);
        expect(stored.text).toBe('paladin');
    });

    test('switching away from unsaved changes asks in place: Keep editing stays, Discard switches', async ({ page }) => {
        await setView(page, { text: 'orc' });
        await saveAs(page, 'Orcs');
        await setView(page, { text: 'goblin' });
        await saveAs(page, 'Goblins');
        await setView(page, { text: 'goblin king' });

        await openPicker(page);
        await page.locator('.view_picker_row_name', { hasText: 'Orcs' }).click();
        await expect(page.locator('.view_picker_unsaved')).toContainText('Unsaved changes to "Goblins"');
        await page.locator('.view_picker_unsaved [data-action="keep"]').click();
        await expect(page.locator('.view_picker_popover')).toHaveCount(0);
        expect((await readView(page)).text).toBe('goblin king');

        await openPicker(page);
        await page.locator('.view_picker_row_name', { hasText: 'Orcs' }).click();
        await page.locator('.view_picker_unsaved [data-action="discard"]').click();
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('Orcs');
        expect((await readView(page)).text).toBe('orc');
    });

    test('unsaved changes survive a reload, on a saved view and on "All characters"', async ({ page }) => {
        await setView(page, { text: 'mage' });
        await saveAs(page, 'Mages');
        await setView(page, { text: 'archmage' });
        await expect(page.locator('#character_view_picker')).toHaveClass(/unsaved/);

        await page.reload();
        await awaitAppReady(page);
        await expect.poll(async () => (await readView(page)).text).toBe('archmage');
        await expect(page.locator('#character_view_picker')).toHaveClass(/unsaved/);
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('Mages');

        await openCharacterManagementDrawer(page);
        await openPicker(page);
        await page.locator('.view_picker_row[data-view-id=""] .view_picker_row_name').click();
        await page.locator('.view_picker_unsaved [data-action="discard"]').click();
        await setView(page, { text: 'witch' });
        await page.reload();
        await awaitAppReady(page);
        await expect.poll(async () => (await readView(page)).text).toBe('witch');
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('All characters');
    });

    test('text typed in the search box just before a reload comes back as a draft', async ({ page }) => {
        await openPicker(page);
        await page.locator('.view_picker_popover input[type="search"]').press('Escape');
        await page.locator('#character_search_bar').fill('');
        await page.locator('#character_search_bar').pressSequentially('quick');
        await page.reload();
        await awaitAppReady(page);
        await expect.poll(async () => (await readView(page)).text).toBe('quick');
    });

    test('a view changed in another tab shows in this one when this tab still shows it as it was', async ({ page, context }) => {
        await setView(page, { text: 'dragon' });
        await saveAs(page, 'Dragons');
        const id = await page.locator('#character_view_picker').getAttribute('data-view-id');

        const other = await context.newPage();
        await other.goto(page.url());
        await testSetup.awaitST({ page: other });
        await other.evaluate(async ({ id }) => {
            const headers = window['SillyTavern'].getContext().getRequestHeaders();
            await fetch('/api/views/change', { method: 'POST', headers, body: JSON.stringify({ id, name: 'Wyrms', view: { text: 'wyrm', tags: { include: [], exclude: [] } } }) });
        }, { id });

        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText('Wyrms');
        await expect.poll(async () => (await readView(page)).text).toBe('wyrm');
        await other.close();
    });
});
