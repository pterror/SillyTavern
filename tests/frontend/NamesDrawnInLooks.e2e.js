import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

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
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} thing
 * @param {{ property: string, value: string }[]} set
 * @param {string[]} reset
 */
const setRest = (page, thing, set, reset) => page.evaluate(async ({ thing, set, reset }) => {
    const { newUi } = await import('/scripts/new-ui-page.js');
    return newUi().looks.setDeclarations({ thing }, 'rest', set, reset);
}, { thing, set, reset });

/** @param {import('@playwright/test').Locator} locator */
const colorOf = locator => locator.evaluate(element => getComputedStyle(element).color);

test('a character\'s look, edited once, shows in its message name line and its row in the character list', async ({ page }) => {
    test.setTimeout(120_000);
    await testSetup.awaitST({ page });
    const name = `Looked-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, name);
    try {
        await openCharacterManagementDrawer(page);
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().getCharacters();
        });
        const search = page.locator('#character_search_bar');
        if (!await search.isVisible()) await page.locator('#rm_button_search').click();
        await search.fill(name);
        const row = page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`);
        await expect(row).toHaveClass(/look-scope/);
        const listed = row.locator('.ch_name .named');
        await expect(listed).toHaveText(name);
        const thing = await listed.getAttribute('data-thing');
        expect(thing).toMatch(/^\d+$/);
        await expect(listed).toHaveClass(`named named-name look-${thing}`);
        const plain = await colorOf(listed);

        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveClass(/look-scope/);
        const nameLine = page.locator('#chat .mes[mesid="0"] .name_text .named');
        await expect(nameLine).toHaveClass(`named named-name look-${thing}`);
        await expect(nameLine).toHaveText(name);

        expect(await setRest(page, String(thing), [{ property: 'color', value: 'rgb(1, 2, 3)' }], [])).toBeNull();
        await expect.poll(() => colorOf(nameLine)).toBe('rgb(1, 2, 3)');
        await expect.poll(() => colorOf(listed)).toBe('rgb(1, 2, 3)');

        expect(await setRest(page, String(thing), [], ['color'])).toBeNull();
        await expect.poll(() => colorOf(listed)).toBe(plain);
        await expect.poll(() => colorOf(nameLine)).not.toBe('rgb(1, 2, 3)');
    } finally {
        await deleteCharacter(page, avatar);
    }
});
