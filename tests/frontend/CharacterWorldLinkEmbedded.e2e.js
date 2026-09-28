import { test, expect } from './fixtures.js';
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

// A card exported from upstream links a lorebook by name (data.extensions.world) and embeds that book
// (character_book). Importing it never makes a World file, so the link names a file that doesn't exist and
// prompts use the embedded book. The page treats that link as a link to the embedded book: it never asks the
// server for the name, the globe shows it as linked, and the Link to World Info popup shows it selected.
test.describe('a link to a name with no World file, on a card with an embedded lorebook', () => {
    test.beforeEach(testSetup.awaitST);

    test('links the embedded book: no /get for the name, globe and Link popup show it linked', async ({ page }) => {
        const linkName = `Embedded Link ${Date.now()}`;
        const requestedNames = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/worldinfo/get') {
                requestedNames.push(JSON.parse(request.postData() ?? '{}').name);
            }
        });

        const avatar = await page.evaluate(async (linkName) => {
            const { getRequestHeaders } = await import('./script.js');
            const card = {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: {
                    name: 'Link Keeper',
                    extensions: { world: linkName },
                    // Named differently from the link: the link counts as the embedded book's whatever its name.
                    character_book: {
                        name: 'Inner Book Name',
                        extensions: {},
                        entries: [{ id: 0, keys: ['lighthouse'], content: 'The lighthouse keeper is named Ida.', enabled: true, insertion_order: 0, extensions: {} }],
                    },
                },
            };
            const form = new FormData();
            form.set('ch_name', 'Link Keeper');
            form.set('world', linkName);
            form.set('fav', 'false');
            form.set('json_data', JSON.stringify(card));
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: form,
            });
            if (!response.ok) {
                throw new Error(`create failed: ${response.status}`);
            }
            return await response.text();
        }, linkName);

        try {
            // A fresh page load, then opening the character (which opens its chat).
            await testSetup.awaitST({ page });
            const lore = await page.evaluate(async (avatar) => {
                const { getSortedEntries, getCharacterWorldLink, EMBEDDED_WORLD_NAME } = await import('./scripts/world-info.js');
                const { selectCharacterByAvatar, getCurrentCharacter, eventSource, event_types } = await import('./script.js');

                await selectCharacterByAvatar(avatar);

                const captured = new Promise((resolve) => {
                    eventSource.once(event_types.WORLDINFO_ENTRIES_LOADED, (data) => resolve(data));
                });
                await getSortedEntries();
                const { characterLore } = await captured;

                return {
                    link: getCharacterWorldLink(getCurrentCharacter()),
                    embeddedContents: characterLore.filter(e => e.world === EMBEDDED_WORLD_NAME).map(e => e.content),
                };
            }, avatar);

            expect(lore.link).toBe('embedded');
            expect(lore.embeddedContents).toEqual(['The lighthouse keeper is named Ida.']);
            expect(requestedNames).not.toContain(linkName);
            await expect(page.locator('#world_button')).toHaveClass(/\bworld_set\b/);

            // Shift-click opens the Link to World Info popup, whose primary lorebook shows the link.
            await page.locator('#world_button').click({ modifiers: ['Shift'] });
            const selected = page.locator('dialog[open] .character_world_info_selector option:checked');
            await expect(selected).toHaveText(`${linkName} (Embedded Lore)`);
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog[open] .character_world_info_selector')).toHaveCount(0);

            // Removing the embedded book leaves the link pointing at nothing: the globe no longer shows it linked.
            await page.evaluate(async (avatar) => {
                const { openEmbeddedLoreEditor } = await import('./scripts/world-info.js');
                await openEmbeddedLoreEditor(avatar);
            }, avatar);
            await page.locator('#world_popup_delete').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('#world_button')).not.toHaveClass(/\bworld_set\b/);

            const afterRemoval = await page.evaluate(async (avatar) => {
                const { getCharacterWorldLink } = await import('./scripts/world-info.js');
                const { charactersStore } = await import('./scripts/character-store.js');
                const character = charactersStore.get(avatar);
                return { link: getCharacterWorldLink(character), world: character?.data?.extensions?.world };
            }, avatar);
            // The link itself is kept as it was.
            expect(afterRemoval).toEqual({ link: 'missing', world: linkName });
            expect(requestedNames).not.toContain(linkName);
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
