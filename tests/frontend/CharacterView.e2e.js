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
 * Records every list query as `window.__queries` ({ filter, sort }), answering with an empty page. The favorites bar
 * (RossAscends-mods.js) asks too; its queries aren't the list's, so they aren't recorded.
 * @param {import('@playwright/test').Page} page
 */
async function recordQueries(page) {
    await page.evaluate(async () => {
        const { characterRepository } = await import('/scripts/character-repository.js');
        window['__queries'] = [];
        characterRepository.query = async (filter = {}, sort) => {
            if (!String(new Error().stack).includes('RossAscends-mods')) {
                window['__queries'].push({ filter: structuredClone(filter), sort: structuredClone(sort) });
            }
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

        // The list asks with the field's canonical name, which the server reads the same as the alias.
        await expect.poll(async () => (await lastQuery(page))?.filter).toMatchObject({ fav: true, search: 'creator:alice castle' });
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

        /**
         * Makes tags on the server, named like their ids, and returns the ids.
         * @param {import('@playwright/test').Page} page
         * @param {string[]} names
         */
        async function makeTags(page, names) {
            const stamp = Date.now().toString(36);
            const ids = names.map(name => `viewpill-${name}-${stamp}`);
            await page.evaluate(async (ids) => {
                const headers = window['SillyTavern'].getContext().getRequestHeaders();
                for (const id of ids) {
                    const tag = { id, name: id, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() };
                    const response = await fetch('/api/tags/create', { method: 'POST', headers, body: JSON.stringify({ tag }) });
                    if (!response.ok) throw new Error(`create ${id} -> ${response.status}`);
                }
            }, ids);
            return ids;
        }

        test('+ Tag picks a tag from the server; the pill shows its name and the list asks for it', async ({ page }) => {
            const [moon] = await makeTags(page, ['moon']);
            await openSearch(page);
            await page.locator('.view_pill_add').click();
            await page.locator('.view_pill_field_option[data-field="@tag"]').click();
            await page.locator('.view_pill_popover input').fill(moon);
            await page.locator(`.view_pill_field_option[data-tag-id="${moon}"]`).click();

            await expect.poll(async () => (await lastQuery(page))?.filter?.tags).toMatchObject({ include: [moon], exclude: [], mode: 'and' });
            await expect(page.locator(`#character_search_pills .view_tag_pill[data-tag-id="${moon}"] .search_pill_value`)).toHaveText(moon);
        });

        test('two tag pills combine with "and" until the joiner is clicked, then "or"; the operator moves a tag to left out', async ({ page }) => {
            const [sun, sea] = await makeTags(page, ['sun', 'sea']);
            await page.evaluate(async (include) => {
                const { setCharacterView } = await import('/scripts/character-list.js');
                setCharacterView({ tags: { include, exclude: [], mode: 'and' } });
            }, [sun, sea]);
            await expect.poll(async () => (await lastQuery(page))?.filter?.tags).toMatchObject({ include: [sun, sea], mode: 'and' });

            await openSearch(page);
            await page.locator('#character_search_pills .view_pill_joiner').click();
            await expect.poll(async () => (await lastQuery(page))?.filter?.tags?.mode).toBe('or');
            await expect(page.locator('#character_search_pills .view_pill_joiner')).toHaveText('or');

            await page.locator(`#character_search_pills .view_tag_pill[data-tag-id="${sea}"] .view_pill_op`).click();
            await expect.poll(async () => (await lastQuery(page))?.filter?.tags).toMatchObject({ include: [sun], exclude: [sea] });
            await expect(page.locator(`#character_search_pills .view_tag_pill[data-tag-id="${sea}"]`)).toHaveAttribute('data-op', 'not_has');
        });

        test('a tag picked in upstream\'s tag filter shows as a tag pill with its name', async ({ page }) => {
            const [star] = await makeTags(page, ['star']);
            await openSearch(page);
            await page.evaluate(async (id) => {
                const { entitiesFilter } = await import('/script.js');
                const { FILTER_TYPES } = await import('/scripts/filters.js');
                entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected: [id], excluded: [] });
            }, star);

            await expect(page.locator(`#character_search_pills .view_tag_pill[data-tag-id="${star}"] .search_pill_value`)).toHaveText(star);
        });

        test('+ Favorite adds a favorites-only pill; its value flips to no favorites, and removing it drops the filter', async ({ page }) => {
            await openSearch(page);
            await page.locator('.view_pill_add').click();
            await page.locator('.view_pill_field_option[data-field="@fav"]').click();
            await expect.poll(async () => (await lastQuery(page))?.filter?.fav).toBe(true);

            await page.locator('#character_search_pills .view_fav_pill .search_pill_value').click();
            await expect.poll(async () => (await lastQuery(page))?.filter?.fav).toBe(false);
            const fav = await page.evaluate(async () => {
                const { entitiesFilter } = await import('/script.js');
                const { FILTER_TYPES } = await import('/scripts/filters.js');
                return entitiesFilter.getFilterData(FILTER_TYPES.FAV);
            });
            expect(fav).toBe('EXCLUDED');

            await page.locator('#character_search_pills .view_fav_pill .search_pill_remove').click();
            await expect.poll(async () => 'fav' in ((await lastQuery(page))?.filter ?? {})).toBe(false);
        });

        test('+ Created adds a date range: From alone is "on or after", To fills the end of that day, and removing it drops it', async ({ page }) => {
            await openSearch(page);
            await page.locator('.view_pill_add').click();
            await page.locator('.view_pill_field_option[data-field="@range:create_date"]').click();
            await page.locator('.view_range_editor input[data-end="min"]').fill('2024-03-05');
            await page.locator('.view_range_editor input[data-end="min"]').press('Enter');

            const startOfDay = await page.evaluate(() => new Date(2024, 2, 5).getTime());
            await expect.poll(async () => (await lastQuery(page))?.filter?.ranges).toEqual({ create_date: { min: startOfDay } });
            await expect(page.locator('#character_search_pills .view_range_pill[data-range="create_date"] .search_pill_value')).toContainText('on or after');

            await page.locator('#character_search_pills .view_range_pill .search_pill_value').click();
            await page.locator('.view_range_editor input[data-end="max"]').fill('2024-03-07');
            await page.locator('.view_range_editor .menu_button').click();
            const endOfDay = await page.evaluate(() => new Date(2024, 2, 7, 23, 59, 59, 999).getTime());
            await expect.poll(async () => (await lastQuery(page))?.filter?.ranges).toEqual({ create_date: { min: startOfDay, max: endOfDay } });
            await expect(page.locator('#character_search_pills .view_range_pill .search_pill_value')).toContainText('between');

            await page.locator('#character_search_pills .view_range_pill .search_pill_remove').click();
            await expect.poll(async () => 'ranges' in ((await lastQuery(page))?.filter ?? {})).toBe(false);
        });

        test('a size range is typed in kilobytes and sent in bytes, and it survives a reload', async ({ page }) => {
            await openSearch(page);
            await page.locator('.view_pill_add').click();
            await page.locator('.view_pill_field_option[data-field="@range:chat_size"]').click();
            await page.locator('.view_range_editor input[data-end="max"]').fill('64');
            await page.locator('.view_range_editor input[data-end="max"]').press('Enter');
            await expect.poll(async () => (await lastQuery(page))?.filter?.ranges).toEqual({ chat_size: { max: 64 * 1024 } });

            await page.reload();
            await awaitAppReady(page);
            const view = await page.evaluate(async () => (await import('/scripts/character-list.js')).getCharacterView());
            expect(view.ranges).toEqual({ chat_size: { max: 64 * 1024 } });
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
