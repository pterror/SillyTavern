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

/**
 * Records every list query as `window.__queries` ({ filter, sort }), answering with an empty page.
 * @param {import('@playwright/test').Page} page
 */
async function recordQueries(page) {
    await page.evaluate(async () => {
        const { characterRepository } = await import('/scripts/character-repository.js');
        window['__queries'] = [];
        characterRepository.query = async (filter = {}, sort) => {
            window['__queries'].push({ filter: structuredClone(filter), sort: structuredClone(sort) });
            return { seq: 0, token: null, rows: [], total: 0 };
        };
    });
}

/** @param {import('@playwright/test').Page} page */
function lastQuery(page) {
    return page.evaluate(() => window['__queries'].at(-1));
}

test.describe('character view', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await recordQueries(page);
    });

    test('a filter an extension sets through upstream\'s FilterHelper is the view, and the list asks for it', async ({ page }) => {
        await page.evaluate(async () => {
            const { entitiesFilter } = await import('/script.js');
            const { FILTER_TYPES, FILTER_STATES } = await import('/scripts/filters.js');
            entitiesFilter.setFilterData(FILTER_TYPES.FAV, FILTER_STATES.SELECTED.key);
            entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, 'by:alice castle');
        });

        await expect.poll(async () => (await lastQuery(page))?.filter).toMatchObject({ fav: true, search: 'by:alice castle' });
        const view = await page.evaluate(async () => (await import('/scripts/character-list.js')).getCharacterView());
        expect(view).toMatchObject({
            text: 'castle',
            conditions: [{ field: 'creator', op: 'contains', value: 'alice' }],
            fav: true,
            group: undefined,
        });
    });

    test('a view set on the list is what upstream\'s FilterHelper reads back, and the search box shows it', async ({ page }) => {
        await page.evaluate(async () => {
            const { setCharacterView } = await import('/scripts/character-list.js');
            setCharacterView({
                text: 'castle',
                conditions: [{ field: 'creator', op: 'contains', value: 'alice' }],
                fav: false,
            });
        });

        await expect.poll(async () => (await lastQuery(page))?.filter).toMatchObject({ fav: false, search: 'creator:alice castle' });
        const read = await page.evaluate(async () => {
            const { entitiesFilter } = await import('/script.js');
            const { FILTER_TYPES } = await import('/scripts/filters.js');
            return { search: entitiesFilter.getFilterData(FILTER_TYPES.SEARCH), fav: entitiesFilter.getFilterData(FILTER_TYPES.FAV) };
        });
        expect(read).toEqual({ search: 'creator:alice castle', fav: 'EXCLUDED' });
        await expect(page.locator('#character_search_bar')).toHaveValue('castle');
        await expect(page.locator('#character_search_pills .search_pill[data-field]')).toHaveText(['Creatorcontainsalice']);
    });

    test.describe('pills', () => {
        /** @param {import('@playwright/test').Page} page */
        async function openSearch(page) {
            if (!(await page.locator('#character_search_bar').isVisible())) await page.locator('#rm_button_search').click();
        }

        test('typing field:value and a space makes a pill, and a minus makes it "doesn\'t contain"', async ({ page }) => {
            await openSearch(page);
            await page.locator('#character_search_bar').pressSequentially('by:alice -tag:horror castle');

            await expect(page.locator('#character_search_pills .search_pill[data-field]')).toHaveCount(2);
            await expect(page.locator('#character_search_pills .search_pill[data-field="creator"]')).toHaveAttribute('data-op', 'contains');
            await expect(page.locator('#character_search_pills .search_pill[data-field="tag"]')).toHaveAttribute('data-op', 'not_contains');
            await expect(page.locator('#character_search_bar')).toHaveValue('castle');
            await expect.poll(async () => (await lastQuery(page))?.filter?.search).toBe('creator:alice -tag:horror castle');
        });

        test('a pill\'s parts change in place: the operator flips, the field is picked, the value is edited', async ({ page }) => {
            await openSearch(page);
            await page.locator('#character_search_bar').pressSequentially('name:bob ');
            const pill = page.locator('#character_search_pills .search_pill[data-field]');

            await pill.locator('.view_pill_op').click();
            await expect.poll(async () => (await lastQuery(page))?.filter?.search).toBe('-name:bob');

            await pill.locator('.search_pill_label').click();
            await page.locator('.view_pill_popover input').fill('creat');
            await page.locator('.view_pill_field_option[data-field="creator"]').click();
            await expect.poll(async () => (await lastQuery(page))?.filter?.search).toBe('-creator:bob');

            await pill.locator('.search_pill_value').click();
            await page.locator('.view_pill_value_input').fill('carol');
            await page.locator('.view_pill_value_input').press('Enter');
            await expect.poll(async () => (await lastQuery(page))?.filter?.search).toBe('-creator:carol');
        });

        test('+ adds a pill from the field list; Escape cancels its value without closing the drawer', async ({ page }) => {
            await openSearch(page);
            await page.locator('.view_pill_add').click();
            await page.locator('.view_pill_field_option[data-field="scenario"]').click();
            await page.locator('.view_pill_value_input').fill('rain');
            await page.locator('.view_pill_value_input').press('Enter');
            await expect.poll(async () => (await lastQuery(page))?.filter?.search).toBe('scenario:rain');

            await page.locator('.view_pill_add').click();
            await page.locator('.view_pill_field_option[data-field="name"]').click();
            await page.locator('.view_pill_value_input').press('Escape');
            await expect(page.locator('#character_search_pills .search_pill[data-field]')).toHaveCount(1);
            await expect(page.locator('#rm_characters_block')).toBeVisible();
        });

        test('a search an extension sets through upstream\'s FilterHelper shows as pills', async ({ page }) => {
            await openSearch(page);
            await page.locator('#character_search_bar').blur();
            await page.evaluate(async () => {
                const { entitiesFilter } = await import('/script.js');
                const { FILTER_TYPES } = await import('/scripts/filters.js');
                entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, 'author:dee forest');
            });

            await expect(page.locator('#character_search_pills .search_pill[data-field="creator"]')).toHaveCount(1);
            await expect(page.locator('#character_search_bar')).toHaveValue('forest');
        });
    });

    test('a sort set on the view is the sort the list asks for and the dropdown shows', async ({ page }) => {
        await page.evaluate(async () => {
            const { setCharacterView } = await import('/scripts/character-list.js');
            setCharacterView({ sort: { field: 'create_date', order: 'asc' } });
        });

        await expect.poll(async () => (await lastQuery(page))?.sort).toEqual({ field: 'create_date', order: 'asc' });
        await expect(page.locator('#character_sort_order option:checked')).toHaveText('Oldest');
    });
});
