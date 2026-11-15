import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        return response.json();
    }, { path, body });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} thing
 * @param {{ property: string, value: string }[]} set
 */
const setRest = (page, thing, set) => page.evaluate(async ({ thing, set }) => {
    const { newUi } = await import('/scripts/new-ui-page.js');
    return newUi().looks.setDeclarations({ thing }, 'rest', set, []);
}, { thing, set });

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} property
 */
const styleOf = (locator, property) => locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property);

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function search(page, text) {
    const field = page.locator('#character_search_bar');
    if (!await field.isVisible()) await page.locator('#rm_button_search').click();
    await field.fill(text);
}

test('a tag is drawn in its look: upstream\'s colors given at its create are its look, its chip and its Manage tags row are its name, and the row opens its Look screen, used over the dialog', async ({ page }) => {
    test.setTimeout(180_000);
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const name = `Tagged-${stamp}`;
    const tagId = `looked-${stamp}`;
    const avatar = await createCharacter(page, name);
    const { tag } = await api(page, '/api/tags/create', { tag: { id: tagId, name: `Rogue ${stamp}`, color: 'rgb(10, 20, 30)', color2: 'rgb(1, 2, 3)' } });
    expect(tag.thing).toMatch(/^\d+$/);
    expect(tag).not.toHaveProperty('color');
    await api(page, '/api/tags/assign', { id: avatar, tagId });

    await openCharacterManagementDrawer(page);
    await page.evaluate(async () => {
        // @ts-ignore
        await stTest.context().getCharacters();
    });
    await search(page, name);
    const chip = page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"] .tags .tag[id="${tagId}"]`);
    await expect(chip).toHaveText(`Rogue ${stamp}`);
    await expect(chip).toHaveClass(new RegExp(`(^| )named named-name look-${tag.thing}( |$)`));
    await expect(chip).toHaveAttribute('data-thing', tag.thing);
    await expect(chip.locator('.named')).toHaveCount(0);
    await expect.poll(() => styleOf(chip, 'color')).toBe('rgb(1, 2, 3)');
    await expect.poll(() => styleOf(chip, 'background-color')).toBe('rgb(10, 20, 30)');

    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_search').fill(`Rogue ${stamp}`);
    const row = page.locator(`#tag_view_list .tag_view_item[id="${tagId}"]`);
    const rowName = row.locator('.tag_view_name');
    await expect(rowName).toHaveClass(new RegExp(`(^| )look-${tag.thing}( |$)`));
    await expect.poll(() => styleOf(rowName, 'background-color')).toBe('rgb(10, 20, 30)');
    await expect(row.locator('toolcool-color-picker')).toHaveCount(0);
    await row.locator('.tag_view_look').click();
    const screen = page.locator('.look-screen');
    await expect(screen.locator('.look-back')).toHaveText(`Rogue ${stamp}`);

    await screen.locator('.look-sth-selected').click();
    await expect(screen.locator('.look-sth-selected')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    await expect(row).toBeVisible();
    await row.locator('.tag_view_look').click();
    await screen.locator('.look-back').click();
    await expect(screen).toHaveCount(0);
    await expect(row).toBeVisible();

    expect(await setRest(page, String(tag.thing), [{ property: 'color', value: 'rgb(4, 5, 6)' }])).toBeNull();
    await expect.poll(() => styleOf(chip, 'color')).toBe('rgb(4, 5, 6)');
});

test('a group\'s name is drawn in its look in its list row', async ({ page }) => {
    test.setTimeout(120_000);
    await testSetup.awaitST({ page });
    const name = `Party-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const group = await api(page, '/api/groups/create', { name, members: [] });
    expect(group.thing).toMatch(/^\d+$/);

    await openCharacterManagementDrawer(page);
    await page.evaluate(async () => {
        // @ts-ignore
        await stTest.context().getCharacters();
    });
    await search(page, name);
    const listed = page.locator(`#rm_print_characters_block .group_select[data-grid="${group.id}"] .ch_name .named`);
    await expect(listed).toHaveText(name);
    await expect(listed).toHaveClass(`named named-name look-${group.thing}`);

    expect(await setRest(page, String(group.thing), [{ property: 'color', value: 'rgb(7, 8, 9)' }])).toBeNull();
    await expect.poll(() => styleOf(listed, 'color')).toBe('rgb(7, 8, 9)');
});
