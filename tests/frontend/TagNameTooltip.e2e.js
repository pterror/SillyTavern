import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A tag whose name is cut short in the character list shows its whole name on hover; one shown whole gets no title.

test('a cut-short tag name shows whole on hover; a short one has no title', async ({ page }) => {
    await testSetup.awaitST({ page });
    const long = `A tag with a very long name that cannot fit in the row ${Date.now()}`;
    const short = `short-${Date.now()}`;
    await page.evaluate(async ({ long, short }) => {
        const { getRequestHeaders } = await import('./script.js');
        const post = (url, body) => fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        const form = new FormData();
        form.append('ch_name', `Tooltip-${Date.now()}`);
        const headers = getRequestHeaders();
        delete headers['Content-Type'];
        const avatar = (await (await fetch('/api/characters/create', { method: 'POST', headers, body: form })).text()).trim();
        for (const [id, name] of [[`${short}-id`, short], [`${short}-long`, long]]) {
            await post('/api/tags/create', { tag: { id, name, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
            await post('/api/tags/assign', { id: avatar, tagId: id });
        }
        const { entitiesFilter } = await import('./scripts/character-list.js');
        const { FILTER_TYPES } = await import('./scripts/filters.js');
        entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected: [`${short}-id`], excluded: [] });
    }, { long, short });
    await openCharacterManagementDrawer(page);
    const row = page.locator('#rm_print_characters_block .character_select').first();
    const longTag = row.locator(`.tag[id="${short}-long"]`);
    const shortTag = row.locator(`.tag[id="${short}-id"]`);
    await expect(longTag).toBeVisible({ timeout: 15000 });
    expect(await longTag.locator('.tag_name').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await longTag.hover();
    await expect(longTag).toHaveAttribute('title', long);
    await shortTag.hover();
    expect(await shortTag.getAttribute('title')).toBeNull();
});
