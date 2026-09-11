import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

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

/**
 * @param {import('@playwright/test').Page} page
 */
async function dismissWelcomePopupIfPresent(page) {
    const okButton = page.locator('.popup-button-ok');
    try {
        await okButton.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        return;
    }
    await okButton.first().click();
    await okButton.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
}

test.describe('embedded lorebook activates with no linked World', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => dismissWelcomePopupIfPresent(page));

    test('getSortedEntries() surfaces an embedded character_book entry when the character has no linked World file', async ({ page }) => {
        const name = `EmbeddedLoreActivationTest-${Date.now()}`;
        let avatar = null;

        // A fresh page load resumes whatever chat/character panel was last open server-side for
        // this account - the character management drawer (which holds #rm_button_create) may not
        // already be open.
        if (!(await page.locator('#rm_button_create').isVisible())) {
            await page.locator('#rightNavDrawerIcon').click();
            await page.locator('#rm_button_create').waitFor({ state: 'visible', timeout: 10000 });
        }
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);

        page.once('console', msg => {
            const text = msg.text();
            if (text.startsWith('new avatar id:')) {
                avatar = text.replace('new avatar id:', '').trim();
            }
        });

        // #create_button itself is `display: none` (styled via its <label for="create_button">).
        // The list panel this row would otherwise be clicked from is paginated/lazily loaded and
        // isn't guaranteed to hold the new row yet right after creation - selectCharacterByAvatar()
        // below is the same avatar-addressed selection path the app itself uses, and doesn't
        // depend on the row having rendered into that list.
        await page.locator('#create_button_label').click();
        await expect.poll(() => avatar, { timeout: 10000 }).not.toBeNull();

        try {
            const result = await page.evaluate(async (avatar) => {
                const { getSortedEntries, EMBEDDED_WORLD_NAME } = await import('./scripts/world-info.js');
                const { selectCharacterByAvatar, createOrEditCharacter, getCurrentCharacter, eventSource, event_types } = await import('./script.js');

                await selectCharacterByAvatar(avatar);

                // No World file is linked - #character_world stays untouched (empty) - so
                // getCharacterLore()'s embedded-book fallback is the only thing that can
                // surface these entries.
                const characterBook = {
                    extensions: {},
                    entries: [
                        { id: 0, keys: ['embeddedlorekeyword'], content: 'embedded lore content', enabled: true, insertion_order: 0, extensions: {} },
                    ],
                };
                $('#character_book_json').val(JSON.stringify(characterBook)).trigger('input');
                await createOrEditCharacter();

                const character = getCurrentCharacter();
                const savedBookEntryCount = character?.data?.character_book?.entries?.length ?? 0;

                // getSortedEntries() itself doesn't expose the per-source breakdown it emits over
                // WORLDINFO_ENTRIES_LOADED, so listen for that instead of re-deriving it.
                const captured = new Promise((resolve) => {
                    eventSource.once(event_types.WORLDINFO_ENTRIES_LOADED, (data) => resolve(data));
                });
                await getSortedEntries();
                const { characterLore } = await captured;

                return {
                    savedBookEntryCount,
                    characterLoreCount: characterLore.length,
                    hasEmbeddedEntry: characterLore.some(e => e.world === EMBEDDED_WORLD_NAME && e.key?.includes('embeddedlorekeyword')),
                };
            }, avatar);

            // Sanity check: the card actually saved the embedded book (rules out a save-path
            // failure masquerading as an activation failure).
            expect(result.savedBookEntryCount).toBe(1);

            // Regression guard: getCharacterLore() used to `return []` before ever reaching the
            // embedded character_book fallback whenever the character had no linked World file
            // and no extra char-lore entry - the exact case here.
            expect(result.characterLoreCount).toBeGreaterThan(0);
            expect(result.hasEmbeddedEntry).toBe(true);
        } finally {
            // getRequestHeaders() (not a plain Content-Type header) is required here - the server
            // rejects a mutating request with no X-CSRF-Token, so a plain header would silently
            // fail to delete the test character while still resolving without throwing.
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
