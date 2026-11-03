import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}
if (process.env.PLAYWRIGHT_BASIC_AUTH_USER) {
    test.use({
        httpCredentials: {
            username: process.env.PLAYWRIGHT_BASIC_AUTH_USER,
            password: process.env.PLAYWRIGHT_BASIC_AUTH_PASS ?? '',
        },
    });
}

test.describe('embedded lorebook activates with no linked World', () => {
    test.beforeEach(testSetup.awaitST);

    test('getSortedEntries() surfaces an embedded character_book entry when the character has no linked World file', async ({ page }) => {
        const name = `EmbeddedLoreActivationTest-${Date.now()}`;
        let avatar = null;

        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);

        page.once('console', msg => {
            const text = msg.text();
            if (text.startsWith('new avatar id:')) {
                avatar = text.replace('new avatar id:', '').trim();
            }
        });

        await page.locator('#create_button_label').click();
        await expect.poll(() => avatar, { timeout: 10000 }).not.toBeNull();

        try {
            const result = await page.evaluate(async (avatar) => {
                const { getSortedEntries, EMBEDDED_WORLD_NAME } = await import('./scripts/world-info.js');
                const { selectCharacterByAvatar, saveCharacterField, getCurrentCharacter } = await import('./script.js');

                await selectCharacterByAvatar(avatar);

                const characterBook = {
                    extensions: {},
                    entries: [
                        { id: 0, keys: ['embeddedlorekeyword'], content: 'embedded lore content', enabled: true, insertion_order: 0, extensions: {} },
                    ],
                };
                const characterBookJson = JSON.stringify(characterBook);
                $('#character_book_json').val(characterBookJson);
                await saveCharacterField(avatar, '#character_book_json', characterBookJson);

                const character = getCurrentCharacter();
                const savedBookEntryCount = character?.data?.character_book?.entries?.length ?? 0;

                const characterLore = (await getSortedEntries()).filter(e => e.world === EMBEDDED_WORLD_NAME);

                return {
                    savedBookEntryCount,
                    characterLoreCount: characterLore.length,
                    hasEmbeddedEntry: characterLore.some(e => e.world === EMBEDDED_WORLD_NAME && e.key?.includes('embeddedlorekeyword')),
                };
            }, avatar);

            expect(result.savedBookEntryCount).toBe(1);

            expect(result.characterLoreCount).toBeGreaterThan(0);
            expect(result.hasEmbeddedEntry).toBe(true);
        } finally {
            await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('./script.js');
                await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
                });
            }, avatar);
        }
    });
});
