import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteCharacter, deleteWorld, makeCharacter, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * Renames the shown world from its name on the world's page.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function renameShownWorld(page, name) {
    const pane = page.locator('#Worldbuilding');
    await pane.getByRole('button', { name: 'The world’s name' }).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(pane.locator('h1.wb-front-name')).toHaveText(name);
}

test.describe('what links to a world follows it', () => {
    test.beforeEach(testSetup.awaitST);

    test('a rename moves the open character\'s, the chat\'s and the persona\'s links to the new name', async ({ page }) => {
        const before = unique('Linked');
        const after = unique('Renamed');
        const avatar = await makeCharacter(page, unique('Linker'));
        try {
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await makeWorld(page, before);
            await page.evaluate(async (name) => {
                const { charUpdatePrimaryWorld, setChatWorld } = await import('/scripts/world-links.js');
                const { getOrCreatePersonaDescriptor, user_avatar } = await import('/scripts/personas.js');
                const { personaStore } = await import('/scripts/power-user.js');
                await charUpdatePrimaryWorld(name);
                await setChatWorld(name);
                getOrCreatePersonaDescriptor();
                personaStore.update(user_avatar, { lorebook: name });
            }, before);
            await renameShownWorld(page, after);
            await expect.poll(() => page.evaluate(async () => {
                const { chat_metadata } = await import('/scripts/chat-state.js');
                const { getPersonaDescriptionLorebook } = await import('/scripts/personas.js');
                return [String($('#character_world').val()), chat_metadata.world_info, getPersonaDescriptionLorebook()];
            })).toEqual([after, after, after]);
            const stored = await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('/scripts/request-headers.js');
                const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
                return (await response.json()).data?.extensions?.world;
            }, avatar);
            expect(stored).toBe(after);
        } finally {
            await deleteWorld(page, after);
            await deleteCharacter(page, avatar);
        }
    });

    test('a delete unlinks the world from the open character and the chat', async ({ page }) => {
        const name = unique('Gone');
        const avatar = await makeCharacter(page, unique('Unlinker'));
        try {
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await makeWorld(page, name);
            await page.evaluate(async (name) => {
                const { charUpdatePrimaryWorld, setChatWorld } = await import('/scripts/world-links.js');
                await charUpdatePrimaryWorld(name);
                await setChatWorld(name);
            }, name);
            await expect(page.locator('#world_button')).toHaveClass(/\bworld_set\b/);
            await deleteWorld(page, name);
            await expect(page.locator('#world_button')).not.toHaveClass(/\bworld_set\b/);
            await expect(page.locator('#world_button')).not.toHaveClass(/\bwarning\b/);
            await expect.poll(() => page.evaluate(async () => {
                const { chat_metadata } = await import('/scripts/chat-state.js');
                return [String($('#character_world').val()), chat_metadata.world_info ?? null];
            })).toEqual(['', null]);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('a character\'s own lorebook opens from the character panel, and its edits go into the card', async ({ page }) => {
        const avatar = await makeCharacter(page, unique('Keeper'), {
            character_book: { name: 'Keeper book', extensions: {}, entries: [{ id: 0, keys: ['lighthouse'], content: 'The keeper is Ida.', enabled: true, insertion_order: 0, extensions: {} }] },
        });
        try {
            await testSetup.awaitST({ page });
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await page.locator('#char-management-dropdown').selectOption({ label: 'View/Edit Embedded Lore' });
            const pane = page.locator('#Worldbuilding');
            await expect(pane.locator('h1.wb-front-name')).toHaveText('Keeper book');
            await pane.locator('.wb-card-open', { hasText: 'The keeper is Ida.' }).click();
            await pane.getByRole('textbox', { name: 'The entry’s text' }).click();
            await pane.locator('.cm-content').click();
            await page.keyboard.press('Control+End');
            await page.keyboard.type(' She trims the wick.');
            await page.keyboard.press('Escape');
            await expect.poll(() => page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('/scripts/request-headers.js');
                const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
                return (await response.json()).data?.character_book?.entries?.[0]?.content;
            }, avatar)).toBe('The keeper is Ida. She trims the wick.');
        } finally {
            await deleteCharacter(page, avatar);
        }
    });
});
