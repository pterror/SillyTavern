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
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

// @ts-ignore
const chatId = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => stTest.context().getCurrentChatId());

test('a fresh tab\'s conversation is named after the character and the session, before and after its first message and a reload', async ({ page }) => {
    await testSetup.awaitST({ page });
    const name = `Named-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, name);
    await openCharacter(page, avatar);

    const before = await chatId(page);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(before).toMatch(new RegExp(`^${escaped} - \\d{4}-\\d{2}-\\d{2}@\\d{2}h\\d{2}m\\d{2}s\\d{3}ms$`));
    await page.evaluate(async () => {
        // @ts-ignore
        await stTest.context().executeSlashCommandsWithOptions('/send hello');
    });
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return stTest.context().chat.map(m => m.mes);
    })).toEqual(['Hello.', 'hello']);
    expect(await chatId(page)).toBe(before);

    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
    expect(await chatId(page)).toBe(before);
});
