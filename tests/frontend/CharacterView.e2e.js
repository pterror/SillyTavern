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
        await expect(page.locator('#character_search_pills .search_pill')).toHaveText(['creator:alice']);
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
