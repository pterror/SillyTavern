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

test.describe('a link to a name with no World file, on a card with an embedded lorebook', () => {
    test.beforeEach(testSetup.awaitST);

    test('links the embedded book: no read of the name, globe and Link popup show it linked, and its page is the card\'s own book', async ({ page }) => {
        const linkName = `Embedded Link ${Date.now()}`;
        const requestedNames = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/ui/action') {
                const body = JSON.parse(request.postData() ?? '{}');
                if (body.payload?.world === linkName) requestedNames.push(linkName);
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
            await testSetup.awaitST({ page });
            const link = await page.evaluate(async (avatar) => {
                const { getCharacterWorldLink } = await import('./scripts/world-links.js');
                const { selectCharacterByAvatar, getCurrentCharacter } = await import('./script.js');
                await selectCharacterByAvatar(avatar);
                return getCharacterWorldLink(getCurrentCharacter());
            }, avatar);

            expect(link).toBe('embedded');
            await expect(page.locator('#world_button')).toHaveClass(/\bworld_set\b/);

            await page.locator('#world_button').click({ modifiers: ['Shift'] });
            const selected = page.locator('dialog[open] .character_world_info_selector option:checked');
            await expect(selected).toHaveText(`${linkName} (Embedded Lore)`);
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog[open] .character_world_info_selector')).toHaveCount(0);

            await page.locator('#char-management-dropdown').selectOption({ label: 'View/Edit Embedded Lore' });
            const front = page.locator('#Worldbuilding .wb-front');
            await expect(front.locator('.wb-front-meta')).toContainText('Lorebook of');
            await expect(front.locator('.wb-front-meta')).toContainText('Link Keeper');
            await expect(front.locator('.wb-card').getByText('The lighthouse keeper is named Ida.')).toBeVisible();
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
