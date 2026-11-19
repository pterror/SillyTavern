import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page @param {number} count */
async function draft(page, count) {
    await testSetup.awaitST({ page });
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    const stamp = `${Date.now()}`;
    await page.locator('#character_name_pole').fill(`AssignedDraft-${stamp}`);
    return page.evaluate(async ({ stamp, count }) => {
        const headers = window['stTest'].context().getRequestHeaders();
        const ids = Array.from({ length: count }, (_, index) => `assigned-${stamp}-${String(index).padStart(3, '0')}`);
        for (const [sort_order, id] of ids.entries()) {
            const response = await fetch('/api/tags/create', { method: 'POST', headers, body: JSON.stringify({ tag: {
                id, name: id, sort_order, folder_type: 'NONE', is_hidden_on_character_card: false, create_date: Date.now(),
            } }) });
            if (!response.ok) throw new Error(`create tag -> ${response.status}`);
        }
        const tags = await import('/scripts/tags.js');
        const read = await tags.readTagsForIds(ids);
        tags.addTagsToEntity(ids.map(id => read.tags.get(id)), null, {
            tagListSelector: '#tagList', tagListOptions: { tagOptions: { removable: true } },
        });
        return ids;
    }, { stamp, count });
}

test('creation saves every draft tag, including the ones behind the overflow control', async ({ page }) => {
    const ids = await draft(page, 55);
    await expect(page.locator('#tagList .tag:not(.placeholder-expander)')).toHaveCount(50);
    await expect(page.locator('#tagList .placeholder-expander')).toHaveCount(1);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
    await page.locator('#create_button_label').click();
    const avatar = (await (await created).text()).trim();
    await expect.poll(() => page.evaluate(async avatar => {
        const headers = window['stTest'].context().getRequestHeaders();
        const response = await fetch('/api/tags/for', { method: 'POST', headers, body: JSON.stringify({ ids: [avatar] }) });
        return (await response.json())[avatar] ?? [];
    }, avatar)).toEqual(ids);
    await page.locator('#tagList .placeholder-expander').dispatchEvent('click');
    await expect(page.locator('#tagList .tag:not(.placeholder-expander)')).toHaveCount(ids.length);
    await expect(page.locator('#tagList .placeholder-expander')).toHaveCount(0);
});

test('a custom removal can refuse without removing a chip or firing the default handler', async ({ page }) => {
    const [id] = await draft(page, 1);
    await page.evaluate(async id => {
        const tags = await import('/scripts/tags.js');
        window['__customRemovals'] = 0;
        tags.printTagList(window['$']('#tagList'), { tags: tags.heldTagsForIds([id]), empty: 'always',
            tagOptions: { removable: true, removeAction: () => { window['__customRemovals']++; return false; } },
        });
    }, id);
    const chip = page.locator(`#tagList .tag[id="${id}"]`);
    await chip.locator('.tag_remove').dispatchEvent('click');
    expect(await page.evaluate(() => window['__customRemovals'])).toBe(1);
    await expect(chip).toHaveCount(1);
    await expect(page.locator(`#tags_div_preview .tag[id="${id}"]`)).toHaveCount(1);
    await page.evaluate(async id => {
        const tags = await import('/scripts/tags.js');
        tags.printTagList(window['$']('#tagList'), { tags: tags.heldTagsForIds([id]), empty: 'always', tagOptions: { removable: true } });
    }, id);
    await chip.locator('.tag_remove').dispatchEvent('click');
    await expect(chip).toHaveCount(0);
    await expect(page.locator('#tags_div_preview .tag')).toHaveCount(0);
});
